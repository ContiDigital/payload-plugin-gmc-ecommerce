import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

const pushProduct = vi.fn()
const deleteFromMC = vi.fn()
const deleteFromMCByIdentity = vi.fn()
const refreshSnapshot = vi.fn()
const pullProduct = vi.fn()
const pullAll = vi.fn()
const runInitialSync = vi.fn()
const createGoogleApiClient = vi.fn()
const createRateLimiterService = vi.fn()
const createRetryService = vi.fn()

const apiClient = {
  listProducts: vi.fn(),
  reportQuery: vi.fn(),
  resetTokenCache: vi.fn(),
}
const rateLimiter = {
  drain: vi.fn(),
  execute: vi.fn((fn: () => Promise<unknown>) => fn()),
}
const retryService = {
  execute: vi.fn((fn: () => Promise<unknown>) => fn()),
}

vi.mock('../sub-services/googleApiClient.js', async () => {
  const actual = await vi.importActual('../sub-services/googleApiClient.js')
  return {
    ...actual,
    createGoogleApiClient,
  }
})

vi.mock('../sub-services/rateLimiterService.js', () => ({
  createRateLimiterService,
}))

vi.mock('../sub-services/retryService.js', () => ({
  createRetryService,
}))

vi.mock('../../sync/pushSync.js', () => ({
  deleteFromMC,
  deleteFromMCByIdentity,
  pushProduct,
  refreshSnapshot,
}))

vi.mock('../../sync/pullSync.js', () => ({
  pullAll,
  pullProduct,
}))

vi.mock('../../sync/initialSync.js', () => ({
  runInitialSync,
}))

const { createMerchantService } = await import('../merchantService.js')

const buildOptions = (overrides?: Partial<NormalizedPluginOptions>): NormalizedPluginOptions => ({
  access: () => Promise.resolve(true),
  admin: { mode: 'route', navLabel: 'GMC', route: '/merchant-center' },
  api: { basePath: '/gmc' },
  collections: {
    products: {
      slug: 'products' as never,
      autoInjectTab: true,
      fetchDepth: 1,
      fieldMappings: [],
      identityField: 'sku',
      tabPosition: 'append',
    },
  },
  dataSourceId: 'ds-123',
  dataSourceName: 'accounts/123/dataSources/ds-123',
  defaults: {
    condition: 'NEW',
    contentLanguage: 'en',
    currency: 'USD',
    feedLabel: 'US',
  },
  disabled: false,
  getCredentials: () =>
    Promise.resolve({
      type: 'json' as const,
      credentials: { client_email: 'test@example.com', private_key: 'key' },
    }),
  localInventory: { enabled: false, storeCode: '' },
  merchantId: '123',
  rateLimit: {
    baseRetryDelayMs: 100,
    enabled: true,
    jitterFactor: 0,
    maxConcurrency: 2,
    maxQueueSize: 10,
    maxRequestsPerMinute: 120,
    maxRetries: 1,
    maxRetryDelayMs: 1000,
    requestTimeoutMs: 5000,
  },
  siteUrl: 'https://example.com',
  sync: {
    conflictStrategy: 'mc-wins',
    initialSync: {
      batchSize: 50,
      dryRun: false,
      enabled: true,
      onlyIfRemoteMissing: true,
    },
    mode: 'scheduled',
    permanentSync: true,
    schedule: {
      apiKey: 'secret',
      cron: '0 4 * * *',
      strategy: 'payload-jobs',
    },
    scheduleCron: '0 4 * * *',
  },
  ...overrides,
})

describe('createMerchantService', () => {
  beforeEach(() => {
    pushProduct.mockReset()
    deleteFromMC.mockReset()
    deleteFromMCByIdentity.mockReset()
    refreshSnapshot.mockReset()
    pullProduct.mockReset()
    pullAll.mockReset()
    runInitialSync.mockReset()
    createGoogleApiClient.mockReset()
    createRateLimiterService.mockReset()
    createRetryService.mockReset()
    apiClient.listProducts.mockReset()
    apiClient.reportQuery.mockReset()
    apiClient.resetTokenCache.mockReset()
    rateLimiter.drain.mockReset()
    rateLimiter.execute.mockClear()
    retryService.execute.mockClear()

    createGoogleApiClient.mockReturnValue(apiClient)
    createRateLimiterService.mockReturnValue(rateLimiter)
    createRetryService.mockReturnValue(retryService)
  })

  test('pushBatch snapshots all matching IDs before syncing products', async () => {
    pushProduct.mockResolvedValue({ action: 'insert', success: true })

    const payload = {
      find: vi.fn().mockImplementation(({ page }: { page: number }) => {
        if (page === 1) {
          return Promise.resolve({
            docs: [{ id: 'prod-1' }, { id: 'prod-2' }],
            hasNextPage: true,
          })
        }

        return Promise.resolve({
          docs: [{ id: 'prod-3' }],
          hasNextPage: false,
        })
      }),
    }

    const service = createMerchantService(buildOptions())
    const report = await service.pushBatch({
      filter: { 'mc.syncMeta.dirty': { equals: true } },
      payload: payload as never,
    })

    expect(payload.find).toHaveBeenCalledTimes(2)
    expect(pushProduct).toHaveBeenNthCalledWith(1, expect.objectContaining({
      payload,
      productId: 'prod-1',
    }))
    expect(pushProduct).toHaveBeenNthCalledWith(2, expect.objectContaining({
      payload,
      productId: 'prod-2',
    }))
    expect(pushProduct).toHaveBeenNthCalledWith(3, expect.objectContaining({
      payload,
      productId: 'prod-3',
    }))
    expect(report).toMatchObject({
      failed: 0,
      processed: 3,
      status: 'completed',
      succeeded: 3,
      total: 3,
    })
  })

  test('getHealth reports queue and worker endpoint requirements', () => {
    const service = createMerchantService(buildOptions({
      sync: {
        ...buildOptions().sync,
        schedule: {
          ...buildOptions().sync.schedule,
          strategy: 'external',
        },
      },
    }))

    expect(service.getHealth()).toMatchObject({
      jobs: {
        queueName: 'gmc-sync',
        runnerRequired: false,
        strategy: 'external',
        workerBasePath: '/gmc/worker',
        workerEndpointsEnabled: true,
      },
      merchant: {
        accountId: '123',
        dataSourceId: 'ds-123',
      },
      status: 'ok',
      sync: {
        mode: 'scheduled',
      },
    })
  })

  test('getProductAnalytics builds report queries and maps performance rows', async () => {
    const payload = {
      findByID: vi.fn().mockResolvedValue({
        id: 'prod-analytics',
        sku: 'SKU-123',
      }),
    }

    // MC Reports API wraps rows in view-specific keys
    apiClient.reportQuery
      .mockResolvedValueOnce({
        data: {
          results: [{
            productView: {
              id: 'en~US~SKU-123',
              aggregatedReportingContextStatus: 'ELIGIBLE',
              offerId: 'SKU-123',
              statusPerReportingContext: [
                { approvedCountries: ['US', 'CA'], reportingContext: 'SHOPPING_ADS' },
                { approvedCountries: ['US'], reportingContext: 'FREE_LISTINGS' },
              ],
              title: 'Analytics Product',
            },
          }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          results: [{
            productPerformanceView: {
              clicks: '5',
              clickThroughRate: 0.25,
              conversions: '2',
              date: { day: 6, month: 3, year: 2026 },
              impressions: '20',
            },
          }],
        },
      })

    const service = createMerchantService(buildOptions())
    const analytics = await service.getProductAnalytics({
      payload: payload as never,
      productId: 'prod-analytics',
      rangeDays: 7,
    })

    expect(apiClient.reportQuery).toHaveBeenCalledTimes(2)
    const statusQuery = apiClient.reportQuery.mock.calls[0]?.[0]
    const perfQuery = apiClient.reportQuery.mock.calls[1]?.[0]
    expect(statusQuery).toContain("product_view.id = 'en~US~SKU-123'")
    expect(statusQuery).toContain('status_per_reporting_context')
    expect(perfQuery).toContain("product_performance_view.offer_id = 'sku-123'")
    expect(analytics).toEqual({
      merchantProductId: 'en~US~SKU-123',
      performance: [{
        clicks: 5,
        clickThroughRate: 0.25,
        conversions: 2,
        date: '2026-03-06',
        impressions: 20,
      }],
      status: {
        id: 'en~US~SKU-123',
        aggregatedReportingContextStatus: 'ELIGIBLE',
        offerId: 'SKU-123',
        statusPerReportingContext: [
          { approvedCountries: ['US', 'CA'], reportingContext: 'SHOPPING_ADS' },
          { approvedCountries: ['US'], reportingContext: 'FREE_LISTINGS' },
        ],
        title: 'Analytics Product',
      },
    })
  })

  test('getProductAnalytics rejects unsafe values in report queries', async () => {
    const payload = {
      findByID: vi.fn().mockResolvedValue({
        id: 'prod-inject',
        sku: "SKU'\\1",
      }),
    }

    const service = createMerchantService(buildOptions())
    await expect(
      service.getProductAnalytics({
        payload: payload as never,
        productId: 'prod-inject',
        rangeDays: 7,
      }),
    ).rejects.toThrow('Unsafe value')
  })

  test('getHealthDeep reports upstream API failures without throwing', async () => {
    apiClient.listProducts.mockRejectedValue(new Error('merchant api unavailable'))

    const service = createMerchantService(buildOptions())
    const health = await service.getHealthDeep({ payload: {} as never })

    expect(health).toMatchObject({
      apiConnection: 'error',
      apiError: 'merchant api unavailable',
      status: 'ok',
    })
  })

  test('cleanupSyncLogs trims expired logs and caps the retained log count', async () => {
    const payload = {
      count: vi.fn().mockResolvedValue({ totalDocs: 503 }),
      delete: vi.fn().mockResolvedValue({}),
      find: vi.fn().mockResolvedValue({
        docs: [{ id: 'old-1' }, { id: 'old-2' }, { id: 'old-3' }],
      }),
    }

    const service = createMerchantService(buildOptions())
    await service.cleanupSyncLogs({
      payload: payload as never,
      ttlDays: 14,
    })

    expect(payload.delete).toHaveBeenNthCalledWith(1, expect.objectContaining({
      collection: 'gmc-sync-log',
      where: {
        startedAt: {
          less_than: expect.any(String),
        },
      },
    }))
    expect(payload.find).toHaveBeenCalledWith(expect.objectContaining({
      collection: 'gmc-sync-log',
      limit: 3,
      sort: 'startedAt',
    }))
    expect(payload.delete).toHaveBeenNthCalledWith(2, {
      collection: 'gmc-sync-log',
      overrideAccess: true,
      where: { id: { in: ['old-1', 'old-2', 'old-3'] } },
    })
  })

  test('destroy drains the rate limiter and resets API client token cache', () => {
    const service = createMerchantService(buildOptions())

    service.destroy()

    expect(rateLimiter.drain).toHaveBeenCalledTimes(1)
    expect(apiClient.resetTokenCache).toHaveBeenCalledTimes(1)
  })
})
