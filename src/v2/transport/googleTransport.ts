import type { GmcMerchantTransport, GmcRemoteProduct, NormalizedGmcV2Options } from '../types.js'

import {
  createGoogleApiClient,
  GoogleApiError,
} from '../../server/services/sub-services/googleApiClient.js'
import { parseGmcApiPrimaryDataSource } from '../dataSource.js'
import { getMerchantProductId, getProcessedProductName, getProductInputName } from '../identity.js'
import { isGmcNonNegativeInt64String } from '../merchantWire.js'

const MAX_REMOTE_PAGE_SIZE = 1_000

const parseRemoteProduct = (
  value: Record<string, unknown>,
  options: NormalizedGmcV2Options,
  dataSourceNamePattern: RegExp,
): GmcRemoteProduct => {
  const required = ['contentLanguage', 'dataSource', 'feedLabel', 'name', 'offerId'] as const
  for (const field of required) {
    if (typeof value[field] !== 'string' || value[field].trim().length === 0) {
      throw new TypeError(`Merchant API product is missing ${field}`)
    }
  }
  const dataSourceName = value.dataSource as string
  const productName = value.name as string
  const productNamePrefix = `accounts/${options.merchantId}/products/`
  const identity = {
    contentLanguage: value.contentLanguage as string,
    feedLabel: value.feedLabel as string,
    offerId: value.offerId as string,
  }
  const merchantProductId = getMerchantProductId(identity)
  const resourceId = productName.slice(productNamePrefix.length)
  const encodedMerchantProductId = Buffer.from(merchantProductId, 'utf8').toString('base64url')
  if (
    !dataSourceNamePattern.test(dataSourceName) ||
    !isGmcNonNegativeInt64String(dataSourceName.split('/').at(-1)) ||
    !/^[a-z]{2}$/.test(value.contentLanguage as string) ||
    !/^[A-Z0-9_-]{1,20}$/.test(value.feedLabel as string) ||
    (value.offerId as string) !== (value.offerId as string).trim() ||
    [...(value.offerId as string)].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    }) ||
    (value.offerId as string).length > 50 ||
    !productName.startsWith(productNamePrefix) ||
    productName.length <= productNamePrefix.length ||
    productName.length > 2_048 ||
    (resourceId !== merchantProductId && resourceId !== encodedMerchantProductId) ||
    [...productName].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  ) {
    throw new TypeError('Merchant API product contains an invalid identity or resource name')
  }
  if (value.versionNumber !== undefined && !isGmcNonNegativeInt64String(value.versionNumber)) {
    throw new TypeError('Merchant API product contains an invalid versionNumber')
  }
  if (
    value.productStatus !== undefined &&
    (typeof value.productStatus !== 'object' ||
      value.productStatus === null ||
      Array.isArray(value.productStatus))
  ) {
    throw new TypeError('Merchant API product contains an invalid productStatus')
  }
  return {
    name: productName,
    dataSourceName,
    identity: {
      contentLanguage: identity.contentLanguage,
      dataSourceOverride: dataSourceName === options.dataSourceName ? undefined : dataSourceName,
      feedLabel: identity.feedLabel,
      offerId: identity.offerId,
    },
    productStatus:
      value.productStatus && typeof value.productStatus === 'object'
        ? (value.productStatus as Record<string, unknown>)
        : undefined,
    versionNumber: typeof value.versionNumber === 'string' ? value.versionNumber : undefined,
  }
}

export const createGoogleMerchantTransport = (
  options: NormalizedGmcV2Options,
): GmcMerchantTransport => {
  const client = createGoogleApiClient(options)
  // Hoisted once per transport instance instead of recompiled on every
  // remote product parsed (a single list page can contain hundreds).
  const dataSourceNamePattern = new RegExp(
    `^accounts/${options.merchantId}/dataSources/[1-9]\\d{0,18}$`,
  )

  return {
    deleteLocalInventory: async ({ identity, payload, storeCode }) => {
      try {
        await client.deleteLocalInventory(
          getProcessedProductName(identity, options.merchantId),
          encodeURIComponent(storeCode),
          payload,
        )
      } catch (error) {
        if (error instanceof GoogleApiError && error.statusCode === 404) {
          return
        }
        throw error
      }
    },
    deleteProductInput: async ({ dataSourceName, identity, payload }) => {
      try {
        await client.deleteProductInput(
          getProductInputName(identity, options.merchantId),
          payload,
          dataSourceName,
        )
      } catch (error) {
        if (error instanceof GoogleApiError && error.statusCode === 404) {
          return
        }
        throw error
      }
    },
    getApiPrimaryDataSource: async ({ dataSourceName, payload }) => {
      const response = await client.getDataSource(dataSourceName, payload)
      return parseGmcApiPrimaryDataSource(response.data, dataSourceName)
    },
    getProcessedProduct: async ({ identity, payload }) => {
      try {
        const response = await client.getProduct(
          getProcessedProductName(identity, options.merchantId),
          payload,
        )
        return parseRemoteProduct(response.data, options, dataSourceNamePattern)
      } catch (error) {
        if (error instanceof GoogleApiError && error.statusCode === 404) {
          return null
        }
        throw error
      }
    },
    insertLocalInventory: async ({ identity, inventory, payload }) => {
      await client.insertLocalInventory(
        getProcessedProductName(identity, options.merchantId),
        inventory,
        payload,
      )
    },
    insertProductInput: async ({ dataSourceName, input, payload }) => {
      await client.insertProductInput(input, payload, dataSourceName)
    },
    listProcessedProducts: async ({ pageSize = 250, pageToken, payload }) => {
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_REMOTE_PAGE_SIZE) {
        throw new TypeError(
          `Merchant product pageSize must be between 1 and ${MAX_REMOTE_PAGE_SIZE}`,
        )
      }
      const response = await client.listProducts(payload, pageSize, pageToken)
      if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
        throw new TypeError('Merchant API product list response must be an object')
      }
      const products = response.data.products ?? []
      if (!Array.isArray(products) || products.length > pageSize) {
        throw new TypeError('Merchant API product list returned an invalid or oversized page')
      }
      if (
        response.data.nextPageToken !== undefined &&
        (typeof response.data.nextPageToken !== 'string' ||
          !response.data.nextPageToken ||
          response.data.nextPageToken.length > 2_048)
      ) {
        throw new TypeError('Merchant API product list returned an invalid nextPageToken')
      }
      if (response.data.nextPageToken !== undefined && response.data.nextPageToken === pageToken) {
        throw new TypeError('Merchant API product list pagination token did not advance')
      }
      return {
        nextPageToken: response.data.nextPageToken,
        products: products.map((product) => {
          if (!product || typeof product !== 'object' || Array.isArray(product)) {
            throw new TypeError('Merchant API product list contains a non-object product')
          }
          return parseRemoteProduct(product, options, dataSourceNamePattern)
        }),
      }
    },
  }
}
