import type { CollectionSlug, Payload } from 'payload'

import type { BatchSyncReport, JobStatus, JobType } from '../types/index.js'

import { GMC_SYNC_LOG_SLUG } from '../constants.js'
import { createPluginLogger } from '../server/utilities/logger.js'
import { getRecordID } from '../server/utilities/recordUtils.js'

type SyncLogErrors = BatchSyncReport['errors']

type SyncLogCreateArgs = {
  errors?: SyncLogErrors
  failed?: number
  jobId: string
  metadata?: Record<string, unknown>
  processed?: number
  startedAt?: string
  status?: JobStatus
  succeeded?: number
  total?: number
  triggeredBy?: string
  type: JobType
}

type SyncLogProgressReport = {
  errors: SyncLogErrors
  failed: number
  processed: number
  succeeded: number
  total: number
}

type SyncLogCompletionReport = {
  completedAt?: string
  status: JobStatus
} & SyncLogProgressReport

export type SyncLogUpdateArgs = {
  completedAt?: string
  errors?: SyncLogErrors
  failed?: number
  metadata?: Record<string, unknown>
  processed?: number
  status?: JobStatus
  succeeded?: number
  total?: number
}

const SYNC_LOG_COLLECTION = GMC_SYNC_LOG_SLUG as CollectionSlug

export const createSyncLog = async (
  payload: Payload,
  data: SyncLogCreateArgs,
): Promise<number | string | undefined> => {
  try {
    const logDoc = await payload.create({
      collection: SYNC_LOG_COLLECTION,
      data: {
        type: data.type,
        errors: data.errors ?? [],
        failed: data.failed ?? 0,
        jobId: data.jobId,
        metadata: data.metadata,
        processed: data.processed ?? 0,
        startedAt: data.startedAt ?? new Date().toISOString(),
        status: data.status ?? 'running',
        succeeded: data.succeeded ?? 0,
        total: data.total ?? 0,
        triggeredBy: data.triggeredBy,
      },
      overrideAccess: true,
    })

    return getRecordID(logDoc)
  } catch {
    return undefined
  }
}

export const updateSyncLog = async (
  payload: Payload,
  id: number | string | undefined,
  data: SyncLogUpdateArgs,
): Promise<void> => {
  if (!id) {
    return
  }

  try {
    await payload.update({
      id,
      collection: SYNC_LOG_COLLECTION,
      data,
      overrideAccess: true,
    })
  } catch {
    // Best-effort only
  }
}

export const logAsyncOperationFailure = (
  payload: Payload,
  operation: string,
  error: unknown,
): void => {
  const log = createPluginLogger(payload.logger, { operation })
  log.error('Async batch operation failed', {
    error: error instanceof Error ? error.message : String(error),
  })
}

export const buildProgressUpdate = <TReport extends SyncLogProgressReport>(
  report: TReport,
): SyncLogUpdateArgs => ({
  errors: report.errors.slice(-20),
  failed: report.failed,
  processed: report.processed,
  succeeded: report.succeeded,
  total: report.total,
})

export const buildCompletionUpdate = <TReport extends SyncLogCompletionReport>(
  report: TReport,
): SyncLogUpdateArgs => ({
  completedAt: report.completedAt,
  errors: report.errors.slice(-50),
  failed: report.failed,
  processed: report.processed,
  status: report.status,
  succeeded: report.succeeded,
  total: report.total,
})
