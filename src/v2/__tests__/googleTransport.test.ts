import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PayloadGmcEcommerceV2Options } from '../types.js'

const googleClient = vi.hoisted(() => ({
  deleteLocalInventory: vi.fn(),
  deleteProductInput: vi.fn(),
  getDataSource: vi.fn(),
  getProduct: vi.fn(),
  insertLocalInventory: vi.fn(),
  insertProductInput: vi.fn(),
  listProducts: vi.fn(),
}))

vi.mock('../../server/services/sub-services/googleApiClient.js', () => {
  class GoogleApiError extends Error {
    readonly statusCode: number

    constructor(message: string, statusCode: number) {
      super(message)
      this.name = 'GoogleApiError'
      this.statusCode = statusCode
    }
  }

  return {
    createGoogleApiClient: () => googleClient,
    GoogleApiError,
  }
})

const { GoogleApiError } = await import('../../server/services/sub-services/googleApiClient.js')
const { normalizeGmcV2Options } = await import('../config.js')
const { getProcessedProductName, getProductInputName } = await import('../identity.js')
const { createGoogleMerchantTransport } = await import('../transport/googleTransport.js')

const identity = { contentLanguage: 'en', feedLabel: 'US', offerId: 'sku-1' }
const payload = {} as Payload

const options = (): PayloadGmcEcommerceV2Options => ({
  access: () => true,
  async: {
    name: 'transport-test',
    capabilities: {
      delivery: 'at-least-once',
      durable: true,
        exclusiveCatalogReconciliation: true,
      globalSourceVersion: true,
      orderedBySubject: true,
      transactionAware: true,
      workflowStatus: true,
    },
    dispatch: () => Promise.resolve({ operationId: 'unused', state: 'queued' }),
    getOperation: () => Promise.resolve(null),
    health: () => Promise.resolve({ checkedAt: new Date().toISOString(), status: 'ok' }),
  },
  dataSourceId: '987654321',
  feeds: [
    {
      id: 'primary',
      access: 'public',
      delivery: 'dynamic',
      path: '/feed.tsv',
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    },
  ],
  getCredentials: () =>
    Promise.resolve({
      type: 'json',
      credentials: { client_email: 'test@example.com', private_key: 'unused' },
    }),
  merchantId: '123456',
  productIngestion: { mode: 'api-primary' },
  products: {
    collection: 'products',
    project: () => ({ products: [], sourceVersion: '1' }),
    resolveIdentities: () => [],
  },
  workerAccess: () => true,
})

describe('Google Merchant v2 transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    googleClient.deleteLocalInventory.mockResolvedValue(undefined)
    googleClient.deleteProductInput.mockResolvedValue(undefined)
    googleClient.getDataSource.mockResolvedValue({
      data: {
        name: 'accounts/123456/dataSources/987654321',
        dataSourceId: '987654321',
        input: 'API',
        primaryProductDataSource: {},
      },
    })
    googleClient.getProduct.mockResolvedValue({ data: {} })
    googleClient.insertLocalInventory.mockResolvedValue(undefined)
    googleClient.insertProductInput.mockResolvedValue(undefined)
    googleClient.listProducts.mockResolvedValue({ data: { products: [] } })
  })

  it('maps complete ProductInput insert/delete requests to the configured source', async () => {
    const normalized = normalizeGmcV2Options(options())
    const transport = createGoogleMerchantTransport(normalized)
    const input = {
      contentLanguage: 'en',
      feedLabel: 'US',
      offerId: 'sku-1',
      versionNumber: '1',
    }

    await transport.insertProductInput({
      dataSourceName: normalized.dataSourceName,
      input,
      payload,
    })
    await transport.deleteProductInput({
      dataSourceName: normalized.dataSourceName,
      identity,
      payload,
    })

    expect(googleClient.insertProductInput).toHaveBeenCalledWith(
      input,
      payload,
      normalized.dataSourceName,
    )
    expect(googleClient.deleteProductInput).toHaveBeenCalledWith(
      getProductInputName(identity, normalized.merchantId),
      payload,
      normalized.dataSourceName,
    )
  })

  it('requires a matching API-backed primary product data source', async () => {
    const normalized = normalizeGmcV2Options(options())
    const transport = createGoogleMerchantTransport(normalized)

    await expect(
      transport.getApiPrimaryDataSource({
        dataSourceName: normalized.dataSourceName,
        payload,
      }),
    ).resolves.toEqual({ name: normalized.dataSourceName, input: 'API' })
    expect(googleClient.getDataSource).toHaveBeenCalledWith(normalized.dataSourceName, payload)

    googleClient.getDataSource.mockResolvedValueOnce({
      data: {
        name: normalized.dataSourceName,
        dataSourceId: normalized.dataSourceId,
        input: 'FILE',
        primaryProductDataSource: {},
      },
    })
    await expect(
      transport.getApiPrimaryDataSource({
        dataSourceName: normalized.dataSourceName,
        payload,
      }),
    ).rejects.toMatchObject({ code: 'GMC_API_PRIMARY_DATA_SOURCE_REQUIRED' })

    googleClient.getDataSource.mockResolvedValueOnce({
      data: {
        name: normalized.dataSourceName,
        dataSourceId: normalized.dataSourceId,
        input: 'API',
        supplementalProductDataSource: {},
      },
    })
    await expect(
      transport.getApiPrimaryDataSource({
        dataSourceName: normalized.dataSourceName,
        payload,
      }),
    ).rejects.toMatchObject({ code: 'GMC_API_PRIMARY_DATA_SOURCE_REQUIRED' })
  })

  it('treats only delete/get 404 as idempotent absence', async () => {
    const normalized = normalizeGmcV2Options(options())
    const transport = createGoogleMerchantTransport(normalized)
    googleClient.deleteProductInput.mockRejectedValueOnce(new GoogleApiError('missing', 404))
    googleClient.getProduct.mockRejectedValueOnce(new GoogleApiError('missing', 404))

    await expect(
      transport.deleteProductInput({
        dataSourceName: normalized.dataSourceName,
        identity,
        payload,
      }),
    ).resolves.toBeUndefined()
    await expect(transport.getProcessedProduct({ identity, payload })).resolves.toBeNull()

    googleClient.deleteProductInput.mockRejectedValueOnce(new GoogleApiError('forbidden', 403))
    await expect(
      transport.deleteProductInput({
        dataSourceName: normalized.dataSourceName,
        identity,
        payload,
      }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('validates and maps processed products, status, versions, and source routing', async () => {
    const normalized = normalizeGmcV2Options(options())
    const transport = createGoogleMerchantTransport(normalized)
    const remote = {
      name: 'accounts/123456/products/en~US~sku-1',
      contentLanguage: 'en',
      dataSource: 'accounts/123456/dataSources/111111',
      feedLabel: 'US',
      offerId: 'sku-1',
      productStatus: { destinationStatuses: [] },
      versionNumber: '7',
    }
    googleClient.getProduct.mockResolvedValueOnce({ data: remote })
    googleClient.listProducts.mockResolvedValueOnce({
      data: { nextPageToken: 'next', products: [remote] },
    })

    await expect(transport.getProcessedProduct({ identity, payload })).resolves.toMatchObject({
      dataSourceName: remote.dataSource,
      identity: { ...identity, dataSourceOverride: remote.dataSource },
      productStatus: remote.productStatus,
      versionNumber: '7',
    })
    await expect(
      transport.listProcessedProducts({
        pageSize: 50,
        pageToken: 'page',
        payload,
      }),
    ).resolves.toMatchObject({
      nextPageToken: 'next',
      products: [expect.objectContaining({ dataSourceName: remote.dataSource })],
    })
    expect(googleClient.getProduct).toHaveBeenCalledWith(
      getProcessedProductName(identity, normalized.merchantId),
      payload,
    )

    googleClient.getProduct.mockResolvedValueOnce({ data: { name: 'incomplete' } })
    await expect(transport.getProcessedProduct({ identity, payload })).rejects.toThrow(
      /missing contentLanguage/i,
    )

    googleClient.getProduct.mockResolvedValueOnce({
      data: { ...remote, name: 'accounts/123456/products/en~US~different' },
    })
    await expect(transport.getProcessedProduct({ identity, payload })).rejects.toThrow(
      /invalid identity or resource name/i,
    )
  })

  it('defaults the list page size to 250 processed products', async () => {
    const normalized = normalizeGmcV2Options(options())
    const transport = createGoogleMerchantTransport(normalized)

    await transport.listProcessedProducts({ payload })

    expect(googleClient.listProducts).toHaveBeenCalledWith(payload, 250, undefined)
  })

  it('fails closed on malformed or oversized Merchant list pages', async () => {
    const transport = createGoogleMerchantTransport(normalizeGmcV2Options(options()))
    await expect(transport.listProcessedProducts({ pageSize: 1_001, payload })).rejects.toThrow(
      /pageSize must be between/i,
    )

    googleClient.listProducts.mockResolvedValueOnce({
      data: { nextPageToken: 7, products: [] },
    })
    await expect(transport.listProcessedProducts({ pageSize: 10, payload })).rejects.toThrow(
      /invalid nextPageToken/i,
    )

    googleClient.listProducts.mockResolvedValueOnce({
      data: { nextPageToken: 'same', products: [] },
    })
    await expect(
      transport.listProcessedProducts({ pageSize: 10, pageToken: 'same', payload }),
    ).rejects.toThrow(/token did not advance/i)

    googleClient.listProducts.mockResolvedValueOnce({
      data: {
        products: [
          {
            name: 'accounts/999999/products/encoded',
            contentLanguage: 'en',
            dataSource: 'accounts/999999/dataSources/111111',
            feedLabel: 'US',
            offerId: 'sku-1',
          },
        ],
      },
    })
    await expect(transport.listProcessedProducts({ pageSize: 10, payload })).rejects.toThrow(
      /invalid identity or resource name/i,
    )
  })

  it('encodes store routes and treats local-inventory delete 404 as success', async () => {
    const normalized = normalizeGmcV2Options(options())
    const transport = createGoogleMerchantTransport(normalized)
    const inventory = {
      localInventoryAttributes: { availability: 'IN_STOCK' as const },
      storeCode: 'New York/1',
    }

    await transport.insertLocalInventory({ identity, inventory, payload })
    googleClient.deleteLocalInventory.mockRejectedValueOnce(new GoogleApiError('missing', 404))
    await transport.deleteLocalInventory({
      identity,
      payload,
      storeCode: inventory.storeCode,
    })

    const productName = getProcessedProductName(identity, normalized.merchantId)
    expect(googleClient.insertLocalInventory).toHaveBeenCalledWith(productName, inventory, payload)
    expect(googleClient.deleteLocalInventory).toHaveBeenCalledWith(
      productName,
      'New%20York%2F1',
      payload,
    )
  })
})
