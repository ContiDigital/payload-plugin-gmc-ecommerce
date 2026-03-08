import type {
  MCCustomAttribute,
  MCProductAttributes,
  MCProductInput,
  MCProductState,
  NormalizedPluginOptions,
  PayloadProductDoc,
  ResolvedMCIdentity,
} from '../../types/index.js'

import {
  MC_FIELD_GROUP_NAME,
  MC_PRODUCT_ATTRIBUTES_FIELD_NAME,
} from '../../constants.js'

// ---------------------------------------------------------------------------
// Price utilities
// ---------------------------------------------------------------------------

export const toMicros = (value: number): string => {
  return String(Math.round(value * 1_000_000))
}

export const fromMicros = (value: string): number => {
  const num = Number(value)
  return Number.isFinite(num) ? num / 1_000_000 : 0
}

const normalizePriceField = (
  value: unknown,
  currencyCode: string,
): MCProductAttributes['price'] | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined
  }

  if (typeof value === 'string') {
    return {
      amountMicros: value,
      currencyCode,
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return {
      amountMicros: String(value),
      currencyCode,
    }
  }

  if (typeof value === 'object' && value !== null) {
    return value as MCProductAttributes['price']
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Custom attribute sanitization
// ---------------------------------------------------------------------------

export const sanitizeCustomAttributes = (
  attrs: MCCustomAttribute[] | undefined,
): MCCustomAttribute[] | undefined => {
  if (!attrs || !Array.isArray(attrs)) {
    return undefined
  }

  const cleaned = attrs.filter(
    (attr) =>
      attr &&
      typeof attr.name === 'string' &&
      attr.name.trim().length > 0 &&
      typeof attr.value === 'string' &&
      attr.value.trim().length > 0,
  ).map((attr) => ({
    name: attr.name.trim(),
    value: attr.value.trim(),
  }))

  return cleaned.length > 0 ? cleaned : undefined
}

// ---------------------------------------------------------------------------
// Strip empty values (deep) — removes null, undefined, empty strings,
// empty arrays, and empty objects so the MC API doesn't choke on them
// ---------------------------------------------------------------------------

const stripEmpty = <T extends Record<string, unknown>>(obj: T): T => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === '') {
      continue
    }
    if (Array.isArray(value)) {
      if (value.length > 0) {
        result[key] = value
      }
      continue
    }
    if (typeof value === 'object') {
      const stripped = stripEmpty(value as Record<string, unknown>)
      if (Object.keys(stripped).length > 0) {
        result[key] = stripped
      }
    } else {
      result[key] = value
    }
  }
  return result as T
}

// ---------------------------------------------------------------------------
// Forward transform: convert Payload row-object arrays back to plain string
// arrays expected by the MC API.
//
// Payload stores these as [{value: "foo"}, ...] or [{url: "..."}] but the
// MC API expects plain ["foo", ...] arrays.
// ---------------------------------------------------------------------------

const STRING_VALUE_ARRAY_FIELDS = new Set([
  'excludedDestinations',
  'gtins',
  'includedDestinations',
  'productTypes',
  'promotionIds',
])

const normalizeArrayFields = (attrs: MCProductAttributes): MCProductAttributes => {
  const result = { ...attrs }

  for (const field of STRING_VALUE_ARRAY_FIELDS) {
    const value = (result as Record<string, unknown>)[field]
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
      ;(result as Record<string, unknown>)[field] = (value as Array<Record<string, unknown>>)
        .map((item) => (typeof item.value === 'string' ? item.value : ''))
        .filter((v) => v.length > 0)
    }
  }

  // additionalImageLinks uses {url: "..."} instead of {value: "..."}
  if (Array.isArray(result.additionalImageLinks) && result.additionalImageLinks.length > 0) {
    const first = result.additionalImageLinks[0]
    if (typeof first === 'object' && first !== null && 'url' in first) {
      result.additionalImageLinks = (result.additionalImageLinks as unknown as Array<Record<string, unknown>>)
        .map((item) => (typeof item.url === 'string' ? item.url : ''))
        .filter((v) => v.length > 0)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Build ProductInput from Payload document's MC fields
// ---------------------------------------------------------------------------

export const buildProductInput = (
  product: PayloadProductDoc | Record<string, unknown>,
  identity: ResolvedMCIdentity,
  options: NormalizedPluginOptions,
): MCProductInput => {
  const mcState: MCProductState | undefined =
    (product as PayloadProductDoc)[MC_FIELD_GROUP_NAME]
  const storedAttributes: MCProductAttributes = mcState?.[MC_PRODUCT_ATTRIBUTES_FIELD_NAME] ?? {}
  const storedCustomAttributes: MCCustomAttribute[] | undefined = mcState?.customAttributes

  const productAttributes = stripEmpty(normalizeArrayFields({ ...storedAttributes }))
  const customAttributes = sanitizeCustomAttributes(storedCustomAttributes)

  // Apply default condition if not set
  if (!productAttributes.condition) {
    productAttributes.condition = options.defaults.condition
  }

  productAttributes.price = normalizePriceField(
    productAttributes.price,
    options.defaults.currency,
  )
  productAttributes.salePrice = normalizePriceField(
    productAttributes.salePrice,
    options.defaults.currency,
  )

  // Ensure price currency defaults
  if (productAttributes.price && !productAttributes.price.currencyCode) {
    productAttributes.price.currencyCode = options.defaults.currency
  }
  if (productAttributes.salePrice && !productAttributes.salePrice.currencyCode) {
    productAttributes.salePrice.currencyCode = options.defaults.currency
  }

  const input: MCProductInput = {
    contentLanguage: identity.contentLanguage,
    feedLabel: identity.feedLabel,
    offerId: identity.offerId,
    productAttributes,
  }

  if (customAttributes) {
    input.customAttributes = customAttributes
  }

  return input
}

// ---------------------------------------------------------------------------
// Reverse transform: MC Product response → Payload MC fields
//
// MC v1 API returns some fields as plain string arrays (productTypes, gtins,
// promotionIds, etc.) but Payload stores them as arrays of { value: string }.
// Similarly, additionalImageLinks comes as string[] but we store [{ url }].
// ---------------------------------------------------------------------------

const STRING_ARRAY_FIELDS = new Set([
  'excludedDestinations',
  'gtins',
  'includedDestinations',
  'productTypes',
  'promotionIds',
])

const normalizeComparisonValue = (value: unknown): unknown => {
  if (value === undefined || value === null || value === '') {
    return undefined
  }

  if (typeof value === 'string') {
    return value.trim().replace(/\s+/g, ' ')
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => normalizeComparisonValue(item))
      .filter((item) => item !== undefined)

    return normalized.length > 0 ? normalized : undefined
  }

  if (typeof value === 'object') {
    const normalizedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'id')
      .map(([key, entryValue]) => [key, normalizeComparisonValue(entryValue)] as const)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))

    if (normalizedEntries.length === 0) {
      return undefined
    }

    return Object.fromEntries(normalizedEntries)
  }

  return value
}

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false
    }

    return left.every((item, index) => deepEqual(item, right[index]))
  }

  if (
    typeof left === 'object' &&
    left !== null &&
    typeof right === 'object' &&
    right !== null
  ) {
    const leftEntries = Object.entries(left as Record<string, unknown>)
    const rightEntries = Object.entries(right as Record<string, unknown>)

    if (leftEntries.length !== rightEntries.length) {
      return false
    }

    return leftEntries.every(([key, value]) => deepEqual(value, (right as Record<string, unknown>)[key]))
  }

  return false
}

const deepContains = (target: unknown, subset: unknown): boolean => {
  if (subset === undefined) {
    return true
  }

  if (Array.isArray(subset)) {
    if (!Array.isArray(target) || target.length !== subset.length) {
      return false
    }

    return subset.every((item, index) => deepContains(target[index], item))
  }

  if (
    typeof subset === 'object' &&
    subset !== null
  ) {
    if (typeof target !== 'object' || target === null) {
      return false
    }

    return Object.entries(subset as Record<string, unknown>).every(([key, value]) =>
      deepContains((target as Record<string, unknown>)[key], value),
    )
  }

  return target === subset
}

export const reverseTransformProduct = (
  mcProduct: Record<string, unknown>,
): {
  customAttributes?: MCCustomAttribute[]
  productAttributes: Record<string, unknown>
} => {
  const rawAttributes = (mcProduct.productAttributes ?? {}) as Record<string, unknown>
  const customAttributes = mcProduct.customAttributes as MCCustomAttribute[] | undefined
  const productAttributes: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(rawAttributes)) {
    if (value === undefined || value === null) {continue}

    // Convert string arrays to Payload array-of-objects format
    if (STRING_ARRAY_FIELDS.has(key) && Array.isArray(value)) {
      productAttributes[key] = value.map((v: unknown) => ({ value: String(v) }))
      continue
    }

    // Convert additionalImageLinks string array to array-of-objects
    if (key === 'additionalImageLinks' && Array.isArray(value)) {
      productAttributes[key] = value.map((v: unknown) => ({ url: String(v) }))
      continue
    }

    // Everything else passes through (price, salePrice, dimensions, strings, booleans)
    productAttributes[key] = value
  }

  return {
    customAttributes: sanitizeCustomAttributes(customAttributes),
    productAttributes: stripEmpty(productAttributes),
  }
}

export const productAttributesEquivalent = (
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean => {
  const normalizedLeft = normalizeComparisonValue(left ?? {})
  const normalizedRight = normalizeComparisonValue(right ?? {})

  return deepEqual(normalizedLeft, normalizedRight)
}

export const productAttributesContainRemoteSubset = (
  local: Record<string, unknown> | undefined,
  remote: Record<string, unknown> | undefined,
): boolean => {
  const normalizedLocal = normalizeComparisonValue(local ?? {})
  const normalizedRemote = normalizeComparisonValue(remote ?? {})

  return deepContains(normalizedLocal, normalizedRemote)
}
