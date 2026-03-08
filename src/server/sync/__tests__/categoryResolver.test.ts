import { describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions, PayloadProductDoc } from '../../../types/index.js'

const { resolveGoogleCategory } = await import('../categoryResolver.js')

const buildOptions = (): NormalizedPluginOptions => ({
  access: () => Promise.resolve(true),
  admin: { mode: 'route', navLabel: 'GMC', route: '/merchant-center' },
  api: { basePath: '/gmc' },
  collections: {
    categories: {
      slug: 'categories' as never,
      googleCategoryIdField: 'googleCategoryId',
      nameField: 'title',
      parentField: 'parent',
      productCategoryField: 'categories',
      productTypeField: 'fullTitle',
    },
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
    feedLabel: 'PRODUCTS',
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
})

describe('categoryResolver', () => {
  test('keeps prebuilt breadcrumb fields as-is instead of duplicating parent traversal', async () => {
    const payload = {
      findByID: vi.fn().mockResolvedValue({
        id: 'cat-1',
        fullTitle: 'Jewelry > Rings > Engagement Rings',
        googleCategoryId: '188',
        parent: 'cat-parent',
      }),
    }

    const result = await resolveGoogleCategory({
      id: 'prod-1',
      categories: ['cat-1'],
    } as PayloadProductDoc, buildOptions(), payload as never)

    expect(result).toEqual({
      googleProductCategory: '188',
      productTypes: ['Jewelry > Rings > Engagement Rings'],
    })
    expect(payload.findByID).toHaveBeenCalledTimes(1)
  })

  test('walks parent relationships when the category field is only a leaf label', async () => {
    const payload = {
      findByID: vi.fn()
        .mockResolvedValueOnce({
          id: 'leaf',
          googleCategoryId: '499972',
          parent: 'parent',
          title: 'Dining Chairs',
        })
        .mockResolvedValueOnce({
          id: 'parent',
          parent: 'root',
          title: 'Chairs',
        })
        .mockResolvedValueOnce({
          id: 'root',
          parent: undefined,
          title: 'Furniture',
        }),
    }

    const options = buildOptions()
    options.collections.categories = {
      ...options.collections.categories!,
      productTypeField: 'title',
    }

    const result = await resolveGoogleCategory({
      id: 'prod-2',
      categories: ['leaf'],
    } as PayloadProductDoc, options, payload as never)

    expect(result).toEqual({
      googleProductCategory: '499972',
      productTypes: ['Furniture > Chairs > Dining Chairs'],
    })
    expect(payload.findByID).toHaveBeenCalledTimes(3)
  })
})
