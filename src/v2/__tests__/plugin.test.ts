import type { Config } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { PayloadGmcEcommerceV2Options } from '../types.js'

import { payloadGmcEcommerceV2 } from '../plugin.js'

const options = (
  overrides: Partial<PayloadGmcEcommerceV2Options> = {},
): PayloadGmcEcommerceV2Options => ({
  access: () => true,
  async: {
    name: 'test-adapter',
    dispatch: vi.fn(() =>
      Promise.resolve({ operationId: 'operation-1', state: 'queued' as const }),
    ),
    getOperation: vi.fn(() => Promise.resolve(null)),
    health: vi.fn(() =>
      Promise.resolve({
        checkedAt: '2026-08-29T12:00:00.000Z',
        status: 'ok' as const,
      }),
    ),
  },
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
      credentials: { client_email: 'merchant@example.com', private_key: 'secret' },
    }),
  merchantId: '123456',
  products: {
    collection: 'products',
    project: () => ({ products: [], sourceVersion: '1' }),
    resolveIdentities: () => [],
  },
  ...overrides,
})

describe('payloadGmcEcommerceV2', () => {
  it('preserves host fields, hooks, endpoints, and adds isolated operational state', () => {
    const existingHook = vi.fn()
    const existingBeforeHook = vi.fn()
    const existingEndpoint = { handler: vi.fn(), method: 'get' as const, path: '/existing' }
    const fields = [{ name: 'title', type: 'text' as const }]
    const input = {
      collections: [
        {
          slug: 'products',
          fields,
          hooks: { afterChange: [existingHook], beforeChange: [existingBeforeHook] },
        },
      ],
      endpoints: [existingEndpoint],
    } as unknown as Config
    const configured = payloadGmcEcommerceV2(options({ requireTransaction: true }))(input) as Config
    const product = configured.collections?.find((collection) => collection.slug === 'products')
    const state = configured.collections?.find(
      (collection) => collection.slug === 'gmc-publications-v2',
    )

    expect(product?.fields).toBe(fields)
    expect(product?.fields).toHaveLength(1)
    expect(product?.hooks?.afterChange?.[0]).toBe(existingHook)
    expect(product?.hooks?.afterChange).toHaveLength(2)
    expect(product?.hooks?.afterDelete).toHaveLength(1)
    expect(product?.hooks?.beforeChange?.[0]).not.toBe(existingBeforeHook)
    expect(product?.hooks?.beforeChange?.[1]).toBe(existingBeforeHook)
    expect(product?.hooks?.beforeDelete).toHaveLength(1)
    expect(state).toMatchObject({ admin: { hidden: true }, versions: false })
    expect(configured.endpoints?.[0]).toBe(existingEndpoint)
    expect(
      configured.endpoints?.some((endpoint) => endpoint.path === '/gmc/v2/catalog/publish'),
    ).toBe(true)
    expect(configured.endpoints?.some((endpoint) => endpoint.path === '/feeds/google.tsv')).toBe(
      true,
    )
  })

  it('attaches plugin-owned hooks to declared canonical dependency collections', () => {
    const input = {
      collections: [
        { slug: 'products', fields: [] },
        { slug: 'promos', fields: [], hooks: { afterChange: [vi.fn()] } },
      ],
    } as unknown as Config
    const configured = payloadGmcEcommerceV2(
      options({
        async: {
          ...options().async,
          capabilities: {
            ...options().async.capabilities,
            scheduledDelivery: true,
          },
        },
        catalogDependencies: [
          {
            collection: 'promos',
            scheduleAt: ({ doc }) => [String(doc.startDate)],
            select: ({ doc }) => doc.title,
          },
        ],
        requireTransaction: true,
      }),
    )(input) as Config
    const promos = configured.collections?.find((collection) => collection.slug === 'promos')

    expect(promos?.hooks?.afterChange).toHaveLength(2)
    expect(promos?.hooks?.afterDelete).toHaveLength(1)
    expect(promos?.hooks?.beforeChange).toHaveLength(1)
    expect(promos?.hooks?.beforeDelete).toHaveLength(1)
  })

  it('attaches plugin-owned hooks to declared canonical dependency Globals', () => {
    const existingHook = vi.fn()
    const input = {
      collections: [{ slug: 'products', fields: [] }],
      globals: [
        {
          slug: 'merchantRules',
          fields: [],
          hooks: { afterChange: [existingHook] },
        },
      ],
    } as unknown as Config
    const configured = payloadGmcEcommerceV2(
      options({
        catalogGlobalDependencies: [
          {
            global: 'merchantRules',
            select: ({ doc }) => ({ enabled: doc.enabled }),
          },
        ],
        requireTransaction: true,
      }),
    )(input) as Config

    expect(configured.globals?.[0]?.hooks?.afterChange?.[0]).toBe(existingHook)
    expect(configured.globals?.[0]?.hooks?.afterChange).toHaveLength(2)
    expect(configured.globals?.[0]?.hooks?.beforeChange).toHaveLength(1)
  })

  it('keeps schema stable while disabled but installs no active hooks or endpoints', () => {
    const input = { collections: [{ slug: 'products', fields: [] }] } as unknown as Config
    const configured = payloadGmcEcommerceV2(options({ disabled: true }))(input) as Config
    const product = configured.collections?.find((collection) => collection.slug === 'products')

    expect(
      configured.collections?.some((collection) => collection.slug === 'gmc-publications-v2'),
    ).toBe(true)
    expect(product?.hooks?.afterChange).toBeUndefined()
    expect(product?.hooks?.beforeChange).toBeUndefined()
    expect(configured.endpoints).toEqual([])
  })

  it('does not install the fail-closed transaction hooks when requireTransaction is left at its default', () => {
    const input = { collections: [{ slug: 'products', fields: [] }] } as unknown as Config
    const configured = payloadGmcEcommerceV2(options())(input) as Config
    const product = configured.collections?.find((collection) => collection.slug === 'products')

    expect(product?.hooks?.afterChange).toHaveLength(1)
    expect(product?.hooks?.afterDelete).toHaveLength(1)
    expect(product?.hooks?.beforeChange).toEqual([])
    expect(product?.hooks?.beforeDelete).toEqual([])
  })

  it('installs isolated durable local-inventory causal state when configured', () => {
    const input = { collections: [{ slug: 'products', fields: [] }] } as unknown as Config
    const configured = payloadGmcEcommerceV2(
      options({
        localInventory: {
          project: () => [],
          storeCodes: ['store-1'],
        },
      }),
    )(input) as Config

    expect(
      configured.collections?.find(
        (collection) => collection.slug === 'gmc-local-inventory-publications-v2',
      ),
    ).toMatchObject({ admin: { hidden: true }, versions: false })
  })

  it('keeps local-inventory state schema stable while its store set is inactive', () => {
    const input = { collections: [{ slug: 'products', fields: [] }] } as unknown as Config
    const configured = payloadGmcEcommerceV2(
      options({
        disabled: true,
        localInventory: {
          project: () => [],
          retiredStoreCodes: [],
          storeCodes: [],
        },
      }),
    )(input) as Config

    expect(
      configured.collections?.find(
        (collection) => collection.slug === 'gmc-local-inventory-publications-v2',
      ),
    ).toMatchObject({ admin: { hidden: true }, versions: false })
    expect(configured.endpoints).toEqual([])
  })

  it('fails explicitly on collection and endpoint collisions', () => {
    expect(() =>
      payloadGmcEcommerceV2(options())({
        collections: [
          { slug: 'products', fields: [] },
          { slug: 'gmc-publications-v2', fields: [] },
        ],
      } as unknown as Config),
    ).toThrow(/publication collection slug/i)

    expect(() =>
      payloadGmcEcommerceV2(
        options({
          localInventory: {
            project: () => [],
            storeCodes: ['store-1'],
          },
        }),
      )({
        collections: [
          { slug: 'products', fields: [] },
          { slug: 'gmc-local-inventory-publications-v2', fields: [] },
        ],
      } as unknown as Config),
    ).toThrow(/local-inventory publication collection slug/i)

    expect(() =>
      payloadGmcEcommerceV2(options())({
        collections: [{ slug: 'products', fields: [] }],
        endpoints: [{ handler: vi.fn(), method: 'post', path: '/gmc/v2/catalog/publish' }],
      } as unknown as Config),
    ).toThrow(/endpoint collision/i)

    expect(() =>
      payloadGmcEcommerceV2(options())({
        collections: [{ slug: 'products', fields: [] }],
        endpoints: [{ handler: vi.fn(), method: 'get', path: '/gmc/v2/operations/:id' }],
      } as unknown as Config),
    ).toThrow(/endpoint collision/i)

    expect(() =>
      payloadGmcEcommerceV2(options())({
        collections: [{ slug: 'products', fields: [] }],
        endpoints: [{ handler: vi.fn(), method: 'post', path: '/gmc/*' }],
      } as unknown as Config),
    ).toThrow(/endpoint collision/i)

    expect(() =>
      payloadGmcEcommerceV2(options())({
        collections: [{ slug: 'products', fields: [] }],
        endpoints: [{ handler: vi.fn(), method: 'get', path: '/feeds/:feed?' }],
      } as unknown as Config),
    ).toThrow(/endpoint collision/i)

    expect(() =>
      payloadGmcEcommerceV2(
        options({
          catalogDependencies: [{ collection: 'missing', select: () => null }],
        }),
      )({
        collections: [{ slug: 'products', fields: [] }],
      } as unknown as Config),
    ).toThrow(/dependency collection missing/i)

    expect(() =>
      payloadGmcEcommerceV2(
        options({
          catalogGlobalDependencies: [{ global: 'missing', select: () => null }],
        }),
      )({
        collections: [{ slug: 'products', fields: [] }],
        globals: [],
      } as unknown as Config),
    ).toThrow(/dependency Global missing/i)
  })

  it('calls the adapter install hook and keeps its added collection', () => {
    const input = { collections: [{ slug: 'products', fields: [] }] } as unknown as Config
    const install = vi.fn((args: { config: Config }) => ({
      ...args.config,
      collections: [
        ...(args.config.collections ?? []),
        { slug: 'adapter-owned-collection', fields: [] },
      ],
    }))
    const configured = payloadGmcEcommerceV2(
      options({ async: { ...options().async, install } }),
    )(input) as Config

    expect(install).toHaveBeenCalledTimes(1)
    expect(
      configured.collections?.some(
        (collection) => collection.slug === 'adapter-owned-collection',
      ),
    ).toBe(true)
  })
})
