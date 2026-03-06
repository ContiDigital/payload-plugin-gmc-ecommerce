import type { CollectionAfterDeleteHook } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { GMC_SYNC_LOG_SLUG, MC_FIELD_GROUP_NAME } from '../constants.js'
import { getMerchantServiceInstance } from '../plugin/applyEndpointEnhancements.js'

export const createAfterDeleteHook = (
  options: NormalizedPluginOptions,
): CollectionAfterDeleteHook => {
  return ({ doc, req }) => {
    const mcState = (doc as Record<string, unknown>)[MC_FIELD_GROUP_NAME] as
      | Record<string, unknown>
      | undefined

    if (!mcState?.enabled) {
      return
    }

    const identity = mcState.identity as Record<string, unknown> | undefined
    if (!identity?.offerId) {
      return
    }

    const service = getMerchantServiceInstance(options.merchantId)
    if (!service) {
      return
    }

    const productId = (doc as Record<string, unknown>).id as string
    const payloadInstance = req.payload

    // Fire-and-forget: attempt to delete from MC
    service
      .deleteProduct({ payload: payloadInstance, productId })
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
