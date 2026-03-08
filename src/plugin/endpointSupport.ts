import type { PayloadRequest, Where } from 'payload'

import type { MerchantService } from '../server/services/merchantService.js'
import type { NormalizedPluginOptions } from '../types/index.js'

import {
  GMC_FIELD_MAPPINGS_SLUG,
  MC_FIELD_GROUP_NAME,
  MC_SYNC_META_DIRTY_PATH,
} from '../constants.js'
import { resolveIdentity } from '../server/sync/identityResolver.js'
import { assertApiKeyAccess } from '../server/utilities/apiKeyAuth.js'
import { getRecordID } from '../server/utilities/recordUtils.js'
import { ValidationError } from '../server/utilities/validation.js'
import { startTrackedOperation } from './asyncSyncRunner.js'
import {
  queueBatchPushJob,
  queueDirtySyncJob,
  queueInitialSyncJob,
  queuePullAllJob,
} from './jobTasks.js'
import { getMerchantServiceInstance } from './serviceRegistry.js'
import {
  buildCompletionUpdate,
  buildProgressUpdate,
  createSyncLog,
  type SyncLogUpdateArgs,
  updateSyncLog,
} from './syncLogs.js'

export const DIRTY_SYNC_FILTER: Where = {
  [MC_SYNC_META_DIRTY_PATH]: { equals: true },
}

export const getService = (options: NormalizedPluginOptions): MerchantService => {
  const service = getMerchantServiceInstance(options.merchantId)
  if (!service) {
    throw new Error('[GMC Plugin] Service not initialised — this is a bug')
  }
  return service
}

export const assertWorkerAccess = (
  req: PayloadRequest,
  options: NormalizedPluginOptions,
): void => {
  assertApiKeyAccess(
    req,
    options.sync.schedule.apiKey,
    'Worker endpoints are not configured. Set sync.schedule.apiKey in plugin options.',
  )
}

export const resolveDeleteIdentity = (
  rawIdentity: {
    contentLanguage?: string
    dataSourceOverride?: string
    feedLabel?: string
    offerId?: string
  } | undefined,
  options: NormalizedPluginOptions,
) => {
  if (!rawIdentity) {
    return undefined
  }

  const identityResult = resolveIdentity(
    { [MC_FIELD_GROUP_NAME]: { identity: rawIdentity } },
    options,
  )

  if (!identityResult.ok) {
    throw new ValidationError(identityResult.errors.join('; '))
  }

  return identityResult.value
}

export const buildPullAllProgressUpdate = (report: {
  errors: Array<{ message: string; productId: string }>
  failed: number
  matched: number
  orphaned: number
  processed: number
  succeeded: number
  total: number
}): SyncLogUpdateArgs => ({
  ...buildProgressUpdate(report),
  metadata: {
    matched: report.matched,
    orphaned: report.orphaned,
  },
})

export const buildPullAllCompletionUpdate = (report: {
  completedAt?: string
  errors: Array<{ message: string; productId: string }>
  failed: number
  matched: number
  orphaned: number
  processed: number
  status: 'cancelled' | 'completed' | 'failed' | 'running'
  succeeded: number
  total: number
}): SyncLogUpdateArgs => ({
  ...buildCompletionUpdate(report),
  metadata: {
    matched: report.matched,
    orphaned: report.orphaned,
  },
})

export const buildInitialSyncCompletionUpdate = (report: {
  completedAt?: string
  dryRun: boolean
  errors: Array<{ message: string; offerId?: string; productId: string }>
  existingRemote: number
  failed: number
  processed: number
  skipped: number
  status: 'cancelled' | 'completed' | 'failed' | 'running'
  succeeded: number
  total: number
}): SyncLogUpdateArgs => ({
  ...buildCompletionUpdate(report),
  metadata: {
    dryRun: report.dryRun,
    existingRemote: report.existingRemote,
    skipped: report.skipped,
  },
})

type TrackedPayloadJobType = 'batch' | 'initialSync' | 'pullAll'

const queueTrackedPayloadJob = async (args: {
  jobId: string
  metadata?: Record<string, unknown>
  req: PayloadRequest
  runQueue: (params: {
    jobId: string
    logDocId: number | string | undefined
    metadata?: Record<string, unknown>
    req: PayloadRequest
    triggeredBy: string
  }) => Promise<number | string | undefined>
  triggeredBy: string
  type: TrackedPayloadJobType
}): Promise<Response> => {
  const { type, jobId, metadata, req, runQueue, triggeredBy } = args

  const logDocId = await createSyncLog(req.payload, {
    type,
    jobId,
    metadata,
    triggeredBy,
  })

  try {
    await runQueue({
      jobId,
      logDocId,
      metadata,
      req,
      triggeredBy,
    })
  } catch (error) {
    // Mark the sync log as failed so it doesn't stay stuck in "running"
    const errorMessage = error instanceof Error ? error.message : String(error)
    await updateSyncLog(req.payload, logDocId, {
      completedAt: new Date().toISOString(),
      errors: [{ message: errorMessage, productId: 'queue' }],
      status: 'failed',
    })
    throw error
  }

  return new Response(JSON.stringify({ jobId, status: 'queued' }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })
}

export const startDirtySyncDispatch = async (args: {
  jobId: string
  metadata?: Record<string, unknown>
  options: NormalizedPluginOptions
  req: PayloadRequest
  triggeredBy: string
}): Promise<Response> => {
  const { jobId, metadata, options, req, triggeredBy } = args

  if (options.sync.schedule.strategy === 'payload-jobs') {
    return queueTrackedPayloadJob({
      type: 'batch',
      jobId,
      metadata,
      req,
      runQueue: ({ jobId: queuedJobId, logDocId, metadata: queuedMetadata, req, triggeredBy }) =>
        queueDirtySyncJob({
          jobId: queuedJobId,
          logDocId,
          merchantId: options.merchantId,
          metadata: queuedMetadata,
          payload: req.payload,
          req,
          triggeredBy,
        }),
      triggeredBy,
    })
  }

  const service = getService(options)
  const result = await startTrackedOperation({
    type: 'batch',
    cleanup: () => service.cleanupSyncLogs({ payload: req.payload }),
    jobId,
    logMetadata: metadata,
    logOperation: 'batch-dirty',
    payload: req.payload,
    run: (onProgress) =>
      service.pushBatch({
        filter: DIRTY_SYNC_FILTER,
        onProgress,
        payload: req.payload,
      }),
    triggeredBy,
  })

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })
}

export const listMappings = async (req: PayloadRequest) => {
  const result = await req.payload.find({
    collection: GMC_FIELD_MAPPINGS_SLUG as never,
    depth: 0,
    limit: 100,
    sort: 'order',
  })

  return { mappings: result.docs }
}

export const replaceMappings = async (args: {
  mappings: Array<{
    order: number
    source: string
    syncMode: 'initialOnly' | 'permanent'
    target: string
    transformPreset:
      | 'extractAbsoluteUrl'
      | 'extractUrl'
      | 'none'
      | 'toArray'
      | 'toBoolean'
      | 'toMicros'
      | 'toMicrosString'
      | 'toString'
  }>
  req: PayloadRequest
}) => {
  const { mappings, req } = args
  const existing = await req.payload.find({
    collection: GMC_FIELD_MAPPINGS_SLUG as never,
    depth: 0,
    limit: 100,
    overrideAccess: true,
  })
  const oldIds = existing.docs
    .map((doc) => getRecordID(doc))
    .filter((id): id is string => typeof id === 'string')
  const createdIds: string[] = []

  for (const mapping of mappings) {
    try {
      const created = await req.payload.create({
        collection: GMC_FIELD_MAPPINGS_SLUG as never,
        data: mapping as never,
        overrideAccess: true,
      })
      const createdId = getRecordID(created)
      if (typeof createdId === 'string') {
        createdIds.push(createdId)
      }
    } catch (error) {
      for (const createdId of createdIds) {
        try {
          await req.payload.delete({
            id: createdId,
            collection: GMC_FIELD_MAPPINGS_SLUG as never,
            overrideAccess: true,
          })
        } catch {
          // Best-effort rollback
        }
      }
      throw error
    }
  }

  for (const id of oldIds) {
    await req.payload.delete({
      id,
      collection: GMC_FIELD_MAPPINGS_SLUG as never,
      overrideAccess: true,
    })
  }

  return { saved: mappings.length }
}

export const startBatchPushDispatch = async (args: {
  filter?: Where
  jobId: string
  metadata?: Record<string, unknown>
  options: NormalizedPluginOptions
  productIds?: string[]
  req: PayloadRequest
  triggeredBy: string
}): Promise<Response> => {
  const { filter, jobId, metadata, options, productIds, req, triggeredBy } = args

  if (options.sync.schedule.strategy === 'payload-jobs') {
    return queueTrackedPayloadJob({
      type: 'batch',
      jobId,
      metadata,
      req,
      runQueue: ({ jobId: queuedJobId, logDocId, metadata: queuedMetadata, req, triggeredBy }) =>
        queueBatchPushJob({
          filter,
          jobId: queuedJobId,
          logDocId,
          merchantId: options.merchantId,
          metadata: queuedMetadata,
          payload: req.payload,
          productIds,
          req,
          triggeredBy,
        }),
      triggeredBy,
    })
  }

  const service = getService(options)
  const result = await startTrackedOperation({
    type: 'batch',
    cleanup: () => service.cleanupSyncLogs({ payload: req.payload }),
    jobId,
    logMetadata: metadata,
    logOperation: 'batch-push',
    payload: req.payload,
    run: (onProgress) =>
      service.pushBatch({
        filter,
        onProgress,
        payload: req.payload,
        productIds,
      }),
    triggeredBy,
  })

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })
}

export const startPullAllDispatch = async (args: {
  jobId: string
  metadata?: Record<string, unknown>
  options: NormalizedPluginOptions
  req: PayloadRequest
  triggeredBy: string
}): Promise<Response> => {
  const { jobId, metadata, options, req, triggeredBy } = args

  if (options.sync.schedule.strategy === 'payload-jobs') {
    return queueTrackedPayloadJob({
      type: 'pullAll',
      jobId,
      metadata,
      req,
      runQueue: ({ jobId: queuedJobId, logDocId, metadata: queuedMetadata, req, triggeredBy }) =>
        queuePullAllJob({
          jobId: queuedJobId,
          logDocId,
          merchantId: options.merchantId,
          metadata: queuedMetadata,
          payload: req.payload,
          req,
          triggeredBy,
        }),
      triggeredBy,
    })
  }

  const service = getService(options)
  const result = await startTrackedOperation({
    type: 'pullAll',
    cleanup: () => service.cleanupSyncLogs({ payload: req.payload }),
    jobId,
    logMetadata: metadata,
    logOperation: 'batch-pull-all',
    payload: req.payload,
    run: (onProgress) =>
      service.pullAllProducts({
        onProgress,
        payload: req.payload,
      }),
    toCompletionUpdate: buildPullAllCompletionUpdate,
    toProgressUpdate: buildPullAllProgressUpdate,
    triggeredBy,
  })

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })
}

export const startInitialSyncDispatch = async (args: {
  jobId: string
  metadata?: Record<string, unknown>
  options: NormalizedPluginOptions
  overrides?: {
    batchSize?: number
    dryRun?: boolean
    limit?: number
    onlyIfRemoteMissing?: boolean
  }
  req: PayloadRequest
  triggeredBy: string
}): Promise<Response> => {
  const { jobId, metadata, options, overrides, req, triggeredBy } = args

  if (options.sync.schedule.strategy === 'payload-jobs') {
    return queueTrackedPayloadJob({
      type: 'initialSync',
      jobId,
      metadata,
      req,
      runQueue: ({ jobId: queuedJobId, logDocId, metadata: queuedMetadata, req, triggeredBy }) =>
        queueInitialSyncJob({
          jobId: queuedJobId,
          logDocId,
          merchantId: options.merchantId,
          metadata: queuedMetadata,
          overrides,
          payload: req.payload,
          req,
          triggeredBy,
        }),
      triggeredBy,
    })
  }

  const service = getService(options)
  const result = await startTrackedOperation({
    type: 'initialSync',
    cleanup: () => service.cleanupSyncLogs({ payload: req.payload }),
    jobId,
    logMetadata: metadata,
    logOperation: 'initial-sync',
    payload: req.payload,
    run: (onProgress) =>
      service.runInitialSync({
        onProgress,
        overrides,
        payload: req.payload,
      }),
    toCompletionUpdate: buildInitialSyncCompletionUpdate,
    triggeredBy,
  })

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })
}
