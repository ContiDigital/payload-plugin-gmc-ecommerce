import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions, ResolvedMCIdentity } from '../../../types/index.js'

import { MC_FIELD_GROUP_NAME, MC_PRODUCT_ATTRIBUTES_FIELD_NAME } from '../../../constants.js'

const prepareProductForSync = vi.fn()
const validateRequiredProductInput = vi.fn()
const resolveIdentity = vi.fn()

vi.mock('../productPreparation.js', () => ({
  prepareProductForSync,
  validateRequiredProductInput,
}))

vi.mock('../identityResolver.js', () => ({
  resolveIdentity,
}))

const { GoogleApiError } = await import('../../services/sub-services/googleApiClient.js')
const { deleteFromMC, deleteFromMCByIdentity, pushProduct, refreshSnapshot } = await import('../pushSync.js')

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

describe('pushSync', () => {
  beforeEach(() => {
    prepareProductForSync.mockReset()
    validateRequiredProductInput.mockReset()
    resolveIdentity.mockReset()
  })

  test('pushProduct persists syncing state, snapshot, and a cleared dirty flag on success', async () => {
    const identity = buildIdentity()
    const payload = {
      findByID: vi.fn().mockResolvedValue({ id: 'prod-1' }),
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      update: vi.fn().mockResolvedValue({}),
    }
    const retryService = {
      execute: vi.fn((fn: () => Promise<unknown>) => fn()),
    }
    const apiClient = {
      getProduct: vi.fn().mockResolvedValue({ data: { name: 'snapshot-1' } }),
      insertProductInput: vi.fn().mockResolvedValue({}),
    }

    resolveIdentity.mockReturnValue({ ok: true, value: identity })
    prepareProductForSync.mockResolvedValue({
      action: 'insert',
      input: {
        contentLanguage: 'en',
        feedLabel: 'US',
        offerId: 'SKU-1',
        productAttributes: {
          availability: 'IN_STOCK',
          imageLink: 'https://example.com/image.jpg',
          link: 'https://example.com/product',
          title: 'Product 1',
        },
      },
      product: { id: 'prod-1' },
    })
    validateRequiredProductInput.mockReturnValue([])

    const result = await pushProduct({
      apiClient: apiClient as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: retryService as never,
    })

    expect(result).toEqual({
      action: 'insert',
      productId: 'prod-1',
      snapshot: { name: 'snapshot-1' },
      success: true,
    })
    expect(payload.update).toHaveBeenCalledTimes(2)
    expect(payload.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({
        [MC_FIELD_GROUP_NAME]: expect.objectContaining({
          syncMeta: expect.objectContaining({
            lastAction: 'saveSync',
            lastError: null,
            state: 'syncing',
            syncSource: 'push',
          }),
        }),
      }),
    }))
    expect(payload.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({
        [MC_FIELD_GROUP_NAME]: expect.objectContaining({
          [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: expect.any(Object),
          snapshot: { name: 'snapshot-1' },
          syncMeta: expect.objectContaining({
            dirty: false,
            lastAction: 'saveSync',
            lastError: null,
            lastSyncedAt: expect.any(String),
            state: 'success',
            syncSource: 'push',
          }),
        }),
      }),
    }))
    expect(apiClient.insertProductInput).toHaveBeenCalledWith(
      expect.objectContaining({
        offerId: 'SKU-1',
      }),
      payload,
      undefined,
    )
  })

  test('pushProduct marks the record as error when validation fails', async () => {
    const identity = buildIdentity()
    const payload = {
      findByID: vi.fn().mockResolvedValue({ id: 'prod-2' }),
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      update: vi.fn().mockResolvedValue({}),
    }

    resolveIdentity.mockReturnValue({ ok: true, value: identity })
    prepareProductForSync.mockResolvedValue({
      action: 'insert',
      input: {
        contentLanguage: 'en',
        feedLabel: 'US',
        offerId: 'SKU-2',
        productAttributes: {
          title: 'Missing fields',
        },
      },
      product: { id: 'prod-2' },
    })
    validateRequiredProductInput.mockReturnValue(['link', 'imageLink', 'availability'])

    const result = await pushProduct({
      apiClient: {
        getProduct: vi.fn(),
        insertProductInput: vi.fn(),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-2',
      retryService: { execute: vi.fn() } as never,
    })

    expect(result).toEqual({
      action: 'insert',
      productId: 'prod-2',
      success: false,
    })
    expect(payload.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: {
        [MC_FIELD_GROUP_NAME]: {
          syncMeta: {
            lastError: 'Missing required fields: link, imageLink, availability',
            state: 'error',
          },
        },
      },
    }))
  })

  test('pushProduct succeeds even when snapshot refresh fails after insert', async () => {
    const identity = buildIdentity()
    const payload = {
      findByID: vi.fn().mockResolvedValue({ id: 'prod-3' }),
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      update: vi.fn().mockResolvedValue({}),
    }
    const retryService = {
      execute: vi.fn((fn: () => Promise<unknown>) => fn()),
    }
    const apiClient = {
      getProduct: vi.fn().mockRejectedValue(new Error('snapshot unavailable')),
      insertProductInput: vi.fn().mockResolvedValue({}),
    }

    resolveIdentity.mockReturnValue({ ok: true, value: identity })
    prepareProductForSync.mockResolvedValue({
      action: 'insert',
      input: {
        contentLanguage: 'en',
        feedLabel: 'US',
        offerId: 'SKU-3',
        productAttributes: {
          availability: 'IN_STOCK',
          imageLink: 'https://example.com/image.jpg',
          link: 'https://example.com/product',
          title: 'Product 3',
        },
      },
      product: { id: 'prod-3' },
    })
    validateRequiredProductInput.mockReturnValue([])

    const result = await pushProduct({
      apiClient: apiClient as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-3',
      retryService: retryService as never,
    })

    expect(result).toEqual({
      action: 'insert',
      productId: 'prod-3',
      snapshot: undefined,
      success: true,
    })
    expect(payload.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'snapshot unavailable',
        merchantProductId: identity.merchantProductId,
        operation: 'push',
        productId: 'prod-3',
      }),
      '[GMC] Failed to fetch snapshot after sync',
    )
    expect(payload.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        [MC_FIELD_GROUP_NAME]: expect.objectContaining({
          syncMeta: expect.objectContaining({
            dirty: false,
            lastAction: 'saveSync',
            lastError: null,
            lastSyncedAt: expect.any(String),
            state: 'success',
            syncSource: 'push',
          }),
        }),
      }),
    }))
  })

  test('pushProduct records an error when identity cannot be resolved', async () => {
    const payload = {
      findByID: vi.fn().mockResolvedValue({ id: 'prod-4' }),
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      update: vi.fn().mockResolvedValue({}),
    }

    resolveIdentity.mockReturnValue({
      errors: ['offerId is required'],
      ok: false,
    })

    const result = await pushProduct({
      apiClient: {
        getProduct: vi.fn(),
        insertProductInput: vi.fn(),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-4',
      retryService: { execute: vi.fn() } as never,
    })

    expect(result).toEqual({
      action: 'insert',
      productId: 'prod-4',
      success: false,
    })
    expect(prepareProductForSync).not.toHaveBeenCalled()
    expect(payload.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: {
        [MC_FIELD_GROUP_NAME]: {
          syncMeta: {
            lastError: 'offerId is required',
            state: 'error',
          },
        },
      },
    }))
  })

  test('pushProduct stores API response details when the insert request fails', async () => {
    const identity = buildIdentity()
    const payload = {
      findByID: vi.fn().mockResolvedValue({ id: 'prod-5' }),
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      update: vi.fn().mockResolvedValue({}),
    }

    resolveIdentity.mockReturnValue({ ok: true, value: identity })
    prepareProductForSync.mockResolvedValue({
      action: 'insert',
      input: {
        contentLanguage: 'en',
        feedLabel: 'US',
        offerId: 'SKU-5',
        productAttributes: {
          availability: 'IN_STOCK',
          imageLink: 'https://example.com/image.jpg',
          link: 'https://example.com/product',
          title: 'Product 5',
        },
      },
      product: { id: 'prod-5' },
    })
    validateRequiredProductInput.mockReturnValue([])

    const result = await pushProduct({
      apiClient: {
        getProduct: vi.fn(),
        insertProductInput: vi.fn().mockRejectedValue(
          new GoogleApiError('Bad request', 400, { code: 'INVALID_ARGUMENT' }),
        ),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-5',
      retryService: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) } as never,
    })

    expect(result).toEqual({
      action: 'insert',
      productId: 'prod-5',
      success: false,
    })
    expect(payload.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: {
        [MC_FIELD_GROUP_NAME]: {
          syncMeta: {
            lastError: 'Bad request',
            state: 'error',
          },
        },
      },
    }))
  })

  test('deleteFromMC updates sync metadata after a successful delete', async () => {
    const identity = buildIdentity()
    const payload = {
      findByID: vi.fn().mockResolvedValue({ id: 'prod-6' }),
      update: vi.fn().mockResolvedValue({}),
    }

    resolveIdentity.mockReturnValue({ ok: true, value: identity })

    const result = await deleteFromMC({
      apiClient: {
        deleteProductInput: vi.fn().mockResolvedValue({}),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-6',
      retryService: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) } as never,
    })

    expect(result).toEqual({
      action: 'delete',
      productId: 'prod-6',
      success: true,
    })
    expect(payload.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: {
        [MC_FIELD_GROUP_NAME]: {
          snapshot: null,
          syncMeta: {
            lastError: null,
            lastSyncedAt: expect.any(String),
            state: 'success',
          },
        },
      },
    }))
  })

  test('refreshSnapshot stores the latest Merchant Center snapshot', async () => {
    const identity = buildIdentity()
    const payload = {
      findByID: vi.fn().mockResolvedValue({ id: 'prod-7' }),
      update: vi.fn().mockResolvedValue({}),
    }

    resolveIdentity.mockReturnValue({ ok: true, value: identity })

    const result = await refreshSnapshot({
      apiClient: {
        getProduct: vi.fn().mockResolvedValue({ data: { name: 'snapshot-7' } }),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-7',
      retryService: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) } as never,
    })

    expect(result).toEqual({
      action: 'update',
      productId: 'prod-7',
      snapshot: { name: 'snapshot-7' },
      success: true,
    })
    expect(payload.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        [MC_FIELD_GROUP_NAME]: expect.objectContaining({
          snapshot: { name: 'snapshot-7' },
          syncMeta: expect.objectContaining({
            lastAction: 'refresh',
            lastError: null,
            state: 'success',
            syncSource: 'pull',
          }),
        }),
      }),
    }))
  })

  test('deleteFromMCByIdentity treats 404 responses as already deleted', async () => {
    const result = await deleteFromMCByIdentity({
      apiClient: {
        deleteProductInput: vi.fn().mockRejectedValue(
          new GoogleApiError('Not found', 404, { error: 'gone' }),
        ),
      } as never,
      identity: buildIdentity(),
      options: buildOptions(),
      payload: {} as never,
      productId: 'prod-3',
      retryService: {
        execute: vi.fn((fn: () => Promise<unknown>) => fn()),
      } as never,
    })

    expect(result).toEqual({
      action: 'delete',
      productId: 'prod-3',
      success: true,
    })
  })
})
