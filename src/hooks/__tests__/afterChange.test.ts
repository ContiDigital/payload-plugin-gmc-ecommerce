import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../types/index.js'

const pushProduct = vi.fn()
const queueProductPushJob = vi.fn()
const getMerchantServiceInstance = vi.fn(() => ({
  pushProduct,
}))

vi.mock('../../plugin/jobTasks.js', () => ({
  queueProductPushJob,
}))

vi.mock('../../plugin/serviceRegistry.js', () => ({
  getMerchantServiceInstance,
}))

const { createAfterChangeHook } = await import('../afterChange.js')

const mockOptions = (overrides?: Partial<NormalizedPluginOptions>): NormalizedPluginOptions => ({
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
  getCredentials: () => Promise.resolve({
    type: 'json' as const,
    credentials: { client_email: 'test@example.com', private_key: 'key' },
  }),
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
    mode: 'onChange',
    permanentSync: true,
    schedule: {
      apiKey: '',
      cron: '0 4 * * *',
      strategy: 'payload-jobs',
    },
    scheduleCron: '0 4 * * *',
  },
  ...overrides,
})

describe('createAfterChangeHook', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pushProduct.mockReset()
    pushProduct.mockResolvedValue({ success: true })
    queueProductPushJob.mockReset()
    queueProductPushJob.mockResolvedValue('job-1')
    getMerchantServiceInstance.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('queues a payload job for dirty enabled products in payload-jobs mode', async () => {
    const hook = createAfterChangeHook(mockOptions())
    const doc = {
      id: 'prod-1',
      merchantCenter: {
        enabled: true,
        syncMeta: { dirty: true },
      },
    }
    const req = {
      payload: {
        logger: {
          debug: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        },
      },
    }

    const result = await hook({
      collection: {} as never,
      context: {},
      doc,
      operation: 'update',
      previousDoc: doc,
      req: req as never,
    })

    expect(result).toBe(doc)
    expect(queueProductPushJob).toHaveBeenCalledWith({
      merchantId: '123',
      payload: req.payload,
      productId: 'prod-1',
      req,
    })
    expect(pushProduct).not.toHaveBeenCalled()
  })

  test('falls back to in-process sync when using the external strategy', async () => {
    const hook = createAfterChangeHook(mockOptions({
      sync: {
        ...mockOptions().sync,
        schedule: {
          ...mockOptions().sync.schedule,
          strategy: 'external',
        },
      },
    }))

    await hook({
      collection: {} as never,
      context: {},
      doc: {
        id: 'prod-2',
        merchantCenter: {
          enabled: true,
          syncMeta: { dirty: true },
        },
      },
      operation: 'update',
      previousDoc: {} as never,
      req: {
        payload: {},
      } as never,
    })

    await vi.runAllTimersAsync()
    expect(pushProduct).toHaveBeenCalledWith({ payload: {}, productId: 'prod-2' })
    expect(queueProductPushJob).not.toHaveBeenCalled()
  })

  test('does not queue a push for internal sync updates', async () => {
    const hook = createAfterChangeHook(mockOptions())

    await hook({
      collection: {} as never,
      context: { 'gmc:skip-sync-hooks': true },
      doc: {
        id: 'prod-3',
        merchantCenter: {
          enabled: true,
          syncMeta: { dirty: true },
        },
      },
      operation: 'update',
      previousDoc: {} as never,
      req: { payload: {} } as never,
    })

    expect(queueProductPushJob).not.toHaveBeenCalled()
    expect(pushProduct).not.toHaveBeenCalled()
  })
})
