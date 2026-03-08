import type { Payload, Where } from 'payload'

import type {
  NormalizedPluginOptions,
  PullAllReport,
  PullResult,
} from '../../types/index.js'
import type { GoogleApiClient } from '../services/sub-services/googleApiClient.js'
import type { RetryService } from '../services/sub-services/retryService.js'

import {
  MC_FIELD_GROUP_NAME,
  MC_IDENTITY_OFFER_ID_PATH,
  MC_PRODUCT_ATTRIBUTES_FIELD_NAME,
} from '../../constants.js'
import { createPluginLogger } from '../utilities/logger.js'
import { asProductDoc } from '../utilities/recordUtils.js'
import { checkPullConflict, extractMCProductLastModified } from './conflictResolver.js'
import { deepMerge } from './fieldMapping.js'
import { buildInternalSyncContext } from './hookContext.js'
import { resolveIdentity } from './identityResolver.js'
import { productAttributesContainRemoteSubset, reverseTransformProduct } from './transformers.js'

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
  }).then(asProductDoc)

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
    const reverseTransformed = reverseTransformProduct(mcProduct)
    const localAttrs =
      product[MC_FIELD_GROUP_NAME]?.[MC_PRODUCT_ATTRIBUTES_FIELD_NAME] as Record<string, unknown> | undefined
    const remoteMatchesLocal = productAttributesContainRemoteSubset(
      localAttrs,
      reverseTransformed.productAttributes,
    )

    // Check conflict strategy before overwriting local data
    const mcState = product[MC_FIELD_GROUP_NAME]
    const conflictResult = checkPullConflict({
      localSyncMeta: mcState?.syncMeta,
      mcLastModified: extractMCProductLastModified(mcProduct),
      remoteMatchesLocal,
      strategy: options.sync.conflictStrategy,
    })

    if (conflictResult.action === 'skip') {
      log.info('Pull skipped due to conflict strategy', { reason: conflictResult.reason })
      return {
        action: 'pull',
        populatedFields: [],
        productId,
        skipped: true,
        success: true,
        warning: conflictResult.reason,
      }
    }

    const { customAttributes, productAttributes } = reverseTransformed
    const mergedProductAttributes = deepMerge(localAttrs ?? {}, productAttributes)
    const populatedFields = Object.keys(productAttributes)

    await payload.update({
      id: productId,
      collection: collectionSlug as never,
      context: buildInternalSyncContext(),
      data: {
        [MC_FIELD_GROUP_NAME]: {
          customAttributes,
          enabled: true,
          identity: {
            contentLanguage: identity.contentLanguage,
            feedLabel: identity.feedLabel,
            offerId: identity.offerId,
          },
          [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: mergedProductAttributes,
          snapshot: mcProduct,
          syncMeta: {
            dirty: false,
            lastAction: 'pullSync',
            lastError: null,
            lastSyncedAt: new Date().toISOString(),
            state: 'success',
            syncSource: 'pull',
          },
        },
      } as never,
      depth: 0,
      overrideAccess: true,
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

          const existing = await findMatchingPayloadProduct({
            collectionSlug,
            contentLanguage: extractContentLanguage(mcProduct),
            feedLabel: extractFeedLabel(mcProduct),
            identityField,
            offerId,
            payload,
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

          const payloadProduct = asProductDoc(existing.docs[0])

          // Check conflict strategy before overwriting local data
          const localMcState = payloadProduct[MC_FIELD_GROUP_NAME]
          const conflictResult = checkPullConflict({
            localSyncMeta: localMcState?.syncMeta,
            mcLastModified: extractMCProductLastModified(fullProduct),
            strategy: options.sync.conflictStrategy,
          })

          if (conflictResult.action === 'skip') {
            report.matched++
            await emitProgress()
            continue
          }

          const { customAttributes, productAttributes } = reverseTransformProduct(fullProduct)

          await payload.update({
            id: typeof payloadProduct.id === 'string' ? payloadProduct.id : String(payloadProduct.id),
            collection: collectionSlug as never,
            context: buildInternalSyncContext(),
            data: {
              [MC_FIELD_GROUP_NAME]: {
                customAttributes,
                enabled: true,
                identity: {
                  contentLanguage: extractContentLanguage(mcProduct),
                  feedLabel: extractFeedLabel(mcProduct),
                  offerId,
                },
                [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: productAttributes,
                snapshot: fullProduct,
                syncMeta: {
                  dirty: false,
                  lastAction: 'pullSync',
                  lastError: null,
                  lastSyncedAt: new Date().toISOString(),
                  state: 'success',
                  syncSource: 'pull',
                },
              },
            } as never,
            depth: 0,
            overrideAccess: true,
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
    return productId?.split('~')[1] ?? 'PRODUCTS'
  }
  return 'PRODUCTS'
}

const findMatchingPayloadProduct = async (args: {
  collectionSlug: string
  contentLanguage: string
  feedLabel: string
  identityField: string
  offerId: string
  payload: Payload
}) => {
  const { collectionSlug, contentLanguage, feedLabel, identityField, offerId, payload } = args

  const byOverrideOfferId = await payload.find({
    collection: collectionSlug as never,
    depth: 0,
    limit: 10,
    where: {
      [MC_IDENTITY_OFFER_ID_PATH]: { equals: offerId },
    },
  })

  if (byOverrideOfferId.docs.length > 0) {
    const exactMatch = byOverrideOfferId.docs.find((doc) => {
      const payloadProduct = asProductDoc(doc)
      const identity = payloadProduct[MC_FIELD_GROUP_NAME]?.identity

      return (
        identity?.contentLanguage === contentLanguage &&
        identity?.feedLabel === feedLabel
      )
    })

    // Only use the override match if feedLabel + contentLanguage match exactly.
    // A mismatched override means a different feed/language product shares
    // the same offerId — fall through to identity-field lookup instead.
    if (exactMatch) {
      return {
        ...byOverrideOfferId,
        docs: [exactMatch],
      }
    }
  }

  const fallbackWhere: Where = {
    [identityField]: { equals: offerId },
  }

  return payload.find({
    collection: collectionSlug as never,
    depth: 0,
    limit: 1,
    where: fallbackWhere,
  })
}
