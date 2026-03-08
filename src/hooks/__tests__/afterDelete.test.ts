import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../types/index.js'

const deleteProductByIdentity = vi.fn()
const getMerchantServiceInstance = vi.fn(() => ({
  deleteProductByIdentity,
}))
const queueProductDeleteJob = vi.fn()

vi.mock('../../plugin/jobTasks.js', () => ({
  queueProductDeleteJob,
}))

vi.mock('../../plugin/serviceRegistry.js', () => ({
  getMerchantServiceInstance,
}))

const { createAfterDeleteHook } = await import('../afterDelete.js')

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
      apiKey: 'secret',
      cron: '0 4 * * *',
      strategy: 'payload-jobs',
    },
    scheduleCron: '0 4 * * *',
  },
  ...overrides,
})

describe('createAfterDeleteHook', () => {
  beforeEach(() => {
    deleteProductByIdentity.mockReset()
    deleteProductByIdentity.mockResolvedValue({ action: 'delete', productId: 'prod-1', success: true })
    queueProductDeleteJob.mockReset()
    queueProductDeleteJob.mockResolvedValue('job-1')
    getMerchantServiceInstance.mockClear()
  })

  test('queues a Payload job when payload-jobs mode is enabled', async () => {
    const hook = createAfterDeleteHook(buildOptions())
    const req = { payload: {} }

    await hook({
      id: 'prod-1',
      collection: {} as never,
      context: {},
      doc: {
        id: 'prod-1',
        merchantCenter: {
          enabled: true,
          identity: {
            contentLanguage: 'en',
            feedLabel: 'US',
            offerId: 'SKU-1',
          },
        },
        sku: 'SKU-1',
      },
      req: req as never,
    })

    expect(queueProductDeleteJob).toHaveBeenCalledWith({
      identity: expect.objectContaining({
        merchantProductId: 'en~US~SKU-1',
        productInputName: 'accounts/123/productInputs/en~US~SKU-1',
        productName: 'accounts/123/products/en~US~SKU-1',
      }),
      merchantId: '123',
      payload: req.payload,
      productId: 'prod-1',
      req,
    })
    expect(deleteProductByIdentity).not.toHaveBeenCalled()
  })

  test('falls back to direct deletion when using the external strategy', async () => {
    const hook = createAfterDeleteHook(buildOptions({
      sync: {
        ...buildOptions().sync,
        schedule: {
          ...buildOptions().sync.schedule,
          strategy: 'external',
        },
      },
    }))

    await hook({
      id: 'prod-2',
      collection: {} as never,
      context: {},
      doc: {
        id: 'prod-2',
        merchantCenter: {
          enabled: true,
          identity: {
            contentLanguage: 'en',
            feedLabel: 'US',
            offerId: 'SKU-2',
          },
        },
        sku: 'SKU-2',
      },
      req: { payload: {} } as never,
    })

    expect(deleteProductByIdentity).toHaveBeenCalledWith({
      identity: expect.objectContaining({
        merchantProductId: 'en~US~SKU-2',
      }),
      payload: {},
      productId: 'prod-2',
    })
    expect(queueProductDeleteJob).not.toHaveBeenCalled()
  })

  test('skips deletion when the deleted document was not GMC-enabled', async () => {
    const hook = createAfterDeleteHook(buildOptions())

    await hook({
      id: 'prod-3',
      collection: {} as never,
      context: {},
      doc: {
        id: 'prod-3',
        merchantCenter: {
          enabled: false,
        },
      },
      req: { payload: {} } as never,
    })

    expect(deleteProductByIdentity).not.toHaveBeenCalled()
    expect(queueProductDeleteJob).not.toHaveBeenCalled()
  })
})
