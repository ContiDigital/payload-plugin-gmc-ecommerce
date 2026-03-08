import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions, ResolvedMCIdentity } from '../../../types/index.js'

import { MC_FIELD_GROUP_NAME, MC_PRODUCT_ATTRIBUTES_FIELD_NAME } from '../../../constants.js'

const applyFieldMappings = vi.fn()
const resolveGoogleCategory = vi.fn()
const buildProductInput = vi.fn()

vi.mock('../categoryResolver.js', () => ({
  resolveGoogleCategory,
}))

vi.mock('../fieldMapping.js', async () => {
  const actual = await vi.importActual('../fieldMapping.js')
  return {
    ...actual,
    applyFieldMappings,
  }
})

vi.mock('../transformers.js', () => ({
  buildProductInput,
}))

const {
  loadMergedFieldMappings,
  prepareProductForSync,
  validateRequiredProductInput,
} = await import('../productPreparation.js')

const buildOptions = (overrides?: Partial<NormalizedPluginOptions>): NormalizedPluginOptions => ({
  access: () => Promise.resolve(true),
  admin: { mode: 'route', navLabel: 'GMC', route: '/merchant-center' },
  api: { basePath: '/gmc' },
  collections: {
    products: {
      slug: 'products' as never,
      autoInjectTab: true,
      fetchDepth: 1,
      fieldMappings: [
        {
          source: 'title',
          syncMode: 'permanent',
          target: 'productAttributes.title',
        },
      ],
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

describe('productPreparation', () => {
  beforeEach(() => {
    applyFieldMappings.mockReset()
    buildProductInput.mockReset()
    resolveGoogleCategory.mockReset()
  })

  test('loadMergedFieldMappings combines config and runtime mappings', async () => {
    const payload = {
      find: vi.fn().mockResolvedValue({
        docs: [{
          order: 5,
          source: 'description',
          syncMode: 'initialOnly',
          target: 'productAttributes.description',
          transformPreset: 'toString',
        }],
      }),
    }

    const mappings = await loadMergedFieldMappings(payload as never, buildOptions())

    expect(mappings).toHaveLength(2)
    expect(mappings[0]?.target).toBe('productAttributes.title')
    expect(mappings[1]).toMatchObject({
      source: 'description',
      syncMode: 'initialOnly',
      target: 'productAttributes.description',
      transformPreset: 'toString',
    })
  })

  test('prepareProductForSync merges mappings, category resolution, and beforePush overrides', async () => {
    const payload = {
      find: vi.fn().mockResolvedValue({ docs: [] }),
    }
    const beforePush = vi.fn().mockResolvedValue({
      contentLanguage: 'en',
      feedLabel: 'US',
      offerId: 'SKU-1',
      productAttributes: {
        availability: 'IN_STOCK',
        color: 'blue',
        googleProductCategory: 'Arts & Entertainment',
        link: 'https://example.com/product',
        title: 'Before Push Title',
      },
    })

    applyFieldMappings.mockReturnValue({
      productAttributes: {
        color: 'red',
        title: 'Mapped Title',
      },
    })
    resolveGoogleCategory.mockResolvedValue({
      googleProductCategory: 'Arts & Entertainment',
      productTypes: [{ value: 'Art > Painting' }],
    })
    buildProductInput.mockReturnValue({
      contentLanguage: 'en',
      feedLabel: 'US',
      offerId: 'SKU-1',
      productAttributes: {
        availability: 'IN_STOCK',
        color: 'red',
        title: 'Mapped Title',
      },
    })

    const result = await prepareProductForSync({
      identity: buildIdentity(),
      options: buildOptions({ beforePush }),
      payload: payload as never,
      product: {
        id: 'prod-1',
        [MC_FIELD_GROUP_NAME]: {
          [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: {
            availability: 'IN_STOCK',
            snapshot: { existing: true },
          },
          snapshot: { existing: true },
        },
        sku: 'SKU-1',
        title: 'Source Title',
      },
    })

    expect(result.action).toBe('update')
    expect(result.product[MC_FIELD_GROUP_NAME]).toMatchObject({
      [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: {
        availability: 'IN_STOCK',
        color: 'red',
        googleProductCategory: 'Arts & Entertainment',
        productTypes: [{ value: 'Art > Painting' }],
        snapshot: { existing: true },
        title: 'Mapped Title',
      },
    })
    expect(beforePush).toHaveBeenCalledWith(expect.objectContaining({
      doc: expect.objectContaining({
        [MC_FIELD_GROUP_NAME]: expect.objectContaining({
          [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: expect.objectContaining({
            color: 'red',
            googleProductCategory: 'Arts & Entertainment',
          }),
        }),
      }),
      operation: 'update',
      payload,
    }))
    expect(result.input.productAttributes?.title).toBe('Before Push Title')
  })

  test('validateRequiredProductInput reports missing required fields', () => {
    expect(validateRequiredProductInput({
      contentLanguage: 'en',
      feedLabel: 'US',
      offerId: 'SKU-1',
      productAttributes: {
        title: 'Only title',
      },
    })).toEqual(['link', 'imageLink', 'availability'])
  })
})
