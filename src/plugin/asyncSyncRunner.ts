import type { Payload } from 'payload'

import type { BatchSyncReport, JobStatus, JobType } from '../types/index.js'

import {
  buildCompletionUpdate,
  buildProgressUpdate,
  createSyncLog,
  logAsyncOperationFailure,
  type SyncLogUpdateArgs,
  updateSyncLog,
} from './syncLogs.js'

type TrackedOperationReport = {
  completedAt?: string
  errors: BatchSyncReport['errors']
  failed: number
  processed: number
  status: JobStatus
  succeeded: number
  total: number
}

type StartTrackedOperationArgs<TReport extends TrackedOperationReport> = {
  cleanup?: () => Promise<void> | void
  jobId: string
  logMetadata?: Record<string, unknown>
  logOperation: string
  payload: Payload
  run: (onProgress: (report: TReport) => Promise<void>) => Promise<TReport>
  toCompletionUpdate?: (report: TReport) => SyncLogUpdateArgs
  toProgressUpdate?: (report: TReport) => SyncLogUpdateArgs
  triggeredBy: string
  type: JobType
}

const buildFailureUpdate = (error: unknown): SyncLogUpdateArgs => ({
  completedAt: new Date().toISOString(),
  errors: [{
    message: error instanceof Error ? error.message : String(error),
    productId: 'global',
  }],
  status: 'failed',
})

export const startTrackedOperation = async <TReport extends TrackedOperationReport>(
  args: StartTrackedOperationArgs<TReport>,
): Promise<{ jobId: string; status: 'running' }> => {
  const {
    type,
    cleanup,
    jobId,
    logMetadata,
    logOperation,
    payload,
    run,
    toCompletionUpdate = buildCompletionUpdate,
    toProgressUpdate = buildProgressUpdate,
    triggeredBy,
  } = args

  const logDocId = await createSyncLog(payload, {
    type,
    jobId,
    metadata: logMetadata,
    triggeredBy,
  })

  const runCleanup = async (): Promise<void> => {
    if (!cleanup) {
      return
    }

    try {
      await cleanup()
    } catch (error) {
      logAsyncOperationFailure(payload, `${logOperation}:cleanup`, error)
    }
  }

  void (async () => {
    try {
      const report = await run(async (progressReport) => {
        await updateSyncLog(payload, logDocId, toProgressUpdate(progressReport))
      })

      await updateSyncLog(payload, logDocId, toCompletionUpdate(report))
    } catch (error) {
      logAsyncOperationFailure(payload, logOperation, error)
      await updateSyncLog(payload, logDocId, buildFailureUpdate(error))
    } finally {
      await runCleanup()
    }
  })()

  return { jobId, status: 'running' }
}
