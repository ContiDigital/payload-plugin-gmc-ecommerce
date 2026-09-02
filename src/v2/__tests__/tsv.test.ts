import { describe, expect, it } from 'vitest'

import { canonicalizeProductInput } from '../canonical.js'
import { GMC_TSV_COLUMNS, serializeCanonicalTsv } from '../feed/tsv.js'

const canonical = (offerId: string, title: string) =>
  canonicalizeProductInput({
    input: {
      contentLanguage: 'en',
      customAttributes: [{ name: 'custom_destination', value: 'https://example.com/landing' }],
      feedLabel: 'US',
      offerId,
      productAttributes: {
        additionalImageLinks: ['https://example.com/a,b.jpg', 'https://example.com/c.jpg'],
        availability: 'IN_STOCK',
        description: 'Line one\nline two\tend',
        identifierExists: false,
        imageLink: 'https://example.com/image.jpg',
        link: `https://example.com/${offerId}`,
        price: { amountMicros: '12990000', currencyCode: 'USD' },
        productDetails: [
          {
            attributeName: 'Finish',
            attributeValue: 'Hand-polished, satin',
            sectionName: 'Specifications',
          },
        ],
        productHighlights: ['Hand carved', 'Indoor, outdoor display'],
        shipping: [
          {
            country: 'US',
            price: { amountMicros: '5000000', currencyCode: 'USD' },
            region: 'New York, NY',
            service: 'Ground: standard',
          },
        ],
        title,
      },
    },
  })

describe('serializeCanonicalTsv', () => {
  it('uses stable columns, deterministic identity ordering, and valid row widths', async () => {
    const withoutCustomTail = canonical('sku-b', 'B')
    withoutCustomTail.input.customAttributes = []
    const result = await serializeCanonicalTsv({
      feedId: 'primary',
      generatedAt: '2026-08-29T12:00:00.000Z',
      products: [withoutCustomTail, canonical('sku-a', 'A')],
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    })
    const text = new TextDecoder().decode(result.body)
    const lines = text.slice(0, -1).split('\n')
    const header = lines[0].split('\t')

    expect(header.slice(0, GMC_TSV_COLUMNS.length)).toEqual(GMC_TSV_COLUMNS)
    expect(header.at(-1)).toBe('custom_destination')
    expect(lines[1].split('\t')[header.indexOf('id')]).toBe('sku-a')
    expect(lines[2].split('\t')[header.indexOf('id')]).toBe('sku-b')
    // Merchant Center requires every product row to contain exactly the same
    // number of delimiters as the header, including blank tail columns.
    expect(lines[1].split('\t')).toHaveLength(header.length)
    expect(lines[2].split('\t')).toHaveLength(header.length)
    expect(lines[2].endsWith('\t')).toBe(true)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('normalizes forbidden TSV whitespace and encodes repeated/group delimiters', async () => {
    const result = await serializeCanonicalTsv({
      feedId: 'primary',
      generatedAt: '2026-08-29T12:00:00.000Z',
      products: [canonical('sku-a', 'A')],
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    })
    const text = new TextDecoder().decode(result.body)
    const [headerLine, rowLine] = text.trimEnd().split('\n')
    const header = headerLine.split('\t')
    const row = rowLine.split('\t')

    expect(row[header.indexOf('description')]).toBe('Line one line two end')
    expect(row[header.indexOf('additional_image_link')]).toBe(
      'https://example.com/a%2Cb.jpg,https://example.com/c.jpg',
    )
    expect(row[header.indexOf('shipping')]).toBe('US:"New York, NY":"Ground: standard":5.00 USD')
    expect(row[header.indexOf('product_highlight')]).toBe('Hand carved,"Indoor, outdoor display"')
    expect(row[header.indexOf('product_detail')]).toBe(
      'Specifications:Finish:"Hand-polished, satin"',
    )
  })

  it('quotes scalar inch marks without wrapping repeated or grouped attributes', async () => {
    const value = canonical('sku-a', '12" Teflon Mirror')
    value.input.customAttributes = [{ name: 'display note', value: 'Fits 24" openings' }]

    const result = await serializeCanonicalTsv({
      feedId: 'primary',
      generatedAt: '2026-08-29T12:00:00.000Z',
      products: [value],
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    })
    const [headerLine, rowLine] = new TextDecoder().decode(result.body).trimEnd().split('\n')
    const header = headerLine.split('\t')
    const row = rowLine.split('\t')

    expect(row[header.indexOf('title')]).toBe('"12"" Teflon Mirror"')
    expect(row[header.indexOf('display_note')]).toBe('"Fits 24"" openings"')
    expect(row[header.indexOf('shipping')]).toBe('US:"New York, NY":"Ground: standard":5.00 USD')
  })

  it('serializes structured text alternatives with provenance', async () => {
    const value = canonical('sku-a', 'A')
    delete value.input.productAttributes?.title
    delete value.input.productAttributes?.description
    Object.assign(value.input.productAttributes ?? {}, {
      structuredDescription: {
        content: 'Structured: description',
        digitalSourceType: 'TRAINED_ALGORITHMIC_MEDIA',
      },
      structuredTitle: { content: 'Structured title', digitalSourceType: 'DEFAULT' },
    })
    const result = await serializeCanonicalTsv({
      feedId: 'primary',
      generatedAt: '2026-08-29T12:00:00.000Z',
      products: [value],
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    })
    const [headerLine, rowLine] = new TextDecoder().decode(result.body).trimEnd().split('\n')
    const header = headerLine.split('\t')
    const row = rowLine.split('\t')

    expect(row[header.indexOf('structured_description')]).toBe(
      'trained_algorithmic_media:"Structured: description"',
    )
  })

  it('translates Merchant API enums to their text-feed spellings', async () => {
    const value = canonical('sku-a', 'A')
    Object.assign(value.input.productAttributes ?? {}, {
      availability: 'LIMITED_AVAILABILITY',
      energyEfficiencyClass: 'APPP',
      excludedDestinations: [
        'SHOPPING_ADS',
        'FREE_LISTINGS',
        'DISPLAY_ADS',
        'YOUTUBE_AFFILIATE',
      ],
      includedDestinations: ['LOCAL_INVENTORY_ADS', 'YOUTUBE_SHOPPING', 'VEHICLE_ADS'],
      maxEnergyEfficiencyClass: 'D',
      minEnergyEfficiencyClass: 'AP',
      pause: 'ADS',
      pickupMethod: 'SHIP_TO_STORE',
      pickupSla: 'TWO_DAY',
      sizeSystem: 'us',
      sizeTypes: ['REGULAR', 'TALL'],
    })

    const result = await serializeCanonicalTsv({
      feedId: 'primary',
      generatedAt: '2026-08-29T12:00:00.000Z',
      products: [value],
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    })
    const [headerLine, rowLine] = new TextDecoder().decode(result.body).trimEnd().split('\n')
    const header = headerLine.split('\t')
    const row = rowLine.split('\t')

    expect(row[header.indexOf('excluded_destination')]).toBe(
      'Shopping_ads,Free_listings,Display_ads,Youtube_affiliate',
    )
    expect(row[header.indexOf('included_destination')]).toBe(
      'Local_inventory_ads,Youtube_merchandise,vehicle_ads',
    )
    expect(row[header.indexOf('availability')]).toBe('in_stock')
    expect(row[header.indexOf('pause')]).toBe('ads')
    expect(row[header.indexOf('pickup_method')]).toBe('ship_to_store')
    expect(row[header.indexOf('pickup_sla')]).toBe('2-day')
    expect(row[header.indexOf('size_system')]).toBe('US')
    expect(row[header.indexOf('size_type')]).toBe('regular,tall')
    expect(row[header.indexOf('energy_efficiency_class')]).toBe('A+++')
    expect(row[header.indexOf('min_energy_efficiency_class')]).toBe('A+')
    expect(row[header.indexOf('max_energy_efficiency_class')]).toBe('D')
  })

  it('maps every nontrivial pickup SLA spelling and omits unspecified enums', async () => {
    const value = canonical('sku-a', 'A')
    Object.assign(value.input.productAttributes ?? {}, {
      ageGroup: 'AGE_GROUP_UNSPECIFIED',
      gender: 'GENDER_UNSPECIFIED',
      pickupSla: 'MULTI_WEEK',
    })

    const result = await serializeCanonicalTsv({
      feedId: 'primary',
      generatedAt: '2026-08-29T12:00:00.000Z',
      products: [value],
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    })
    const [headerLine, rowLine] = new TextDecoder().decode(result.body).trimEnd().split('\n')
    const header = headerLine.split('\t')
    const row = rowLine.split('\t')

    expect(row[header.indexOf('age_group')]).toBe('')
    expect(row[header.indexOf('gender')]).toBe('')
    expect(row[header.indexOf('pickup_sla')]).toBe('multi-week')
  })

  it('fails closed on unknown strongly typed API enums', () => {
    const value = canonical('sku-a', 'A')
    Object.assign(value.input.productAttributes ?? {}, { pickupSla: 'FUTURE_DAY' })

    expect(() =>
      serializeCanonicalTsv({
        feedId: 'primary',
        generatedAt: '2026-08-29T12:00:00.000Z',
        products: [value],
        selector: { contentLanguage: 'en', feedLabel: 'US' },
      }),
    ).toThrow(/cannot serialize PickupSla value/i)
  })

  it('fails closed on API destination enums with no documented TSV representation', () => {
    for (const destination of ['FREE_VEHICLE_LISTINGS', 'YOUTUBE_SHOPPING_CHECKOUT']) {
      const value = canonical('sku-a', 'A')
      Object.assign(value.input.productAttributes ?? {}, {
        excludedDestinations: [destination],
      })

      expect(() =>
        serializeCanonicalTsv({
          feedId: 'primary',
          generatedAt: '2026-08-29T12:00:00.000Z',
          products: [value],
          selector: { contentLanguage: 'en', feedLabel: 'US' },
        }),
      ).toThrow(/cannot serialize DestinationEnum value/i)
    }
  })

  it('rejects custom columns which normalize onto a built-in column', () => {
    const value = canonical('sku-a', 'A')
    value.input.customAttributes = [{ name: ' title ', value: 'collision' }]

    expect(() =>
      serializeCanonicalTsv({
        feedId: 'primary',
        generatedAt: '2026-08-29T12:00:00.000Z',
        products: [value],
        selector: { contentLanguage: 'en', feedLabel: 'US' },
      }),
    ).toThrow(/collides with a built-in TSV column/i)
  })

  it('normalizes generic API attribute names into text-feed columns', async () => {
    const value = canonical('sku-a', 'A')
    value.input.customAttributes = [
      { name: 'energy efficiency class', value: 'A+' },
      { name: 'My Custom Attribute', value: 'value' },
    ]

    const result = await serializeCanonicalTsv({
      feedId: 'primary',
      generatedAt: '2026-08-29T12:00:00.000Z',
      products: [value],
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    })
    const [headerLine, rowLine] = new TextDecoder().decode(result.body).trimEnd().split('\n')
    const header = headerLine.split('\t')
    const row = rowLine.split('\t')

    expect(row[header.indexOf('energy_efficiency_class')]).toBe('A+')
    expect(row[header.indexOf('my_custom_attribute')]).toBe('value')
  })

  it('fails closed on grouped API custom attributes that text feeds cannot preserve', () => {
    const value = canonical('sku-a', 'A')
    value.input.customAttributes = [
      { name: 'shipping', groupValues: [{ name: 'country', value: 'US' }] },
    ]

    expect(() =>
      serializeCanonicalTsv({
        feedId: 'primary',
        generatedAt: '2026-08-29T12:00:00.000Z',
        products: [value],
        selector: { contentLanguage: 'en', feedLabel: 'US' },
      }),
    ).toThrow(/cannot serialize grouped custom attribute.*shipping/i)
  })

  it('fails closed instead of silently dropping an unsupported strongly typed field', () => {
    const value = canonical('sku-a', 'A')
    Object.assign(value.input.productAttributes ?? {}, {
      warranty: { duration: '1', unit: 'YEAR' },
    })

    expect(() =>
      serializeCanonicalTsv({
        feedId: 'primary',
        generatedAt: '2026-08-29T12:00:00.000Z',
        products: [value],
        selector: { contentLanguage: 'en', feedLabel: 'US' },
      }),
    ).toThrow(/cannot serialize.*warranty/i)
  })

  it('fails closed instead of silently dropping an unsupported ProductInput root field', () => {
    const value = canonical('sku-a', 'A')
    Object.assign(value.input, { futureInputField: 'api-only' })

    expect(() =>
      serializeCanonicalTsv({
        feedId: 'primary',
        generatedAt: '2026-08-29T12:00:00.000Z',
        products: [value],
        selector: { contentLanguage: 'en', feedLabel: 'US' },
      }),
    ).toThrow(/cannot serialize ProductInput field.*futureInputField/i)
  })
})
