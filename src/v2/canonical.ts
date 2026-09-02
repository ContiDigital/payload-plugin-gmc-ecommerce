import { createHash } from 'node:crypto'

import type { MCPrice, MCProductIdentity } from '../types/index.js'
import type {
  GmcApiProductInput,
  GmcCanonicalProduct,
  GmcProductProjection,
  GmcProjectedProductInput,
  GmcProjectionWarning,
} from './types.js'

import { normalizeGmcCustomAttributes } from './customAttributes.js'
import {
  isGmcNonNegativeInt64String,
  isGmcRfc3339Timestamp,
  parseGmcRfc3339Timestamp,
} from './merchantWire.js'

const PRICE_FIELDS = new Set(['amountMicros', 'currencyCode'])
const PROJECTED_INTERVAL_FIELDS = new Set(['endDate', 'endTime', 'id', 'startDate', 'startTime'])

export type GmcValidationIssue = {
  code: string
  message: string
  path: string
}

const issue = (code: string, path: string, message: string): GmcValidationIssue => ({
  code,
  message,
  path,
})

const addIssue = (
  issues: GmcValidationIssue[],
  code: string,
  path: string,
  message: string,
): void => {
  issues.push(issue(code, path, message))
}

export class GmcProjectionValidationError extends TypeError {
  readonly issues: GmcValidationIssue[]

  constructor(issues: GmcValidationIssue[]) {
    const summary = issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')
    super(
      `Invalid Google Merchant product projection (${issues.length} issue${issues.length === 1 ? '' : 's'}): ${summary}`,
    )
    this.name = 'GmcProjectionValidationError'
    this.issues = issues
  }
}

class GmcJsonValueError extends TypeError {
  readonly path: string

  constructor(path: string, message: string) {
    super(message)
    this.name = 'GmcJsonValueError'
    this.path = path
  }
}

const MAX_CANONICAL_PRODUCT_BYTES = 1_048_576
const MAX_JSON_DEPTH = 100
export const GMC_V2_MAX_PRODUCTS_PER_PROJECTION = 1_000
const MAX_PROJECTION_WARNINGS = 1_000
const MAX_WARNING_CODE_LENGTH = 128
const MAX_WARNING_MESSAGE_LENGTH = 4_000
const MAX_WARNING_PATH_LENGTH = 1_024

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })

const canonicalizeWarnings = (value: unknown): GmcProjectionWarning[] => {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || value.length > MAX_PROJECTION_WARNINGS) {
    throw new GmcProjectionValidationError([
      issue(
        'count',
        'projection.warnings',
        `must be an array containing at most ${MAX_PROJECTION_WARNINGS} warnings`,
      ),
    ])
  }
  const issues: GmcValidationIssue[] = []
  const warnings = value.map((entry, index): GmcProjectionWarning => {
    const prefix = `projection.warnings[${index}]`
    if (!isRecord(entry) || Object.getPrototypeOf(entry) !== Object.prototype) {
      addIssue(issues, 'type', prefix, 'must be a plain object')
      return { code: 'INVALID', message: 'Invalid warning' }
    }
    const code = typeof entry.code === 'string' ? entry.code.trim() : ''
    const message = typeof entry.message === 'string' ? entry.message.trim() : ''
    const path = typeof entry.path === 'string' ? entry.path.trim() : entry.path
    if (!code || code.length > MAX_WARNING_CODE_LENGTH || !/^[\w.:-]+$/.test(code)) {
      addIssue(
        issues,
        'warning_code',
        `${prefix}.code`,
        `must contain 1-${MAX_WARNING_CODE_LENGTH} safe characters`,
      )
    }
    if (!message || message.length > MAX_WARNING_MESSAGE_LENGTH || hasControlCharacters(message)) {
      addIssue(
        issues,
        'warning_message',
        `${prefix}.message`,
        `must contain 1-${MAX_WARNING_MESSAGE_LENGTH} safe characters`,
      )
    }
    if (
      path !== undefined &&
      (typeof path !== 'string' ||
        !path ||
        path.length > MAX_WARNING_PATH_LENGTH ||
        hasControlCharacters(path))
    ) {
      addIssue(
        issues,
        'warning_path',
        `${prefix}.path`,
        `must contain 1-${MAX_WARNING_PATH_LENGTH} safe characters when supplied`,
      )
    }
    return {
      code,
      message,
      ...(typeof path === 'string' ? { path } : {}),
    }
  })
  if (issues.length > 0) {
    throw new GmcProjectionValidationError(issues)
  }
  return warnings
}

const normalizeStringArray = (value: unknown): unknown => {
  if (!Array.isArray(value)) {
    return value
  }
  return value.map((entry) => {
    if (typeof entry === 'string') {
      return entry
    }
    if (isRecord(entry)) {
      if (typeof entry.value === 'string') {
        return entry.value
      }
      if (typeof entry.url === 'string') {
        return entry.url
      }
    }
    return entry
  })
}

/**
 * Removes legacy Payload row wrappers before either hashing or transport.
 * The v2 boundary is API-native even when a host migrates an old projection.
 */
const normalizeProjectedInput = (input: GmcProjectedProductInput): GmcProjectedProductInput => {
  const normalizedValue = normalizeJson(input, 'input')
  if (!isRecord(normalizedValue)) {
    throw new GmcJsonValueError('input', 'must be a plain JSON object')
  }
  const normalized = normalizedValue as GmcProjectedProductInput
  const attrs = normalized.productAttributes
  if (isRecord(attrs)) {
    for (const field of [
      'additionalImageLinks',
      'adsLabels',
      'displayAdsSimilarIds',
      'excludedDestinations',
      'gtins',
      'includedDestinations',
      'lifestyleImageLinks',
      'productHighlights',
      'productTypes',
      'promotionIds',
      'shoppingAdsExcludedCountries',
      'sizeTypes',
      'videoLinks',
    ]) {
      if (attrs[field] !== undefined) {
        attrs[field] = normalizeStringArray(attrs[field])
      }
    }

    if (attrs.sizeTypes === undefined && typeof attrs.sizeType === 'string') {
      attrs.sizeTypes = [attrs.sizeType]
    }
    delete attrs.sizeType

    if (typeof attrs.multipack === 'number' && Number.isSafeInteger(attrs.multipack)) {
      attrs.multipack = String(attrs.multipack)
    }

    if (isRecord(attrs.salePriceEffectiveDate)) {
      const interval = attrs.salePriceEffectiveDate as unknown as Record<string, unknown>
      const unknownFields = Object.keys(interval).filter(
        (field) => !PROJECTED_INTERVAL_FIELDS.has(field),
      )
      if (unknownFields.length > 0) {
        throw new GmcJsonValueError(
          'input.productAttributes.salePriceEffectiveDate',
          `contains unsupported fields: ${unknownFields.sort().join(', ')}`,
        )
      }
      if (
        (interval.startTime !== undefined && interval.startDate !== undefined) ||
        (interval.endTime !== undefined && interval.endDate !== undefined)
      ) {
        throw new GmcJsonValueError(
          'input.productAttributes.salePriceEffectiveDate',
          'must not mix legacy date aliases with Merchant time fields',
        )
      }
      attrs.salePriceEffectiveDate = {
        endTime: interval.endTime ?? interval.endDate,
        startTime: interval.startTime ?? interval.startDate,
      } as NonNullable<typeof attrs.salePriceEffectiveDate>
    }

    if (Array.isArray(attrs.productDetails)) {
      attrs.productDetails = attrs.productDetails.map((entry) =>
        isRecord(entry)
          ? {
              attributeName: entry.attributeName,
              attributeValue: entry.attributeValue,
              sectionName: entry.sectionName,
            }
          : entry,
      )
    }
  }
  return normalizeJson(normalized, 'input') as GmcProjectedProductInput
}

const requireString = (
  issues: GmcValidationIssue[],
  path: string,
  value: unknown,
): value is string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    addIssue(issues, 'required', path, 'must be a non-empty string')
    return false
  }
  return true
}

/**
 * Validates the transport shape of a URL the projection actually supplied.
 * Character ceilings and per-field cardinality are Merchant Center
 * merchandising policy, not wire contract: Google reports them as item issues
 * against a published offer, so enforcing them here would strand offers that
 * Google itself would have accepted.
 */
const validateUrl = (issues: GmcValidationIssue[], path: string, value: unknown): void => {
  if (!requireString(issues, path, value)) {
    return
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError('unsupported protocol')
    }
  } catch {
    addIssue(issues, 'url', path, 'must be an absolute HTTP(S) URL')
  }
}

const validateStringArray = (issues: GmcValidationIssue[], path: string, value: unknown): void => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    addIssue(issues, 'type', path, 'must contain strings')
  }
}

const validatePrice = (issues: GmcValidationIssue[], path: string, value: unknown): void => {
  if (!isRecord(value)) {
    addIssue(issues, 'price', path, 'must be a price object')
    return
  }

  for (const field of Object.keys(value)) {
    if (!PRICE_FIELDS.has(field)) {
      addIssue(issues, 'field', `${path}.${field}`, 'is not a supported Price field')
    }
  }

  if (!isGmcNonNegativeInt64String(value.amountMicros)) {
    addIssue(
      issues,
      'amount_micros',
      `${path}.amountMicros`,
      'amountMicros must be a non-negative signed int64 string',
    )
  }
  if (typeof value.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(value.currencyCode)) {
    addIssue(
      issues,
      'currency',
      `${path}.currencyCode`,
      'currencyCode must be a three-letter uppercase ISO 4217 code',
    )
  }
}

const validPrice = (value: unknown): value is MCPrice =>
  isRecord(value) &&
  Object.keys(value).every((field) => PRICE_FIELDS.has(field)) &&
  isGmcNonNegativeInt64String(value.amountMicros) &&
  typeof value.currencyCode === 'string' &&
  /^[A-Z]{3}$/.test(value.currencyCode)

const validateIdentity = (
  issues: GmcValidationIssue[],
  input: GmcApiProductInput,
  prefix: string,
): void => {
  if (
    requireString(issues, `${prefix}.contentLanguage`, input.contentLanguage) &&
    !/^[a-z]{2}$/.test(input.contentLanguage)
  ) {
    addIssue(
      issues,
      'content_language',
      `${prefix}.contentLanguage`,
      'must be a lowercase ISO 639-1 language code',
    )
  }
  if (
    requireString(issues, `${prefix}.feedLabel`, input.feedLabel) &&
    !/^[A-Z0-9_-]{1,20}$/.test(input.feedLabel)
  ) {
    addIssue(
      issues,
      'feed_label',
      `${prefix}.feedLabel`,
      'must contain 1-20 uppercase letters, digits, hyphens, or underscores',
    )
  }
  if (requireString(issues, `${prefix}.offerId`, input.offerId) && input.offerId.length > 50) {
    addIssue(issues, 'offer_id', `${prefix}.offerId`, 'must not exceed 50 characters')
  }
}

/** Single-value URL attributes; every one is optional in the Merchant API. */
const URL_ATTRIBUTE_FIELDS = [
  'adsRedirect',
  'canonicalLink',
  'displayAdsLink',
  'imageLink',
  'link',
  'linkTemplate',
  'mobileLink',
  'mobileLinkTemplate',
  'virtualModelLink',
] as const

const REPEATED_URL_ATTRIBUTE_FIELDS = [
  'additionalImageLinks',
  'lifestyleImageLinks',
  'videoLinks',
] as const

const STRING_ARRAY_ATTRIBUTE_FIELDS = ['gtins', 'productHighlights', 'sizeTypes'] as const

const TIMESTAMP_ATTRIBUTE_FIELDS = ['availabilityDate', 'disclosureDate', 'expirationDate'] as const

const INT64_ATTRIBUTE_FIELDS = [
  'maxHandlingTime',
  'minHandlingTime',
  'multipack',
  'sellOnGoogleQuantity',
] as const

const PRICE_ATTRIBUTE_FIELDS = [
  'autoPricingMinPrice',
  'costOfGoodsSold',
  'maximumRetailPrice',
  'price',
  'salePrice',
] as const

const STRUCTURED_TEXT_FIELDS = [
  ['description', 'structuredDescription'],
  ['title', 'structuredTitle'],
] as const

const AVAILABILITY_VALUES = [
  'BACKORDER',
  'IN_STOCK',
  'LIMITED_AVAILABILITY',
  'OUT_OF_STOCK',
  'PREORDER',
]
const CONDITION_VALUES = ['NEW', 'REFURBISHED', 'USED']
const DIGITAL_SOURCE_TYPES = [
  'DEFAULT',
  'DIGITAL_SOURCE_TYPE_UNSPECIFIED',
  'TRAINED_ALGORITHMIC_MEDIA',
]

/**
 * Checks only what Google's transport cannot accept: enum vocabulary, protobuf
 * wire shapes, and mutually exclusive attributes. A supplemental feed row is a
 * legitimate ProductInput, so nothing here is required beyond identity.
 */
const validateAttributes = (
  issues: GmcValidationIssue[],
  input: GmcApiProductInput,
  prefix: string,
): void => {
  const rawAttributes = input.productAttributes
  if (!isRecord(rawAttributes)) {
    addIssue(
      issues,
      rawAttributes === undefined ? 'required' : 'type',
      `${prefix}.productAttributes`,
      'productAttributes must be a plain object',
    )
    return
  }
  const attrs = rawAttributes
  const attributePath = (name: string): string => `${prefix}.productAttributes.${name}`

  for (const [name, structuredName] of STRUCTURED_TEXT_FIELDS) {
    if (attrs[name] !== undefined && attrs[structuredName] !== undefined) {
      addIssue(
        issues,
        'exclusive',
        attributePath(name),
        `must not be supplied with ${structuredName}`,
      )
    }
  }

  for (const name of URL_ATTRIBUTE_FIELDS) {
    if (attrs[name] !== undefined) {
      validateUrl(issues, attributePath(name), attrs[name])
    }
  }

  for (const name of REPEATED_URL_ATTRIBUTE_FIELDS) {
    const value = attrs[name]
    if (value === undefined) {
      continue
    }
    if (!Array.isArray(value)) {
      addIssue(issues, 'type', attributePath(name), 'must contain URL strings')
      continue
    }
    value.forEach((url, index) => {
      validateUrl(issues, `${attributePath(name)}[${index}]`, url)
    })
  }

  for (const name of STRING_ARRAY_ATTRIBUTE_FIELDS) {
    if (attrs[name] !== undefined) {
      validateStringArray(issues, attributePath(name), attrs[name])
    }
  }

  for (const name of TIMESTAMP_ATTRIBUTE_FIELDS) {
    if (attrs[name] !== undefined && !isGmcRfc3339Timestamp(attrs[name])) {
      addIssue(issues, 'timestamp', attributePath(name), 'must be an RFC 3339 protobuf Timestamp')
    }
  }

  for (const name of INT64_ATTRIBUTE_FIELDS) {
    if (attrs[name] !== undefined && !isGmcNonNegativeInt64String(attrs[name])) {
      addIssue(issues, 'integer', attributePath(name), 'must be a non-negative signed int64 string')
    }
  }

  for (const name of PRICE_ATTRIBUTE_FIELDS) {
    if (attrs[name] !== undefined) {
      validatePrice(issues, attributePath(name), attrs[name])
    }
  }
  // Google prices one offer in one currency; a mismatched sale price is a
  // transport error rather than a merchandising warning.
  if (
    validPrice(attrs.price) &&
    validPrice(attrs.salePrice) &&
    attrs.salePrice.currencyCode !== attrs.price.currencyCode
  ) {
    addIssue(
      issues,
      'currency',
      attributePath('salePrice.currencyCode'),
      'must match price currency',
    )
  }

  if (
    attrs.availability !== undefined &&
    (!requireString(issues, attributePath('availability'), attrs.availability) ||
      !AVAILABILITY_VALUES.includes(attrs.availability))
  ) {
    addIssue(
      issues,
      'availability',
      attributePath('availability'),
      'must be a Merchant API availability enum',
    )
  }
  if (attrs.condition !== undefined && !CONDITION_VALUES.includes(attrs.condition)) {
    addIssue(
      issues,
      'condition',
      attributePath('condition'),
      'must be a Merchant API condition enum',
    )
  }

  const interval = attrs.salePriceEffectiveDate
  if (interval !== undefined) {
    if (!attrs.salePrice) {
      addIssue(issues, 'dependency', attributePath('salePriceEffectiveDate'), 'requires salePrice')
    }
    if (!isRecord(interval)) {
      addIssue(
        issues,
        'type',
        attributePath('salePriceEffectiveDate'),
        'must be an Interval object',
      )
    } else {
      const bounds = (['startTime', 'endTime'] as const).map((field) => {
        const value = interval[field]
        const parsed = value === undefined ? undefined : parseGmcRfc3339Timestamp(value)
        if (parsed === null) {
          addIssue(
            issues,
            'timestamp',
            attributePath(`salePriceEffectiveDate.${field}`),
            'must be an RFC 3339 protobuf Timestamp',
          )
        }
        return parsed
      })
      const [start, end] = bounds
      if (start != null && end != null && start > end) {
        addIssue(
          issues,
          'interval',
          attributePath('salePriceEffectiveDate'),
          'startTime must not be after endTime',
        )
      }
    }
  }

  if (attrs.productDetails !== undefined) {
    if (!Array.isArray(attrs.productDetails)) {
      addIssue(
        issues,
        'type',
        attributePath('productDetails'),
        'must contain product detail objects',
      )
    } else {
      attrs.productDetails.forEach((detail, index) => {
        const path = `${attributePath('productDetails')}[${index}]`
        if (!isRecord(detail)) {
          addIssue(issues, 'type', path, 'must be an object')
          return
        }
        if (detail.sectionName !== undefined) {
          requireString(issues, `${path}.sectionName`, detail.sectionName)
        }
        for (const field of ['attributeName', 'attributeValue'] as const) {
          requireString(issues, `${path}.${field}`, detail[field])
        }
      })
    }
  }

  for (const name of ['structuredDescription', 'structuredTitle'] as const) {
    const value = attrs[name]
    if (value === undefined) {
      continue
    }
    if (!isRecord(value)) {
      addIssue(issues, 'type', attributePath(name), 'must be an object')
      continue
    }
    requireString(issues, attributePath(`${name}.content`), value.content)
    if (
      value.digitalSourceType !== undefined &&
      !DIGITAL_SOURCE_TYPES.includes(String(value.digitalSourceType))
    ) {
      addIssue(
        issues,
        'enum',
        attributePath(`${name}.digitalSourceType`),
        'has an unsupported digitalSourceType',
      )
    }
  }

  if (input.customAttributes !== undefined) {
    const customAttributes = normalizeGmcCustomAttributes(
      input.customAttributes,
      `${prefix}.customAttributes`,
    )
    issues.push(...customAttributes.issues)
    if (customAttributes.attributes) {
      input.customAttributes = customAttributes.attributes
    }
  }
}

const normalizeJson = (
  value: unknown,
  path = 'value',
  ancestors = new Set<object>(),
  depth = 0,
): unknown => {
  if (depth > MAX_JSON_DEPTH) {
    throw new GmcJsonValueError(path, `must not exceed ${MAX_JSON_DEPTH} nested levels`)
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new GmcJsonValueError(path, 'must be a finite JSON number')
    }
    return value
  }
  if (value === undefined) {
    return undefined
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new GmcJsonValueError(path, 'must not contain a circular reference')
    }
    ancestors.add(value)
    try {
      return value.map((entry, index) => {
        if (entry === undefined) {
          throw new GmcJsonValueError(`${path}[${index}]`, 'must not be undefined in an array')
        }
        return normalizeJson(entry, `${path}[${index}]`, ancestors, depth + 1)
      })
    } finally {
      ancestors.delete(value)
    }
  }
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new GmcJsonValueError(path, 'must contain only plain JSON objects')
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new GmcJsonValueError(path, 'must not contain symbol keys')
    }
    if (ancestors.has(value)) {
      throw new GmcJsonValueError(path, 'must not contain a circular reference')
    }
    ancestors.add(value)
    try {
      const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined) {
          normalized[key] = normalizeJson(value[key], `${path}.${key}`, ancestors, depth + 1)
        }
      }
      return normalized
    } finally {
      ancestors.delete(value)
    }
  }
  throw new GmcJsonValueError(path, `must not contain ${typeof value} values`)
}

export const canonicalJson = (value: unknown): string => JSON.stringify(normalizeJson(value))

export const getIdentityKey = (identity: MCProductIdentity): string => {
  return [
    identity.dataSourceOverride ?? '',
    identity.contentLanguage,
    identity.feedLabel,
    identity.offerId,
  ]
    .map((part) => `${part.length}:${part}`)
    .join('|')
}

/** Google processed-product identity; routing data sources do not participate. */
export const getProcessedIdentityKey = (identity: MCProductIdentity): string => {
  return [identity.contentLanguage, identity.feedLabel, identity.offerId]
    .map((part) => `${part.length}:${part}`)
    .join('|')
}

export const canonicalizeProductInput = (args: {
  input: GmcProjectedProductInput
  sourceVersion?: string
}): GmcCanonicalProduct => {
  let projectedInput: GmcProjectedProductInput
  try {
    projectedInput = normalizeProjectedInput(args.input)
  } catch (error) {
    if (error instanceof GmcJsonValueError) {
      throw new GmcProjectionValidationError([issue('json', error.path, error.message)])
    }
    throw error
  }
  const { dataSourceOverride, ...apiInput } = projectedInput
  const input = apiInput as GmcApiProductInput
  const issues: GmcValidationIssue[] = []
  const supportedInputFields = new Set([
    'contentLanguage',
    'customAttributes',
    'feedLabel',
    'legacyLocal',
    'offerId',
    'productAttributes',
  ])
  for (const field of Object.keys(input)) {
    if (!supportedInputFields.has(field)) {
      addIssue(issues, 'field', `input.${field}`, 'is not a supported writable ProductInput field')
    }
  }
  validateIdentity(issues, input, 'input')
  validateAttributes(issues, input, 'input')

  if (input.legacyLocal !== undefined && typeof input.legacyLocal !== 'boolean') {
    addIssue(issues, 'type', 'input.legacyLocal', 'must be a boolean when supplied')
  }

  if (dataSourceOverride !== undefined && dataSourceOverride.trim().length === 0) {
    addIssue(
      issues,
      'data_source_override',
      'input.dataSourceOverride',
      'must be a non-empty data source resource name when supplied',
    )
  }

  if (args.sourceVersion !== undefined) {
    if (!isGmcNonNegativeInt64String(args.sourceVersion)) {
      addIssue(
        issues,
        'source_version',
        'sourceVersion',
        'must be a non-negative signed int64 string',
      )
    }
  }

  if (issues.length > 0) {
    throw new GmcProjectionValidationError(issues)
  }

  input.contentLanguage = input.contentLanguage.trim()
  input.feedLabel = input.feedLabel.trim()
  input.offerId = input.offerId.trim()

  const identity: MCProductIdentity = {
    contentLanguage: input.contentLanguage.trim(),
    dataSourceOverride: dataSourceOverride?.trim(),
    feedLabel: input.feedLabel.trim(),
    offerId: input.offerId.trim(),
  }
  if (identity.dataSourceOverride === undefined) {
    delete identity.dataSourceOverride
  }

  const serializedInput = canonicalJson(input)
  const byteLength = Buffer.byteLength(serializedInput, 'utf8')
  if (byteLength > MAX_CANONICAL_PRODUCT_BYTES) {
    throw new GmcProjectionValidationError([
      issue('size', 'input', `must not exceed ${MAX_CANONICAL_PRODUCT_BYTES} serialized bytes`),
    ])
  }

  return {
    digest: createHash('sha256').update(serializedInput).digest('hex'),
    identity,
    input,
    sourceVersion: args.sourceVersion,
  }
}

export const canonicalizeProjection = (
  projection: GmcProductProjection,
): { products: GmcCanonicalProduct[]; warnings: GmcProjectionWarning[] } => {
  if (!projection || !Array.isArray(projection.products)) {
    throw new GmcProjectionValidationError([
      issue('required', 'projection.products', 'projection.products must be an array'),
    ])
  }
  if (projection.sourceVersion !== undefined && typeof projection.sourceVersion !== 'string') {
    throw new GmcProjectionValidationError([
      issue(
        'type',
        'projection.sourceVersion',
        'projection.sourceVersion must be a string when provided',
      ),
    ])
  }
  if (projection.products.length > GMC_V2_MAX_PRODUCTS_PER_PROJECTION) {
    throw new GmcProjectionValidationError([
      issue(
        'count',
        'projection.products',
        `must not contain more than ${GMC_V2_MAX_PRODUCTS_PER_PROJECTION} products`,
      ),
    ])
  }
  const warnings = canonicalizeWarnings(projection.warnings)

  const seen = new Set<string>()
  const products = projection.products.map((input, index) => {
    try {
      const product = canonicalizeProductInput({ input, sourceVersion: projection.sourceVersion })
      const key = getProcessedIdentityKey(product.identity)
      if (seen.has(key)) {
        throw new GmcProjectionValidationError([
          issue(
            'duplicate_identity',
            `projection.products[${index}]`,
            'projection contains the same Google identity more than once',
          ),
        ])
      }
      seen.add(key)
      return product
    } catch (error) {
      if (error instanceof GmcProjectionValidationError) {
        throw new GmcProjectionValidationError(
          error.issues.map((issue) => ({
            ...issue,
            path: `projection.products[${index}].${issue.path}`,
          })),
        )
      }
      throw error
    }
  })

  return { products, warnings }
}

export const priceToFeedValue = (price: MCPrice): string => {
  if (
    !isGmcNonNegativeInt64String(price.amountMicros) ||
    typeof price.currencyCode !== 'string' ||
    !/^[A-Z]{3}$/.test(price.currencyCode)
  ) {
    throw new TypeError('Feed price must use signed-int64 amountMicros and uppercase ISO currency')
  }
  const micros = BigInt(price.amountMicros)
  const whole = micros / 1_000_000n
  const remainder = (micros % 1_000_000n).toString().padStart(6, '0')
  const fractional = remainder.replace(/0+$/, '').padEnd(2, '0')
  return `${whole.toString()}.${fractional} ${price.currencyCode}`
}
