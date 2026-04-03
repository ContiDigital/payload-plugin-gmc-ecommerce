import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions, ResolvedMCIdentity } from '../../../types/index.js'

import { GoogleApiError } from '../../services/sub-services/googleApiClient.js'
import { reconcileLocalInventory, resolveLocalAvailability, syncLocalInventory } from '../localInventorySync.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const buildOptions = (overrides?: Partial<NormalizedPluginOptions['localInventory']>): NormalizedPluginOptions => ({
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
  defaults: { condition: 'NEW', contentLanguage: 'en', currency: 'USD', feedLabel: 'US' },
  disabled: false,
  getCredentials: () => Promise.resolve({ type: 'json' as const, credentials: { client_email: 'x', private_key: 'k' } }),
  localInventory: { enabled: true, storeCode: 'bonita-springs-01', ...overrides },
  merchantId: '123',
  rateLimit: {
    baseRetryDelayMs: 100, enabled: true, jitterFactor: 0, maxConcurrency: 2,
    maxQueueSize: 10, maxRequestsPerMinute: 120, maxRetries: 1, maxRetryDelayMs: 1000, requestTimeoutMs: 5000,
  },
  siteUrl: 'https://example.com',
  sync: {
    conflictStrategy: 'mc-wins',
    initialSync: { batchSize: 50, dryRun: false, enabled: true, onlyIfRemoteMissing: true },
    mode: 'manual', permanentSync: true,
    schedule: { apiKey: '', cron: '0 4 * * *', strategy: 'external' },
    scheduleCron: '0 4 * * *',
  },
})

const buildIdentity = (): ResolvedMCIdentity => ({
  contentLanguage: 'en',
  dataSourceName: 'accounts/123/dataSources/ds-123',
  feedLabel: 'US',
  merchantProductId: 'en~US~SKU-001',
  offerId: 'SKU-001',
  productInputName: 'accounts/123/productInputs/en~US~SKU-001',
  productName: 'accounts/123/products/en~US~SKU-001',
})

const mockApiClient = {
  deleteLocalInventory: vi.fn().mockResolvedValue({ data: undefined, status: 204 }),
  insertLocalInventory: vi.fn().mockResolvedValue({ data: {}, status: 200 }),
  listLocalInventories: vi.fn().mockResolvedValue({ data: { localInventories: [] }, status: 200 }),
}

const mockRetryService = {
  execute: vi.fn((fn: () => Promise<unknown>) => fn()),
}

const mockPayload = {
  find: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// resolveLocalAvailability
// ---------------------------------------------------------------------------

describe('resolveLocalAvailability', () => {
  it('returns in_stock when MC availability is IN_STOCK', () => {
    const product = { mc: { attrs: { availability: 'IN_STOCK' } } }
    const result = resolveLocalAvailability(product, buildOptions())
    expect(result).toBe('in_stock')
  })

  it('returns null when MC availability is OUT_OF_STOCK', () => {
    const product = { mc: { attrs: { availability: 'OUT_OF_STOCK' } } }
    const result = resolveLocalAvailability(product, buildOptions())
    expect(result).toBeNull()
  })

  it('returns null when no mc attrs present', () => {
    const product = {}
    const result = resolveLocalAvailability(product, buildOptions())
    expect(result).toBeNull()
  })

  it('uses custom availabilityResolver when provided', () => {
    const resolver = vi.fn().mockReturnValue('in_stock')
    const product = { stockStatus: 'in-stock' }
    const options = buildOptions({ availabilityResolver: resolver })
    const result = resolveLocalAvailability(product, options)
    expect(result).toBe('in_stock')
    expect(resolver).toHaveBeenCalledWith(product)
  })

  it('custom resolver returning null removes local inventory', () => {
    const resolver = vi.fn().mockReturnValue(null)
    const product = { stockStatus: 'pending-sale' }
    const options = buildOptions({ availabilityResolver: resolver })
    const result = resolveLocalAvailability(product, options)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// syncLocalInventory
// ---------------------------------------------------------------------------

describe('syncLocalInventory', () => {
  it('inserts local inventory for in-stock product', async () => {
    const result = await syncLocalInventory({
      apiClient: mockApiClient as never,
      identity: buildIdentity(),
      localAvailability: 'in_stock',
      options: buildOptions(),
      payload: mockPayload as never,
      price: { amountMicros: '5990000', currencyCode: 'USD' },
      productId: 'prod-1',
      retryService: mockRetryService as never,
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('insert')
    expect(result.storeCode).toBe('bonita-springs-01')
    expect(mockApiClient.insertLocalInventory).toHaveBeenCalledWith(
      'accounts/123/products/en~US~SKU-001',
      {
        localInventoryAttributes: {
          availability: 'IN_STOCK',
          price: { amountMicros: '5990000', currencyCode: 'USD' },
        },
        storeCode: 'bonita-springs-01',
      },
      expect.anything(),
    )
  })

  it('includes pickupSla when pickup config is set', async () => {
    const options = buildOptions({ pickup: { sla: 'MULTI_WEEK' } })

    await syncLocalInventory({
      apiClient: mockApiClient as never,
      identity: buildIdentity(),
      localAvailability: 'in_stock',
      options,
      payload: mockPayload as never,
      productId: 'prod-1',
      retryService: mockRetryService as never,
    })

    expect(mockApiClient.insertLocalInventory).toHaveBeenCalledWith(
      expect.anything(),
      {
        localInventoryAttributes: expect.objectContaining({
          availability: 'IN_STOCK',
          pickupSla: 'MULTI_WEEK',
        }),
        storeCode: 'bonita-springs-01',
      },
      expect.anything(),
    )
  })

  it('includes specific day pickupSla', async () => {
    const options = buildOptions({ pickup: { sla: 'SIX_DAY' } })

    await syncLocalInventory({
      apiClient: mockApiClient as never,
      identity: buildIdentity(),
      localAvailability: 'in_stock',
      options,
      payload: mockPayload as never,
      productId: 'prod-1',
      retryService: mockRetryService as never,
    })

    expect(mockApiClient.insertLocalInventory).toHaveBeenCalledWith(
      expect.anything(),
      {
        localInventoryAttributes: expect.objectContaining({ pickupSla: 'SIX_DAY' }),
        storeCode: 'bonita-springs-01',
      },
      expect.anything(),
    )
  })

  it('deletes local inventory for non-in-stock product', async () => {
    const result = await syncLocalInventory({
      apiClient: mockApiClient as never,
      identity: buildIdentity(),
      localAvailability: null,
      options: buildOptions(),
      payload: mockPayload as never,
      productId: 'prod-1',
      retryService: mockRetryService as never,
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('delete')
    expect(mockApiClient.deleteLocalInventory).toHaveBeenCalledWith(
      'accounts/123/products/en~US~SKU-001',
      'bonita-springs-01',
      expect.anything(),
    )
  })

  it('treats 404 on delete as success', async () => {
    mockApiClient.deleteLocalInventory.mockRejectedValueOnce(
      new GoogleApiError('Not found', 404),
    )

    const result = await syncLocalInventory({
      apiClient: mockApiClient as never,
      identity: buildIdentity(),
      localAvailability: null,
      options: buildOptions(),
      payload: mockPayload as never,
      productId: 'prod-1',
      retryService: mockRetryService as never,
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('delete')
  })

  it('returns error on API failure (non-critical)', async () => {
    mockApiClient.insertLocalInventory.mockRejectedValueOnce(
      new GoogleApiError('Rate limited', 429),
    )

    const result = await syncLocalInventory({
      apiClient: mockApiClient as never,
      identity: buildIdentity(),
      localAvailability: 'in_stock',
      options: buildOptions(),
      payload: mockPayload as never,
      productId: 'prod-1',
      retryService: mockRetryService as never,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Rate limited')
  })

  it('returns error when local inventory not configured', async () => {
    const options = buildOptions()
    options.localInventory = { enabled: false, storeCode: '' }

    const result = await syncLocalInventory({
      apiClient: mockApiClient as never,
      identity: buildIdentity(),
      localAvailability: 'in_stock',
      options,
      payload: mockPayload as never,
      productId: 'prod-1',
      retryService: mockRetryService as never,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('not configured')
  })

  it('does not include price when not provided', async () => {
    await syncLocalInventory({
      apiClient: mockApiClient as never,
      identity: buildIdentity(),
      localAvailability: 'in_stock',
      options: buildOptions(),
      payload: mockPayload as never,
      productId: 'prod-1',
      retryService: mockRetryService as never,
    })

    const body = mockApiClient.insertLocalInventory.mock.calls[0][1]
    expect(body.storeCode).toBe('bonita-springs-01')
    expect(body.localInventoryAttributes.availability).toBe('IN_STOCK')
    expect(body.localInventoryAttributes.price).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// reconcileLocalInventory
// ---------------------------------------------------------------------------

describe('reconcileLocalInventory', () => {
  it('returns zeros when local inventory is disabled', async () => {
    const options = buildOptions()
    options.localInventory = { enabled: false, storeCode: '' }

    const report = await reconcileLocalInventory({
      apiClient: mockApiClient as never,
      options,
      payload: mockPayload as never,
      retryService: mockRetryService as never,
    })

    expect(report).toEqual({ deleted: 0, errors: 0, inserted: 0, processed: 0, total: 0 })
  })

  it('inserts for in-stock products and deletes for out-of-stock', async () => {
    mockPayload.find.mockResolvedValueOnce({
      docs: [
        {
          id: '1',
          mc: {
            attrs: { availability: 'IN_STOCK', price: { amountMicros: '1000000', currencyCode: 'USD' } },
            enabled: true,
            identity: { contentLanguage: 'en', feedLabel: 'US', offerId: 'SKU-1' },
          },
        },
        {
          id: '2',
          mc: {
            attrs: { availability: 'OUT_OF_STOCK' },
            enabled: true,
            identity: { contentLanguage: 'en', feedLabel: 'US', offerId: 'SKU-2' },
          },
        },
      ],
      hasNextPage: false,
      totalDocs: 2,
    })

    const report = await reconcileLocalInventory({
      apiClient: mockApiClient as never,
      options: buildOptions(),
      payload: mockPayload as never,
      retryService: mockRetryService as never,
    })

    expect(report.inserted).toBe(1)
    expect(report.deleted).toBe(1)
    expect(report.errors).toBe(0)
    expect(report.processed).toBe(2)
  })

  it('skips products without identity', async () => {
    mockPayload.find.mockResolvedValueOnce({
      docs: [{ id: '1', mc: { enabled: true } }],
      hasNextPage: false,
      totalDocs: 1,
    })

    const report = await reconcileLocalInventory({
      apiClient: mockApiClient as never,
      options: buildOptions(),
      payload: mockPayload as never,
      retryService: mockRetryService as never,
    })

    expect(report.processed).toBe(1)
    expect(report.inserted).toBe(0)
    expect(report.deleted).toBe(0)
  })

  it('calls onProgress callback', async () => {
    // Create 30 products to trigger progress (every 25)
    const docs = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      mc: {
        attrs: { availability: 'IN_STOCK' },
        enabled: true,
        identity: { contentLanguage: 'en', feedLabel: 'US', offerId: `SKU-${i}` },
      },
    }))

    mockPayload.find.mockResolvedValueOnce({ docs, hasNextPage: false, totalDocs: 30 })

    const onProgress = vi.fn()
    await reconcileLocalInventory({
      apiClient: mockApiClient as never,
      onProgress,
      options: buildOptions(),
      payload: mockPayload as never,
      retryService: mockRetryService as never,
    })

    expect(onProgress).toHaveBeenCalled()
  })
})
