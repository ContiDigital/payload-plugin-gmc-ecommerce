import { generateKeyPairSync } from 'crypto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { GoogleApiClientOptions, GoogleApiError, GoogleTransportError } from '../googleApiClient.js'

import { createGoogleApiClient } from '../googleApiClient.js'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const buildOptions = (): GoogleApiClientOptions => ({
  dataSourceName: 'accounts/123/dataSources/ds-123',
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
    requestTimeoutMs: 5000,
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
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            expires_in: 3600,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'product-1' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ products: [] }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )

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

  test('reads data-source control-plane state from the Data Sources v1 sub-API', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'accounts/123/dataSources/987654321',
            dataSourceId: '987654321',
            input: 'API',
            primaryProductDataSource: {},
          }),
          { status: 200 },
        ),
      )

    const client = createGoogleApiClient(buildOptions())
    await expect(client.getDataSource('accounts/123/dataSources/987654321', null)).resolves.toEqual(
      {
        data: expect.objectContaining({ input: 'API' }),
        status: 200,
      },
    )
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://merchantapi.googleapis.com/datasources/v1/accounts/123/dataSources/987654321',
    )
  })

  test('builds the exact insert URL with a properly form-encoded dataSource query', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'accounts/1/products/en~US~sku-1' }), { status: 200 }),
      )

    const client = createGoogleApiClient({ ...buildOptions(), merchantId: '1' })
    await client.insertProductInput({}, null, 'accounts/1/dataSources/2')

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://merchantapi.googleapis.com/products/v1/accounts/1/productInputs:insert?dataSource=accounts%2F1%2FdataSources%2F2',
    )
  })

  test('builds the exact delete URL for a base64url-encoded product input name', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    const client = createGoogleApiClient({ ...buildOptions(), merchantId: '1' })
    await client.deleteProductInput(
      'accounts/1/productInputs/ZW5-VVN-c2t1LTE',
      null,
      'accounts/1/dataSources/2',
    )

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://merchantapi.googleapis.com/products/v1/accounts/1/productInputs/ZW5-VVN-c2t1LTE?dataSource=accounts%2F1%2FdataSources%2F2',
    )
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' })
  })

  test('coalesces concurrent access-token exchanges', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'product-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ products: [] }), { status: 200 }))

    const getCredentials = vi.fn(buildOptions().getCredentials)
    const client = createGoogleApiClient({ ...buildOptions(), getCredentials })

    await Promise.all([
      client.getProduct('accounts/123/products/product-1', null),
      client.listProducts(null),
    ])

    expect(getCredentials).toHaveBeenCalledTimes(1)
    expect(
      fetchMock.mock.calls.filter(([url]) => url === 'https://oauth2.googleapis.com/token'),
    ).toHaveLength(1)
  })

  test('resets the token cache and re-authenticates on the next request', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            expires_in: 3600,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-2',
            expires_in: 3600,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    const client = createGoogleApiClient(buildOptions())

    await client.deleteProductInput('accounts/123/productInputs/en~US~SKU-1', null)
    client.resetTokenCache()
    await client.deleteProductInput('accounts/123/productInputs/en~US~SKU-1', null)

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://oauth2.googleapis.com/token')
  })

  test('invalidates a rejected cached token for the quota-aware outer retry boundary', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'expired token' }), { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-2',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ products: [] }), { status: 200 }))

    const client = createGoogleApiClient(buildOptions())

    await expect(client.listProducts(null)).rejects.toMatchObject({ statusCode: 401 })
    await expect(client.listProducts(null)).resolves.toMatchObject({ status: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer access-2' }),
    })
  })

  test('throws GoogleApiError when Merchant API requests fail', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            expires_in: 3600,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  domain: 'merchantapi.googleapis.com',
                  metadata: {
                    FIELD_LOCATION: 'productInput.productAttributes.title',
                    REASON: 'INVALID_ARGUMENT_WITH_NAME',
                  },
                  reason: 'invalid',
                },
              ],
              message: 'bad request',
            },
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 400,
          },
        ),
      )

    const client = createGoogleApiClient(buildOptions())

    const error = await client.reportQuery('SELECT * FROM product_view', null).catch((caught: unknown) => caught)
    expect(error).toEqual(
      expect.objectContaining<Partial<GoogleApiError>>({
        name: 'GoogleApiError',
        apiMessage: 'bad request',
        fieldLocation: 'productInput.productAttributes.title',
        reason: 'INVALID_ARGUMENT_WITH_NAME',
        statusCode: 400,
      }),
    )
    // The raw Merchant response body must not be retained on the error — only
    // the fields extracted for classification/display. `domain` above is a
    // sibling field of the raw `details[0]` entry that was never extracted;
    // its absence proves the whole response body wasn't kept verbatim.
    expect(error).not.toHaveProperty('responseBody')
    const serialized = JSON.stringify(error)
    expect(serialized).not.toContain('responseBody')
    expect(serialized).not.toContain('merchantapi.googleapis.com')
  })

  test('wraps OAuth and Merchant fetch failures as retryable transport errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))

    const oauthClient = createGoogleApiClient(buildOptions())
    await expect(oauthClient.listProducts(null)).rejects.toEqual(
      expect.objectContaining<Partial<GoogleTransportError>>({
        name: 'GoogleTransportError',
        code: 'GMC_GOOGLE_TRANSPORT',
        message: 'Google OAuth token exchange transport failed',
      }),
    )

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockRejectedValueOnce(new TypeError('socket closed'))

    const merchantClient = createGoogleApiClient(buildOptions())
    await expect(merchantClient.listProducts(null)).rejects.toEqual(
      expect.objectContaining<Partial<GoogleTransportError>>({
        name: 'GoogleTransportError',
        code: 'GMC_GOOGLE_TRANSPORT',
        message: 'Merchant API GET accounts/123/products transport failed',
      }),
    )
  })

  test('preserves status and discards the body when Google returns a non-JSON error', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('upstream unavailable', { status: 503 }))

    const client = createGoogleApiClient(buildOptions())

    const error = await client
      .getProduct('accounts/123/products/encoded', null)
      .catch((caught: unknown) => caught)
    expect(error).toEqual(
      expect.objectContaining<Partial<GoogleApiError>>({
        name: 'GoogleApiError',
        statusCode: 503,
      }),
    )
    expect(error).not.toHaveProperty('responseBody')
  })

  test('surfaces a bounded Retry-After hint on Merchant failures', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'quota' }), {
          headers: { 'Retry-After': '7' },
          status: 429,
        }),
      )

    const client = createGoogleApiClient(buildOptions())

    await expect(client.listProducts(null)).rejects.toEqual(
      expect.objectContaining<Partial<GoogleApiError>>({
        retryAfterMs: 7_000,
        statusCode: 429,
      }),
    )
  })

  test('does not treat an empty non-2xx Merchant response as success', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { 'Content-Length': '0' },
          status: 503,
        }),
      )

    const client = createGoogleApiClient(buildOptions())

    const error = await client
      .getProduct('accounts/123/products/encoded', null)
      .catch((caught: unknown) => caught)
    expect(error).toEqual(
      expect.objectContaining<Partial<GoogleApiError>>({
        name: 'GoogleApiError',
        statusCode: 503,
      }),
    )
    expect(error).not.toHaveProperty('responseBody')
  })

  test('refuses an oversized Merchant response before parsing or retaining it', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response('small body with a hostile declared size', {
          headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) },
          status: 200,
        }),
      )

    const client = createGoogleApiClient(buildOptions())

    await expect(client.listProducts(null)).rejects.toThrow(/8388608 byte response limit/i)
  })

  test('classifies an OAuth rejection without leaking its response into the message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'credential detail',
        }),
        { status: 401 },
      ),
    )

    const client = createGoogleApiClient(buildOptions())

    await expect(client.listProducts(null)).rejects.toEqual(
      expect.objectContaining<Partial<GoogleApiError>>({
        name: 'GoogleApiError',
        message: 'Google OAuth token exchange failed',
        statusCode: 401,
      }),
    )
  })

  test('rejects unsafe OAuth token lifetimes', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'access-1', expires_in: -1 }), { status: 200 }),
    )

    const client = createGoogleApiClient(buildOptions())

    await expect(client.listProducts(null)).rejects.toThrow(/token response is malformed/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('rejects unsafe OAuth access-token bytes before constructing a request header', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'access-token\nforged', expires_in: 3600 }), {
        status: 200,
      }),
    )

    const client = createGoogleApiClient(buildOptions())

    await expect(client.listProducts(null)).rejects.toThrow(/token response is malformed/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('rejects a large but malformed private key via RSA validation before network I/O', async () => {
    const options = buildOptions()
    options.getCredentials = () =>
      Promise.resolve({
        type: 'json',
        credentials: {
          client_email: 'merchant-sync@example.com',
          private_key: 'x'.repeat(1024 * 1024 + 1),
        },
      })
    const client = createGoogleApiClient(options)

    await expect(client.listProducts(null)).rejects.toThrow(/private key is invalid/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('rejects an invalid service-account private key before network I/O', async () => {
    const options = buildOptions()
    options.getCredentials = () =>
      Promise.resolve({
        type: 'json',
        credentials: {
          client_email: 'merchant-sync@example.com',
          private_key: 'not-a-private-key',
        },
      })
    const client = createGoogleApiClient(options)

    await expect(client.listProducts(null)).rejects.toThrow(/private key is invalid/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
