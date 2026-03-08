import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions, ResolvedMCIdentity } from '../../../types/index.js'

const checkPullConflict = vi.fn()
const resolveIdentity = vi.fn()
const reverseTransformProduct = vi.fn()

vi.mock('../conflictResolver.js', () => ({
  checkPullConflict,
}))

vi.mock('../identityResolver.js', () => ({
  resolveIdentity,
}))

vi.mock('../transformers.js', () => ({
  reverseTransformProduct,
}))

const { pullAll, pullProduct } = await import('../pullSync.js')

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
    mode: 'manual',
    permanentSync: true,
    schedule: {
      apiKey: '',
      cron: '0 4 * * *',
      strategy: 'external',
    },
    scheduleCron: '0 4 * * *',
  },
  ...overrides,
})

const buildIdentity = (): ResolvedMCIdentity => ({
  contentLanguage: 'en',
  dataSourceName: 'accounts/123/dataSources/ds-123',
  feedLabel: 'US',
  merchantProductId: 'en~US~SKU-1',
  offerId: 'SKU-1',
  productInputName: 'accounts/123/productInputs/en~US~SKU-1',
  productName: 'accounts/123/products/en~US~SKU-1',
})

describe('pullSync', () => {
  beforeEach(() => {
    checkPullConflict.mockReset()
    resolveIdentity.mockReset()
    reverseTransformProduct.mockReset()
  })

  test('pullProduct updates local state from Merchant Center when conflicts allow it', async () => {
    const payload = {
      findByID: vi.fn().mockResolvedValue({
        id: 'prod-1',
        merchantCenter: {
          syncMeta: { dirty: false },
        },
      }),
      logger: {
        info: vi.fn(),
      },
      update: vi.fn().mockResolvedValue({}),
    }
    const retryService = {
      execute: vi.fn((fn: () => Promise<unknown>) => fn()),
    }

    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    checkPullConflict.mockReturnValue({ action: 'pull' })
    reverseTransformProduct.mockReturnValue({
      customAttributes: [{ name: 'material', value: 'gold' }],
      productAttributes: {
        availability: 'IN_STOCK',
        imageLink: 'https://example.com/image.jpg',
        link: 'https://example.com/product',
        title: 'Remote Title',
      },
    })

    const result = await pullProduct({
      apiClient: {
        getProduct: vi.fn().mockResolvedValue({
          data: {
            name: 'accounts/123/products/en~US~SKU-1',
            updateTime: '2026-03-07T12:00:00Z',
          },
        }),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: retryService as never,
    })

    expect(result).toEqual({
      action: 'pull',
      populatedFields: ['availability', 'imageLink', 'link', 'title'],
      productId: 'prod-1',
      success: true,
    })
    expect(payload.update).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        merchantCenter: {
          customAttributes: [{ name: 'material', value: 'gold' }],
          enabled: true,
          identity: {
            contentLanguage: 'en',
            feedLabel: 'US',
            offerId: 'SKU-1',
          },
          productAttributes: {
            availability: 'IN_STOCK',
            imageLink: 'https://example.com/image.jpg',
            link: 'https://example.com/product',
            title: 'Remote Title',
          },
          snapshot: {
            name: 'accounts/123/products/en~US~SKU-1',
            updateTime: '2026-03-07T12:00:00Z',
          },
          syncMeta: {
            dirty: false,
            lastAction: 'pullSync',
            lastError: undefined,
            lastSyncedAt: expect.any(String),
            state: 'success',
            syncSource: 'pull',
          },
        },
      },
    }))
  })

  test('pullProduct skips updates when the conflict strategy says so', async () => {
    const payload = {
      findByID: vi.fn().mockResolvedValue({
        id: 'prod-2',
        merchantCenter: {
          syncMeta: { dirty: true },
        },
      }),
      logger: {
        info: vi.fn(),
      },
      update: vi.fn().mockResolvedValue({}),
    }

    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    checkPullConflict.mockReturnValue({ action: 'skip', reason: 'local dirty state wins' })

    const result = await pullProduct({
      apiClient: {
        getProduct: vi.fn().mockResolvedValue({
          data: { updateTime: '2026-03-07T12:00:00Z' },
        }),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-2',
      retryService: {
        execute: vi.fn((fn: () => Promise<unknown>) => fn()),
      } as never,
    })

    expect(result).toEqual({
      action: 'pull',
      populatedFields: [],
      productId: 'prod-2',
      success: false,
    })
    expect(payload.update).not.toHaveBeenCalled()
  })

  test('pullAll matches local products and persists pulled state', async () => {
    const payload = {
      find: vi.fn().mockResolvedValue({
        docs: [{
          id: 'prod-3',
          merchantCenter: {
            syncMeta: { dirty: false },
          },
          sku: 'SKU-3',
        }],
      }),
      update: vi.fn().mockResolvedValue({}),
    }

    checkPullConflict.mockReturnValue({ action: 'pull' })
    reverseTransformProduct.mockReturnValue({
      customAttributes: [{ name: 'artist', value: 'Example' }],
      productAttributes: {
        availability: 'IN_STOCK',
        imageLink: 'https://example.com/image.jpg',
        link: 'https://example.com/product',
        title: 'Pulled Product',
      },
    })

    const report = await pullAll({
      apiClient: {
        getProduct: vi.fn().mockResolvedValue({
          data: {
            name: 'accounts/123/products/en~US~SKU-3',
            updateTime: '2026-03-07T12:00:00Z',
          },
        }),
        listProducts: vi.fn().mockResolvedValue({
          data: {
            nextPageToken: undefined,
            products: [{
              name: 'accounts/123/products/en~US~SKU-3',
            }],
          },
        }),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      retryService: {
        execute: vi.fn((fn: () => Promise<unknown>) => fn()),
      } as never,
    })

    expect(report).toMatchObject({
      failed: 0,
      matched: 1,
      orphaned: 0,
      processed: 1,
      status: 'completed',
      succeeded: 1,
      total: 1,
    })
    expect(payload.update).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        merchantCenter: expect.objectContaining({
          customAttributes: [{ name: 'artist', value: 'Example' }],
          enabled: true,
          identity: {
            contentLanguage: 'en',
            feedLabel: 'US',
            offerId: 'SKU-3',
          },
          productAttributes: {
            availability: 'IN_STOCK',
            imageLink: 'https://example.com/image.jpg',
            link: 'https://example.com/product',
            title: 'Pulled Product',
          },
          syncMeta: expect.objectContaining({
            dirty: false,
            lastAction: 'pullSync',
            state: 'success',
          }),
        }),
      },
    }))
  })

  test('pullAll matches per-product identity overrides before falling back to the global identity field', async () => {
    const payload = {
      find: vi.fn()
        .mockResolvedValueOnce({
          docs: [{
            id: 'prod-override',
            merchantCenter: {
              identity: {
                contentLanguage: 'en',
                feedLabel: 'US',
                offerId: 'REMOTE-1',
              },
              syncMeta: { dirty: false },
            },
            sku: 'LOCAL-SKU',
          }],
        }),
      update: vi.fn().mockResolvedValue({}),
    }

    checkPullConflict.mockReturnValue({ action: 'pull' })
    reverseTransformProduct.mockReturnValue({
      customAttributes: [],
      productAttributes: {
        availability: 'IN_STOCK',
        imageLink: 'https://example.com/image.jpg',
        link: 'https://example.com/product',
        title: 'Override Match',
      },
    })

    const report = await pullAll({
      apiClient: {
        getProduct: vi.fn().mockResolvedValue({
          data: {
            name: 'accounts/123/products/en~US~REMOTE-1',
            updateTime: '2026-03-07T12:00:00Z',
          },
        }),
        listProducts: vi.fn().mockResolvedValue({
          data: {
            nextPageToken: undefined,
            products: [{
              name: 'accounts/123/products/en~US~REMOTE-1',
            }],
          },
        }),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      retryService: {
        execute: vi.fn((fn: () => Promise<unknown>) => fn()),
      } as never,
    })

    expect(report).toMatchObject({
      matched: 1,
      orphaned: 0,
      succeeded: 1,
      total: 1,
    })
    expect(payload.find).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: {
        'merchantCenter.identity.offerId': { equals: 'REMOTE-1' },
      },
    }))
    expect(payload.find).toHaveBeenCalledTimes(1)
  })

  test('pullAll counts unmatched Merchant Center products as orphaned', async () => {
    const payload = {
      find: vi.fn().mockResolvedValue({
        docs: [],
      }),
      update: vi.fn().mockResolvedValue({}),
    }

    const report = await pullAll({
      apiClient: {
        getProduct: vi.fn(),
        listProducts: vi.fn().mockResolvedValue({
          data: {
            nextPageToken: undefined,
            products: [{
              name: 'accounts/123/products/en~US~SKU-404',
            }],
          },
        }),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      retryService: {
        execute: vi.fn((fn: () => Promise<unknown>) => fn()),
      } as never,
    })

    expect(report).toMatchObject({
      matched: 0,
      orphaned: 1,
      processed: 1,
      succeeded: 0,
      total: 1,
    })
    expect(payload.update).not.toHaveBeenCalled()
  })
})
