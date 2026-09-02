import type { Payload } from 'payload'

import type {
  InitialSyncReport,
  NormalizedPluginOptions,
  PayloadProductDoc,
} from '../../types/index.js'
import type { GoogleApiClient } from '../services/sub-services/googleApiClient.js'
import type { RateLimiterService } from '../services/sub-services/rateLimiterService.js'
import type { RetryService } from '../services/sub-services/retryService.js'

import { MC_FIELD_GROUP_NAME, MC_PRODUCT_ATTRIBUTES_FIELD_NAME } from '../../constants.js'
import { GoogleApiError } from '../services/sub-services/googleApiClient.js'
import { asProductDoc, asRecord } from '../utilities/recordUtils.js'
import { resolveIdentity } from './identityResolver.js'
import { STATE_NOT_PERSISTED_WARNING, writeMCState } from './mcStateWriter.js'
import { prepareProductForSync, validateRequiredProductInput } from './productPreparation.js'

type InitialSyncOptions = {
  batchSize: number
  dryRun: boolean
  limit?: number
  onlyIfRemoteMissing: boolean
}

type ProductSyncOutcome = {
  error?: { message: string; offerId?: string; productId: string }
  result: 'existingRemote' | 'failed' | 'skipped' | 'succeeded'
}

export const runInitialSync = async (args: {
  apiClient: GoogleApiClient
  onProgress?: (report: InitialSyncReport) => Promise<void> | void
  options: NormalizedPluginOptions
  overrides?: Partial<InitialSyncOptions>
  payload: Payload
  rateLimiter: RateLimiterService
  retryService: RetryService
}): Promise<InitialSyncReport> => {
  const { apiClient, onProgress, options, overrides, payload, rateLimiter, retryService } = args
  const collectionSlug = options.collections.products.slug

  const syncOptions: InitialSyncOptions = {
    batchSize: overrides?.batchSize ?? options.sync.initialSync.batchSize,
    dryRun: overrides?.dryRun ?? options.sync.initialSync.dryRun,
    limit: overrides?.limit,
    onlyIfRemoteMissing: overrides?.onlyIfRemoteMissing ?? options.sync.initialSync.onlyIfRemoteMissing,
  }

  const report: InitialSyncReport = {
    completedAt: undefined,
    dryRun: syncOptions.dryRun,
    errors: [],
    existingRemote: 0,
    failed: 0,
    jobId: `gmc-initial-${Date.now().toString(36)}`,
    processed: 0,
    skipped: 0,
    startedAt: new Date().toISOString(),
    status: 'running',
    succeeded: 0,
    total: 0,
  }

  try {
    // Paginate through all eligible products
    let page = 1
    let hasMore = true

    while (hasMore) {
      const result = await payload.find({
        collection: collectionSlug as never,
        depth: options.collections.products.fetchDepth,
        limit: syncOptions.batchSize,
        page,
        where: {
          or: [
            { [`${MC_FIELD_GROUP_NAME}.enabled`]: { equals: true } },
          ],
        },
      })

      const docs = result.docs.map((doc) => asProductDoc(doc))
      if (report.total === 0) {
        report.total = syncOptions.limit
          ? Math.min(result.totalDocs, syncOptions.limit)
          : result.totalDocs
      }

      if (docs.length === 0) {
        break
      }

      // Determine which docs to process within this batch (respect limit)
      const remaining = syncOptions.limit
        ? syncOptions.limit - report.processed
        : docs.length
      const docsToProcess = docs.slice(0, remaining)
      const docsSkipped = docs.length - docsToProcess.length

      // Process each product through the rate limiter — each returns an
      // isolated outcome instead of mutating shared state
      const outcomes = await Promise.allSettled(
        docsToProcess.map((doc) =>
          rateLimiter.execute(async (): Promise<ProductSyncOutcome> => {
            return processInitialSyncProduct({
              apiClient,
              collectionSlug,
              doc,
              dryRun: syncOptions.dryRun,
              onlyIfRemoteMissing: syncOptions.onlyIfRemoteMissing,
              options,
              payload,
              retryService,
            })
          }),
        ),
      )

      // Aggregate outcomes into report (single-threaded, no races)
      for (const outcome of outcomes) {
        report.processed++

        if (outcome.status === 'rejected') {
          report.failed++
          report.errors.push({
            message: outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
            productId: 'unknown',
          })
          continue
        }

        const { error, result: syncResult } = outcome.value

        switch (syncResult) {
          case 'existingRemote':
            report.existingRemote++
            break
          case 'failed':
            report.failed++
            break
          case 'skipped':
            report.skipped++
            break
          case 'succeeded':
            report.succeeded++
            break
        }

        if (error) {
          report.errors.push(error)
        }
      }

      report.skipped += docsSkipped

      if (onProgress) {
        await onProgress({
          ...report,
          errors: [...report.errors],
        })
      }

      hasMore = result.hasNextPage ?? false
      page++

      if (syncOptions.limit && report.processed >= syncOptions.limit) {
        break
      }
    }

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
// Process a single product during initial sync — returns an outcome object
// instead of mutating shared state
// ---------------------------------------------------------------------------

const processInitialSyncProduct = async (args: {
  apiClient: GoogleApiClient
  collectionSlug: string
  doc: PayloadProductDoc
  dryRun: boolean
  onlyIfRemoteMissing: boolean
  options: NormalizedPluginOptions
  payload: Payload
  retryService: RetryService
}): Promise<ProductSyncOutcome> => {
  const { apiClient, collectionSlug, doc, dryRun, onlyIfRemoteMissing, options, payload, retryService } = args
  const productId = String(doc.id)

  // Resolve identity
  const identityResult = resolveIdentity(doc, options)
  if (!identityResult.ok) {
    return {
      error: {
        message: `Identity resolution failed: ${identityResult.errors.join('; ')}`,
        offerId: undefined,
        productId,
      },
      result: 'skipped',
    }
  }

  const identity = identityResult.value

  // Check if product exists remotely (if configured to skip existing)
  if (onlyIfRemoteMissing) {
    try {
      await apiClient.getProduct(identity.productName, payload)
      // Product exists — skip
      return { result: 'existingRemote' }
    } catch (error) {
      if (!(error instanceof GoogleApiError && error.statusCode === 404)) {
        return {
          error: {
            message: error instanceof Error ? error.message : String(error),
            offerId: identity.offerId,
            productId,
          },
          result: 'failed',
        }
      }
      // 404 = doesn't exist, proceed with insert
    }
  }

  try {
    const { derivedAttributes, input } = await prepareProductForSync({
      identity,
      options,
      payload,
      product: doc,
    })

    // Pre-flight validation — required MC fields
    const missing = validateRequiredProductInput(input)
    if (missing.length > 0) {
      return {
        error: {
          message: `Missing required fields: ${missing.join(', ')}`,
          offerId: identity.offerId,
          productId,
        },
        result: 'failed',
      }
    }

    // Dry run stops after validation — product was prepared and validated but not pushed
    if (dryRun) {
      return { result: 'succeeded' }
    }

    // Insert into Merchant Center
    await retryService.execute(
      () =>
        apiClient.insertProductInput(
          input as unknown as Record<string, unknown>,
          payload,
          identity.dataSourceOverride
            ? `accounts/${options.merchantId}/dataSources/${identity.dataSourceOverride}`
            : undefined,
        ),
      {
        merchantProductId: identity.merchantProductId,
        operation: 'insertProductInput (initial)',
        productId,
      },
    )

    // Fetch snapshot
    let snapshot: Record<string, unknown> | undefined
    try {
      const snapshotResponse = await apiClient.getProduct(identity.productName, payload)
      snapshot = snapshotResponse.data
    } catch {
      // Non-critical
    }

    // Persist only what this sync produced, assembled against the row as it
    // stands at write time. Spreading the document's own `mc` group back over
    // itself would re-assert state read before the Merchant Center round-trip
    // and revert anything saved in the meantime.
    //
    // `dirty` is cleared because this sync has just sent the product — unless
    // the live row went dirty while the request was in flight, in which case
    // Merchant Center holds the earlier content and the product stays queued.
    const observedDirty = asRecord(asRecord(doc[MC_FIELD_GROUP_NAME]).syncMeta).dirty === true

    const statePersisted = await writeMCState(payload, collectionSlug, productId, (row) => {
      const liveMCState = asRecord(row[MC_FIELD_GROUP_NAME])
      const liveAttributes = asRecord(liveMCState[MC_PRODUCT_ATTRIBUTES_FIELD_NAME])
      const racedASave = asRecord(liveMCState.syncMeta).dirty === true && !observedDirty

      const persistedMCState: Record<string, unknown> = {
        syncMeta: {
          dirty: racedASave,
          lastAction: 'initialSync',
          lastError: null,
          lastSyncedAt: new Date().toISOString(),
          state: 'success',
          syncSource: 'initial',
        },
      }

      if (snapshot) {
        persistedMCState.snapshot = snapshot
      }

      // Derived values only ever fill a gap; the live row always wins.
      const attributeFill = Object.fromEntries(
        Object.entries(derivedAttributes).filter(([key]) => liveAttributes[key] === undefined),
      )
      if (Object.keys(attributeFill).length > 0) {
        persistedMCState[MC_PRODUCT_ATTRIBUTES_FIELD_NAME] = attributeFill
      }

      return { [MC_FIELD_GROUP_NAME]: persistedMCState }
    })

    if (!statePersisted) {
      return {
        error: {
          message: STATE_NOT_PERSISTED_WARNING,
          offerId: identity.offerId,
          productId,
        },
        result: 'failed',
      }
    }

    return { result: 'succeeded' }
  } catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : String(error),
        offerId: identity.offerId,
        productId,
      },
      result: 'failed',
    }
  }
}
