import type {
  MCArrayField,
  MCPrice,
  MCProductAttributes,
  MCShipping,
  MCShippingDimension,
  MCUrlArrayField,
} from '../../types/index.js'
import type { GmcCanonicalProduct, GmcFeedFormatAdapter, GmcProjectionWarning } from '../types.js'

import { getIdentityKey, priceToFeedValue } from '../canonical.js'

/**
 * A bare `shipping` header is documented as the four-position default
 * `country:region:service:price`. Emitting the full sub-attribute set under it
 * would have Google read position 3 as the service. Naming the sub-attributes
 * in the header is Google's documented way to declare a different layout, so
 * every row carries all eleven positions in exactly this order.
 */
export const GMC_TSV_SHIPPING_COLUMN =
  'shipping(country:region:postal_code:location_id:location_group_name:service:price:min_handling_time:max_handling_time:min_transit_time:max_transit_time)'

export const GMC_TSV_COLUMNS = [
  'id',
  'title',
  'short_title',
  'description',
  'structured_title',
  'structured_description',
  'link',
  'canonical_link',
  'mobile_link',
  'image_link',
  'additional_image_link',
  'lifestyle_image_link',
  'video_link',
  'availability',
  'availability_date',
  'expiration_date',
  'disclosure_date',
  'price',
  'maximum_retail_price',
  'sale_price',
  'sale_price_effective_date',
  'cost_of_goods_sold',
  'auto_pricing_min_price',
  'condition',
  'brand',
  'gtin',
  'mpn',
  'identifier_exists',
  'google_product_category',
  'product_type',
  'product_highlight',
  'product_detail',
  'item_group_id',
  'color',
  'material',
  'pattern',
  'size',
  'size_type',
  'size_system',
  'gender',
  'age_group',
  'adult',
  'is_bundle',
  'multipack',
  GMC_TSV_SHIPPING_COLUMN,
  'shipping_weight',
  'shipping_length',
  'shipping_width',
  'shipping_height',
  'product_weight',
  'product_length',
  'product_width',
  'product_height',
  'free_shipping_threshold',
  'energy_efficiency_class',
  'min_energy_efficiency_class',
  'max_energy_efficiency_class',
  'promotion_id',
  'shopping_ads_excluded_country',
  'included_destination',
  'excluded_destination',
  'pause',
  'shipping_label',
  'return_policy_label',
  'transit_time_label',
  'min_handling_time',
  'max_handling_time',
  'sell_on_google_quantity',
  'pickup_method',
  'pickup_SLA',
  'link_template',
  'mobile_link_template',
  'virtual_model_link',
  'external_seller_id',
  'ads_labels',
  'ads_grouping',
  'ads_redirect',
  'display_ads_id',
  'display_ads_title',
  'display_ads_link',
  'display_ads_value',
  'display_ads_similar_id',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
] as const

export const GMC_TSV_PRODUCT_ATTRIBUTE_FIELDS = [
  'additionalImageLinks',
  'adult',
  'adsGrouping',
  'adsLabels',
  'adsRedirect',
  'ageGroup',
  'autoPricingMinPrice',
  'availability',
  'availabilityDate',
  'brand',
  'canonicalLink',
  'color',
  'condition',
  'costOfGoodsSold',
  'customLabel0',
  'customLabel1',
  'customLabel2',
  'customLabel3',
  'customLabel4',
  'description',
  'disclosureDate',
  'displayAdsId',
  'displayAdsLink',
  'displayAdsSimilarIds',
  'displayAdsTitle',
  'displayAdsValue',
  'energyEfficiencyClass',
  'excludedDestinations',
  'expirationDate',
  'externalSellerId',
  'freeShippingThreshold',
  'gender',
  'googleProductCategory',
  'gtins',
  'identifierExists',
  'imageLink',
  'includedDestinations',
  'isBundle',
  'itemGroupId',
  'lifestyleImageLinks',
  'link',
  'linkTemplate',
  'material',
  'maxEnergyEfficiencyClass',
  'maxHandlingTime',
  'maximumRetailPrice',
  'minEnergyEfficiencyClass',
  'minHandlingTime',
  'mobileLink',
  'mobileLinkTemplate',
  'mpn',
  'multipack',
  'pattern',
  'pause',
  'pickupMethod',
  'pickupSla',
  'price',
  'productDetails',
  'productHeight',
  'productHighlights',
  'productLength',
  'productTypes',
  'productWeight',
  'productWidth',
  'promotionIds',
  'returnPolicyLabel',
  'salePrice',
  'salePriceEffectiveDate',
  'sellOnGoogleQuantity',
  'shipping',
  'shippingHeight',
  'shippingLabel',
  'shippingLength',
  'shippingWeight',
  'shippingWidth',
  'shoppingAdsExcludedCountries',
  'shortTitle',
  'size',
  'sizeSystem',
  'sizeTypes',
  'structuredDescription',
  'structuredTitle',
  'title',
  'transitTimeLabel',
  'videoLinks',
  'virtualModelLink',
] as const satisfies readonly (keyof MCProductAttributes)[]

const supportedProductAttributeFields = new Set<string>(GMC_TSV_PRODUCT_ATTRIBUTE_FIELDS)
const builtInColumnsByLowerCaseName = new Map<string, string>(
  GMC_TSV_COLUMNS.map((column) => [column.toLowerCase(), column]),
)
const supportedProductInputFields = new Set([
  'contentLanguage',
  'customAttributes',
  'feedLabel',
  'offerId',
  'productAttributes',
])

const cleanCell = (value: string): string => value.replace(/[\t\r\n]+/g, ' ').trim()

/**
 * Encode one non-repeated, non-grouped TSV value. A tab is the only delimiter
 * such a cell has, and Google documents quoting only for sub-values of
 * repeated and grouped attributes, so a scalar is emitted verbatim: wrapping
 * it would publish the quotes as part of the value.
 */
const scalarValue = (value: string): string => cleanCell(value)

const customColumnName = (value: string): string => {
  const normalized = cleanCell(value)
    .replace(/[\s_]+/g, '_')
    .toLowerCase()
  if (!/^[a-z][a-z0-9_]{0,149}$/.test(normalized)) {
    throw new TypeError(
      'Custom attribute names must normalize to 1-150 lowercase letters, digits, or underscores and start with a letter',
    )
  }
  return normalized
}

const delimitedPart = (value: string, delimiters: RegExp): string => {
  const cleaned = cleanCell(value)
  if (!delimiters.test(cleaned)) {
    return cleaned
  }
  return `"${cleaned.replace(/"/g, '""')}"`
}

const AGE_GROUP_FEED_VALUES: Readonly<Record<string, string>> = {
  ADULT: 'adult',
  INFANT: 'infant',
  KIDS: 'kids',
  NEWBORN: 'newborn',
  TODDLER: 'toddler',
}

const AVAILABILITY_FEED_VALUES: Readonly<Record<string, string>> = {
  BACKORDER: 'backorder',
  IN_STOCK: 'in_stock',
  // The API exposes LIMITED_AVAILABILITY, while Google's product-file
  // vocabulary folds Schema.org LimitedAvailability into in_stock.
  LIMITED_AVAILABILITY: 'in_stock',
  OUT_OF_STOCK: 'out_of_stock',
  PREORDER: 'preorder',
}

const CONDITION_FEED_VALUES: Readonly<Record<string, string>> = {
  NEW: 'new',
  REFURBISHED: 'refurbished',
  USED: 'used',
}

const GENDER_FEED_VALUES: Readonly<Record<string, string>> = {
  FEMALE: 'female',
  MALE: 'male',
  UNISEX: 'unisex',
}

const PAUSE_FEED_VALUES: Readonly<Record<string, string>> = {
  ADS: 'ads',
  ALL: 'all',
}

const PICKUP_METHOD_FEED_VALUES: Readonly<Record<string, string>> = {
  BUY: 'buy',
  NOT_SUPPORTED: 'not_supported',
  RESERVE: 'reserve',
  SHIP_TO_STORE: 'ship_to_store',
}

const PICKUP_SLA_FEED_VALUES: Readonly<Record<string, string>> = {
  FIVE_DAY: '5-day',
  FOUR_DAY: '4-day',
  MULTI_WEEK: 'multi-week',
  NEXT_DAY: 'next_day',
  SAME_DAY: 'same_day',
  SIX_DAY: '6-day',
  THREE_DAY: '3-day',
  TWO_DAY: '2-day',
}

const mappedEnumValue = (
  enumName: string,
  unspecifiedValue: string,
  values: Readonly<Record<string, string>>,
  value: string | undefined,
): string => {
  const normalized = value?.trim().toUpperCase() ?? ''
  if (!normalized || normalized === unspecifiedValue) {
    return ''
  }
  const mapped = values[normalized]
  if (!mapped) {
    throw new TypeError(`TSV feed cannot serialize ${enumName} value: ${value?.trim() ?? ''}`)
  }
  return mapped
}

// Product data source values are not a mechanical case conversion of the
// Merchant API enum. In particular, API YOUTUBE_SHOPPING retains the legacy
// text-feed value Youtube_merchandise. Keep this allowlist tied to Google's
// documented text values and fail closed when an API-only destination has no
// documented lossless representation.
const DESTINATION_FEED_VALUES: Readonly<Record<string, string>> = {
  CLOUD_RETAIL: 'Cloud_retail',
  DISPLAY_ADS: 'Display_ads',
  FREE_LISTINGS: 'Free_listings',
  FREE_LOCAL_LISTINGS: 'Free_local_listings',
  LOCAL_CLOUD_RETAIL: 'Local_cloud_retail',
  LOCAL_INVENTORY_ADS: 'Local_inventory_ads',
  SHOPPING_ADS: 'Shopping_ads',
  VEHICLE_ADS: 'vehicle_ads',
  YOUTUBE_AFFILIATE: 'Youtube_affiliate',
  YOUTUBE_SHOPPING: 'Youtube_merchandise',
}

const destinationValue = (value: string): string => {
  const normalized = value.trim()
  if (!normalized || normalized === 'DESTINATION_ENUM_UNSPECIFIED') {
    return ''
  }
  const mapped = DESTINATION_FEED_VALUES[normalized.toUpperCase()]
  if (!mapped) {
    throw new TypeError(`TSV feed cannot serialize DestinationEnum value: ${normalized}`)
  }
  return mapped
}

const ENERGY_CLASS_FEED_VALUES: Readonly<Record<string, string>> = {
  A: 'A',
  AP: 'A+',
  APP: 'A++',
  APPP: 'A+++',
  B: 'B',
  C: 'C',
  D: 'D',
  E: 'E',
  F: 'F',
  G: 'G',
}

const energyClassValue = (value: string | undefined): string => {
  const normalized = value?.trim() ?? ''
  if (!normalized || normalized === 'ENERGY_EFFICIENCY_CLASS_UNSPECIFIED') {
    return ''
  }
  const mapped = ENERGY_CLASS_FEED_VALUES[normalized.toUpperCase().replace(/\+/g, 'P')]
  if (!mapped) {
    throw new TypeError(`TSV feed cannot serialize EnergyEfficiencyClass value: ${normalized}`)
  }
  return mapped
}

const SIZE_TYPE_VALUES = new Set(['BIG', 'MATERNITY', 'PETITE', 'PLUS', 'REGULAR', 'TALL'])
const SIZE_SYSTEM_VALUES = new Set([
  'AU',
  'BR',
  'CN',
  'DE',
  'EU',
  'FR',
  'IT',
  'JP',
  'MEX',
  'UK',
  'US',
])

const sizeSystemValue = (value: string | undefined): string => {
  const normalized = value?.trim().toUpperCase() ?? ''
  if (!normalized || normalized === 'SIZE_SYSTEM_UNSPECIFIED') {
    return ''
  }
  if (!SIZE_SYSTEM_VALUES.has(normalized)) {
    throw new TypeError(`TSV feed cannot serialize SizeSystem value: ${value?.trim() ?? ''}`)
  }
  return normalized
}

const sizeTypeValue = (value: string): string => {
  const normalized = value.trim().toUpperCase()
  if (!normalized || normalized === 'SIZE_TYPE_UNSPECIFIED') {
    return ''
  }
  if (!SIZE_TYPE_VALUES.has(normalized)) {
    throw new TypeError(`TSV feed cannot serialize SizeType value: ${value.trim()}`)
  }
  return normalized.toLowerCase()
}
const booleanValue = (value: boolean | undefined): string => {
  if (value === undefined) {
    return ''
  }
  return value ? 'yes' : 'no'
}
const numberValue = (value: number | string | undefined): string =>
  value === undefined ? '' : String(value)
const moneyValue = (value: MCPrice | undefined): string => (value ? priceToFeedValue(value) : '')

const arrayValues = (value: MCArrayField | MCUrlArrayField | undefined): string[] => {
  if (!value) {
    return []
  }
  return value.map((entry) => {
    if (typeof entry === 'string') {
      return entry
    }
    if ('url' in entry) {
      return entry.url
    }
    return entry.value
  })
}

const repeatedValue = (value: MCArrayField | MCUrlArrayField | undefined): string => {
  return arrayValues(value)
    .map((entry) => delimitedPart(entry, /[,"]/))
    .join(',')
}

const repeatedMappedValue = (
  value: MCArrayField | MCUrlArrayField | undefined,
  map: (entry: string) => string,
): string => {
  return arrayValues(value)
    .map(map)
    .filter(Boolean)
    .map((entry) => delimitedPart(entry, /[,"]/))
    .join(',')
}

const repeatedUrlValue = (value: MCUrlArrayField | undefined): string => {
  return arrayValues(value)
    .map((entry) => cleanCell(entry).replace(/,/g, '%2C'))
    .join(',')
}

const dimensionValue = (dimension: MCShippingDimension | undefined): string => {
  if (!dimension || dimension.value === undefined) {
    return ''
  }
  return cleanCell(`${dimension.value}${dimension.unit ? ` ${dimension.unit}` : ''}`)
}

const groupValue = (parts: Array<boolean | number | string | undefined>): string => {
  return parts
    .map((part) => delimitedPart(part === undefined ? '' : String(part), /[,:"]/))
    .join(':')
}

const structuredValue = (value: MCProductAttributes['structuredTitle'] | undefined): string => {
  if (!value) {
    return ''
  }
  const source =
    value.digitalSourceType === 'TRAINED_ALGORITHMIC_MEDIA'
      ? 'trained_algorithmic_media'
      : value.digitalSourceType === 'DEFAULT'
        ? 'default'
        : ''
  // An unspecified provenance has no documented spelling, and a leading colon
  // would be read as an empty first sub-attribute rather than as "absent". The
  // content is still a group sub-value, so it keeps Google's quoting rule.
  return source ? groupValue([source, value.content]) : delimitedPart(value.content ?? '', /[,:"]/)
}

/**
 * Google's documented positional order for the shipping attribute, declared to
 * Google by GMC_TSV_SHIPPING_COLUMN. Every position is always emitted: an
 * absent sub-attribute holds its place with an empty value so a row can never
 * be read against a shorter layout than the header announces.
 */
const SHIPPING_SUB_ATTRIBUTES = [
  'country',
  'region',
  'postalCode',
  'locationId',
  'locationGroupName',
  'service',
  'price',
  'minHandlingTime',
  'maxHandlingTime',
  'minTransitTime',
  'maxTransitTime',
] as const satisfies readonly (keyof MCShipping)[]

const supportedShippingSubAttributes = new Set<string>(SHIPPING_SUB_ATTRIBUTES)

const shippingValue = (shipping: MCShipping[] | undefined): string => {
  return (shipping ?? [])
    .map((entry) => {
      const unsupported = Object.keys(entry).filter(
        (field) => !supportedShippingSubAttributes.has(field),
      )
      if (unsupported.length > 0) {
        throw new TypeError(
          `TSV feed cannot serialize shipping sub-attribute${unsupported.length === 1 ? '' : 's'}: ${unsupported.sort().join(', ')}`,
        )
      }
      return SHIPPING_SUB_ATTRIBUTES.map((field) => {
        if (field === 'price') {
          return entry.price ? priceToFeedValue(entry.price) : ''
        }
        return entry[field] === undefined ? '' : cleanCell(String(entry[field]))
      }).join(':')
    })
    .join(',')
}

/**
 * Google publishes new attributes between releases of this package. An
 * attribute with no documented column is reported once per build and omitted:
 * failing the whole feed would take a working catalog offline for a field the
 * text format cannot carry anyway. Enum values with no documented text
 * spelling still throw, because emitting the wrong value is worse than none.
 */
const productRow = (
  product: GmcCanonicalProduct,
  reportUnmapped: (path: string, name: string) => void,
): Record<string, string> => {
  for (const field of Object.keys(product.input)) {
    if (!supportedProductInputFields.has(field)) {
      reportUnmapped(`input.${field}`, field)
    }
  }
  const attrs = product.input.productAttributes ?? {}
  for (const field of Object.keys(attrs)) {
    if (!supportedProductAttributeFields.has(field)) {
      reportUnmapped(`input.productAttributes.${field}`, field)
    }
  }
  const row: Record<string, string> = {
    id: scalarValue(product.identity.offerId),
    additional_image_link: repeatedUrlValue(attrs.additionalImageLinks),
    ads_grouping: scalarValue(attrs.adsGrouping ?? ''),
    ads_labels: repeatedValue(attrs.adsLabels),
    ads_redirect: scalarValue(attrs.adsRedirect ?? ''),
    adult: booleanValue(attrs.adult),
    age_group: mappedEnumValue(
      'AgeGroup',
      'AGE_GROUP_UNSPECIFIED',
      AGE_GROUP_FEED_VALUES,
      attrs.ageGroup,
    ),
    auto_pricing_min_price: moneyValue(attrs.autoPricingMinPrice),
    availability: mappedEnumValue(
      'Availability',
      'AVAILABILITY_UNSPECIFIED',
      AVAILABILITY_FEED_VALUES,
      attrs.availability,
    ),
    availability_date: scalarValue(attrs.availabilityDate ?? ''),
    brand: scalarValue(attrs.brand ?? ''),
    canonical_link: scalarValue(attrs.canonicalLink ?? ''),
    color: scalarValue(attrs.color ?? ''),
    condition: mappedEnumValue(
      'Condition',
      'CONDITION_UNSPECIFIED',
      CONDITION_FEED_VALUES,
      attrs.condition,
    ),
    cost_of_goods_sold: moneyValue(attrs.costOfGoodsSold),
    custom_label_0: scalarValue(attrs.customLabel0 ?? ''),
    custom_label_1: scalarValue(attrs.customLabel1 ?? ''),
    custom_label_2: scalarValue(attrs.customLabel2 ?? ''),
    custom_label_3: scalarValue(attrs.customLabel3 ?? ''),
    custom_label_4: scalarValue(attrs.customLabel4 ?? ''),
    description: scalarValue(attrs.description ?? ''),
    disclosure_date: scalarValue(attrs.disclosureDate ?? ''),
    display_ads_id: scalarValue(attrs.displayAdsId ?? ''),
    display_ads_link: scalarValue(attrs.displayAdsLink ?? ''),
    display_ads_similar_id: repeatedValue(attrs.displayAdsSimilarIds),
    display_ads_title: scalarValue(attrs.displayAdsTitle ?? ''),
    display_ads_value: numberValue(attrs.displayAdsValue),
    energy_efficiency_class: energyClassValue(attrs.energyEfficiencyClass),
    excluded_destination: repeatedMappedValue(attrs.excludedDestinations, destinationValue),
    expiration_date: scalarValue(attrs.expirationDate ?? ''),
    external_seller_id: scalarValue(attrs.externalSellerId ?? ''),
    free_shipping_threshold: (attrs.freeShippingThreshold ?? [])
      .map((threshold) =>
        groupValue([
          threshold.country,
          threshold.priceThreshold ? priceToFeedValue(threshold.priceThreshold) : undefined,
        ]),
      )
      .join(','),
    gender: mappedEnumValue('Gender', 'GENDER_UNSPECIFIED', GENDER_FEED_VALUES, attrs.gender),
    [GMC_TSV_SHIPPING_COLUMN]: shippingValue(attrs.shipping),
    google_product_category: scalarValue(attrs.googleProductCategory ?? ''),
    gtin: repeatedValue(attrs.gtins),
    identifier_exists: booleanValue(attrs.identifierExists),
    image_link: scalarValue(attrs.imageLink ?? ''),
    included_destination: repeatedMappedValue(attrs.includedDestinations, destinationValue),
    is_bundle: booleanValue(attrs.isBundle),
    item_group_id: scalarValue(attrs.itemGroupId ?? ''),
    lifestyle_image_link: repeatedUrlValue(attrs.lifestyleImageLinks),
    link: scalarValue(attrs.link ?? ''),
    link_template: scalarValue(attrs.linkTemplate ?? ''),
    material: scalarValue(attrs.material ?? ''),
    max_energy_efficiency_class: energyClassValue(attrs.maxEnergyEfficiencyClass),
    max_handling_time: scalarValue(attrs.maxHandlingTime ?? ''),
    maximum_retail_price: moneyValue(attrs.maximumRetailPrice),
    min_energy_efficiency_class: energyClassValue(attrs.minEnergyEfficiencyClass),
    min_handling_time: scalarValue(attrs.minHandlingTime ?? ''),
    mobile_link: scalarValue(attrs.mobileLink ?? ''),
    mobile_link_template: scalarValue(attrs.mobileLinkTemplate ?? ''),
    mpn: scalarValue(attrs.mpn ?? ''),
    multipack: numberValue(attrs.multipack),
    pattern: scalarValue(attrs.pattern ?? ''),
    pause: mappedEnumValue('Pause', 'PAUSE_UNSPECIFIED', PAUSE_FEED_VALUES, attrs.pause),
    pickup_method: mappedEnumValue(
      'PickupMethod',
      'PICKUP_METHOD_UNSPECIFIED',
      PICKUP_METHOD_FEED_VALUES,
      attrs.pickupMethod,
    ),
    pickup_SLA: mappedEnumValue(
      'PickupSla',
      'PICKUP_SLA_UNSPECIFIED',
      PICKUP_SLA_FEED_VALUES,
      attrs.pickupSla,
    ),
    price: moneyValue(attrs.price),
    product_detail: (attrs.productDetails ?? [])
      .map((detail) =>
        groupValue([detail.sectionName, detail.attributeName, detail.attributeValue]),
      )
      .join(','),
    product_height: dimensionValue(attrs.productHeight),
    product_highlight: repeatedValue(attrs.productHighlights),
    product_length: dimensionValue(attrs.productLength),
    product_type: repeatedValue(attrs.productTypes),
    product_weight: dimensionValue(attrs.productWeight),
    product_width: dimensionValue(attrs.productWidth),
    promotion_id: repeatedValue(attrs.promotionIds),
    return_policy_label: scalarValue(attrs.returnPolicyLabel ?? ''),
    sale_price: moneyValue(attrs.salePrice),
    sale_price_effective_date: attrs.salePriceEffectiveDate
      ? cleanCell(
          `${attrs.salePriceEffectiveDate.startTime ?? ''}/${attrs.salePriceEffectiveDate.endTime ?? ''}`,
        )
      : '',
    sell_on_google_quantity: scalarValue(attrs.sellOnGoogleQuantity ?? ''),
    shipping_height: dimensionValue(attrs.shippingHeight),
    shipping_label: scalarValue(attrs.shippingLabel ?? ''),
    shipping_length: dimensionValue(attrs.shippingLength),
    shipping_weight: dimensionValue(attrs.shippingWeight),
    shipping_width: dimensionValue(attrs.shippingWidth),
    shopping_ads_excluded_country: repeatedValue(attrs.shoppingAdsExcludedCountries),
    short_title: scalarValue(attrs.shortTitle ?? ''),
    size: scalarValue(attrs.size ?? ''),
    size_system: sizeSystemValue(attrs.sizeSystem),
    size_type: repeatedMappedValue(attrs.sizeTypes, sizeTypeValue),
    structured_description: structuredValue(attrs.structuredDescription),
    structured_title: structuredValue(attrs.structuredTitle),
    title: scalarValue(attrs.title ?? ''),
    transit_time_label: scalarValue(attrs.transitTimeLabel ?? ''),
    video_link: repeatedUrlValue(attrs.videoLinks),
    virtual_model_link: scalarValue(attrs.virtualModelLink ?? ''),
  }

  for (const attribute of product.input.customAttributes ?? []) {
    if (typeof attribute.value !== 'string') {
      throw new TypeError(
        `TSV feed cannot serialize grouped custom attribute: ${cleanCell(attribute.name) || '(unnamed)'}`,
      )
    }
    // Column names are matched case-insensitively so a generic attribute still
    // resolves onto a built-in column Google spells with capitals (pickup_SLA).
    const normalized = customColumnName(attribute.name)
    // A generic `shipping` value is written for the four-position default
    // layout. This feed declares a named eleven-position layout, so the two
    // cannot share a column and the value cannot be reinterpreted safely.
    if (normalized === 'shipping') {
      throw new TypeError(
        'Custom attribute shipping collides with the named shipping column; supply productAttributes.shipping instead',
      )
    }
    const name = builtInColumnsByLowerCaseName.get(normalized) ?? normalized
    if (builtInColumnsByLowerCaseName.has(normalized) && row[name]) {
      throw new TypeError(`Custom attribute ${name} collides with a built-in TSV column`)
    }
    // Merchant API replaces underscores in generic attribute names with
    // spaces. Text feeds require the inverse snake_case spelling. A generic
    // standard attribute may populate an otherwise-empty built-in column;
    // simultaneous strong + generic values are rejected above as ambiguous.
    row[name] = scalarValue(attribute.value)
  }

  return row
}

/**
 * Code-unit ordering, never `localeCompare`: the artifact checksum is a
 * promotion fence, so two hosts on different ICU locales must serialize the
 * same catalog to the same bytes.
 */
const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

export const serializeCanonicalTsv: GmcFeedFormatAdapter['serialize'] = (context) => {
  const unmapped = new Map<string, GmcProjectionWarning>()
  const reportUnmapped = (path: string, name: string): void => {
    if (!unmapped.has(name)) {
      unmapped.set(name, {
        code: 'GMC_TSV_UNMAPPED_ATTRIBUTE',
        message: `Attribute ${name} has no documented text-feed column and was omitted from feed ${context.feedId}`,
        path,
      })
    }
  }
  const rows = [...context.products]
    .sort((left, right) =>
      byCodeUnit(getIdentityKey(left.identity), getIdentityKey(right.identity)),
    )
    .map((product) => productRow(product, reportUnmapped))
  const customColumns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
    .filter((column) => !GMC_TSV_COLUMNS.includes(column as never))
    .sort(byCodeUnit)
  const columns = [...GMC_TSV_COLUMNS, ...customColumns]
  const lines = [
    columns.join('\t'),
    ...rows.map((row) => {
      const cells = columns.map((column) => row[column] ?? '')
      return cells.join('\t')
    }),
  ]
  return {
    body: new TextEncoder().encode(`${lines.join('\n')}\n`),
    contentType: 'text/tab-separated-values; charset=utf-8',
    extension: 'tsv',
    warnings: [...unmapped.values()].sort((left, right) =>
      byCodeUnit(left.path ?? '', right.path ?? ''),
    ),
  }
}

export const gmcTsvFormat: GmcFeedFormatAdapter = {
  id: 'tsv',
  serialize: serializeCanonicalTsv,
}
