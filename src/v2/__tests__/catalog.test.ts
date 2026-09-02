import type { Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { GmcAsyncAdapter, PayloadGmcEcommerceV2Options } from '../types.js'

import { collectCanonicalProducts } from '../catalog.js'
import { normalizeGmcV2Options } from '../config.js'
import { GmcFeedLimitError } from '../feed/limits.js'

const asyncAdapter: GmcAsyncAdapter = {
  name: 'catalog-test-adapter',
  capabilities: {
    delivery: 'at-least-once',
    durable: true,
        exclusiveCatalogReconciliation: true,
    globalSourceVersion: true,
    orderedBySubject: true,
    transactionAware: true,
    workflowStatus: true,
  },
  dispatch: vi.fn(() => Promise.resolve({ operationId: 'operation-1', state: 'queued' as const })),
  getOperation: vi.fn(() => Promise.resolve(null)),
  health: vi.fn(() =>
    Promise.resolve({ checkedAt: '2026-08-29T12:00:00.000Z', status: 'ok' as const }),
  ),
}

const options = normalizeGmcV2Options({
  access: () => true,
  async: asyncAdapter,
  dataSourceId: '987654321',
  feeds: [
    {
      id: 'primary',
      access: 'public',
      delivery: 'dynamic',
      path: '/feeds/google.tsv',
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    },
  ],
  getCredentials: () =>
    Promise.resolve({
      type: 'json',
      credentials: { client_email: 'test@example.com', private_key: 'secret' },
    }),
  merchantId: '123456',
  productIngestion: { mode: 'api-primary' },
  products: {
    batchSize: 10,
    collection: 'products',
    project: ({ doc }) => ({
      products: [
        {
          contentLanguage: 'en',
          feedLabel: 'US',
          offerId: String(doc.id),
          productAttributes: {
            availability: 'IN_STOCK',
            description: String(doc.description),
            imageLink: 'https://example.com/image.jpg',
            link: `https://example.com/products/${String(doc.id)}`,
            price: { amountMicros: '1000000', currencyCode: 'USD' },
            title: 'Product',
          },
        },
      ],
      sourceVersion: String(doc.id),
    }),
    resolveIdentities: () => [],
  },
  workerAccess: () => true,
} satisfies PayloadGmcEcommerceV2Options)

describe('canonical catalog collection', () => {
  it('fails before a formatter can accumulate an oversized canonical projection', async () => {
    const payload = {
      find: vi.fn(() =>
        Promise.resolve({
          docs: [{ id: 1, description: 'x'.repeat(1_000) }],
        }),
      ),
    } as unknown as Payload

    await expect(
      collectCanonicalProducts({
        maxProducts: 10,
        maxProjectedBytes: 500,
        options,
        payload,
      }),
    ).rejects.toBeInstanceOf(GmcFeedLimitError)
  })

  it('bounds local scan pages even when output limits would not stop the traversal', async () => {
    const payload = {
      find: vi.fn(() =>
        Promise.resolve({
          docs: Array.from({ length: 10 }, (_, index) => ({
            id: index + 1,
            _status: 'draft',
            description: 'not projected',
          })),
        }),
      ),
    } as unknown as Payload

    await expect(
      collectCanonicalProducts({
        options: { ...options, products: { ...options.products, maxCatalogPages: 1 } },
        payload,
      }),
    ).rejects.toBeInstanceOf(GmcFeedLimitError)
    expect(payload.find).toHaveBeenCalledOnce()
  })

  it('pins projection time and may replace host versions with durable ledger order', async () => {
    const originalProject = options.products.project
    const project = vi.fn(originalProject)
    options.products.project = project
    const payload = {
      find: vi.fn(() => Promise.resolve({ docs: [{ id: 1, description: 'bounded' }] })),
    } as unknown as Payload

    try {
      const products = await collectCanonicalProducts({
        options,
        payload,
        projectionTime: '2026-08-29T12:00:00.000Z',
        sourceVersion: '2000000000000001',
      })

      expect(products[0]?.sourceVersion).toBe('2000000000000001')
      expect(project).toHaveBeenCalledWith(
        expect.objectContaining({
          projectionTime: '2026-08-29T12:00:00.000Z',
        }),
      )
    } finally {
      options.products.project = originalProject
    }
  })

  it('excludes explicit draft rows from canonical feeds while retaining draftless collections', async () => {
    const originalProject = options.products.project
    const project = vi.fn(originalProject)
    options.products.project = project
    const payload = {
      find: vi.fn(() =>
        Promise.resolve({
          docs: [
            { id: 1, _status: 'draft', description: 'unpublished' },
            { id: 2, _status: 'published', description: 'live' },
            { id: 3, description: 'collection-without-drafts' },
          ],
        }),
      ),
    } as unknown as Payload

    try {
      const products = await collectCanonicalProducts({ options, payload })

      expect(products.map((product) => product.identity.offerId)).toEqual(['2', '3'])
      expect(project).toHaveBeenCalledTimes(2)
      expect(project).not.toHaveBeenCalledWith(
        expect.objectContaining({ doc: expect.objectContaining({ id: 1 }) }),
      )
    } finally {
      options.products.project = originalProject
    }
  })

  it('rejects a non-advancing full keyset page', async () => {
    const originalBatchSize = options.products.batchSize
    options.products.batchSize = 1
    const payload = {
      find: vi.fn(() => Promise.resolve({ docs: [{ id: 1, description: 'bounded' }] })),
    } as unknown as Payload

    try {
      await expect(collectCanonicalProducts({ options, payload })).rejects.toThrow(
        /pagination did not advance/i,
      )
      expect(payload.find).toHaveBeenCalledTimes(2)
    } finally {
      options.products.batchSize = originalBatchSize
    }
  })
})
