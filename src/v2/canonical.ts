import { createHash } from 'node:crypto'

import type { MCPrice, MCProductIdentity } from '../types/index.js'
import type {
  GmcApiProductInput,
  GmcCanonicalProduct,
  GmcProductProjection,
  GmcProjectedProductInput,
  GmcProjectionWarning,
  GmcVersionedCanonicalProduct,
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
      {
        code: 'count',
        message: `must be an array containing at most ${MAX_PROJECTION_WARNINGS} warnings`,
        path: 'projection.warnings',
      },
    ])
  }
  const issues: GmcValidationIssue[] = []
  const warnings = value.map((entry, index): GmcProjectionWarning => {
    const prefix = `projection.warnings[${index}]`
    if (!isRecord(entry) || Object.getPrototypeOf(entry) !== Object.prototype) {
      issues.push({ code: 'type', message: 'must be a plain object', path: prefix })
      return { code: 'INVALID', message: 'Invalid warning' }
    }
    const code = typeof entry.code === 'string' ? entry.code.trim() : ''
    const message = typeof entry.message === 'string' ? entry.message.trim() : ''
    const path = typeof entry.path === 'string' ? entry.path.trim() : entry.path
    if (!code || code.length > MAX_WARNING_CODE_LENGTH || !/^[\w.:-]+$/.test(code)) {
      issues.push({
        code: 'warning_code',
        message: `must contain 1-${MAX_WARNING_CODE_LENGTH} safe characters`,
        path: `${prefix}.code`,
      })
    }
    if (!message || message.length > MAX_WARNING_MESSAGE_LENGTH || hasControlCharacters(message)) {
      issues.push({
        code: 'warning_message',
        message: `must contain 1-${MAX_WARNING_MESSAGE_LENGTH} safe characters`,
        path: `${prefix}.message`,
      })
    }
    if (
      path !== undefined &&
      (typeof path !== 'string' ||
        !path ||
        path.length > MAX_WARNING_PATH_LENGTH ||
        hasControlCharacters(path))
    ) {
      issues.push({
        code: 'warning_path',
        message: `must contain 1-${MAX_WARNING_PATH_LENGTH} safe characters when supplied`,
        path: `${prefix}.path`,
      })
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
    issues.push({ code: 'required', message: 'must be a non-empty string', path })
    return false
  }
  return true
}

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
    issues.push({ code: 'url', message: 'must be an absolute HTTP(S) URL', path })
  }
  if (value.length > 2_000) {
    issues.push({ code: 'length', message: 'must not exceed 2000 characters', path })
  }
}

const validatePrice = (issues: GmcValidationIssue[], path: string, value: unknown): void => {
  if (!isRecord(value)) {
    issues.push({ code: 'price', message: 'must be a price object', path })
    return
  }

  for (const field of Object.keys(value)) {
    if (!PRICE_FIELDS.has(field)) {
      issues.push({
        code: 'field',
        message: 'is not a supported Price field',
        path: `${path}.${field}`,
      })
    }
  }

  if (!isGmcNonNegativeInt64String(value.amountMicros)) {
    issues.push({
      code: 'amount_micros',
      message: 'amountMicros must be a non-negative signed int64 string',
      path: `${path}.amountMicros`,
    })
  }
  if (typeof value.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(value.currencyCode)) {
    issues.push({
      code: 'currency',
      message: 'currencyCode must be a three-letter uppercase ISO 4217 code',
      path: `${path}.currencyCode`,
    })
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
    issues.push({
      code: 'content_language',
      message: 'must be a lowercase ISO 639-1 language code',
      path: `${prefix}.contentLanguage`,
    })
  }
  if (
    requireString(issues, `${prefix}.feedLabel`, input.feedLabel) &&
    !/^[A-Z0-9_-]{1,20}$/.test(input.feedLabel)
  ) {
    issues.push({
      code: 'feed_label',
      message: 'must contain 1-20 uppercase letters, digits, hyphens, or underscores',
      path: `${prefix}.feedLabel`,
    })
  }
  if (requireString(issues, `${prefix}.offerId`, input.offerId) && input.offerId.length > 50) {
    issues.push({
      code: 'offer_id',
      message: 'must not exceed 50 characters',
      path: `${prefix}.offerId`,
    })
  }
}

const validateAttributes = (
  issues: GmcValidationIssue[],
  input: GmcApiProductInput,
  prefix: string,
): void => {
  const rawAttributes = input.productAttributes
  if (!isRecord(rawAttributes)) {
    issues.push({
      code: rawAttributes === undefined ? 'required' : 'type',
      message: 'productAttributes must be a plain object',
      path: `${prefix}.productAttributes`,
    })
    return
  }
  const attrs = rawAttributes

  const textAlternative = (
    name: 'description' | 'title',
    structuredName: 'structuredDescription' | 'structuredTitle',
    maxLength: number,
  ): void => {
    const plain = attrs[name]
    const structured = attrs[structuredName]
    if (plain === undefined && structured === undefined) {
      issues.push({
        code: 'required',
        message: `requires either ${name} or ${structuredName}`,
        path: `${prefix}.productAttributes.${name}`,
      })
      return
    }
    if (plain !== undefined && structured !== undefined) {
      issues.push({
        code: 'exclusive',
        message: `must not be supplied with ${structuredName}`,
        path: `${prefix}.productAttributes.${name}`,
      })
    }
    if (
      plain !== undefined &&
      requireString(issues, `${prefix}.productAttributes.${name}`, plain) &&
      plain.length > maxLength
    ) {
      issues.push({
        code: 'length',
        message: `must not exceed ${maxLength} characters`,
        path: `${prefix}.productAttributes.${name}`,
      })
    }
  }
  textAlternative('title', 'structuredTitle', 150)
  textAlternative('description', 'structuredDescription', 5_000)
  validateUrl(issues, `${prefix}.productAttributes.link`, attrs.link)
  validateUrl(issues, `${prefix}.productAttributes.imageLink`, attrs.imageLink)

  for (const [name, value] of [
    ['adsRedirect', attrs.adsRedirect],
    ['canonicalLink', attrs.canonicalLink],
    ['displayAdsLink', attrs.displayAdsLink],
    ['linkTemplate', attrs.linkTemplate],
    ['mobileLink', attrs.mobileLink],
    ['mobileLinkTemplate', attrs.mobileLinkTemplate],
    ['virtualModelLink', attrs.virtualModelLink],
  ] as const) {
    if (value !== undefined) {
      validateUrl(issues, `${prefix}.productAttributes.${name}`, value)
    }
  }

  for (const [name, value, maxCount] of [
    ['additionalImageLinks', attrs.additionalImageLinks, 10],
    ['lifestyleImageLinks', attrs.lifestyleImageLinks, 10],
    ['videoLinks', attrs.videoLinks, 10],
  ] as const) {
    if (value === undefined) {
      continue
    }
    if (!Array.isArray(value)) {
      issues.push({
        code: 'type',
        message: 'must contain URL strings',
        path: `${prefix}.productAttributes.${name}`,
      })
      continue
    }
    if (value.length > maxCount) {
      issues.push({
        code: 'count',
        message: `must not contain more than ${maxCount} URLs`,
        path: `${prefix}.productAttributes.${name}`,
      })
    }
    value.forEach((url, index) => {
      validateUrl(issues, `${prefix}.productAttributes.${name}[${index}]`, url)
    })
  }

  if (attrs.gtins !== undefined) {
    if (!Array.isArray(attrs.gtins) || attrs.gtins.some((gtin) => typeof gtin !== 'string')) {
      issues.push({
        code: 'type',
        message: 'must contain strings',
        path: `${prefix}.productAttributes.gtins`,
      })
    } else if (attrs.gtins.length > 10) {
      issues.push({
        code: 'count',
        message: 'must not contain more than 10 values',
        path: `${prefix}.productAttributes.gtins`,
      })
    }
  }

  if (attrs.sizeTypes !== undefined) {
    if (
      !Array.isArray(attrs.sizeTypes) ||
      attrs.sizeTypes.some((sizeType) => typeof sizeType !== 'string')
    ) {
      issues.push({
        code: 'type',
        message: 'must contain strings',
        path: `${prefix}.productAttributes.sizeTypes`,
      })
    } else if (attrs.sizeTypes.length > 2) {
      issues.push({
        code: 'count',
        message: 'must not contain more than 2 values',
        path: `${prefix}.productAttributes.sizeTypes`,
      })
    }
  }

  for (const [name, value] of [
    ['availabilityDate', attrs.availabilityDate],
    ['disclosureDate', attrs.disclosureDate],
    ['expirationDate', attrs.expirationDate],
  ] as const) {
    if (value !== undefined && !isGmcRfc3339Timestamp(value)) {
      issues.push({
        code: 'timestamp',
        message: 'must be an RFC 3339 protobuf Timestamp',
        path: `${prefix}.productAttributes.${name}`,
      })
    }
  }

  if (
    requireString(issues, `${prefix}.productAttributes.availability`, attrs.availability) &&
    ![
      'BACKORDER',
      'IN_STOCK',
      'LIMITED_AVAILABILITY',
      'OUT_OF_STOCK',
      'PREORDER',
    ].includes(attrs.availability)
  ) {
    issues.push({
      code: 'availability',
      message: 'must be a Merchant API availability enum',
      path: `${prefix}.productAttributes.availability`,
    })
  }
  if (
    (attrs.availability === 'BACKORDER' || attrs.availability === 'PREORDER') &&
    attrs.availabilityDate === undefined
  ) {
    issues.push({
      code: 'dependency',
      message: `is required when availability is ${attrs.availability}`,
      path: `${prefix}.productAttributes.availabilityDate`,
    })
  }

  validatePrice(issues, `${prefix}.productAttributes.price`, attrs.price)
  if (attrs.salePrice !== undefined) {
    validatePrice(issues, `${prefix}.productAttributes.salePrice`, attrs.salePrice)
  }
  if (attrs.autoPricingMinPrice !== undefined) {
    validatePrice(
      issues,
      `${prefix}.productAttributes.autoPricingMinPrice`,
      attrs.autoPricingMinPrice,
    )
  }
  if (attrs.maximumRetailPrice !== undefined) {
    validatePrice(
      issues,
      `${prefix}.productAttributes.maximumRetailPrice`,
      attrs.maximumRetailPrice,
    )
  }
  if (attrs.costOfGoodsSold !== undefined) {
    validatePrice(issues, `${prefix}.productAttributes.costOfGoodsSold`, attrs.costOfGoodsSold)
  }
  if (validPrice(attrs.price) && validPrice(attrs.salePrice)) {
    if (attrs.salePrice.currencyCode !== attrs.price.currencyCode) {
      issues.push({
        code: 'currency',
        message: 'currency must match price currency',
        path: `${prefix}.productAttributes.salePrice.currencyCode`,
      })
    } else if (BigInt(attrs.salePrice.amountMicros) > BigInt(attrs.price.amountMicros)) {
      issues.push({
        code: 'price_order',
        message: 'must not exceed price',
        path: `${prefix}.productAttributes.salePrice.amountMicros`,
      })
    }
  }

  for (const [name, value] of [
    ['maxHandlingTime', attrs.maxHandlingTime],
    ['minHandlingTime', attrs.minHandlingTime],
    ['multipack', attrs.multipack],
    ['sellOnGoogleQuantity', attrs.sellOnGoogleQuantity],
  ] as const) {
    if (value !== undefined && !isGmcNonNegativeInt64String(value)) {
      issues.push({
        code: 'integer',
        message: 'must be a non-negative signed int64 string',
        path: `${prefix}.productAttributes.${name}`,
      })
    }
  }

  const interval = attrs.salePriceEffectiveDate
  if (interval !== undefined) {
    if (!attrs.salePrice) {
      issues.push({
        code: 'dependency',
        message: 'requires salePrice',
        path: `${prefix}.productAttributes.salePriceEffectiveDate`,
      })
    }
    if (!isRecord(interval)) {
      issues.push({
        code: 'type',
        message: 'must be an Interval object',
        path: `${prefix}.productAttributes.salePriceEffectiveDate`,
      })
    } else {
      const start = interval.startTime
      const end = interval.endTime
      const parsedStart = start === undefined ? undefined : parseGmcRfc3339Timestamp(start)
      const parsedEnd = end === undefined ? undefined : parseGmcRfc3339Timestamp(end)
      if (start !== undefined && parsedStart === null) {
        issues.push({
          code: 'timestamp',
          message: 'must be an RFC 3339 protobuf Timestamp',
          path: `${prefix}.productAttributes.salePriceEffectiveDate.startTime`,
        })
      }
      if (end !== undefined && parsedEnd === null) {
        issues.push({
          code: 'timestamp',
          message: 'must be an RFC 3339 protobuf Timestamp',
          path: `${prefix}.productAttributes.salePriceEffectiveDate.endTime`,
        })
      }
      if (
        parsedStart !== undefined &&
        parsedStart !== null &&
        parsedEnd !== undefined &&
        parsedEnd !== null &&
        parsedStart > parsedEnd
      ) {
        issues.push({
          code: 'interval',
          message: 'startTime must not be after endTime',
          path: `${prefix}.productAttributes.salePriceEffectiveDate`,
        })
      }
    }
  }

  if (attrs.productHighlights !== undefined) {
    if (
      !Array.isArray(attrs.productHighlights) ||
      attrs.productHighlights.some((highlight) => typeof highlight !== 'string')
    ) {
      issues.push({
        code: 'type',
        message: 'must contain strings',
        path: `${prefix}.productAttributes.productHighlights`,
      })
    } else if (attrs.productHighlights.length < 2 || attrs.productHighlights.length > 100) {
      issues.push({
        code: 'count',
        message: 'must contain between 2 and 100 values when supplied',
        path: `${prefix}.productAttributes.productHighlights`,
      })
    } else {
      attrs.productHighlights.forEach((highlight, index) => {
        if (highlight.trim().length === 0 || highlight.length > 150) {
          issues.push({
            code: 'length',
            message: 'must contain 1-150 characters',
            path: `${prefix}.productAttributes.productHighlights[${index}]`,
          })
        }
      })
    }
  }

  if (attrs.productDetails !== undefined) {
    if (!Array.isArray(attrs.productDetails)) {
      issues.push({
        code: 'type',
        message: 'must contain product detail objects',
        path: `${prefix}.productAttributes.productDetails`,
      })
    } else {
      if (attrs.productDetails.length > 100) {
        issues.push({
          code: 'count',
          message: 'must not contain more than 100 product details',
          path: `${prefix}.productAttributes.productDetails`,
        })
      }
      attrs.productDetails.forEach((detail, index) => {
        const path = `${prefix}.productAttributes.productDetails[${index}]`
        if (!isRecord(detail)) {
          issues.push({ code: 'type', message: 'must be an object', path })
          return
        }
        if (
          detail.sectionName !== undefined &&
          requireString(issues, `${path}.sectionName`, detail.sectionName) &&
          detail.sectionName.length > 150
        ) {
          issues.push({
            code: 'length',
            message: 'must not exceed 150 characters',
            path: `${path}.sectionName`,
          })
        }
        for (const field of ['attributeName', 'attributeValue'] as const) {
          if (
            requireString(issues, `${path}.${field}`, detail[field]) &&
            detail[field].length > 150
          ) {
            issues.push({
              code: 'length',
              message: 'must not exceed 150 characters',
              path: `${path}.${field}`,
            })
          }
        }
      })
    }
  }

  for (const [name, value, maxLength] of [
    ['structuredDescription', attrs.structuredDescription, 5_000],
    ['structuredTitle', attrs.structuredTitle, 150],
  ] as const) {
    if (value === undefined) {
      continue
    }
    if (!isRecord(value)) {
      issues.push({
        code: 'type',
        message: 'must be an object',
        path: `${prefix}.productAttributes.${name}`,
      })
      continue
    }
    if (
      requireString(issues, `${prefix}.productAttributes.${name}.content`, value.content) &&
      value.content.length > maxLength
    ) {
      issues.push({
        code: 'length',
        message: `must not exceed ${maxLength} characters`,
        path: `${prefix}.productAttributes.${name}.content`,
      })
    }
    if (
      value.digitalSourceType !== undefined &&
      !['DEFAULT', 'DIGITAL_SOURCE_TYPE_UNSPECIFIED', 'TRAINED_ALGORITHMIC_MEDIA'].includes(
        String(value.digitalSourceType),
      )
    ) {
      issues.push({
        code: 'enum',
        message: 'has an unsupported digitalSourceType',
        path: `${prefix}.productAttributes.${name}.digitalSourceType`,
      })
    }
  }
  if (attrs.condition !== undefined && !['NEW', 'REFURBISHED', 'USED'].includes(attrs.condition)) {
    issues.push({
      code: 'condition',
      message: 'must be a Merchant API condition enum',
      path: `${prefix}.productAttributes.condition`,
    })
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
      throw new GmcProjectionValidationError([
        {
          code: 'json',
          message: error.message,
          path: error.path,
        },
      ])
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
    'offerId',
    'productAttributes',
  ])
  for (const field of Object.keys(input)) {
    if (!supportedInputFields.has(field)) {
      issues.push({
        code: 'field',
        message: 'is not a supported writable ProductInput field',
        path: `input.${field}`,
      })
    }
  }
  validateIdentity(issues, input, 'input')
  validateAttributes(issues, input, 'input')

  if (dataSourceOverride !== undefined && dataSourceOverride.trim().length === 0) {
    issues.push({
      code: 'data_source_override',
      message: 'must be a non-empty data source resource name when supplied',
      path: 'input.dataSourceOverride',
    })
  }

  if (args.sourceVersion !== undefined) {
    if (!isGmcNonNegativeInt64String(args.sourceVersion)) {
      issues.push({
        code: 'source_version',
        message: 'must be a non-negative signed int64 string',
        path: 'sourceVersion',
      })
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
      {
        code: 'size',
        message: `must not exceed ${MAX_CANONICAL_PRODUCT_BYTES} serialized bytes`,
        path: 'input',
      },
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
): { products: GmcVersionedCanonicalProduct[]; warnings: GmcProjectionWarning[] } => {
  if (!projection || !Array.isArray(projection.products)) {
    throw new GmcProjectionValidationError([
      {
        code: 'required',
        message: 'projection.products must be an array',
        path: 'projection.products',
      },
    ])
  }
  if (typeof projection.sourceVersion !== 'string') {
    throw new GmcProjectionValidationError([
      {
        code: 'required',
        message: 'projection.sourceVersion must be a string',
        path: 'projection.sourceVersion',
      },
    ])
  }
  if (projection.products.length > GMC_V2_MAX_PRODUCTS_PER_PROJECTION) {
    throw new GmcProjectionValidationError([
      {
        code: 'count',
        message: `must not contain more than ${GMC_V2_MAX_PRODUCTS_PER_PROJECTION} products`,
        path: 'projection.products',
      },
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
          {
            code: 'duplicate_identity',
            message: 'projection contains the same Google identity more than once',
            path: `projection.products[${index}]`,
          },
        ])
      }
      seen.add(key)
      return product as GmcVersionedCanonicalProduct
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
