import type { CollectionAfterDeleteHook } from 'payload'

import type { NormalizedPluginOptions, PayloadProductDoc } from '../types/index.js'

import { GMC_SYNC_LOG_SLUG, MC_FIELD_GROUP_NAME } from '../constants.js'
import { queueProductDeleteJob } from '../plugin/jobTasks.js'
import { getMerchantServiceInstance } from '../plugin/serviceRegistry.js'
import { resolveIdentity } from '../server/sync/identityResolver.js'

export const createAfterDeleteHook = (
  options: NormalizedPluginOptions,
): CollectionAfterDeleteHook => {
  return async ({ doc, req }) => {
    const product = doc as PayloadProductDoc
    const mcState = product[MC_FIELD_GROUP_NAME]

    if (!mcState?.enabled) {
      return
    }

    // Resolve identity from the deleted doc — we cannot re-fetch it
    const identityResult = resolveIdentity(product, options)
    if (!identityResult.ok) {
      return
    }

    const productId = typeof product.id === 'string' ? product.id : String(product.id)
    const identity = identityResult.value
    const payloadInstance = req.payload

    if (options.sync.schedule.strategy === 'payload-jobs') {
      await queueProductDeleteJob({
        identity,
        merchantId: options.merchantId,
        payload: payloadInstance,
        productId,
        req,
      })
      return
    }

    const service = getMerchantServiceInstance(options.merchantId)
    if (!service) {
      return
    }

    // Fire-and-forget: attempt to delete from MC using pre-resolved identity
    service
      .deleteProductByIdentity({ identity, payload: payloadInstance, productId })
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err)
        payloadInstance?.logger?.error(
          `[GMC Plugin] Failed to delete product ${productId} from Merchant Center after deletion`,
          err,
        )

        // Record failure in sync log so it is visible in the admin UI
        try {
          await payloadInstance.create({
            collection: GMC_SYNC_LOG_SLUG as never,
            data: {
              type: 'push',
              completedAt: new Date().toISOString(),
              errors: [{ message, productId }],
              failed: 1,
              jobId: `gmc-delete-${productId}-${Date.now().toString(36)}`,
              processed: 1,
              startedAt: new Date().toISOString(),
              status: 'failed',
              succeeded: 0,
              total: 1,
              triggeredBy: 'afterDelete-hook',
            } as never,
            overrideAccess: true,
          })
        } catch {
          // Best-effort — don't let sync log failure mask the original error
        }
      })
  }
}
