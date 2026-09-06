import { describe, expect, it } from 'vitest'

import type { MCProductAttributes } from '../../types/index.js'
import type { GmcProjectedProductInput } from '../types.js'

import {
  canonicalizeProductInput,
  canonicalizeProjection,
  GmcProjectionValidationError,
  priceToFeedValue,
} from '../canonical.js'

const product = (offerId = 'sku-1'): GmcProjectedProductInput => ({
  contentLanguage: 'en',
  feedLabel: 'US',
  offerId,
  productAttributes: {
    availability: 'IN_STOCK',
    description: 'A durable product description',
    imageLink: 'https://example.com/image.jpg',
    link: `https://example.com/products/${offerId}`,
    price: { amountMicros: '12340000', currencyCode: 'USD' },
    title: 'A product',
  },
})

/**
 * Frozen realistic offer whose digest is pinned below. Never edit this fixture:
 * a new normalization question needs a new fixture, not a new golden value.
 */
const GOLDEN_FIXTURE: GmcProjectedProductInput = {
  contentLanguage: 'en',
  customAttributes: [
    { name: 'care_instructions', value: 'Wipe with a dry cloth' },
    {
      name: 'dimensions_group',
      groupValues: [
        { name: 'height', value: '40 cm' },
        { name: 'width', value: '18 cm' },
      ],
    },
  ],
  feedLabel: 'PRODUCTS',
  offerId: 'golden-fixture-0001',
  productAttributes: {
    additionalImageLinks: [{ url: 'https://example.com/images/lamp-2.jpg' }],
    availability: 'IN_STOCK',
    brand: 'Golden Fixture Co',
    color: 'Brass',
    condition: 'NEW',
    customLabel0: 'evergreen',
    description: 'A brushed brass table lamp with a linen shade.',
    googleProductCategory: '594',
    gtins: [{ value: '00012345678905' }],
    imageLink: 'https://example.com/images/lamp-1.jpg',
    itemGroupId: 'lamp-group-1',
    link: 'https://example.com/products/brass-lamp',
    maxHandlingTime: '3',
    minHandlingTime: '1',
    multipack: 1,
    price: { amountMicros: '129990000', currencyCode: 'USD' },
    productDetails: [
      { attributeName: 'Finish', attributeValue: 'Brushed brass', sectionName: 'Materials' },
    ],
    productHighlights: ['Hand finished in the UK', 'Dimmable LED compatible'],
    productTypes: [{ value: 'Home > Lighting > Table lamps' }],
    salePrice: { amountMicros: '99990000', currencyCode: 'USD' },
    salePriceEffectiveDate: {
      endTime: '2026-02-01T00:00:00Z',
      startTime: '2026-01-01T00:00:00Z',
    },
    shipping: [
      {
        country: 'US',
        price: { amountMicros: '4990000', currencyCode: 'USD' },
        region: 'CA',
        service: 'Standard',
      },
    ],
    shippingWeight: { unit: 'kg', value: 2.4 },
    sizeTypes: ['REGULAR'],
    title: 'Brushed Brass Table Lamp',
  },
}

describe('canonicalizeProductInput', () => {
  it('produces a deterministic digest without mutating the projection', () => {
    const input = product()
    const original = structuredClone(input)
    const first = canonicalizeProductInput({ input, sourceVersion: '42' })
    const second = canonicalizeProductInput({
      input: {
        contentLanguage: input.contentLanguage,
        feedLabel: input.feedLabel,
        offerId: input.offerId,
        productAttributes: input.productAttributes,
      },
      sourceVersion: '42',
    })

    expect(first.digest).toBe(second.digest)
    expect(first.sourceVersion).toBe('42')
    expect(input).toEqual(original)
  })

  it('separates data source routing from the Merchant API body', () => {
    const result = canonicalizeProductInput({
      input: {
        ...product(),
        dataSourceOverride: 'accounts/1/dataSources/2',
      },
    })

    expect(result.identity.dataSourceOverride).toBe('accounts/1/dataSources/2')
    expect(result.input).not.toHaveProperty('dataSourceOverride')
  })

  it('preserves forward-compatible Merchant API attributes in canonical input and digest', () => {
    const first = canonicalizeProductInput({
      input: {
        ...product(),
        productAttributes: {
          ...product().productAttributes,
          handlingCutoffTime: { cutoffTime: '17:00', timezone: 'America/New_York' },
        },
      },
    })
    const second = canonicalizeProductInput({ input: product() })

    expect(first.input.productAttributes?.handlingCutoffTime).toEqual({
      cutoffTime: '17:00',
      timezone: 'America/New_York',
    })
    expect(first.digest).not.toBe(second.digest)
  })

  it.each([
    [
      'circular',
      (input: GmcProjectedProductInput) => {
        const attrs = input.productAttributes as Record<string, unknown>
        attrs.circular = attrs
      },
    ],
    [
      'non-finite',
      (input: GmcProjectedProductInput) => {
        Object.assign(input.productAttributes ?? {}, { futureScore: Number.NaN })
      },
    ],
    [
      'non-plain',
      (input: GmcProjectedProductInput) => {
        Object.assign(input.productAttributes ?? {}, { futureDate: new Date() })
      },
    ],
  ])('rejects %s non-JSON projection values with a bounded validation error', (_name, mutate) => {
    const input = product()
    mutate(input)

    expect(() => canonicalizeProductInput({ input })).toThrow(GmcProjectionValidationError)
  })

  it('rejects price micros outside the Merchant signed-int64 wire range', () => {
    const input = product()
    input.productAttributes!.price!.amountMicros = '9223372036854775808'

    expect(() => canonicalizeProductInput({ input })).toThrow(/signed int64/i)
  })

  it('normalizes legacy row wrappers and interval names to the Merchant v1 wire shape', () => {
    const input = {
      ...product(),
      customAttributes: [{ id: 'payload-row', name: 'custom', value: 'value' }],
      productAttributes: {
        ...product().productAttributes,
        productTypes: [{ id: 'payload-row', value: 'Home > Decor' }],
        salePrice: { amountMicros: '10000000', currencyCode: 'USD' },
        salePriceEffectiveDate: {
          endDate: '2026-09-02T00:00:00.000Z',
          startDate: '2026-09-01T00:00:00.000Z',
        },
        sizeType: 'REGULAR',
      },
    } as unknown as GmcProjectedProductInput

    const result = canonicalizeProductInput({ input, sourceVersion: '2' })

    expect(result.input.customAttributes).toEqual([{ name: 'custom', value: 'value' }])
    expect(result.input.productAttributes).toMatchObject({
      productTypes: ['Home > Decor'],
      salePriceEffectiveDate: {
        endTime: '2026-09-02T00:00:00.000Z',
        startTime: '2026-09-01T00:00:00.000Z',
      },
      sizeTypes: ['REGULAR'],
    })
    expect(result.input.productAttributes).not.toHaveProperty('sizeType')
  })

  it('preserves recursive API custom-attribute groups while removing Payload row IDs', () => {
    const input = {
      ...product(),
      customAttributes: [
        {
          id: 'root-1',
          name: 'shipping',
          groupValues: [
            { id: 'child-1', name: 'country', value: 'US' },
            {
              id: 'child-2',
              name: 'delivery',
              groupValues: [{ id: 'grandchild-1', name: 'service', value: 'ground' }],
            },
          ],
        },
      ],
    } as unknown as GmcProjectedProductInput

    const result = canonicalizeProductInput({ input })

    expect(result.input.customAttributes).toEqual([
      {
        name: 'shipping',
        groupValues: [
          { name: 'country', value: 'US' },
          { name: 'delivery', groupValues: [{ name: 'service', value: 'ground' }] },
        ],
      },
    ])
  })

  it.each([
    [
      'both value and groupValues',
      { name: 'group', groupValues: [{ name: 'child', value: 'nested' }], value: 'flat' },
    ],
    ['neither value nor groupValues', { name: 'empty' }],
    ['an empty value', { name: 'empty', value: '' }],
    ['an empty group', { name: 'empty', groupValues: [] }],
  ])('rejects custom attributes with %s', (_case, attribute) => {
    const input = product()
    input.customAttributes = [attribute]

    expect(() => canonicalizeProductInput({ input })).toThrow(
      /exactly one non-empty value or non-empty groupValues/i,
    )
  })

  it('normalizes empty inactive custom-attribute alternatives', () => {
    const input = product()
    input.customAttributes = [
      { name: 'flat', groupValues: [], value: 'value' },
      { name: 'group', groupValues: [{ name: 'child', value: 'nested' }], value: '' },
    ]

    expect(canonicalizeProductInput({ input }).input.customAttributes).toEqual([
      { name: 'flat', value: 'value' },
      { name: 'group', groupValues: [{ name: 'child', value: 'nested' }] },
    ])
  })

  it('bounds recursive custom attributes and rejects unknown custom-attribute fields', () => {
    let nested: Record<string, unknown> = { name: 'leaf', value: 'value' }
    for (let depth = 0; depth < 21; depth += 1) {
      nested = { name: `level-${depth}`, groupValues: [nested] }
    }
    const input = product()
    input.customAttributes = [nested as never]

    expect(() => canonicalizeProductInput({ input })).toThrow(/20 nested custom-attribute levels/i)

    input.customAttributes = [{ name: 'custom', futureField: true, value: 'value' } as never]
    expect(() => canonicalizeProductInput({ input })).toThrow(/unsupported field.*futureField/i)
  })

  it('rejects writable ProductInput fields the plugin does not explicitly own', () => {
    const input = product()
    Object.assign(input, { versionNumber: '123' })

    expect(() => canonicalizeProductInput({ input })).toThrow(
      /input\.versionNumber is not a supported writable ProductInput field/i,
    )
  })

  it('rejects malformed sale intervals', () => {
    expect(() =>
      canonicalizeProductInput({
        input: {
          ...product(),
          productAttributes: {
            ...product().productAttributes,
            productHighlights: ['Only one highlight'],
            salePriceEffectiveDate: {
              endTime: '2026-08-01T00:00:00.000Z',
              startTime: 'not-a-date',
            },
          },
        },
      }),
    ).toThrow(/requires salePrice.*RFC 3339/s)
  })

  it('enforces exact known Price shapes and sale-price consistency', () => {
    const unknownPriceField = product()
    Object.assign(unknownPriceField.productAttributes?.price ?? {}, { units: '12' })
    expect(() => canonicalizeProductInput({ input: unknownPriceField })).toThrow(
      /price\.units is not a supported Price field/i,
    )

    const malformedCost = product()
    malformedCost.productAttributes!.costOfGoodsSold = {
      amountMicros: 'not-an-int',
      currencyCode: 'usd',
    }
    expect(() => canonicalizeProductInput({ input: malformedCost })).toThrow(
      /costOfGoodsSold\.amountMicros.*costOfGoodsSold\.currencyCode/s,
    )

    const mismatchedCurrency = product()
    mismatchedCurrency.productAttributes!.salePrice = {
      amountMicros: '12000000',
      currencyCode: 'CAD',
    }
    expect(() => canonicalizeProductInput({ input: mismatchedCurrency })).toThrow(
      /salePrice\.currencyCode.*must match price currency/s,
    )

    // A sale price above the list price is a Merchant Center merchandising
    // warning, not a wire error, so the projection is published as authored.
    const higherSalePrice = product()
    higherSalePrice.productAttributes!.salePrice = {
      amountMicros: '13000000',
      currencyCode: 'USD',
    }
    expect(() => canonicalizeProductInput({ input: higherSalePrice })).not.toThrow()
  })

  it('validates every Product Timestamp and Interval at protobuf nanosecond precision', () => {
    const invalidAvailability = product()
    invalidAvailability.productAttributes!.availabilityDate = '2026-02-29T00:00:00Z'
    expect(() => canonicalizeProductInput({ input: invalidAvailability })).toThrow(/RFC 3339/i)

    const reverseNanos = product()
    reverseNanos.productAttributes!.salePrice = {
      amountMicros: '10000000',
      currencyCode: 'USD',
    }
    reverseNanos.productAttributes!.salePriceEffectiveDate = {
      endTime: '2026-08-30T00:00:00.000000001Z',
      startTime: '2026-08-30T00:00:00.000000002Z',
    }
    expect(() => canonicalizeProductInput({ input: reverseNanos })).toThrow(/startTime.*after/i)

    const malformedInterval = product()
    malformedInterval.productAttributes!.salePrice = {
      amountMicros: '10000000',
      currencyCode: 'USD',
    }
    malformedInterval.productAttributes!.salePriceEffectiveDate = 'always' as never
    expect(() => canonicalizeProductInput({ input: malformedInterval })).toThrow(/Interval object/i)

    const unknownInterval = product()
    unknownInterval.productAttributes!.salePrice = {
      amountMicros: '10000000',
      currencyCode: 'USD',
    }
    unknownInterval.productAttributes!.salePriceEffectiveDate = {
      startTime: '2026-08-30T00:00:00Z',
      timezone: 'UTC',
    } as never
    expect(() => canonicalizeProductInput({ input: unknownInterval })).toThrow(
      /salePriceEffectiveDate.*unsupported fields.*timezone/i,
    )
  })

  it('enforces repeated wire shapes without imposing Google cardinality limits', () => {
    expect(() =>
      canonicalizeProductInput({
        input: {
          ...product(),
          productAttributes: {
            ...product().productAttributes,
            additionalImageLinks: ['not-a-url'],
            gtins: [1 as never],
            productDetails: [
              { attributeName: '', attributeValue: 'Stone', sectionName: 'Material' },
            ],
          },
        },
      }),
    ).toThrow(/absolute HTTP.*gtins must contain strings.*attributeName/s)

    // Cardinality is Merchant Center policy; the plugin publishes what it is given.
    expect(() =>
      canonicalizeProductInput({
        input: {
          ...product(),
          productAttributes: {
            ...product().productAttributes,
            additionalImageLinks: Array.from(
              { length: 11 },
              (_, index) => `https://example.com/${index}.jpg`,
            ),
            gtins: Array.from({ length: 11 }, (_, index) => String(index)),
            sizeTypes: ['REGULAR', 'PETITE', 'MATERNITY'],
          },
        },
      }),
    ).not.toThrow()
  })

  it('allows an omitted product-detail section and rejects non-RFC timestamps', () => {
    const input = product()
    input.productAttributes!.productDetails = [
      { attributeName: 'Warranty', attributeValue: 'One year' },
    ]
    input.productAttributes!.availabilityDate = 'August 29, 2026'

    expect(() => canonicalizeProductInput({ input })).toThrow(/RFC 3339 protobuf Timestamp/i)
    delete input.productAttributes!.availabilityDate
    expect(() => canonicalizeProductInput({ input })).not.toThrow()
  })

  it('accepts every current Merchant API v1 ProductAvailability value', () => {
    for (const availability of [
      'BACKORDER',
      'IN_STOCK',
      'LIMITED_AVAILABILITY',
      'OUT_OF_STOCK',
      'PREORDER',
    ]) {
      const input = product()
      input.productAttributes!.availability = availability
      expect(() => canonicalizeProductInput({ input })).not.toThrow()
    }
  })

  it('reports exactly one issue for a non-string availability', () => {
    const input = product()
    input.productAttributes!.availability = 42 as never

    try {
      canonicalizeProductInput({ input })
      expect.unreachable('a non-string availability must not canonicalize')
    } catch (error) {
      expect(error).toBeInstanceOf(GmcProjectionValidationError)
      // requireString already reported the value; adding an enum issue on top
      // would make one mistake look like two to the projecting host.
      expect((error as GmcProjectionValidationError).issues).toEqual([
        {
          code: 'required',
          message: 'must be a non-empty string',
          path: 'input.productAttributes.availability',
        },
      ])
    }
  })

  it('publishes preorder and backorder offers without an availabilityDate', () => {
    // Google surfaces the missing date as an item-level issue. Rejecting the
    // projection here would strand an otherwise publishable offer.
    for (const availability of ['BACKORDER', 'PREORDER']) {
      const input = product()
      input.productAttributes!.availability = availability
      expect(() => canonicalizeProductInput({ input })).not.toThrow()
    }
  })

  it('rejects sibling custom attribute names that collide after Google normalization', () => {
    const input = product()
    input.customAttributes = [
      { name: 'size_type', value: 'regular' },
      { name: 'Size Type', value: 'petite' },
    ]

    expect(() => canonicalizeProductInput({ input })).toThrow(/after Google normalization/i)
  })

  it('rejects a plain and a structured spelling of the same text value', () => {
    expect(() =>
      canonicalizeProductInput({
        input: {
          ...product(),
          productAttributes: {
            ...product().productAttributes,
            structuredTitle: {
              content: 'AI title',
              digitalSourceType: 'TRAINED_ALGORITHMIC_MEDIA',
            },
          },
        },
      }),
    ).toThrow(/title.*must not be supplied with structuredTitle/i)

    expect(() =>
      canonicalizeProductInput({
        input: {
          ...product(),
          productAttributes: {
            ...product().productAttributes,
            description: undefined,
            structuredDescription: { content: 'Structured description' },
            structuredTitle: { content: 'Structured title' },
            title: undefined,
          },
        },
      }),
    ).not.toThrow()
  })

  it('reports all core validation errors with paths', () => {
    expect(() =>
      canonicalizeProductInput({
        input: {
          contentLanguage: 'EN-us',
          feedLabel: '',
          offerId: '',
          productAttributes: {
            availability: 'available',
            description: '',
            imageLink: '/image.jpg',
            link: 'javascript:alert(1)',
            price: { amountMicros: '12.34', currencyCode: 'usd' },
            title: '',
          },
        },
      }),
    ).toThrow(GmcProjectionValidationError)

    try {
      canonicalizeProductInput({
        input: {
          contentLanguage: 'en',
          feedLabel: 'US',
          offerId: 'sku',
          productAttributes: {
            availability: 'IN_STOCK',
            description: 'Description',
            imageLink: 'https://example.com/image.jpg',
            link: 'https://example.com/product',
            price: { amountMicros: '-1', currencyCode: 'USD' },
            title: 'Product',
          },
        },
      })
    } catch (error) {
      expect(error).toBeInstanceOf(GmcProjectionValidationError)
      expect((error as GmcProjectionValidationError).issues).toContainEqual(
        expect.objectContaining({ path: 'input.productAttributes.price.amountMicros' }),
      )
    }
  })

  it('rejects duplicate offer identities in a multi-offer projection', () => {
    expect(() =>
      canonicalizeProjection({ products: [product(), product()], sourceVersion: '1' }),
    ).toThrowError(/same Google identity/i)
  })

  it('rejects duplicate processed identities even when their source routes differ', () => {
    expect(() =>
      canonicalizeProjection({
        products: [product(), { ...product(), dataSourceOverride: 'accounts/123/dataSources/456' }],
        sourceVersion: '1',
      }),
    ).toThrowError(/same Google identity/i)
  })

  it('rejects oversized digit strings before Merchant int64 conversion', () => {
    const input = product()
    input.productAttributes!.maxHandlingTime = '9'.repeat(100_000)
    expect(() => canonicalizeProductInput({ input })).toThrow(/signed int64/i)
    expect(() =>
      canonicalizeProductInput({ input: product(), sourceVersion: '9'.repeat(100_000) }),
    ).toThrow(/signed int64/i)
  })

  it('rejects an unbounded per-document offer projection before canonicalizing it', () => {
    expect(() =>
      canonicalizeProjection({
        products: Array.from({ length: 1_001 }, (_, index) => product(`sku-${index}`)),
        sourceVersion: '1',
      }),
    ).toThrowError(/not contain more than 1000 products/i)
  })

  it('bounds and validates projection warning metadata', () => {
    expect(() =>
      canonicalizeProjection({
        products: [product()],
        sourceVersion: '1',
        warnings: [{ code: 'BAD CODE', message: 'unsafe\nmessage' }],
      }),
    ).toThrowError(/warning.*safe characters/is)

    expect(
      canonicalizeProjection({
        products: [product()],
        sourceVersion: '1',
        warnings: [
          { code: 'CANONICAL_NOTE', message: '  Needs review  ', path: ' product.title ' },
        ],
      }).warnings,
    ).toEqual([{ code: 'CANONICAL_NOTE', message: 'Needs review', path: 'product.title' }])
  })

  it('canonicalizes a supplemental input carrying only identity and one attribute', () => {
    const result = canonicalizeProductInput({
      input: {
        contentLanguage: 'en',
        feedLabel: 'US',
        offerId: 'supplemental-1',
        productAttributes: { customLabel0: 'clearance' },
      },
    })

    expect(result.identity.offerId).toBe('supplemental-1')
    expect(result.input.productAttributes).toEqual({ customLabel0: 'clearance' })
  })

  it('accepts merchandising text Google truncates rather than rejects', () => {
    const input = product()
    input.productAttributes!.productDetails = [
      { attributeName: 'A'.repeat(200), attributeValue: 'B'.repeat(600), sectionName: 'C'.repeat(200) },
    ]
    input.productAttributes!.title = 'T'.repeat(400)
    input.productAttributes!.productHighlights = ['Only one highlight']

    expect(() => canonicalizeProductInput({ input })).not.toThrow()
  })

  it('accepts the Merchant API v1 legacyLocal ProductInput field', () => {
    const result = canonicalizeProductInput({
      input: { ...product(), legacyLocal: true },
    })

    expect(result.input.legacyLocal).toBe(true)
    expect(() =>
      canonicalizeProductInput({ input: { ...product(), legacyLocal: 'yes' as never } }),
    ).toThrow(/input\.legacyLocal must be a boolean/i)
  })

  it('passes unknown attributes through without a taxes field on the attribute type', () => {
    // Merchant API v1 has no `taxes` attribute: the type must not offer one, and an
    // unknown attribute must survive as opaque forward-compatible JSON.
    const attributes: MCProductAttributes = {
      // @ts-expect-error Merchant API v1 removed the Content API `taxes` attribute
      taxes: [{ country: 'US', rate: 5 }],
    }

    const result = canonicalizeProductInput({
      input: {
        ...product(),
        productAttributes: { ...product().productAttributes, ...attributes },
      },
    })

    expect(result.input.productAttributes).toHaveProperty('taxes')
  })

  it('pins the canonical digest of a fixed realistic offer', () => {
    const result = canonicalizeProductInput({
      input: structuredClone(GOLDEN_FIXTURE),
      sourceVersion: '7',
    })

    // Recorded from the released canonicalization. A change here means the
    // canonical JSON changed and every stored publication digest is invalidated.
    expect(result.digest).toBe(
      '8054e33c0ed32142e7da4b578763d8a57d56b3b76325435e9c289dd5f403e3ab',
    )
  })
})

describe('priceToFeedValue', () => {
  it.each([
    ['0', '0.00 USD'],
    ['1', '0.000001 USD'],
    ['1200000', '1.20 USD'],
    ['12340000', '12.34 USD'],
  ])('formats %s micros without floating point loss', (amountMicros, expected) => {
    expect(priceToFeedValue({ amountMicros, currencyCode: 'USD' })).toBe(expected)
  })
})
