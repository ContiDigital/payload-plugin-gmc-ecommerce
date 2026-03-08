import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions, ResolvedMCIdentity } from '../../../types/index.js'

import { MC_FIELD_GROUP_NAME } from '../../../constants.js'

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
const { runInitialSync } = await import('../initialSync.js')

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

describe('runInitialSync', () => {
  beforeEach(() => {
    prepareProductForSync.mockReset()
    validateRequiredProductInput.mockReset()
    resolveIdentity.mockReset()
  })

  test('syncs eligible products through the shared preparation pipeline', async () => {
    const identity = buildIdentity()
    const payload = {
      find: vi.fn().mockResolvedValue({
        docs: [{ id: 'prod-1', [MC_FIELD_GROUP_NAME]: {} }],
        hasNextPage: false,
        totalDocs: 1,
      }),
      update: vi.fn().mockResolvedValue({}),
    }
    const apiClient = {
      getProduct: vi.fn()
        .mockRejectedValueOnce(new GoogleApiError('Not found', 404))
        .mockResolvedValueOnce({ data: { name: 'snapshot-1' } }),
      insertProductInput: vi.fn().mockResolvedValue({}),
    }
    const rateLimiter = {
      execute: vi.fn((fn: () => Promise<unknown>) => fn()),
    }
    const retryService = {
      execute: vi.fn((fn: () => Promise<unknown>) => fn()),
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

    const report = await runInitialSync({
      apiClient: apiClient as never,
      options: buildOptions(),
      payload: payload as never,
      rateLimiter: rateLimiter as never,
      retryService: retryService as never,
    })

    expect(report).toMatchObject({
      existingRemote: 0,
      failed: 0,
      processed: 1,
      status: 'completed',
      succeeded: 1,
      total: 1,
    })
    expect(prepareProductForSync).toHaveBeenCalledWith(expect.objectContaining({
      identity,
      payload,
      product: { id: 'prod-1', [MC_FIELD_GROUP_NAME]: {} },
    }))
    expect(payload.update).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        [MC_FIELD_GROUP_NAME]: {
          snapshot: { name: 'snapshot-1' },
          syncMeta: {
            lastAction: 'initialSync',
            lastError: null,
            lastSyncedAt: expect.any(String),
            state: 'success',
            syncSource: 'initial',
          },
        },
      },
    }))
  })
})
