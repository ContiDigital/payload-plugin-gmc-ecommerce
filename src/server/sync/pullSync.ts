import type { Payload, Where } from 'payload'

import type {
  MCProductState,
  NormalizedPluginOptions,
  PullAllReport,
  PullResult,
} from '../../types/index.js'
import type { GoogleApiClient } from '../services/sub-services/googleApiClient.js'
import type { RetryService } from '../services/sub-services/retryService.js'

import { MC_FIELD_GROUP_NAME } from '../../constants.js'
import { createPluginLogger } from '../utilities/logger.js'
import { checkPullConflict } from './conflictResolver.js'
import { resolveIdentity } from './identityResolver.js'
import { reverseTransformProduct } from './transformers.js'

// ---------------------------------------------------------------------------
// Pull single product from Merchant Center
// ---------------------------------------------------------------------------

export const pullProduct = async (args: {
  apiClient: GoogleApiClient
  options: NormalizedPluginOptions
  payload: Payload
  productId: string
  retryService: RetryService
}): Promise<PullResult> => {
  const { apiClient, options, payload, productId, retryService } = args
  const log = createPluginLogger(payload.logger, { operation: 'pull', productId })
  const collectionSlug = options.collections.products.slug

  const product = await payload.findByID({
    id: productId,
    collection: collectionSlug,
    depth: 0,
  }) as unknown as Record<string, unknown>

  // Resolve identity to find product in MC
  const identityResult = resolveIdentity(product, options)

  if (!identityResult.ok) {
    return {
      action: 'pull',
      populatedFields: [],
      productId,
      success: false,
    }
  }

  const identity = identityResult.value

  try {
    const response = await retryService.execute(
      () => apiClient.getProduct(identity.productName, payload),
      {
        merchantProductId: identity.merchantProductId,
        operation: 'getProduct (pull)',
        productId,
      },
    )

    const mcProduct = response.data

    // Check conflict strategy before overwriting local data
    const mcState = (product[MC_FIELD_GROUP_NAME] as MCProductState | undefined)
    const conflictResult = checkPullConflict({
      localSyncMeta: mcState?.syncMeta,
      mcLastModified: typeof mcProduct.updateTime === 'string' ? mcProduct.updateTime : undefined,
      strategy: options.sync.conflictStrategy,
    })

    if (conflictResult.action === 'skip') {
      log.info('Pull skipped due to conflict strategy', { reason: conflictResult.reason })
      return {
        action: 'pull',
        populatedFields: [],
        productId,
        success: false,
      }
    }

    const { customAttributes, productAttributes } = reverseTransformProduct(mcProduct)
    const populatedFields = Object.keys(productAttributes)

    await payload.update({
      id: productId,
      collection: collectionSlug as never,
      data: {
        [MC_FIELD_GROUP_NAME]: {
          customAttributes,
          enabled: true,
          identity: {
            contentLanguage: identity.contentLanguage,
            feedLabel: identity.feedLabel,
            offerId: identity.offerId,
          },
          productAttributes,
          snapshot: mcProduct,
          syncMeta: {
            dirty: false,
            lastAction: 'pullSync',
            lastError: undefined,
            lastSyncedAt: new Date().toISOString(),
            state: 'success',
            syncSource: 'pull',
          },
        },
      } as never,
      depth: 0,
    })

    return {
      action: 'pull',
      populatedFields,
      productId,
      success: true,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Pull failed', { error: message })
    return {
      action: 'pull',
      populatedFields: [],
      productId,
      success: false,
    }
  }
}

// ---------------------------------------------------------------------------
// Pull all products from Merchant Center
// ---------------------------------------------------------------------------

export const pullAll = async (args: {
  apiClient: GoogleApiClient
  onProgress?: (report: PullAllReport) => Promise<void> | void
  options: NormalizedPluginOptions
  payload: Payload
  retryService: RetryService
}): Promise<PullAllReport> => {
  const { apiClient, onProgress, options, payload, retryService } = args
  const collectionSlug = options.collections.products.slug
  const identityField = options.collections.products.identityField

  const report: PullAllReport = {
    completedAt: undefined,
    errors: [],
    failed: 0,
    jobId: `gmc-pull-${Date.now().toString(36)}`,
    matched: 0,
    orphaned: 0,
    processed: 0,
    startedAt: new Date().toISOString(),
    status: 'running',
    succeeded: 0,
    total: 0,
  }

  // Throttle progress callbacks — fire at most every 2s
  let lastProgressAt = 0
  const PROGRESS_INTERVAL_MS = 2_000
  const emitProgress = async (force?: boolean) => {
    if (!onProgress) {return}
    const now = Date.now()
    if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) {return}
    lastProgressAt = now
    try {
      await onProgress(report)
    } catch {
      // Swallow progress errors
    }
  }

  try {
    // Paginate through MC products page-by-page to avoid unbounded memory growth
    let pageToken: string | undefined

    do {
      const listResponse = await retryService.execute(
        () => apiClient.listProducts(payload, 250, pageToken),
        { operation: 'listProducts' },
      )

      const products = listResponse.data.products ?? []
      report.total += products.length
      pageToken = listResponse.data.nextPageToken

      // Process each product in this page before fetching the next
      for (const mcProduct of products) {
        report.processed++

        try {
          const offerId = extractOfferId(mcProduct)
          if (!offerId) {
            report.orphaned++
            await emitProgress()
            continue
          }

          // Find matching Payload product by identity field
          const where: Where = {
            [identityField]: { equals: offerId },
          }

          const existing = await payload.find({
            collection: collectionSlug as never,
            depth: 0,
            limit: 1,
            where,
          })

          if (existing.docs.length === 0) {
            report.orphaned++
            await emitProgress()
            continue
          }

          // We have a match — need to GET full product data since list only returns metadata
          const productName = (mcProduct).name as string
          let fullProduct: Record<string, unknown>

          try {
            const fullRes = await retryService.execute(
              () => apiClient.getProduct(productName, payload),
              { operation: 'getProduct (pull-all)', productId: productName },
            )
            fullProduct = fullRes.data
          } catch {
            // If we can't fetch the full product, use what we have from the list
            fullProduct = mcProduct
          }

          const payloadProduct = existing.docs[0] as unknown as Record<string, unknown>

          // Check conflict strategy before overwriting local data
          const localMcState = (payloadProduct[MC_FIELD_GROUP_NAME] as MCProductState | undefined)
          const conflictResult = checkPullConflict({
            localSyncMeta: localMcState?.syncMeta,
            mcLastModified: typeof fullProduct.updateTime === 'string' ? fullProduct.updateTime : undefined,
            strategy: options.sync.conflictStrategy,
          })

          if (conflictResult.action === 'skip') {
            report.matched++
            await emitProgress()
            continue
          }

          const { customAttributes, productAttributes } = reverseTransformProduct(fullProduct)

          await payload.update({
            id: payloadProduct.id as string,
            collection: collectionSlug as never,
            data: {
              [MC_FIELD_GROUP_NAME]: {
                customAttributes,
                enabled: true,
                identity: {
                  contentLanguage: extractContentLanguage(mcProduct),
                  feedLabel: extractFeedLabel(mcProduct),
                  offerId,
                },
                productAttributes,
                snapshot: fullProduct,
                syncMeta: {
                  dirty: false,
                  lastAction: 'pullSync',
                  lastError: undefined,
                  lastSyncedAt: new Date().toISOString(),
                  state: 'success',
                  syncSource: 'pull',
                },
              },
            } as never,
            depth: 0,
          })

          report.matched++
          report.succeeded++
        } catch (error) {
          report.failed++
          report.errors.push({
            message: error instanceof Error ? error.message : String(error),
            productId: typeof mcProduct.name === 'string' ? mcProduct.name : 'unknown',
          })
        }

        await emitProgress()
      }

      await emitProgress(true)
    } while (pageToken)

    report.status = report.failed > 0 && report.succeeded === 0 ? 'failed' : 'completed'
    report.completedAt = new Date().toISOString()
  } catch (error) {
    report.status = 'failed'
    report.completedAt = new Date().toISOString()
    report.errors.push({
      message: error instanceof Error ? error.message : String(error),
      productId: 'global',
    })
  }

  return report
}

// ---------------------------------------------------------------------------
// MC product identity extraction helpers
// ---------------------------------------------------------------------------

const extractOfferId = (mcProduct: Record<string, unknown>): string | undefined => {
  // offerId is a top-level field on Product resources
  if (typeof mcProduct.offerId === 'string') {
    return mcProduct.offerId
  }

  // Also try parsing from the product name: accounts/{id}/products/{lang}~{label}~{offerId}
  const name = mcProduct.name as string | undefined
  if (name) {
    const parts = name.split('/')
    const productId = parts[parts.length - 1]
    const segments = productId?.split('~')
    if (segments && segments.length >= 3) {
      return segments.slice(2).join('~')
    }
  }

  return undefined
}

const extractContentLanguage = (mcProduct: Record<string, unknown>): string => {
  if (typeof mcProduct.contentLanguage === 'string') {
    return mcProduct.contentLanguage
  }
  const name = mcProduct.name as string | undefined
  if (name) {
    const productId = name.split('/').pop()
    return productId?.split('~')[0] ?? 'en'
  }
  return 'en'
}

const extractFeedLabel = (mcProduct: Record<string, unknown>): string => {
  if (typeof mcProduct.feedLabel === 'string') {
    return mcProduct.feedLabel
  }
  const name = mcProduct.name as string | undefined
  if (name) {
    const productId = name.split('/').pop()
    return productId?.split('~')[1] ?? 'US'
  }
  return 'US'
}
