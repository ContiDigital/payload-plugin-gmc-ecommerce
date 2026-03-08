import { describe, expect, test } from 'vitest'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { createBeforeChangeHook } from '../beforeChange.js'

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
    mode: 'manual',
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

describe('createBeforeChangeHook', () => {
  test('marks previously enabled products as dirty even when merchantCenter is omitted from the update', () => {
    const hook = createBeforeChangeHook(mockOptions())
    const data = { title: 'Updated title' }

    const result = hook({
      collection: {} as never,
      context: {},
      data,
      operation: 'update',
      originalDoc: {
        id: '1',
        merchantCenter: {
          enabled: true,
          identity: { offerId: 'SKU-1' },
          syncMeta: { dirty: false, state: 'success' },
        },
        sku: 'SKU-1',
        title: 'Original title',
      },
      req: {} as never,
    }) as Record<string, unknown>

    const mcState = result.merchantCenter as Record<string, unknown>
    const syncMeta = mcState.syncMeta as Record<string, unknown>
    expect(syncMeta.dirty).toBe(true)
  })

  test('auto-populates offerId from the identity field when sync is enabled', () => {
    const hook = createBeforeChangeHook(mockOptions())
    const result = hook({
      collection: {} as never,
      context: {},
      data: {
        merchantCenter: {
          enabled: true,
        },
        sku: 'SKU-2',
      },
      operation: 'create',
      req: {} as never,
    }) as Record<string, unknown>

    expect(
      ((result.merchantCenter as Record<string, unknown>).identity as Record<string, unknown>).offerId,
    ).toBe('SKU-2')
  })

  test('applies permanent mappings from the merged document state', () => {
    const hook = createBeforeChangeHook(
      mockOptions({
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
      }),
    )

    const result = hook({
      collection: {} as never,
      context: {},
      data: {
        title: 'Mapped Title',
      },
      operation: 'update',
      originalDoc: {
        id: '1',
        merchantCenter: {
          enabled: true,
          productAttributes: {
            description: 'Keep me',
          },
        },
        sku: 'SKU-1',
        title: 'Original',
      },
      req: {} as never,
    }) as Record<string, unknown>

    expect(
      ((result.merchantCenter as Record<string, unknown>).productAttributes as Record<string, unknown>).title,
    ).toBe('Mapped Title')
    expect(
      ((result.merchantCenter as Record<string, unknown>).productAttributes as Record<string, unknown>).description,
    ).toBe('Keep me')
  })

  test('skips dirty tracking for internal sync updates', () => {
    const hook = createBeforeChangeHook(mockOptions())
    const result = hook({
      collection: {} as never,
      context: { 'gmc:skip-sync-hooks': true },
      data: {
        merchantCenter: {
          enabled: true,
        },
        sku: 'SKU-3',
      },
      operation: 'update',
      originalDoc: {
        id: '1',
        merchantCenter: {
          enabled: true,
          syncMeta: { dirty: false, state: 'success' },
        },
        sku: 'SKU-3',
      },
      req: {} as never,
    }) as Record<string, unknown>

    expect(result.merchantCenter).toEqual({ enabled: true })
  })
})
