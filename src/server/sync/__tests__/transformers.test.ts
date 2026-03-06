import { describe, expect, test } from 'vitest'

import type {
  MCCustomAttribute,
  NormalizedPluginOptions,
  ResolvedMCIdentity,
} from '../../../types/index.js'

import {
  buildProductInput,
  fromMicros,
  reverseTransformProduct,
  sanitizeCustomAttributes,
  toMicros,
} from '../transformers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockOptions = (overrides?: Partial<NormalizedPluginOptions>): NormalizedPluginOptions => ({
  admin: { mode: 'route', navLabel: 'GMC', route: '/gmc' },
  api: { basePath: '/api/gmc' },
  collections: {
    products: {
      slug: 'products' as never,
      autoInjectTab: true,
      fieldMappings: [],
      identityField: 'sku',
      tabPosition: 'append',
    },
  },
  dataSourceId: 'ds-123',
  dataSourceName: 'accounts/12345/dataSources/ds-123',
  defaults: {
    condition: 'NEW',
    contentLanguage: 'en',
    currency: 'USD',
    feedLabel: 'US',
  },
  disabled: false,
  getCredentials: () => Promise.resolve({ type: 'json' as const, credentials: { client_email: '', private_key: '' } }),
  merchantId: '12345',
  rateLimit: {
    baseRetryDelayMs: 1000,
    enabled: false,
    jitterFactor: 0.2,
    maxConcurrency: 5,
    maxQueueSize: 100,
    maxRequestsPerMinute: 120,
    maxRetries: 3,
    maxRetryDelayMs: 30000,
    requestTimeoutMs: 30000,
  },
  siteUrl: '',
  sync: {
    conflictStrategy: 'mc-wins',
    initialSync: {
      batchSize: 50,
      dryRun: false,
      enabled: false,
      onlyIfRemoteMissing: true,
    },
    mode: 'manual',
    permanentSync: false,
    schedule: { apiKey: '', cron: '0 4 * * *', strategy: 'payload-jobs' },
    scheduleCron: '0 4 * * *',
  },
  ...overrides,
})

const mockIdentity: ResolvedMCIdentity = {
  contentLanguage: 'en',
  dataSourceName: 'accounts/12345/dataSources/ds-123',
  dataSourceOverride: undefined,
  feedLabel: 'US',
  merchantProductId: 'en~US~SKU-001',
  offerId: 'SKU-001',
  productInputName: 'accounts/12345/productInputs/en~US~SKU-001',
  productName: 'accounts/12345/products/en~US~SKU-001',
}

// ---------------------------------------------------------------------------
// toMicros
// ---------------------------------------------------------------------------

describe('toMicros', () => {
  test('converts 19.99 to "19990000"', () => {
    expect(toMicros(19.99)).toBe('19990000')
  })

  test('converts 0 to "0"', () => {
    expect(toMicros(0)).toBe('0')
  })

  test('converts 1 to "1000000"', () => {
    expect(toMicros(1)).toBe('1000000')
  })

  test('converts 0.01 to "10000"', () => {
    expect(toMicros(0.01)).toBe('10000')
  })

  test('converts 999999.99 to "999999990000"', () => {
    expect(toMicros(999999.99)).toBe('999999990000')
  })
})

// ---------------------------------------------------------------------------
// fromMicros
// ---------------------------------------------------------------------------

describe('fromMicros', () => {
  test('converts "19990000" to 19.99', () => {
    expect(fromMicros('19990000')).toBe(19.99)
  })

  test('converts "0" to 0', () => {
    expect(fromMicros('0')).toBe(0)
  })

  test('converts "1000000" to 1', () => {
    expect(fromMicros('1000000')).toBe(1)
  })

  test('converts "invalid" to 0', () => {
    expect(fromMicros('invalid')).toBe(0)
  })

  test('converts "" to 0', () => {
    expect(fromMicros('')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// sanitizeCustomAttributes
// ---------------------------------------------------------------------------

describe('sanitizeCustomAttributes', () => {
  test('removes entries with empty names', () => {
    const input: MCCustomAttribute[] = [
      { name: '', value: 'val' },
      { name: 'color', value: 'red' },
    ]
    expect(sanitizeCustomAttributes(input)).toEqual([{ name: 'color', value: 'red' }])
  })

  test('removes entries with empty values', () => {
    const input: MCCustomAttribute[] = [
      { name: 'color', value: '' },
      { name: 'size', value: 'large' },
    ]
    expect(sanitizeCustomAttributes(input)).toEqual([{ name: 'size', value: 'large' }])
  })

  test('trims whitespace from names and values', () => {
    const input: MCCustomAttribute[] = [
      { name: '  color  ', value: '  red  ' },
    ]
    expect(sanitizeCustomAttributes(input)).toEqual([{ name: 'color', value: 'red' }])
  })

  test('returns undefined for empty array', () => {
    expect(sanitizeCustomAttributes([])).toBeUndefined()
  })

  test('returns undefined for undefined input', () => {
    expect(sanitizeCustomAttributes(undefined)).toBeUndefined()
  })

  test('returns undefined when all entries are invalid', () => {
    const input: MCCustomAttribute[] = [
      { name: '', value: '' },
      { name: '  ', value: 'val' },
    ]
    expect(sanitizeCustomAttributes(input)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildProductInput
// ---------------------------------------------------------------------------

describe('buildProductInput', () => {
  test('builds correct MCProductInput from product data and identity', () => {
    const product = {
      merchantCenter: {
        productAttributes: {
          description: 'A great product',
          link: 'https://example.com/product',
          price: { amountMicros: '19990000', currencyCode: 'USD' },
          title: 'Test Product',
        },
      },
    }
    const options = mockOptions()

    const result = buildProductInput(product, mockIdentity, options)

    expect(result.offerId).toBe('SKU-001')
    expect(result.contentLanguage).toBe('en')
    expect(result.feedLabel).toBe('US')
    expect(result.productAttributes?.title).toBe('Test Product')
    expect(result.productAttributes?.description).toBe('A great product')
    expect(result.productAttributes?.price?.amountMicros).toBe('19990000')
    expect(result.productAttributes?.price?.currencyCode).toBe('USD')
  })

  test('strips empty/null fields from productAttributes', () => {
    const product = {
      merchantCenter: {
        productAttributes: {
          brand: null,
          description: '',
          link: undefined,
          title: 'Test',
        },
      },
    }
    const options = mockOptions()

    const result = buildProductInput(product, mockIdentity, options)

    expect(result.productAttributes?.title).toBe('Test')
    expect(result.productAttributes).not.toHaveProperty('description')
    expect(result.productAttributes).not.toHaveProperty('brand')
    expect(result.productAttributes).not.toHaveProperty('link')
  })

  test('applies default condition when not set', () => {
    const product = {
      merchantCenter: {
        productAttributes: { title: 'Test' },
      },
    }
    const options = mockOptions()

    const result = buildProductInput(product, mockIdentity, options)

    expect(result.productAttributes?.condition).toBe('NEW')
  })

  test('does not override existing condition', () => {
    const product = {
      merchantCenter: {
        productAttributes: { condition: 'USED', title: 'Test' },
      },
    }
    const options = mockOptions()

    const result = buildProductInput(product, mockIdentity, options)

    expect(result.productAttributes?.condition).toBe('USED')
  })

  test('applies default currency to price when missing', () => {
    const product = {
      merchantCenter: {
        productAttributes: {
          price: { amountMicros: '19990000' },
        },
      },
    }
    const options = mockOptions()

    const result = buildProductInput(product, mockIdentity, options)

    expect(result.productAttributes?.price?.currencyCode).toBe('USD')
  })

  test('applies default currency to salePrice when missing', () => {
    const product = {
      merchantCenter: {
        productAttributes: {
          salePrice: { amountMicros: '9990000' },
        },
      },
    }
    const options = mockOptions()

    const result = buildProductInput(product, mockIdentity, options)

    expect(result.productAttributes?.salePrice?.currencyCode).toBe('USD')
  })

  test('includes customAttributes when present', () => {
    const product = {
      merchantCenter: {
        customAttributes: [
          { name: 'warehouse', value: 'us-east' },
        ],
        productAttributes: { title: 'Test' },
      },
    }
    const options = mockOptions()

    const result = buildProductInput(product, mockIdentity, options)

    expect(result.customAttributes).toEqual([{ name: 'warehouse', value: 'us-east' }])
  })

  test('does not include customAttributes key when none are valid', () => {
    const product = {
      merchantCenter: {
        customAttributes: [{ name: '', value: '' }],
        productAttributes: { title: 'Test' },
      },
    }
    const options = mockOptions()

    const result = buildProductInput(product, mockIdentity, options)

    expect(result.customAttributes).toBeUndefined()
  })

  test('handles missing merchantCenter state', () => {
    const product = {}
    const options = mockOptions()

    const result = buildProductInput(product, mockIdentity, options)

    expect(result.offerId).toBe('SKU-001')
    expect(result.productAttributes?.condition).toBe('NEW')
  })
})

// ---------------------------------------------------------------------------
// reverseTransformProduct
// ---------------------------------------------------------------------------

describe('reverseTransformProduct', () => {
  test('converts MC product response back to Payload format', () => {
    const mcProduct = {
      productAttributes: {
        description: 'A description',
        price: { amountMicros: '19990000', currencyCode: 'USD' },
        title: 'Test Product',
      },
    }

    const result = reverseTransformProduct(mcProduct)

    expect(result.productAttributes.title).toBe('Test Product')
    expect(result.productAttributes.description).toBe('A description')
    expect(result.productAttributes.price).toEqual({
      amountMicros: '19990000',
      currencyCode: 'USD',
    })
  })

  test('wraps string array fields (productTypes) in objects with value key', () => {
    const mcProduct = {
      productAttributes: {
        productTypes: ['Clothing', 'Shirts'],
      },
    }

    const result = reverseTransformProduct(mcProduct)

    expect(result.productAttributes.productTypes).toEqual([
      { value: 'Clothing' },
      { value: 'Shirts' },
    ])
  })

  test('wraps gtins string array in objects with value key', () => {
    const mcProduct = {
      productAttributes: {
        gtins: ['0012345678901', '0012345678902'],
      },
    }

    const result = reverseTransformProduct(mcProduct)

    expect(result.productAttributes.gtins).toEqual([
      { value: '0012345678901' },
      { value: '0012345678902' },
    ])
  })

  test('wraps promotionIds string array in objects with value key', () => {
    const mcProduct = {
      productAttributes: {
        promotionIds: ['PROMO1'],
      },
    }

    const result = reverseTransformProduct(mcProduct)

    expect(result.productAttributes.promotionIds).toEqual([{ value: 'PROMO1' }])
  })

  test('wraps excludedDestinations string array in objects with value key', () => {
    const mcProduct = {
      productAttributes: {
        excludedDestinations: ['Shopping'],
      },
    }

    const result = reverseTransformProduct(mcProduct)

    expect(result.productAttributes.excludedDestinations).toEqual([{ value: 'Shopping' }])
  })

  test('wraps includedDestinations string array in objects with value key', () => {
    const mcProduct = {
      productAttributes: {
        includedDestinations: ['Shopping', 'FreeListing'],
      },
    }

    const result = reverseTransformProduct(mcProduct)

    expect(result.productAttributes.includedDestinations).toEqual([
      { value: 'Shopping' },
      { value: 'FreeListing' },
    ])
  })

  test('converts additionalImageLinks to objects with url key', () => {
    const mcProduct = {
      productAttributes: {
        additionalImageLinks: [
          'https://example.com/img1.jpg',
          'https://example.com/img2.jpg',
        ],
      },
    }

    const result = reverseTransformProduct(mcProduct)

    expect(result.productAttributes.additionalImageLinks).toEqual([
      { url: 'https://example.com/img1.jpg' },
      { url: 'https://example.com/img2.jpg' },
    ])
  })

  test('strips empty values from result', () => {
    const mcProduct = {
      productAttributes: {
        brand: null,
        description: '',
        link: undefined,
        title: 'Test',
      },
    }

    const result = reverseTransformProduct(mcProduct)

    expect(result.productAttributes.title).toBe('Test')
    expect(result.productAttributes).not.toHaveProperty('description')
    expect(result.productAttributes).not.toHaveProperty('brand')
    expect(result.productAttributes).not.toHaveProperty('link')
  })

  test('handles missing productAttributes gracefully', () => {
    const mcProduct = {}

    const result = reverseTransformProduct(mcProduct)

    expect(result.productAttributes).toEqual({})
  })

  test('passes through customAttributes after sanitization', () => {
    const mcProduct = {
      customAttributes: [
        { name: 'warehouse', value: 'us-east' },
        { name: '', value: '' },
      ],
      productAttributes: { title: 'Test' },
    }

    const result = reverseTransformProduct(mcProduct)

    expect(result.customAttributes).toEqual([{ name: 'warehouse', value: 'us-east' }])
  })

  test('returns undefined customAttributes when none are valid', () => {
    const mcProduct = {
      customAttributes: [{ name: '', value: '' }],
      productAttributes: { title: 'Test' },
    }

    const result = reverseTransformProduct(mcProduct)

    expect(result.customAttributes).toBeUndefined()
  })
})
