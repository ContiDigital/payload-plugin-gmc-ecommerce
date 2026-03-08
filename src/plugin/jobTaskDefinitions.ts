import type { PayloadRequest, Where } from 'payload'

import type { NormalizedPluginOptions, ResolvedMCIdentity } from '../types/index.js'

import {
  GMC_BATCH_PUSH_TASK_SLUG,
  GMC_DELETE_PRODUCT_TASK_SLUG,
  GMC_INITIAL_SYNC_TASK_SLUG,
  GMC_PULL_ALL_TASK_SLUG,
  GMC_PUSH_PRODUCT_TASK_SLUG,
  GMC_SYNC_DIRTY_TASK_SLUG,
} from '../constants.js'
import { createPluginLogger } from '../server/utilities/logger.js'
import { getMerchantServiceInstance } from './serviceRegistry.js'
import {
  buildCompletionUpdate,
  buildProgressUpdate,
  createSyncLog,
  updateSyncLog,
} from './syncLogs.js'

type PushProductJobInput = {
  merchantId: string
  productId: string
}

type DeleteProductJobInput = {
  identity: ResolvedMCIdentity
  merchantId: string
  productId: string
}

type SyncDirtyJobInput = {
  jobId?: string
  logDocId?: number | string
  merchantId: string
  metadata?: Record<string, unknown>
  triggeredBy?: string
}

type BatchPushJobInput = {
  filter?: Where
  jobId?: string
  logDocId?: number | string
  merchantId: string
  metadata?: Record<string, unknown>
  productIds?: string[]
  triggeredBy?: string
}

type InitialSyncJobInput = {
  jobId?: string
  logDocId?: number | string
  merchantId: string
  metadata?: Record<string, unknown>
  overrides?: {
    batchSize?: number
    dryRun?: boolean
    limit?: number
    onlyIfRemoteMissing?: boolean
  }
  triggeredBy?: string
}

type PullAllJobInput = {
  jobId?: string
  logDocId?: number | string
  merchantId: string
  metadata?: Record<string, unknown>
  triggeredBy?: string
}

const buildPullAllProgressUpdate = (report: {
  errors: Array<{ message: string; productId: string }>
  failed: number
  matched: number
  orphaned: number
  processed: number
  succeeded: number
  total: number
}) => ({
  ...buildProgressUpdate(report),
  metadata: {
    matched: report.matched,
    orphaned: report.orphaned,
  },
})

const buildPullAllCompletionUpdate = (report: {
  completedAt?: string
  errors: Array<{ message: string; productId: string }>
  failed: number
  matched: number
  orphaned: number
  processed: number
  status: 'cancelled' | 'completed' | 'failed' | 'running'
  succeeded: number
  total: number
}) => ({
  ...buildCompletionUpdate(report),
  metadata: {
    matched: report.matched,
    orphaned: report.orphaned,
  },
})

const buildInitialSyncCompletionUpdate = (report: {
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
}) => ({
  ...buildCompletionUpdate(report),
  metadata: {
    dryRun: report.dryRun,
    existingRemote: report.existingRemote,
    skipped: report.skipped,
  },
})

export const buildPushProductTaskConfig = (options: NormalizedPluginOptions) => ({
  slug: GMC_PUSH_PRODUCT_TASK_SLUG,
  handler: async ({ input, req }: { input: PushProductJobInput; req: PayloadRequest }) => {
    const service = getMerchantServiceInstance(input.merchantId)
    if (!service) {
      return { errorMessage: 'Service not initialized', state: 'failed' as const }
    }

    const result = await service.pushProduct({
      payload: req.payload,
      productId: input.productId,
    })

    return {
      output: {
        action: result.action,
        productId: result.productId,
        queuedWithMerchant: options.merchantId,
        success: result.success,
      },
    }
  },
  inputSchema: [],
  interfaceName: 'GmcPushProductTaskInput',
  outputSchema: [],
  retries: 2,
})

export const buildDeleteProductTaskConfig = () => ({
  slug: GMC_DELETE_PRODUCT_TASK_SLUG,
  handler: async ({ input, req }: { input: DeleteProductJobInput; req: PayloadRequest }) => {
    const service = getMerchantServiceInstance(input.merchantId)
    if (!service) {
      return { errorMessage: 'Service not initialized', state: 'failed' as const }
    }

    try {
      const result = await service.deleteProductByIdentity({
        identity: input.identity,
        payload: req.payload,
        productId: input.productId,
      })

      return {
        output: {
          action: result.action,
          productId: result.productId,
          success: result.success,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await createSyncLog(req.payload, {
        type: 'push',
        errors: [{ message, productId: input.productId }],
        failed: 1,
        jobId: `gmc-delete-${input.productId}-${Date.now().toString(36)}`,
        processed: 1,
        status: 'failed',
        succeeded: 0,
        total: 1,
        triggeredBy: 'afterDelete-hook',
      })

      return { errorMessage: message, state: 'failed' as const }
    }
  },
  inputSchema: [],
  interfaceName: 'GmcDeleteProductTaskInput',
  outputSchema: [],
  retries: 2,
})

export const buildSyncDirtyTaskConfig = () => ({
  slug: GMC_SYNC_DIRTY_TASK_SLUG,
  handler: async ({ input, req }: { input: SyncDirtyJobInput; req: PayloadRequest }) => {
    const payload = req.payload
    const log = createPluginLogger(payload.logger, { operation: 'scheduledSync' })
    const service = getMerchantServiceInstance(input.merchantId)

    if (!service) {
      return { errorMessage: 'Service not initialized', state: 'failed' as const }
    }

    const jobId = input.jobId ?? `gmc-cron-job-${Date.now().toString(36)}`
    const logDocId = input.logDocId ?? await createSyncLog(payload, {
      type: 'batch',
      jobId,
      metadata: { trigger: 'payload-jobs', ...input.metadata },
      triggeredBy: input.triggeredBy ?? 'cron',
    })

    try {
      const report = await service.pushBatch({
        filter: { 'merchantCenter.syncMeta.dirty': { equals: true } },
        onProgress: async (progressReport) => {
          await updateSyncLog(payload, logDocId, buildProgressUpdate(progressReport))
        },
        payload,
      })

      await updateSyncLog(payload, logDocId, buildCompletionUpdate(report))
      void service.cleanupSyncLogs({ payload })

      log.info('Scheduled sync complete', {
        failed: report.failed,
        succeeded: report.succeeded,
        total: report.total,
      })

      return {
        output: {
          failed: report.failed,
          message: `Synced ${report.succeeded}/${report.total} products`,
          succeeded: report.succeeded,
          success: true,
          total: report.total,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('Scheduled sync failed', { error: message })

      await updateSyncLog(payload, logDocId, {
        completedAt: new Date().toISOString(),
        errors: [{ message, productId: 'global' }],
        status: 'failed',
      })

      return { errorMessage: message, state: 'failed' as const }
    }
  },
  inputSchema: [],
  interfaceName: 'GmcSyncDirtyTaskInput',
  outputSchema: [
    { name: 'success', type: 'checkbox' as const },
    { name: 'message', type: 'text' as const },
    { name: 'total', type: 'number' as const },
    { name: 'succeeded', type: 'number' as const },
    { name: 'failed', type: 'number' as const },
  ],
  retries: 1,
})

export const buildBatchPushTaskConfig = () => ({
  slug: GMC_BATCH_PUSH_TASK_SLUG,
  handler: async ({ input, req }: { input: BatchPushJobInput; req: PayloadRequest }) => {
    const payload = req.payload
    const service = getMerchantServiceInstance(input.merchantId)

    if (!service) {
      await updateSyncLog(payload, input.logDocId, {
        completedAt: new Date().toISOString(),
        errors: [{ message: 'Service not initialized', productId: 'global' }],
        status: 'failed',
      })
      return { errorMessage: 'Service not initialized', state: 'failed' as const }
    }

    const jobId = input.jobId ?? `gmc-batch-${Date.now().toString(36)}`
    const logDocId = input.logDocId ?? await createSyncLog(payload, {
      type: 'batch',
      jobId,
      metadata: { trigger: 'payload-jobs', ...input.metadata },
      triggeredBy: input.triggeredBy ?? 'system',
    })

    try {
      const report = await service.pushBatch({
        filter: input.filter,
        onProgress: async (progressReport) => {
          await updateSyncLog(payload, logDocId, buildProgressUpdate(progressReport))
        },
        payload,
        productIds: input.productIds,
      })

      await updateSyncLog(payload, logDocId, buildCompletionUpdate(report))
      void service.cleanupSyncLogs({ payload })

      return {
        output: {
          failed: report.failed,
          message: `Synced ${report.succeeded}/${report.total} products`,
          succeeded: report.succeeded,
          success: true,
          total: report.total,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await updateSyncLog(payload, logDocId, {
        completedAt: new Date().toISOString(),
        errors: [{ message, productId: 'global' }],
        status: 'failed',
      })

      return { errorMessage: message, state: 'failed' as const }
    }
  },
  inputSchema: [],
  interfaceName: 'GmcBatchPushTaskInput',
  outputSchema: [],
  retries: 1,
})

export const buildInitialSyncTaskConfig = () => ({
  slug: GMC_INITIAL_SYNC_TASK_SLUG,
  handler: async ({ input, req }: { input: InitialSyncJobInput; req: PayloadRequest }) => {
    const payload = req.payload
    const service = getMerchantServiceInstance(input.merchantId)

    if (!service) {
      await updateSyncLog(payload, input.logDocId, {
        completedAt: new Date().toISOString(),
        errors: [{ message: 'Service not initialized', productId: 'global' }],
        status: 'failed',
      })
      return { errorMessage: 'Service not initialized', state: 'failed' as const }
    }

    const jobId = input.jobId ?? `gmc-isync-${Date.now().toString(36)}`
    const logDocId = input.logDocId ?? await createSyncLog(payload, {
      type: 'initialSync',
      jobId,
      metadata: { trigger: 'payload-jobs', ...input.metadata },
      triggeredBy: input.triggeredBy ?? 'system',
    })

    try {
      const report = await service.runInitialSync({
        onProgress: async (progressReport) => {
          await updateSyncLog(payload, logDocId, buildProgressUpdate(progressReport))
        },
        overrides: input.overrides,
        payload,
      })

      await updateSyncLog(payload, logDocId, buildInitialSyncCompletionUpdate(report))
      void service.cleanupSyncLogs({ payload })

      return {
        output: {
          failed: report.failed,
          message: `Processed ${report.processed}/${report.total} products`,
          succeeded: report.succeeded,
          success: true,
          total: report.total,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await updateSyncLog(payload, logDocId, {
        completedAt: new Date().toISOString(),
        errors: [{ message, productId: 'global' }],
        status: 'failed',
      })

      return { errorMessage: message, state: 'failed' as const }
    }
  },
  inputSchema: [],
  interfaceName: 'GmcInitialSyncTaskInput',
  outputSchema: [],
  retries: 1,
})

export const buildPullAllTaskConfig = () => ({
  slug: GMC_PULL_ALL_TASK_SLUG,
  handler: async ({ input, req }: { input: PullAllJobInput; req: PayloadRequest }) => {
    const payload = req.payload
    const service = getMerchantServiceInstance(input.merchantId)

    if (!service) {
      await updateSyncLog(payload, input.logDocId, {
        completedAt: new Date().toISOString(),
        errors: [{ message: 'Service not initialized', productId: 'global' }],
        status: 'failed',
      })
      return { errorMessage: 'Service not initialized', state: 'failed' as const }
    }

    const jobId = input.jobId ?? `gmc-pull-${Date.now().toString(36)}`
    const logDocId = input.logDocId ?? await createSyncLog(payload, {
      type: 'pullAll',
      jobId,
      metadata: { trigger: 'payload-jobs', ...input.metadata },
      triggeredBy: input.triggeredBy ?? 'system',
    })

    try {
      const report = await service.pullAllProducts({
        onProgress: async (progressReport) => {
          await updateSyncLog(payload, logDocId, buildPullAllProgressUpdate(progressReport))
        },
        payload,
      })

      await updateSyncLog(payload, logDocId, buildPullAllCompletionUpdate(report))
      void service.cleanupSyncLogs({ payload })

      return {
        output: {
          failed: report.failed,
          matched: report.matched,
          message: `Pulled ${report.succeeded}/${report.total} products`,
          orphaned: report.orphaned,
          success: true,
          total: report.total,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await updateSyncLog(payload, logDocId, {
        completedAt: new Date().toISOString(),
        errors: [{ message, productId: 'global' }],
        status: 'failed',
      })

      return { errorMessage: message, state: 'failed' as const }
    }
  },
  inputSchema: [],
  interfaceName: 'GmcPullAllTaskInput',
  outputSchema: [],
  retries: 1,
})
