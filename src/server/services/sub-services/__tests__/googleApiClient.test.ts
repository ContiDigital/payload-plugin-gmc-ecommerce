import { generateKeyPairSync } from 'crypto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'
import type { GoogleApiError } from '../googleApiClient.js'

import { createGoogleApiClient } from '../googleApiClient.js'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const buildOptions = (): NormalizedPluginOptions => ({
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
      credentials: {
        client_email: 'merchant-sync@example.com',
        private_key: privateKeyPem,
      },
    }),
  merchantId: '123',
  rateLimit: {
    baseRetryDelayMs: 100,
    enabled: true,
    jitterFactor: 0,
    maxConcurrency: 2,
    maxQueueSize: 10,
    maxRequestsPerMinute: 60,
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

describe('createGoogleApiClient', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('caches exchanged access tokens across API requests', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-1',
        expires_in: 3600,
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'product-1' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ products: [] }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))

    const client = createGoogleApiClient(buildOptions())

    await expect(client.getProduct('accounts/123/products/en~US~SKU-1', null)).resolves.toEqual({
      data: { name: 'product-1' },
      status: 200,
    })
    await expect(client.listProducts(null, 25)).resolves.toEqual({
      data: { products: [] },
      status: 200,
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://oauth2.googleapis.com/token')
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://merchantapi.googleapis.com/products/v1/accounts/123/products/en~US~SKU-1',
    )
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      'https://merchantapi.googleapis.com/products/v1/accounts/123/products?pageSize=25',
    )
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: 'Bearer access-1',
      }),
      method: 'GET',
    })
  })

  test('resets the token cache and re-authenticates on the next request', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-1',
        expires_in: 3600,
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-2',
        expires_in: 3600,
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    const client = createGoogleApiClient(buildOptions())

    await client.deleteProductInput('accounts/123/productInputs/en~US~SKU-1', null)
    client.resetTokenCache()
    await client.deleteProductInput('accounts/123/productInputs/en~US~SKU-1', null)

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://oauth2.googleapis.com/token')
  })

  test('throws GoogleApiError when Merchant API requests fail', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-1',
        expires_in: 3600,
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'bad request' },
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 400,
      }))

    const client = createGoogleApiClient(buildOptions())

    await expect(client.reportQuery('SELECT * FROM product_view', null)).rejects.toEqual(
      expect.objectContaining<Partial<GoogleApiError>>({
        name: 'GoogleApiError',
        responseBody: { error: { message: 'bad request' } },
        statusCode: 400,
      }),
    )
  })
})
