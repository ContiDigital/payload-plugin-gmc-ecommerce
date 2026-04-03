import type { Payload } from 'payload'

import type {
  LocalInventoryAvailability,
  LocalInventorySyncResult,
  MCPrice,
  NormalizedPluginOptions,
  ResolvedMCIdentity,
} from '../../types/index.js'
import type { GoogleApiClient } from '../services/sub-services/googleApiClient.js'
import type { RetryService } from '../services/sub-services/retryService.js'

import { GoogleApiError } from '../services/sub-services/googleApiClient.js'
import { createPluginLogger } from '../utilities/logger.js'

// ---------------------------------------------------------------------------
// Resolve local availability from a product document
// ---------------------------------------------------------------------------

export const resolveLocalAvailability = (
  product: Record<string, unknown>,
  options: NormalizedPluginOptions,
): LocalInventoryAvailability | null => {
  const { localInventory } = options

  // Custom resolver takes priority
  if (localInventory.availabilityResolver) {
    return localInventory.availabilityResolver(product)
  }

  // Default: check productAttributes.availability from the prepared MC input
  // This is called AFTER beforePush, so availability is already resolved
  const mcState = product.mc as Record<string, unknown> | undefined
  const attrs = mcState?.attrs as Record<string, unknown> | undefined
  const availability = attrs?.availability as string | undefined

  if (availability === 'IN_STOCK') {
    return 'in_stock'
  }

  return null
}

// ---------------------------------------------------------------------------
// Sync local inventory for a single product after push
// ---------------------------------------------------------------------------

export const syncLocalInventory = async (args: {
  apiClient: GoogleApiClient
  identity: ResolvedMCIdentity
  localAvailability: LocalInventoryAvailability | null
  options: NormalizedPluginOptions
  payload: Payload
  price?: MCPrice
  productId: string
  retryService: RetryService
}): Promise<LocalInventorySyncResult> => {
  const { apiClient, identity, localAvailability, options, payload, price, productId, retryService } = args
  const { localInventory } = options
  const log = createPluginLogger(payload.logger, { operation: 'localInventory', productId })

  if (!localInventory.enabled || !localInventory.storeCode) {
    return { action: 'insert', error: 'Local inventory not configured', productId, storeCode: '', success: false }
  }

  const storeCode = localInventory.storeCode

  try {
    if (localAvailability === 'in_stock') {
      // Build localInventoryAttributes (v1 API nests fields under this wrapper)
      const inventoryAttributes: Record<string, unknown> = {
        availability: 'IN_STOCK',
      }

      if (price) {
        inventoryAttributes.price = price
      }

      // Add pickup SLA if configured (pickupMethod is optional as of Sep 2024)
      if (localInventory.pickup?.sla) {
        inventoryAttributes.pickupSla = localInventory.pickup.sla
      }

      // v1 API requires storeCode at top level, all other fields under localInventoryAttributes
      const localInventoryInput: Record<string, unknown> = {
        localInventoryAttributes: inventoryAttributes,
        storeCode,
      }

      await retryService.execute(
        () => apiClient.insertLocalInventory(identity.productName, localInventoryInput, payload),
        {
          merchantProductId: identity.merchantProductId,
          operation: 'insertLocalInventory',
          productId,
        },
      )

      log.debug('Local inventory inserted', { storeCode })
      return { action: 'insert', productId, storeCode, success: true }
    } else {
      // Product is not in-stock — remove local inventory entry
      await retryService.execute(
        () => apiClient.deleteLocalInventory(identity.productName, storeCode, payload),
        {
          merchantProductId: identity.merchantProductId,
          operation: 'deleteLocalInventory',
          productId,
        },
      )

      log.debug('Local inventory deleted', { storeCode })
      return { action: 'delete', productId, storeCode, success: true }
    }
  } catch (error) {
    // 404 on delete means it was already gone — treat as success
    if (error instanceof GoogleApiError && error.statusCode === 404) {
      log.debug('Local inventory already absent (404)', { storeCode })
      return { action: 'delete', productId, storeCode, success: true }
    }

    const message = error instanceof Error ? error.message : String(error)
    log.warn('Local inventory sync failed (non-critical)', { error: message, storeCode })
    return {
      action: localAvailability === 'in_stock' ? 'insert' : 'delete',
      error: message,
      productId,
      storeCode,
      success: false,
    }
  }
}

// ---------------------------------------------------------------------------
// Batch reconciliation — ensure all in-stock products have local inventory
// ---------------------------------------------------------------------------

export const reconcileLocalInventory = async (args: {
  apiClient: GoogleApiClient
  onProgress?: (report: { deleted: number; errors: number; inserted: number; processed: number; total: number }) => void
  options: NormalizedPluginOptions
  payload: Payload
  retryService: RetryService
}): Promise<{ deleted: number; errors: number; inserted: number; processed: number; total: number }> => {
  const { apiClient, onProgress, options, payload, retryService } = args
  const log = createPluginLogger(payload.logger, { operation: 'reconcileLocalInventory' })
  const collectionSlug = options.collections.products.slug

  if (!options.localInventory.enabled) {
    return { deleted: 0, errors: 0, inserted: 0, processed: 0, total: 0 }
  }

  const report = { deleted: 0, errors: 0, inserted: 0, processed: 0, total: 0 }
  let page = 1
  let hasMore = true

  while (hasMore) {
    const result = await payload.find({
      collection: collectionSlug,
      depth: 0,
      limit: 100,
      page,
      where: {
        'mc.enabled': { equals: true },
      },
    })

    report.total = result.totalDocs

    for (const doc of result.docs) {
      const product = doc as unknown as Record<string, unknown>
      const mcState = product.mc as Record<string, unknown> | undefined
      const identity = mcState?.identity as Record<string, unknown> | undefined
      const attrs = mcState?.attrs as Record<string, unknown> | undefined

      if (!identity?.offerId || !attrs) {
        report.processed++
        continue
      }

      // Determine local availability
      let localAvailability: LocalInventoryAvailability | null = null
      if (options.localInventory.availabilityResolver) {
        localAvailability = options.localInventory.availabilityResolver(product)
      } else {
        localAvailability = attrs.availability === 'IN_STOCK' ? 'in_stock' : null
      }

      // Build the resolved identity
      const resolvedIdentity: ResolvedMCIdentity = {
        contentLanguage: String(identity.contentLanguage || options.defaults.contentLanguage),
        dataSourceName: options.dataSourceName,
        feedLabel: String(identity.feedLabel || options.defaults.feedLabel),
        merchantProductId: `${identity.contentLanguage || options.defaults.contentLanguage}~${identity.feedLabel || options.defaults.feedLabel}~${identity.offerId}`,
        offerId: String(identity.offerId),
        productInputName: `accounts/${options.merchantId}/productInputs/${identity.contentLanguage || options.defaults.contentLanguage}~${identity.feedLabel || options.defaults.feedLabel}~${identity.offerId}`,
        productName: `accounts/${options.merchantId}/products/${identity.contentLanguage || options.defaults.contentLanguage}~${identity.feedLabel || options.defaults.feedLabel}~${identity.offerId}`,
      }

      const price = attrs.price as MCPrice | undefined

      const syncResult = await syncLocalInventory({
        apiClient,
        identity: resolvedIdentity,
        localAvailability,
        options,
        payload,
        price,
        productId: String(product.id),
        retryService,
      })

      if (syncResult.success) {
        if (syncResult.action === 'insert') report.inserted++
        else report.deleted++
      } else {
        report.errors++
      }

      report.processed++

      if (onProgress && report.processed % 25 === 0) {
        onProgress(report)
      }
    }

    hasMore = result.hasNextPage
    page++
  }

  log.debug('Local inventory reconciliation complete', report)
  return report
}
