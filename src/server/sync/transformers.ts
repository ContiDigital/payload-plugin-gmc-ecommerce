import type {
  MCCustomAttribute,
  MCProductAttributes,
  MCProductInput,
  MCProductState,
  NormalizedPluginOptions,
  PayloadProductDoc,
  ResolvedMCIdentity,
} from '../../types/index.js'

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
  const mcState: MCProductState | undefined = (product as PayloadProductDoc).merchantCenter
  const storedAttributes: MCProductAttributes = mcState?.productAttributes ?? {}
  const storedCustomAttributes: MCCustomAttribute[] | undefined = mcState?.customAttributes

  const productAttributes = stripEmpty(normalizeArrayFields({ ...storedAttributes }))
  const customAttributes = sanitizeCustomAttributes(storedCustomAttributes)

  // Apply default condition if not set
  if (!productAttributes.condition) {
    productAttributes.condition = options.defaults.condition
  }

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
