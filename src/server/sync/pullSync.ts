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
import { asProductDoc , asRecord } from '../utilities/recordUtils.js'
import { checkPullConflict, extractMCProductLastModified } from './conflictResolver.js'
import { deepMerge } from './fieldMapping.js'
import { resolveIdentity } from './identityResolver.js'
import { STATE_NOT_PERSISTED_WARNING, writeMCState } from './mcStateWriter.js'
import { productAttributesContainRemoteSubset, reverseTransformProduct } from './transformers.js'

// ---------------------------------------------------------------------------
// Pull single product from Merchant Center
// ---------------------------------------------------------------------------

export const PULL_RACED_A_SAVE_WARNING =
  'The product changed while it was being pulled from Merchant Center, so it stays queued for another sync.'

/**
 * The sync-metadata a pull should write, decided against the row as it stands
 * at write time rather than the document the pull started from.
 *
 * A pull cannot declare a product clean if it was saved after the pull read it:
 * the remote data now landing was reconciled against older content. Clearing
 * `syncToken` for the same reason stops a push that is still in flight from
 * certifying content this pull has just overwritten.
 */
const pullSyncMeta = (
  row: Record<string, unknown>,
  observedDirty: boolean | undefined,
): { racedASave: boolean; syncMeta: Record<string, unknown> } => {
  const liveSyncMeta = asRecord(asRecord(row[MC_FIELD_GROUP_NAME]).syncMeta)
  const racedASave = liveSyncMeta.dirty === true && observedDirty !== true

  return {
    racedASave,
    syncMeta: {
      dirty: racedASave,
      lastAction: 'pullSync',
      lastError: null,
      lastSyncedAt: new Date().toISOString(),
      state: 'success',
      syncSource: 'pull',
      syncToken: null,
    },
  }
}

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
    const populatedFields = Object.keys(productAttributes)

    let racedASave = false

    const statePersisted = await writeMCState(payload, collectionSlug, productId, (row) => {
      const meta = pullSyncMeta(row, mcState?.syncMeta?.dirty)
      racedASave = meta.racedASave

      // Remote data is merged onto the attributes as they stand now, not the
      // ones read before the Merchant Center round-trip: an edit made during
      // the fetch keeps whatever the remote does not itself set.
      const liveAttributes = asRecord(
        asRecord(row[MC_FIELD_GROUP_NAME])[MC_PRODUCT_ATTRIBUTES_FIELD_NAME],
      )

      return {
        [MC_FIELD_GROUP_NAME]: {
          customAttributes,
          enabled: true,
          identity: {
            contentLanguage: identity.contentLanguage,
            feedLabel: identity.feedLabel,
            offerId: identity.offerId,
          },
          [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: deepMerge(liveAttributes, productAttributes),
          snapshot: mcProduct,
          syncMeta: meta.syncMeta,
        },
      }
    })

    if (!statePersisted) {
      return {
        action: 'pull',
        populatedFields: [],
        productId,
        success: false,
        warning: STATE_NOT_PERSISTED_WARNING,
      }
    }

    return {
      action: 'pull',
      populatedFields,
      productId,
      success: true,
      ...(racedASave ? { warning: PULL_RACED_A_SAVE_WARNING } : {}),
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

          const statePersisted = await writeMCState(
            payload,
            collectionSlug,
            typeof payloadProduct.id === 'string' ? payloadProduct.id : String(payloadProduct.id),
            (row) => ({
              [MC_FIELD_GROUP_NAME]: {
                customAttributes,
                enabled: true,
                identity: {
                  contentLanguage: extractContentLanguage(mcProduct),
                  feedLabel: extractFeedLabel(mcProduct),
                  offerId,
                },
                [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: deepMerge(
                  asRecord(asRecord(row[MC_FIELD_GROUP_NAME])[MC_PRODUCT_ATTRIBUTES_FIELD_NAME]),
                  productAttributes,
                ),
                snapshot: fullProduct,
                syncMeta: pullSyncMeta(row, localMcState?.syncMeta?.dirty).syncMeta,
              },
            }),
          )

          report.matched++

          if (statePersisted) {
            report.succeeded++
          } else {
            report.failed++
            report.errors.push({ message: STATE_NOT_PERSISTED_WARNING, productId: offerId })
          }
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
