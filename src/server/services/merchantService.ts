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
  SyncResult,
} from '../../types/index.js'
import type { GoogleApiClient } from './sub-services/googleApiClient.js'
import type { RateLimiterService } from './sub-services/rateLimiterService.js'
import type { RetryService } from './sub-services/retryService.js'

import { MC_FIELD_GROUP_NAME } from '../../constants.js'
import { resolveIdentity } from '../sync/identityResolver.js'
import { runInitialSync } from '../sync/initialSync.js'
import { pullAll, pullProduct } from '../sync/pullSync.js'
import { deleteFromMC, pushProduct, refreshSnapshot } from '../sync/pushSync.js'
import { createPluginLogger } from '../utilities/logger.js'
import { createGoogleApiClient } from './sub-services/googleApiClient.js'
import { createRateLimiterService } from './sub-services/rateLimiterService.js'
import { createRetryService } from './sub-services/retryService.js'

export type MerchantService = {
  cleanupSyncLogs: (args: { payload: Payload; ttlDays?: number }) => Promise<void>
  deleteProduct: (args: { payload: Payload; productId: string }) => Promise<SyncResult>
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
    maxConcurrency: options.rateLimit.maxConcurrency,
    maxQueueSize: options.rateLimit.maxQueueSize,
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

        // Count total
        const countResult = await payload.count({
          collection: collectionSlug as never,
          where,
        })
        report.total = countResult.totalDocs

        // Paginate and process
        let page = 1
        let hasMore = true

        while (hasMore) {
          const result = await payload.find({
            collection: collectionSlug as never,
            depth: 0,
            limit: 100,
            page,
            where,
          })

          const docs = result.docs as unknown as Array<{ id: string }>

          const results = await Promise.allSettled(
            docs.map((doc) =>
              rateLimiter.execute(() =>
                pushProduct({ apiClient, options, payload, productId: doc.id, retryService }),
              ),
            ),
          )

          for (const result of results) {
            report.processed++
            if (result.status === 'fulfilled' && result.value.success) {
              report.succeeded++
            } else {
              report.failed++
              const message = result.status === 'rejected'
                ? (result.reason instanceof Error ? result.reason.message : String(result.reason))
                : 'Sync failed'
              report.errors.push({ message, productId: 'unknown' })
            }
          }

          void onProgress?.(report)
          hasMore = result.hasNextPage ?? false
          page++
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
      }) as unknown as Record<string, unknown>

      const identityResult = resolveIdentity(product, options)

      if (!identityResult.ok) {
        throw new Error(`Cannot resolve identity: ${identityResult.errors.join('; ')}`)
      }

      const identity = identityResult.value
      const endDate = new Date()
      const startDate = new Date()
      startDate.setDate(startDate.getDate() - rangeDays)

      const formatDate = (d: Date) => d.toISOString().split('T')[0]

      // Sanitize values interpolated into MC report queries to prevent injection
      const sanitize = (val: string): string => val.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

      const safeProductId = sanitize(identity.merchantProductId)
      const safeOfferId = sanitize(identity.offerId)
      const safeStartDate = sanitize(formatDate(startDate))
      const safeEndDate = sanitize(formatDate(endDate))

      // Product status query
      const statusQuery = `SELECT product_view.id, product_view.offer_id, product_view.title, product_view.aggregated_reporting_context_status FROM product_view WHERE product_view.id = '${safeProductId}'`

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

      const status = statusResult.status === 'fulfilled'
        ? statusResult.value.data.results?.[0]
        : undefined

      const performanceRows = perfResult.status === 'fulfilled'
        ? (perfResult.value.data.results ?? [])
        : []

      return {
        merchantProductId: identity.merchantProductId,
        performance: performanceRows.map((row: Record<string, unknown>) => ({
          clicks: Number(row.clicks ?? 0),
          clickThroughRate: Number(row.clickThroughRate ?? row.click_through_rate ?? 0),
          conversions: Number(row.conversions ?? 0),
          date: typeof row.date === 'string' ? row.date : '',
          impressions: Number(row.impressions ?? 0),
        })),
        status,
      }
    },

    getHealth: () => ({
      admin: { mode: options.admin.mode },
      merchant: {
        accountId: options.merchantId,
        dataSourceId: options.dataSourceId,
      },
      rateLimit: { enabled: options.rateLimit.enabled },
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
          const ids = excess.docs.map((d) => (d as unknown as Record<string, unknown>).id as string)
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
