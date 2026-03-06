import type { Config, Payload, Where } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { createPluginLogger } from '../server/utilities/logger.js'
import { getMerchantServiceInstance } from './applyEndpointEnhancements.js'

const GMC_SYNC_TASK_SLUG = 'gmcSyncDirty'

/**
 * Registers a Payload Jobs task and optional cron autoRun for scheduled sync.
 *
 * When `sync.schedule.strategy` is `'payload-jobs'`, this:
 * 1. Adds a `gmcSyncDirty` task that pushes all dirty products to MC
 * 2. Configures `autoRun` with the user's cron expression
 *
 * When strategy is `'external'`, this only registers the task (no autoRun).
 * The cron endpoint in applyEndpointEnhancements handles external triggers.
 */
export const applyScheduledSync = (
  config: Config,
  options: NormalizedPluginOptions,
): Config => {
  // Only apply when sync mode is 'scheduled'
  if (options.sync.mode !== 'scheduled') {
    return config
  }

  if (!config.jobs) {
    config.jobs = { tasks: [] }
  }

  if (!config.jobs.tasks) {
    config.jobs.tasks = []
  }

  const jobs = config.jobs

  // Register the GMC sync task
  const taskConfig = {
    slug: GMC_SYNC_TASK_SLUG,
    handler: async ({ req }: { req: { payload: Payload } }) => {
      const payload = req.payload
      const log = createPluginLogger(payload.logger, { operation: 'scheduledSync' })
      const service = getMerchantServiceInstance(options.merchantId)

      if (!service) {
        log.warn('Scheduled sync skipped — service not initialized yet')
        return { output: { message: 'Service not initialized', success: false } }
      }

      log.info('Scheduled sync starting — pushing dirty products')

      const jobId = `gmc-cron-job-${Date.now().toString(36)}`

      // Create sync log entry
      let logDocId: number | string | undefined
      try {
        const logDoc = await payload.create({
          collection: 'gmc-sync-log' as never,
          data: {
            type: 'batch',
            failed: 0,
            jobId,
            metadata: { trigger: 'payload-jobs' },
            processed: 0,
            startedAt: new Date().toISOString(),
            status: 'running',
            succeeded: 0,
            total: 0,
            triggeredBy: 'cron',
          } as never,
          overrideAccess: true,
        })
        logDocId = (logDoc as unknown as Record<string, unknown>).id as string
      } catch {
        // Non-critical
      }

      try {
        const report = await service.pushBatch({
          filter: { 'merchantCenter.syncMeta.dirty': { equals: true } } as Where,
          payload,
        })

        if (logDocId) {
          try {
            await payload.update({
              id: logDocId,
              collection: 'gmc-sync-log' as never,
              data: {
                completedAt: report.completedAt,
                errors: report.errors.slice(-50),
                failed: report.failed,
                processed: report.processed,
                status: report.status,
                succeeded: report.succeeded,
                total: report.total,
              } as never,
              overrideAccess: true,
            })
          } catch { /* non-critical */ }
        }

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

        if (logDocId) {
          try {
            await payload.update({
              id: logDocId,
              collection: 'gmc-sync-log' as never,
              data: {
                completedAt: new Date().toISOString(),
                errors: [{ message, productId: 'global' }],
                status: 'failed',
              } as never,
              overrideAccess: true,
            })
          } catch { /* non-critical */ }
        }

        return { output: { message, success: false } }
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
  }

  jobs.tasks.push(taskConfig as never)

  // When strategy is 'payload-jobs', add autoRun with the cron schedule
  if (options.sync.schedule.strategy === 'payload-jobs') {
    if (!jobs.autoRun) {
      jobs.autoRun = []
    }

    if (Array.isArray(jobs.autoRun)) {
      jobs.autoRun.push({
        cron: options.sync.schedule.cron,
        limit: 1,
        task: GMC_SYNC_TASK_SLUG,
      } as never)
    }
  }

  return config
}
