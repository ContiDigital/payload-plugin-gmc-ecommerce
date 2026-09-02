import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions, ResolvedMCIdentity } from '../../../types/index.js'
import type { WrittenRow } from './helpers/payloadDouble.js'

import {
  MC_FIELD_GROUP_NAME,
  MC_IDENTITY_OFFER_ID_PATH,
  MC_PRODUCT_ATTRIBUTES_FIELD_NAME,
} from '../../../constants.js'
import { buildPayloadDouble, buildRow, writtenMC, writtenRow } from './helpers/payloadDouble.js'

const checkPullConflict = vi.fn()
const extractMCProductLastModified = vi.fn()
const productAttributesContainRemoteSubset = vi.fn()
const resolveIdentity = vi.fn()
const reverseTransformProduct = vi.fn()

vi.mock('../conflictResolver.js', () => ({
  checkPullConflict,
  extractMCProductLastModified,
}))

vi.mock('../identityResolver.js', () => ({
  resolveIdentity,
}))

vi.mock('../transformers.js', () => ({
  productAttributesContainRemoteSubset,
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
    extractMCProductLastModified.mockReset()
    productAttributesContainRemoteSubset.mockReset()
    productAttributesContainRemoteSubset.mockReturnValue(false)
    resolveIdentity.mockReset()
    reverseTransformProduct.mockReset()
  })

  test('pullProduct updates local state from Merchant Center when conflicts allow it', async () => {
    const payload = buildPayloadDouble({
      doc: {
        id: 'prod-1',
        [MC_FIELD_GROUP_NAME]: { syncMeta: { dirty: false } },
      },
    })
    const retryService = {
      execute: vi.fn((fn: () => Promise<unknown>) => fn()),
    }

    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    checkPullConflict.mockReturnValue({ action: 'proceed' })
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
    expect(payload.update).not.toHaveBeenCalled()
    expect(writtenMC(payload)).toMatchObject({
      customAttributes: [
        { id: expect.stringMatching(/^[0-9a-f]{24}$/), name: 'material', value: 'gold' },
      ],
      enabled: true,
      identity: {
        contentLanguage: 'en',
        feedLabel: 'US',
        offerId: 'SKU-1',
      },
      [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: {
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
        lastError: null,
        lastSyncedAt: expect.any(String),
        state: 'success',
        syncSource: 'pull',
      },
    })
    // A pull rewrites Merchant Center state; the document's own content is not
    // its business.
    expect(writtenRow(payload)).toMatchObject({ _status: 'published', title: 'Live title' })
  })

  test('does not clear a dirty flag it never saw, and invalidates any in-flight push token', async () => {
    // The conflict decision was made against a document read before the
    // Merchant Center round-trip. If the product was saved since, the pull is
    // not entitled to declare it clean — and a push still in flight must not
    // be able to certify content the pull has just overwritten.
    const row = buildRow()
    ;(row[MC_FIELD_GROUP_NAME] as WrittenRow).syncMeta = {
      dirty: true,
      state: 'syncing',
      syncToken: 'token-from-an-in-flight-push',
    }
    const payload = buildPayloadDouble({
      doc: { id: 'prod-1', [MC_FIELD_GROUP_NAME]: { syncMeta: { dirty: false } } },
      rowsById: { 'prod-1': row },
    })

    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    checkPullConflict.mockReturnValue({ action: 'proceed' })
    reverseTransformProduct.mockReturnValue({ customAttributes: [], productAttributes: {} })

    const result = await pullProduct({
      apiClient: { getProduct: vi.fn().mockResolvedValue({ data: { name: 'remote' } }) } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) } as never,
    })

    expect(writtenMC(payload).syncMeta).toMatchObject({ dirty: true, syncToken: null })
    expect(result.warning).toMatch(/changed while/i)
  })

  test('merges remote data onto the live attributes, not the ones it read before fetching', async () => {
    // An editor changes an MC attribute while the fetch is in flight. Merging
    // against the document the pull started from would erase that value even
    // though the fresh row is right there.
    const payload = buildPayloadDouble({
      doc: {
        id: 'prod-1',
        [MC_FIELD_GROUP_NAME]: {
          [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: { brand: 'Stale brand' },
          syncMeta: { dirty: false },
        },
      },
    })

    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    checkPullConflict.mockReturnValue({ action: 'proceed' })
    reverseTransformProduct.mockReturnValue({
      customAttributes: [],
      productAttributes: { title: 'Remote Title' },
    })

    await pullProduct({
      apiClient: {
        getProduct: vi.fn().mockImplementation(async () => {
          const current = (await payload.db.findOne({
            collection: 'products',
            where: { id: { equals: 'prod-1' } },
          } as never)) as WrittenRow

          await payload.db.updateOne({
            id: 'prod-1',
            collection: 'products',
            data: {
              ...current,
              [MC_FIELD_GROUP_NAME]: {
                ...current[MC_FIELD_GROUP_NAME],
                [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: { brand: 'Edited during the fetch' },
              },
            },
          } as never)

          return { data: { name: 'remote' } }
        }),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) } as never,
    })

    expect(writtenMC(payload)[MC_PRODUCT_ATTRIBUTES_FIELD_NAME]).toEqual({
      brand: 'Edited during the fetch',
      title: 'Remote Title',
    })
  })

  test('pullProduct reports failure when the pulled state could not be persisted', async () => {
    const payload = buildPayloadDouble({
      doc: { id: 'prod-1', [MC_FIELD_GROUP_NAME]: { syncMeta: { dirty: false } } },
      row: null,
    })

    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    checkPullConflict.mockReturnValue({ action: 'proceed' })
    reverseTransformProduct.mockReturnValue({ customAttributes: [], productAttributes: {} })

    const result = await pullProduct({
      apiClient: {
        getProduct: vi.fn().mockResolvedValue({ data: { name: 'remote' } }),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) } as never,
    })

    expect(result.success).toBe(false)
    expect(result.warning).toMatch(/could not be recorded/)
  })

  test('pullProduct skips updates when the conflict strategy says so', async () => {
    const payload = {
      findByID: vi.fn().mockResolvedValue({
        id: 'prod-2',
        [MC_FIELD_GROUP_NAME]: {
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
      ...buildPayloadDouble({ rowsById: { 'prod-3': buildRow({ id: 'prod-3' }) } }),
      find: vi.fn().mockResolvedValue({
        docs: [{
          id: 'prod-3',
          [MC_FIELD_GROUP_NAME]: {
            syncMeta: { dirty: false },
          },
          sku: 'SKU-3',
        }],
      }),
    }

    checkPullConflict.mockReturnValue({ action: 'proceed' })
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
    expect(payload.update).not.toHaveBeenCalled()
    expect(writtenMC(payload)).toMatchObject({
      customAttributes: [
        { id: expect.stringMatching(/^[0-9a-f]{24}$/), name: 'artist', value: 'Example' },
      ],
      enabled: true,
      identity: {
        contentLanguage: 'en',
        feedLabel: 'US',
        offerId: 'SKU-3',
      },
      [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: {
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
    })
  })

  test('pullAll matches per-product identity overrides before falling back to the global identity field', async () => {
    const payload = {
      ...buildPayloadDouble({ rowsById: { 'prod-override': buildRow({ id: 'prod-override' }) } }),
      find: vi.fn()
        .mockResolvedValueOnce({
          docs: [{
            id: 'prod-override',
            [MC_FIELD_GROUP_NAME]: {
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

    checkPullConflict.mockReturnValue({ action: 'proceed' })
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
        [MC_IDENTITY_OFFER_ID_PATH]: { equals: 'REMOTE-1' },
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
