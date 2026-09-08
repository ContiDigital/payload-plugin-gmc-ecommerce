import { describe, expect, it, vi } from 'vitest'

import type { GmcAsyncAdapter, PayloadGmcEcommerceV2Options } from '../types.js'

import { hasDefaultPluginAccess } from '../../server/utilities/access.js'
import { normalizeGmcV2Options } from '../config.js'

const dispatch = vi.fn(() => Promise.resolve({ operationId: 'op-1', state: 'queued' as const }))
const getOperation = vi.fn(() => Promise.resolve(null))
const health = vi.fn(() =>
  Promise.resolve({
    checkedAt: '2026-08-29T12:00:00.000Z',
    status: 'ok' as const,
  }),
)
const minimalAdapter: GmcAsyncAdapter = { name: 'test-adapter', dispatch, getOperation, health }

const baseOptions: PayloadGmcEcommerceV2Options = {
  access: () => true,
  async: minimalAdapter,
  dataSourceId: '987654321',
  getCredentials: () =>
    Promise.resolve({
      type: 'json',
      credentials: { client_email: 'merchant@example.com', private_key: 'secret' },
    }),
  merchantId: '123456',
  products: {
    collection: 'products',
    project: () => ({ products: [], sourceVersion: '1' }),
    resolveIdentities: () => [],
  },
  workerAccess: () => true,
}

const validOptions = (): PayloadGmcEcommerceV2Options => ({
  ...baseOptions,
  async: { ...minimalAdapter, capabilities: {} },
  feeds: [
    {
      id: 'primary',
      access: 'public',
      delivery: 'dynamic',
      path: '/feeds/google.tsv',
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    },
  ],
  products: { ...baseOptions.products },
})

describe('normalizeGmcV2Options', () => {
  it('accepts an adapter with only dispatch/getOperation/health', () => {
    const options = normalizeGmcV2Options({
      ...baseOptions,
      async: { name: 'x', dispatch, getOperation, health },
    })
    expect(options.async.name).toBe('x')
  })

  it('ignores rc.35 capability flags', () => {
    const capabilities = { durable: true, globalSourceVersion: true }
    const options = normalizeGmcV2Options({
      ...baseOptions,
      async: { ...minimalAdapter, capabilities },
    })
    expect(options.async.name).toBe('test-adapter')
    expect(options.async.dispatch).toBe(dispatch)
    expect(options.async.getOperation).toBe(getOperation)
    expect(options.async.health).toBe(health)
    expect(options.async.capabilities).toBe(capabilities)
  })

  it('drops the deprecated productIngestion option from the normalized value', () => {
    // It is accepted so a 1.x config still loads, and ignored; leaving it on
    // the object would contradict NormalizedGmcV2Options at runtime.
    const options = normalizeGmcV2Options({
      ...baseOptions,
      productIngestion: { mode: 'api-primary' },
    })
    expect('productIngestion' in options).toBe(false)
  })

  it('defaults feeds to an empty array', () => {
    expect(normalizeGmcV2Options({ ...baseOptions, feeds: undefined }).feeds).toEqual([])
  })

  it('requires workerAccess only when the worker endpoint is exposed', () => {
    expect(() => normalizeGmcV2Options({ ...baseOptions, workerAccess: undefined })).not.toThrow()
    expect(() =>
      normalizeGmcV2Options({
        ...baseOptions,
        api: { exposeWorkerEndpoint: true },
        workerAccess: undefined,
      }),
    ).toThrow(/workerAccess/)
  })

  it('still requires scheduledDelivery for scheduleAt dependencies', () => {
    expect(() =>
      normalizeGmcV2Options({
        ...baseOptions,
        catalogDependencies: [{ collection: 'promos', scheduleAt: () => [], select: () => null }],
      }),
    ).toThrow(/scheduledDelivery/)
  })

  it('defaults requireTransaction to false and access to the default plugin access', () => {
    const options = normalizeGmcV2Options({ ...baseOptions, access: undefined })
    expect(options.requireTransaction).toBe(false)
    expect(options.access).toBe(hasDefaultPluginAccess)
  })

  it('requires immutable artifact read-back before promotion', () => {
    const options = validOptions()
    options.feeds = [
      {
        ...options.feeds![0],
        artifactStore: {
          promote: vi.fn(),
          put: vi.fn(),
          readCurrent: vi.fn(),
          readCurrentDescriptor: vi.fn(),
        },
        delivery: 'artifact',
      } as never,
    ]

    expect(() => normalizeGmcV2Options(options)).toThrow(/put, read, promote.*readCurrent/i)
  })

  it('normalizes resource names, feed paths, and bounded defaults', () => {
    const normalized = normalizeGmcV2Options(validOptions())

    expect(normalized.dataSourceName).toBe('accounts/123456/dataSources/987654321')
    expect(normalized.products.batchSize).toBe(100)
    expect(normalized.products.fetchDepth).toBe(1)
    expect(normalized.products.maxCatalogPages).toBe(10_000)
    expect(normalized.products.remotePageSize).toBe(250)
    expect(normalized.rateLimit.maxConcurrency).toBe(4)
    expect(normalized.reconciliation.orphanDeletion).toBe('disabled')
  })

  it('rejects ambiguous feed routing', () => {
    const options = validOptions()
    options.feeds!.push({
      id: 'second',
      access: 'public',
      delivery: 'dynamic',
      path: '/feeds/google.tsv',
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    })
    expect(() => normalizeGmcV2Options(options)).toThrow(/duplicate feed path/i)
  })

  it('rejects feed endpoints inside the reserved API namespace', () => {
    const options = validOptions()
    options.api = { basePath: '/merchant/v2' }
    options.feeds![0] = {
      ...options.feeds![0],
      path: '/merchant/v2/operations/feed.tsv',
    }

    expect(() => normalizeGmcV2Options(options)).toThrow(/outside the API base path/i)
  })

  it('requires static API and feed paths', () => {
    const dynamicFeed = validOptions()
    dynamicFeed.feeds![0] = { ...dynamicFeed.feeds![0], path: '/feeds/:tenant/google.tsv' }
    expect(() => normalizeGmcV2Options(dynamicFeed)).toThrow(/feed .* path must be static/i)

    const dynamicApi = validOptions()
    dynamicApi.api = { basePath: '/merchant/:tenant' }
    expect(() => normalizeGmcV2Options(dynamicApi)).toThrow(/api.basePath must be static/i)
  })

  it('rejects unsafe resource IDs, artifact keys, and unbounded coordinators', () => {
    const unsafeMerchant = validOptions()
    unsafeMerchant.merchantId = '../other-account'
    expect(() => normalizeGmcV2Options(unsafeMerchant)).toThrow(/URL-safe resource ID/i)

    const nonNumericDataSource = validOptions()
    nonNumericDataSource.dataSourceId = 'data-source-1'
    expect(() => normalizeGmcV2Options(nonNumericDataSource)).toThrow(/canonical int64/i)

    const overflowingMerchant = validOptions()
    overflowingMerchant.merchantId = '9223372036854775808'
    expect(() => normalizeGmcV2Options(overflowingMerchant)).toThrow(/canonical int64/i)

    const unsafeFeed = validOptions()
    unsafeFeed.feeds![0].id = '../feed'
    expect(() => normalizeGmcV2Options(unsafeFeed)).toThrow(/object-key safe/i)

    const dotFeed = validOptions()
    dotFeed.feeds![0].id = '..'
    expect(() => normalizeGmcV2Options(dotFeed)).toThrow(/object-key safe/i)

    const dotInstance = validOptions()
    dotInstance.instanceId = '..'
    expect(() => normalizeGmcV2Options(dotInstance)).toThrow(/instanceId/i)

    const unsafeFormat = validOptions()
    unsafeFormat.feeds![0].format = { id: '..', serialize: vi.fn() }
    expect(() => normalizeGmcV2Options(unsafeFormat)).toThrow(/format.id/i)

    const unbounded = validOptions()
    unbounded.products.batchSize = 1_001
    expect(() => normalizeGmcV2Options(unbounded)).toThrow(/no greater than 1000/i)
  })

  it('rejects an out-of-range remote reconcile page size', () => {
    const tooLarge = validOptions()
    tooLarge.products.remotePageSize = 1_001
    expect(() => normalizeGmcV2Options(tooLarge)).toThrow(/products.remotePageSize.*no greater than 1000/i)

    const tooSmall = validOptions()
    tooSmall.products.remotePageSize = 0
    expect(() => normalizeGmcV2Options(tooSmall)).toThrow(/products.remotePageSize/i)
  })

  it('allows inert non-numeric resource placeholders only while disabled', () => {
    const options = validOptions()
    options.disabled = true
    options.merchantId = 'merchant-not-configured'
    options.dataSourceId = 'data-source-not-configured'

    expect(normalizeGmcV2Options(options)).toMatchObject({
      dataSourceId: 'data-source-not-configured',
      disabled: true,
      merchantId: 'merchant-not-configured',
    })
  })

  it('validates optional boolean and distributed limiter boundaries', () => {
    const options = validOptions() as unknown as Record<string, unknown>
    options.disabled = 'yes'
    expect(() => normalizeGmcV2Options(options as never)).toThrow(/disabled must be a boolean/i)

    const limiter = validOptions()
    limiter.rateLimit = { store: {} as never }
    expect(() => normalizeGmcV2Options(limiter)).toThrow(/store.claimSlot is required/i)

    const reconciliation = validOptions()
    reconciliation.reconciliation = { orphanDeletion: 'delete-everything' as never }
    expect(() => normalizeGmcV2Options(reconciliation)).toThrow(/exclusive-data-sources/i)
  })

  it('rejects malformed nested configuration', () => {
    const primitiveRateLimit = validOptions() as unknown as Record<string, unknown>
    primitiveRateLimit.rateLimit = 'defaults-please'
    expect(() => normalizeGmcV2Options(primitiveRateLimit as never)).toThrow(
      /rateLimit must be an object/i,
    )

    const primitiveLimits = validOptions() as unknown as {
      feeds: Array<Record<string, unknown>>
    }
    primitiveLimits.feeds[0].limits = 'unbounded'
    expect(() => normalizeGmcV2Options(primitiveLimits as never)).toThrow(
      /feeds\[\]\.limits must be an object/i,
    )
  })

  it('normalizes Business Profile store codes and enforces the published 64-character limit', () => {
    const options = validOptions()
    options.localInventory = {
      project: () => [],
      storeCodes: [' store-1 ', 'x'.repeat(64)],
    }
    expect(normalizeGmcV2Options(options).localInventory).toMatchObject({
      storeCodes: ['store-1', 'x'.repeat(64)],
    })

    options.localInventory.storeCodes = ['x'.repeat(65)]
    expect(() => normalizeGmcV2Options(options)).toThrow(/1-64 safe characters/i)
  })

  it('normalizes retired stores and forbids ambiguous active/retired ownership', () => {
    const options = validOptions()
    options.localInventory = {
      project: () => [],
      retiredStoreCodes: [' old-store '],
      storeCodes: ['active-store'],
    }
    expect(normalizeGmcV2Options(options).localInventory).toMatchObject({
      retiredStoreCodes: ['old-store'],
      storeCodes: ['active-store'],
    })

    options.localInventory.retiredStoreCodes = ['active-store']
    expect(() => normalizeGmcV2Options(options)).toThrow(/both active and retired/i)
  })

  it('allows final-store retirement and a schema-stable inactive store set', () => {
    const options = validOptions()
    options.localInventory = {
      project: () => [],
      retiredStoreCodes: [' final-store '],
      storeCodes: [],
    }

    expect(normalizeGmcV2Options(options).localInventory).toMatchObject({
      retiredStoreCodes: ['final-store'],
      storeCodes: [],
    })

    options.localInventory.retiredStoreCodes = []
    expect(normalizeGmcV2Options(options).localInventory).toMatchObject({
      retiredStoreCodes: [],
      storeCodes: [],
    })
  })

  it('requires durable scheduled delivery for time-dependent catalog dependencies', () => {
    const options = validOptions()
    options.catalogDependencies = [
      {
        collection: 'promos',
        scheduleAt: ({ doc }) => [String(doc.startDate)],
        select: ({ doc }) => doc.title,
      },
    ]
    expect(() => normalizeGmcV2Options(options)).toThrow(/scheduledDelivery/i)

    options.async.capabilities!.scheduledDelivery = true
    expect(normalizeGmcV2Options(options).catalogDependencies).toHaveLength(1)

    options.catalogDependencies[0].resolveProductIds = 'unsafe' as never
    expect(() => normalizeGmcV2Options(options)).toThrow(/resolveProductIds must be a function/i)
  })

  it('validates canonical Global dependencies and publication collection slugs', () => {
    const options = validOptions()
    options.catalogGlobalDependencies = [
      {
        global: 'merchantRules',
        scheduleAt: ({ doc }) => [String(doc.nextBoundary)],
        select: ({ doc }) => doc.enabled,
      },
    ]
    expect(() => normalizeGmcV2Options(options)).toThrow(/scheduledDelivery/i)

    options.async.capabilities!.scheduledDelivery = true
    expect(normalizeGmcV2Options(options).catalogGlobalDependencies).toHaveLength(1)

    options.catalogGlobalDependencies.push({
      global: 'merchantRules',
      select: () => null,
    })
    expect(() => normalizeGmcV2Options(options)).toThrow(/duplicate catalog Global/i)

    const invalidResolver = validOptions()
    invalidResolver.catalogGlobalDependencies = [
      {
        global: 'merchantRules',
        resolveProductIds: 'unsafe' as never,
        select: () => null,
      },
    ]
    expect(() => normalizeGmcV2Options(invalidResolver)).toThrow(
      /resolveProductIds must be a function/i,
    )

    const unsafeSlug = validOptions()
    unsafeSlug.publicationState = { collectionSlug: 'unsafe.slug' }
    expect(() => normalizeGmcV2Options(unsafeSlug)).toThrow(/collectionSlug must start/i)
  })
})
