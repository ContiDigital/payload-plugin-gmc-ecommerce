import type { Payload, Where } from 'payload'

import type {
  BatchSyncReport,
  DeepHealthResult,
  HealthResult,
  InitialSyncReport,
  MCProductAnalytics,
  NormalizedPluginOptions,
  PullAllReport,
  PullResult,
  ResolvedMCIdentity,
  SyncResult,
} from '../../types/index.js'
import type { GoogleApiClient } from './sub-services/googleApiClient.js'
import type { RateLimiterService } from './sub-services/rateLimiterService.js'
import type { RetryService } from './sub-services/retryService.js'

import { GMC_SYNC_QUEUE_NAME, MC_FIELD_GROUP_NAME } from '../../constants.js'
import { resolveIdentity } from '../sync/identityResolver.js'
import { runInitialSync } from '../sync/initialSync.js'
import { reconcileLocalInventory } from '../sync/localInventorySync.js'
import { pullAll, pullProduct } from '../sync/pullSync.js'
import { deleteFromMC, deleteFromMCByIdentity, pushProduct, refreshSnapshot } from '../sync/pushSync.js'
import { createPluginLogger } from '../utilities/logger.js'
import { asProductDoc, getRecordID } from '../utilities/recordUtils.js'
import { createGoogleApiClient } from './sub-services/googleApiClient.js'
import { createRateLimiterService } from './sub-services/rateLimiterService.js'
import { createRetryService } from './sub-services/retryService.js'

export type MerchantService = {
  cleanupSyncLogs: (args: { payload: Payload; ttlDays?: number }) => Promise<void>
  deleteProduct: (args: { payload: Payload; productId: string }) => Promise<SyncResult>
  deleteProductByIdentity: (args: {
    identity: ResolvedMCIdentity
    payload: Payload
    productId: string
  }) => Promise<SyncResult>
  destroy: () => void
  getHealth: () => HealthResult
  getHealthDeep: (args: { payload: Payload }) => Promise<DeepHealthResult>
  getProductAnalytics: (args: {
    payload: Payload
    productId: string
    rangeDays: number
  }) => Promise<MCProductAnalytics>
  pullAllProducts: (args: {
    onProgress?: (report: PullAllReport) => Promise<void> | void
    payload: Payload
  }) => Promise<PullAllReport>
  pullProduct: (args: { payload: Payload; productId: string }) => Promise<PullResult>
  pushBatch: (args: {
    filter?: Where
    onProgress?: (report: BatchSyncReport) => Promise<void> | void
    payload: Payload
    productIds?: string[]
  }) => Promise<BatchSyncReport>
  pushProduct: (args: { payload: Payload; productId: string }) => Promise<SyncResult>
  reconcileLocalInventory: (args: {
    onProgress?: (report: { deleted: number; errors: number; inserted: number; processed: number; total: number }) => void
    payload: Payload
  }) => Promise<{ deleted: number; errors: number; inserted: number; processed: number; total: number }>
  refreshSnapshot: (args: { payload: Payload; productId: string }) => Promise<SyncResult>
  runInitialSync: (args: {
    onProgress?: (report: InitialSyncReport) => Promise<void> | void
    overrides?: { batchSize?: number; dryRun?: boolean; limit?: number; onlyIfRemoteMissing?: boolean }
    payload: Payload
  }) => Promise<InitialSyncReport>
}

// Track active services for graceful shutdown
const ACTIVE_SERVICES = new Set<MerchantService>()
let shutdownRegistered = false

const registerShutdownHooks = (): void => {
  if (shutdownRegistered) {return}
  shutdownRegistered = true

  const shutdown = (): void => {
    for (const s of ACTIVE_SERVICES) {
      s.destroy()
    }
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

export const createMerchantService = (
  options: NormalizedPluginOptions,
  logger?: { debug: (...args: unknown[]) => void; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): MerchantService => {
  const _log = createPluginLogger(
    logger ? { ...logger, info: logger.debug } : undefined,
    { service: 'MerchantService' },
  )
  const apiClient: GoogleApiClient = createGoogleApiClient(options)

  const retryService: RetryService = createRetryService(
    {
      baseRetryDelayMs: options.rateLimit.baseRetryDelayMs,
      jitterFactor: options.rateLimit.jitterFactor,
      maxRetries: options.rateLimit.maxRetries,
      maxRetryDelayMs: options.rateLimit.maxRetryDelayMs,
    },
    logger,
  )

  const rateLimiter: RateLimiterService = createRateLimiterService({
    enabled: options.rateLimit.enabled,
    maxConcurrency: options.rateLimit.maxConcurrency,
    maxQueueSize: options.rateLimit.maxQueueSize,
    maxRequestsPerMinute: options.rateLimit.maxRequestsPerMinute,
    scopeKey: `merchant:${options.merchantId}`,
    store: options.rateLimit.store,
  })

  const service: MerchantService = {
    pushProduct: async ({ payload, productId }) =>
      rateLimiter.execute(() =>
        pushProduct({ apiClient, options, payload, productId, retryService }),
      ),

    pushBatch: async ({ filter, onProgress, payload, productIds }) => {
      const collectionSlug = options.collections.products.slug
      const startedAt = new Date().toISOString()
      const jobId = `gmc-batch-${Date.now().toString(36)}`

      const report: BatchSyncReport = {
        errors: [],
        failed: 0,
        jobId,
        processed: 0,
        startedAt,
        status: 'running',
        succeeded: 0,
        total: 0,
      }

      try {
        // Determine which products to sync
        let where: undefined | Where = filter
        if (productIds && productIds.length > 0) {
          where = { id: { in: productIds } }
        } else if (!where) {
          where = { [`${MC_FIELD_GROUP_NAME}.enabled`]: { equals: true } }
        }

        // Collect all matching IDs upfront to avoid pagination drift when
        // the filter (e.g. dirty=true) changes as products are processed
        const allIds: string[] = []
        let page = 1
        let hasMore = true

        while (hasMore) {
          const result = await payload.find({
            collection: collectionSlug as never,
            depth: 0,
            limit: 500,
            page,
            select: {},
            where,
          })
          const docs = result.docs as unknown as Array<{ id: string }>
          for (const doc of docs) {
            allIds.push(doc.id)
          }
          hasMore = result.hasNextPage ?? false
          page++
        }

        report.total = allIds.length

        // Process in chunks
        const CHUNK_SIZE = 100
        for (let i = 0; i < allIds.length; i += CHUNK_SIZE) {
          const chunk = allIds.slice(i, i + CHUNK_SIZE)

          const results = await Promise.allSettled(
            chunk.map((id) =>
              rateLimiter.execute(() =>
                pushProduct({ apiClient, options, payload, productId: id, retryService }),
              ),
            ),
          )

          for (let j = 0; j < results.length; j++) {
            const result = results[j]
            report.processed++
            if (result.status === 'fulfilled' && result.value.success) {
              report.succeeded++
            } else {
              report.failed++
              const message = result.status === 'rejected'
                ? (result.reason instanceof Error ? result.reason.message : String(result.reason))
                : 'Sync failed'
              report.errors.push({ message, productId: chunk[j] ?? 'unknown' })
            }
          }

          await onProgress?.(report)
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
    },

    deleteProduct: async ({ payload, productId }) =>
      rateLimiter.execute(() =>
        deleteFromMC({ apiClient, options, payload, productId, retryService }),
      ),

    deleteProductByIdentity: async ({ identity, payload, productId }) =>
      rateLimiter.execute(() =>
        deleteFromMCByIdentity({ apiClient, identity, options, payload, productId, retryService }),
      ),

    refreshSnapshot: async ({ payload, productId }) =>
      rateLimiter.execute(() =>
        refreshSnapshot({ apiClient, options, payload, productId, retryService }),
      ),

    pullProduct: async ({ payload, productId }) =>
      rateLimiter.execute(() =>
        pullProduct({ apiClient, options, payload, productId, retryService }),
      ),

    pullAllProducts: async ({ onProgress, payload }) =>
      pullAll({ apiClient, onProgress, options, payload, retryService }),

    runInitialSync: async ({ onProgress, overrides, payload }) =>
      runInitialSync({
        apiClient,
        onProgress,
        options,
        overrides,
        payload,
        rateLimiter,
        retryService,
      }),

    getProductAnalytics: async ({ payload, productId, rangeDays }) => {
      const collectionSlug = options.collections.products.slug

      const product = await payload.findByID({
        id: productId,
        collection: collectionSlug as never,
        depth: 0,
      }).then(asProductDoc)

      const identityResult = resolveIdentity(product, options)

      if (!identityResult.ok) {
        throw new Error(`Cannot resolve identity: ${identityResult.errors.join('; ')}`)
      }

      const identity = identityResult.value
      const endDate = new Date()
      const startDate = new Date()
      startDate.setDate(startDate.getDate() - rangeDays)

      const formatDate = (d: Date) => d.toISOString().split('T')[0]

      // Validate values interpolated into MC report queries to prevent injection.
      // Only allow alphanumerics, hyphens, underscores, tildes, and dots.
      const assertSafeQueryValue = (val: string, label: string): string => {
        if (!/^[\w.~-]+$/.test(val)) {
          throw new Error(`Unsafe value for ${label}: ${val}`)
        }
        return val
      }

      const safeProductId = assertSafeQueryValue(identity.merchantProductId, 'merchantProductId')
      // MC Reports API stores offer_id in lowercase — always lowercase for performance queries
      const safeOfferId = assertSafeQueryValue(identity.offerId.toLowerCase(), 'offerId')
      const safeStartDate = assertSafeQueryValue(formatDate(startDate), 'startDate')
      const safeEndDate = assertSafeQueryValue(formatDate(endDate), 'endDate')

      // Product status query
      const statusQuery = `SELECT product_view.id, product_view.offer_id, product_view.title, product_view.aggregated_reporting_context_status, product_view.status_per_reporting_context FROM product_view WHERE product_view.id = '${safeProductId}'`

      // Performance query
      const perfQuery = `SELECT date, impressions, clicks, click_through_rate, conversions FROM product_performance_view WHERE product_performance_view.offer_id = '${safeOfferId}' AND date BETWEEN '${safeStartDate}' AND '${safeEndDate}' ORDER BY date`

      const [statusResult, perfResult] = await Promise.allSettled([
        retryService.execute(
          () => apiClient.reportQuery(statusQuery, payload),
          { operation: 'reportQuery (status)', productId },
        ),
        retryService.execute(
          () => apiClient.reportQuery(perfQuery, payload),
          { operation: 'reportQuery (performance)', productId },
        ),
      ])

      // MC Reports API wraps each row: { productView: { ... } } or { productPerformanceView: { ... } }
      const unwrapRow = (row: Record<string, unknown>): Record<string, unknown> => {
        for (const key of ['productView', 'productPerformanceView', 'priceInsightsProductView']) {
          if (row[key] && typeof row[key] === 'object') {
            return row[key] as Record<string, unknown>
          }
        }
        return row
      }

      // MC date fields are { year, month, day } objects — convert to YYYY-MM-DD string
      const formatMcDate = (val: unknown): string => {
        if (typeof val === 'string') {
          return val
        }
        if (val && typeof val === 'object' && 'year' in val && 'month' in val && 'day' in val) {
          const d = val as { day: number; month: number; year: number }
          return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
        }
        return ''
      }

      const statusRow = statusResult.status === 'fulfilled'
        ? statusResult.value.data.results?.[0]
        : undefined
      const status = statusRow ? unwrapRow(statusRow) : undefined

      const rawPerfRows = perfResult.status === 'fulfilled'
        ? (perfResult.value.data.results ?? [])
        : []

      return {
        merchantProductId: identity.merchantProductId,
        performance: rawPerfRows.map((raw: Record<string, unknown>) => {
          const row = unwrapRow(raw)
          return {
            clicks: Number(row.clicks ?? 0),
            clickThroughRate: Number(row.clickThroughRate ?? row.click_through_rate ?? 0),
            conversions: Number(row.conversions ?? 0),
            date: formatMcDate(row.date),
            impressions: Number(row.impressions ?? 0),
          }
        }),
        status,
      }
    },

    getHealth: () => ({
      admin: { mode: options.admin.mode },
      jobs: {
        queueName: GMC_SYNC_QUEUE_NAME,
        runnerRequired: options.sync.schedule.strategy === 'payload-jobs',
        strategy: options.sync.schedule.strategy,
        workerBasePath: `${options.api.basePath}/worker`,
        workerEndpointsEnabled: Boolean(options.sync.schedule.apiKey),
      },
      merchant: {
        accountId: options.merchantId,
        dataSourceId: options.dataSourceId,
      },
      rateLimit: {
        distributed: Boolean(options.rateLimit.store),
        enabled: options.rateLimit.enabled,
      },
      status: 'ok',
      sync: { mode: options.sync.mode },
      timestamp: new Date().toISOString(),
    }),

    getHealthDeep: async ({ payload }) => {
      const basic = service.getHealth()
      try {
        await apiClient.listProducts(payload, 1)
        return { ...basic, apiConnection: 'ok' as const }
      } catch (error) {
        return {
          ...basic,
          apiConnection: 'error' as const,
          apiError: error instanceof Error ? error.message : String(error),
        }
      }
    },

    reconcileLocalInventory: async ({ onProgress, payload }) =>
      reconcileLocalInventory({ apiClient, onProgress, options, payload, retryService }),

    cleanupSyncLogs: async ({ payload, ttlDays = 30 }) => {
      try {
        // Delete logs older than TTL
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - ttlDays)
        await payload.delete({
          collection: 'gmc-sync-log' as never,
          overrideAccess: true,
          where: {
            startedAt: { less_than: cutoff.toISOString() },
          },
        })

        // Cap total count at 500
        const count = await payload.count({
          collection: 'gmc-sync-log' as never,
          overrideAccess: true,
        })
        if (count.totalDocs > 500) {
          const excess = await payload.find({
            collection: 'gmc-sync-log' as never,
            depth: 0,
            limit: count.totalDocs - 500,
            overrideAccess: true,
            sort: 'startedAt',
          })
          const ids = excess.docs.map((doc) => getRecordID(doc)).filter((id): id is string => {
            return typeof id === 'string'
          })
          if (ids.length > 0) {
            await payload.delete({
              collection: 'gmc-sync-log' as never,
              overrideAccess: true,
              where: { id: { in: ids } },
            })
          }
        }
      } catch {
        // Non-critical — cleanup failure should not break operations
      }
    },

    destroy: () => {
      rateLimiter.drain()
      apiClient.resetTokenCache()
      ACTIVE_SERVICES.delete(service)
    },
  }

  ACTIVE_SERVICES.add(service)
  registerShutdownHooks()

  return service
}
