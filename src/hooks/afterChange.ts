import type { CollectionAfterChangeHook, Payload } from 'payload'

import type { MCSyncMeta, NormalizedPluginOptions, PayloadProductDoc } from '../types/index.js'

import { GMC_SYNC_LOG_SLUG, MC_FIELD_GROUP_NAME } from '../constants.js'
import { queueProductPushJob } from '../plugin/jobTasks.js'
import { getMerchantServiceInstance } from '../plugin/serviceRegistry.js'
import { shouldSkipSyncHooks } from '../server/sync/hookContext.js'
import { createPluginLogger } from '../server/utilities/logger.js'

export const createAfterChangeHook = (
  options: NormalizedPluginOptions,
): CollectionAfterChangeHook => {
  return async ({ context, doc, operation, req }) => {
    if (shouldSkipSyncHooks(context) || options.sync.mode !== 'onChange') {
      return doc
    }

    const product = doc as PayloadProductDoc
    const mcState = product[MC_FIELD_GROUP_NAME]
    const syncMeta: MCSyncMeta | undefined = mcState?.syncMeta
    if (!mcState?.enabled || syncMeta?.dirty !== true) {
      return doc
    }

    const productId = typeof product.id === 'string' ? product.id : String(product.id)
    if (!productId) {
      return doc
    }

    const log = createPluginLogger(req.payload?.logger, {
      operation: operation === 'create' ? 'onChange:create' : 'onChange:update',
      productId,
    })

    if (options.sync.schedule.strategy === 'payload-jobs') {
      try {
        await queueProductPushJob({
          merchantId: options.merchantId,
          payload: req.payload,
          productId,
          req,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('Failed to queue onChange sync job', { error: message })
        void createSyncLogEntry(req.payload, productId, message, 'onChange:queue')
      }

      return doc
    }

    const service = getMerchantServiceInstance(options.merchantId)
    if (!service) {
      return doc
    }

    const payloadInstance = req.payload
    setImmediate(() => {
      service.pushProduct({ payload: payloadInstance, productId }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        log.error('onChange sync failed', { error: message })
        void createSyncLogEntry(payloadInstance, productId, message, 'onChange:push')
      })
    })

    return doc
  }
}

// ---------------------------------------------------------------------------
// Sync log helper — fire-and-forget, mirrors afterDelete pattern
// ---------------------------------------------------------------------------

const createSyncLogEntry = async (
  payload: Payload,
  productId: string,
  errorMessage: string,
  triggeredBy: string,
): Promise<void> => {
  try {
    await payload.create({
      collection: GMC_SYNC_LOG_SLUG as never,
      data: {
        type: 'push',
        completedAt: new Date().toISOString(),
        errors: [{ message: errorMessage, productId }],
        failed: 1,
        jobId: `gmc-onchange-${productId}-${Date.now().toString(36)}`,
        processed: 1,
        startedAt: new Date().toISOString(),
        status: 'failed',
        succeeded: 0,
        total: 1,
        triggeredBy,
      } as never,
      overrideAccess: true,
    })
  } catch {
    // Best-effort — don't let sync log failure mask the original error
  }
}
