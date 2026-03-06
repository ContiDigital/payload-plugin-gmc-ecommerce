import type { CollectionBeforeChangeHook } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { MC_FIELD_GROUP_NAME } from '../constants.js'
import { getMerchantServiceInstance } from '../plugin/applyEndpointEnhancements.js'
import { applyFieldMappings, deepMerge } from '../server/sync/fieldMapping.js'
import { resolveIdentity } from '../server/sync/identityResolver.js'
import { createPluginLogger } from '../server/utilities/logger.js'

export const createBeforeChangeHook = (
  options: NormalizedPluginOptions,
): CollectionBeforeChangeHook => {
  return ({ data, operation, originalDoc, req }) => {
    const mcState = data[MC_FIELD_GROUP_NAME] as Record<string, unknown> | undefined
    if (!mcState?.enabled) {
      return data
    }

    // 1. Auto-populate offerId from identity field if not set
    const identity = (mcState.identity ?? {}) as Record<string, unknown>
    if (!identity.offerId || (identity.offerId as string).trim().length === 0) {
      const identityFieldValue = data[options.collections.products.identityField]
      if (identityFieldValue) {
        if (!data[MC_FIELD_GROUP_NAME]) {
          data[MC_FIELD_GROUP_NAME] = {}
        }
        const mc = data[MC_FIELD_GROUP_NAME] as Record<string, unknown>
        if (!mc.identity) {
          mc.identity = {}
        }
        ;(mc.identity as Record<string, unknown>).offerId = String(identityFieldValue)
      }
    }

    // 2. Apply permanent field mappings
    const permanentMappings = options.collections.products.fieldMappings.filter(
      (m) => m.syncMode === 'permanent',
    )

    if (permanentMappings.length > 0 && options.sync.permanentSync) {
      const mappedValues = applyFieldMappings(data, permanentMappings, 'permanent', { siteUrl: options.siteUrl })
      const currentAttrs = (mcState.productAttributes ?? {}) as Record<string, unknown>
      const mappedAttrs = (mappedValues.productAttributes ?? mappedValues) as Record<string, unknown>

      const mc = data[MC_FIELD_GROUP_NAME] as Record<string, unknown>
      mc.productAttributes = deepMerge(currentAttrs, mappedAttrs)

      // Mark product as dirty so delta sync knows it needs re-syncing
      if (!mc.syncMeta) {
        mc.syncMeta = {}
      }
      ;(mc.syncMeta as Record<string, unknown>).dirty = true
    }

    // 3. If sync mode is 'onChange', trigger push after this save completes
    if (options.sync.mode === 'onChange' && operation === 'update') {
      const service = getMerchantServiceInstance(options.merchantId)
      if (service) {
        const doc = { ...originalDoc, ...data }
        const identityResult = resolveIdentity(doc as Record<string, unknown>, options)

        if (identityResult.ok) {
          // Fire-and-forget: queue push after save completes
          // We don't await this — the save should not be blocked by the sync
          const productId = (originalDoc as Record<string, unknown>)?.id as string
          if (productId) {
            const log = createPluginLogger(req.payload?.logger, { operation: 'onChange', productId })
            const payloadInstance = req.payload
            setImmediate(() => {
              service
                .pushProduct({ payload: payloadInstance, productId })
                .catch((err) => {
                  log.error('onChange sync failed', {
                    error: err instanceof Error ? err.message : String(err),
                  })
                })
            })
          }
        }
      }
    }

    return data
  }
}
