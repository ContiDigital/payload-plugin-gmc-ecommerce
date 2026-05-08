import { describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions, ResolvedMCIdentity } from '../../../types/index.js'

import { MC_FIELD_GROUP_NAME, MC_PRODUCT_ATTRIBUTES_FIELD_NAME } from '../../../constants.js'

// Integration test: exercises prepareProductForSync against the REAL
// transformers (no buildProductInput mock) so we prove that a stored
// [{ url }] videoLinks array on a Payload doc is converted to the wire
// string[] shape that insertProductInput receives.

vi.mock('../categoryResolver.js', () => ({
  resolveGoogleCategory: vi.fn().mockResolvedValue(undefined),
}))

const { prepareProductForSync } = await import('../productPreparation.js')

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
    mode: 'manual',
    permanentSync: false,
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

describe('productPreparation videoLinks integration (real transformer)', () => {
  test('Payload-stored [{url}] videoLinks survive the full prep chain as wire-shape string[]', async () => {
    const payload = {
      find: vi.fn().mockResolvedValue({ docs: [] }),
    }

    const result = await prepareProductForSync({
      identity: buildIdentity(),
      options: buildOptions(),
      payload: payload as never,
      product: {
        id: 'prod-1',
        [MC_FIELD_GROUP_NAME]: {
          enabled: true,
          [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: {
            availability: 'IN_STOCK',
            imageLink: 'https://example.com/image.jpg',
            link: 'https://example.com/products/test',
            title: 'Test Product',
            videoLinks: [
              { url: 'https://example.com/v1.mp4' },
              { url: 'https://www.youtube.com/watch?v=abc' },
            ],
          },
        },
        sku: 'SKU-1',
        title: 'Test Product',
      },
    })

    expect(result.input.productAttributes?.videoLinks).toEqual([
      'https://example.com/v1.mp4',
      'https://www.youtube.com/watch?v=abc',
    ])
  })

  test('an empty [{url}] videoLinks array is stripped from the prepared input', async () => {
    const payload = {
      find: vi.fn().mockResolvedValue({ docs: [] }),
    }

    const result = await prepareProductForSync({
      identity: buildIdentity(),
      options: buildOptions(),
      payload: payload as never,
      product: {
        id: 'prod-2',
        [MC_FIELD_GROUP_NAME]: {
          enabled: true,
          [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: {
            availability: 'IN_STOCK',
            imageLink: 'https://example.com/image.jpg',
            link: 'https://example.com/products/test',
            title: 'Test Product',
            videoLinks: [],
          },
        },
        sku: 'SKU-2',
        title: 'Test Product',
      },
    })

    expect(result.input.productAttributes).not.toHaveProperty('videoLinks')
  })
})
