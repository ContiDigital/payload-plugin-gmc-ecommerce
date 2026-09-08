import type { MCPrice } from '../types/index.js'
import type { GmcLocalInventoryInput } from './types.js'

import { canonicalJson } from './canonical.js'
import { normalizeGmcCustomAttributes } from './customAttributes.js'
import { isGmcNonNegativeInt64String, parseGmcRfc3339Timestamp } from './merchantWire.js'

const AVAILABILITY = new Set([
  'IN_STOCK',
  'LIMITED_AVAILABILITY',
  'ON_DISPLAY_TO_ORDER',
  'OUT_OF_STOCK',
])
const PICKUP_METHOD = new Set(['BUY', 'NOT_SUPPORTED', 'RESERVE', 'SHIP_TO_STORE'])
const PICKUP_SLA = new Set([
  'FIVE_DAY',
  'FOUR_DAY',
  'MULTI_WEEK',
  'NEXT_DAY',
  'SAME_DAY',
  'SEVEN_DAY',
  'SIX_DAY',
  'THREE_DAY',
  'TWO_DAY',
])
const INPUT_FIELDS = new Set(['localInventoryAttributes', 'storeCode'])
const ATTRIBUTE_FIELDS = new Set([
  'availability',
  'customAttributes',
  'instoreProductLocation',
  'localShippingLabel',
  'loyaltyPrograms',
  'pickupMethod',
  'pickupSla',
  'price',
  'quantity',
  'salePrice',
  'salePriceEffectiveDate',
])
const LOYALTY_FIELDS = new Set([
  'cashbackForFutureUse',
  'loyaltyPoints',
  'memberPriceEffectiveInterval',
  'price',
  'programLabel',
  'shippingLabel',
  'tierLabel',
])
const INTERVAL_FIELDS = new Set(['endTime', 'startTime'])
const PRICE_FIELDS = new Set(['amountMicros', 'currencyCode'])
const MAX_LOCAL_INVENTORY_BYTES = 262_144

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })

const assertSupportedFields = (name: string, value: object, supported: Set<string>): void => {
  const unknown = Object.keys(value).filter((field) => !supported.has(field))
  if (unknown.length > 0) {
    throw new TypeError(
      `${name} contains unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.sort().join(', ')}`,
    )
  }
}

const assertPrice = (name: string, value: unknown): void => {
  if (value === undefined) {
    return
  }
  if (!isRecord(value)) {
    throw new TypeError(`${name} must be a Price object`)
  }
  assertSupportedFields(name, value, PRICE_FIELDS)
  const { amountMicros, currencyCode } = value
  if (
    !isGmcNonNegativeInt64String(amountMicros) ||
    typeof currencyCode !== 'string' ||
    !/^[A-Z]{3}$/.test(currencyCode)
  ) {
    throw new TypeError(
      `${name} must use signed-int64 non-negative amountMicros and an uppercase ISO currency`,
    )
  }
}

const assertInterval = (name: string, value: unknown): void => {
  if (!isRecord(value)) {
    throw new TypeError(`${name} must be an interval object`)
  }
  assertSupportedFields(name, value, INTERVAL_FIELDS)
  const { endTime, startTime } = value
  const parsedStart = startTime === undefined ? undefined : parseGmcRfc3339Timestamp(startTime)
  const parsedEnd = endTime === undefined ? undefined : parseGmcRfc3339Timestamp(endTime)
  if (startTime !== undefined && parsedStart === null) {
    throw new TypeError(`${name}.startTime must be an RFC 3339 timestamp`)
  }
  if (endTime !== undefined && parsedEnd === null) {
    throw new TypeError(`${name}.endTime must be an RFC 3339 timestamp`)
  }
  if (
    parsedStart !== undefined &&
    parsedStart !== null &&
    parsedEnd !== undefined &&
    parsedEnd !== null &&
    parsedStart > parsedEnd
  ) {
    throw new TypeError(`${name} startTime must not follow endTime`)
  }
}

const assertOptionalSafeString = (name: string, value: unknown, maxCharacters?: number): void => {
  if (
    value !== undefined &&
    (typeof value !== 'string' ||
      !value ||
      value !== value.trim() ||
      hasControlCharacters(value) ||
      (maxCharacters !== undefined && [...value].length > maxCharacters))
  ) {
    throw new TypeError(
      `${name} must be a canonical non-empty string without control characters${
        maxCharacters === undefined ? '' : ` and at most ${maxCharacters} characters`
      }`,
    )
  }
}

export const canonicalizeLocalInventoryInput = (
  input: GmcLocalInventoryInput,
): GmcLocalInventoryInput => {
  if (!input || typeof input !== 'object' || !input.localInventoryAttributes) {
    throw new TypeError('Local inventory input and localInventoryAttributes are required')
  }
  let serialized: string
  try {
    serialized = canonicalJson(input)
  } catch (error) {
    throw new TypeError('Local inventory input must contain bounded, finite, acyclic JSON', {
      cause: error,
    })
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_LOCAL_INVENTORY_BYTES) {
    throw new TypeError(
      `Local inventory input must not exceed ${MAX_LOCAL_INVENTORY_BYTES} serialized bytes`,
    )
  }
  const normalized = JSON.parse(serialized) as GmcLocalInventoryInput
  assertSupportedFields('Local inventory input', normalized, INPUT_FIELDS)
  const storeCode = normalized.storeCode?.trim()
  if (!storeCode || [...storeCode].length > 64 || hasControlCharacters(storeCode)) {
    throw new TypeError('Local inventory storeCode must contain 1-64 safe characters')
  }
  const attrs = normalized.localInventoryAttributes
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) {
    throw new TypeError('Local inventory localInventoryAttributes must be a JSON object')
  }
  assertSupportedFields('Local inventory attributes', attrs, ATTRIBUTE_FIELDS)
  if (!AVAILABILITY.has(attrs.availability)) {
    throw new TypeError('Local inventory availability is required and must be valid')
  }
  if (attrs.quantity !== undefined && !isGmcNonNegativeInt64String(attrs.quantity)) {
    throw new TypeError('Local inventory quantity must be a non-negative signed int64 string')
  }
  if (attrs.pickupMethod !== undefined && !PICKUP_METHOD.has(attrs.pickupMethod)) {
    throw new TypeError('Local inventory pickupMethod is invalid')
  }
  if (attrs.pickupSla !== undefined && !PICKUP_SLA.has(attrs.pickupSla)) {
    throw new TypeError('Local inventory pickupSla is invalid')
  }
  if (attrs.pickupSla !== undefined && attrs.pickupMethod === undefined) {
    throw new TypeError('Local inventory pickupSla requires pickupMethod')
  }
  if (
    attrs.pickupMethod !== undefined &&
    attrs.pickupMethod !== 'NOT_SUPPORTED' &&
    attrs.pickupSla === undefined
  ) {
    throw new TypeError('Local inventory pickupMethod requires pickupSla')
  }
  assertOptionalSafeString('Local inventory instoreProductLocation', attrs.instoreProductLocation)
  if (attrs.instoreProductLocation !== undefined) {
    if (Buffer.byteLength(attrs.instoreProductLocation, 'utf8') > 20) {
      throw new TypeError('Local inventory instoreProductLocation must not exceed 20 bytes')
    }
  }
  assertOptionalSafeString('Local inventory localShippingLabel', attrs.localShippingLabel, 100)
  assertPrice('Local inventory price', attrs.price)
  assertPrice('Local inventory salePrice', attrs.salePrice)
  if (attrs.salePrice !== undefined && attrs.price === undefined) {
    throw new TypeError('Local inventory salePrice requires price')
  }
  if (attrs.salePriceEffectiveDate !== undefined && attrs.salePrice === undefined) {
    throw new TypeError('Local inventory salePriceEffectiveDate requires salePrice')
  }
  if (attrs.salePriceEffectiveDate !== undefined) {
    assertInterval('Local inventory salePriceEffectiveDate', attrs.salePriceEffectiveDate)
  }
  if (attrs.loyaltyPrograms !== undefined) {
    if (!Array.isArray(attrs.loyaltyPrograms)) {
      throw new TypeError('Local inventory loyaltyPrograms must be an array')
    }
    const identities = new Set<string>()
    attrs.loyaltyPrograms.forEach((program, index) => {
      const name = `Local inventory loyaltyPrograms[${index}]`
      if (!isRecord(program)) {
        throw new TypeError(`${name} must be an object`)
      }
      assertSupportedFields(name, program, LOYALTY_FIELDS)
      for (const field of ['programLabel', 'shippingLabel', 'tierLabel'] as const) {
        assertOptionalSafeString(`${name}.${field}`, program[field])
      }
      assertPrice(`${name}.price`, program.price)
      assertPrice(`${name}.cashbackForFutureUse`, program.cashbackForFutureUse)
      if (
        program.loyaltyPoints !== undefined &&
        !isGmcNonNegativeInt64String(program.loyaltyPoints)
      ) {
        throw new TypeError(`${name}.loyaltyPoints must be a non-negative signed int64 string`)
      }
      if (program.memberPriceEffectiveInterval !== undefined) {
        if (program.price === undefined) {
          throw new TypeError(`${name}.memberPriceEffectiveInterval requires price`)
        }
        assertInterval(`${name}.memberPriceEffectiveInterval`, program.memberPriceEffectiveInterval)
      }
      if (
        program.price === undefined &&
        program.cashbackForFutureUse === undefined &&
        program.loyaltyPoints === undefined &&
        program.shippingLabel === undefined
      ) {
        throw new TypeError(`${name} must define at least one loyalty benefit`)
      }
      if (
        program.price &&
        attrs.price &&
        program.price.currencyCode === attrs.price.currencyCode &&
        BigInt(program.price.amountMicros) > BigInt(attrs.price.amountMicros)
      ) {
        throw new TypeError(`${name}.price must not exceed the store price`)
      }
      const identity = `${program.programLabel?.toLowerCase() ?? ''}\u0000${
        program.tierLabel?.toLowerCase() ?? ''
      }`
      if (identities.has(identity)) {
        throw new TypeError(`${name} duplicates a loyalty program/tier identity`)
      }
      identities.add(identity)
    })
  }
  if (
    attrs.salePrice &&
    attrs.price &&
    attrs.salePrice.currencyCode === attrs.price.currencyCode &&
    BigInt(attrs.salePrice.amountMicros) > BigInt(attrs.price.amountMicros)
  ) {
    throw new TypeError('Local inventory salePrice must not exceed price')
  }
  if (attrs.salePrice && attrs.price && attrs.salePrice.currencyCode !== attrs.price.currencyCode) {
    throw new TypeError('Local inventory salePrice currency must match price currency')
  }
  if (attrs.loyaltyPrograms) {
    for (const [index, program] of attrs.loyaltyPrograms.entries()) {
      for (const field of ['cashbackForFutureUse', 'price'] as const) {
        if (
          program[field] &&
          attrs.price &&
          program[field].currencyCode !== attrs.price.currencyCode
        ) {
          throw new TypeError(
            `Local inventory loyaltyPrograms[${index}].${field} currency must match the store price currency`,
          )
        }
      }
    }
  }
  if (attrs.customAttributes !== undefined) {
    const customAttributes = normalizeGmcCustomAttributes(
      attrs.customAttributes,
      'localInventoryAttributes.customAttributes',
    )
    if (customAttributes.issues.length > 0 || !customAttributes.attributes) {
      throw new TypeError(
        `Invalid local inventory customAttributes: ${customAttributes.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join('; ')}`,
      )
    }
    attrs.customAttributes = customAttributes.attributes
  }

  return { localInventoryAttributes: attrs, storeCode }
}

/** Enforce invariants that require the canonical online offer's regular price. */
export const assertLocalInventoryMatchesProductPrice = (
  inventory: GmcLocalInventoryInput,
  productPrice: MCPrice,
): void => {
  assertPrice('Canonical product price', productPrice)
  const attrs = inventory.localInventoryAttributes
  const regularPrice = attrs.price ?? productPrice
  if (attrs.price && attrs.price.currencyCode !== productPrice.currencyCode) {
    throw new TypeError(
      'Local inventory price currency must match canonical product price currency',
    )
  }
  for (const [index, program] of (attrs.loyaltyPrograms ?? []).entries()) {
    const name = `Local inventory loyaltyPrograms[${index}]`
    for (const field of ['cashbackForFutureUse', 'price'] as const) {
      if (program[field] && program[field].currencyCode !== regularPrice.currencyCode) {
        throw new TypeError(`${name}.${field} currency must match regular price currency`)
      }
    }
    if (program.price && BigInt(program.price.amountMicros) > BigInt(regularPrice.amountMicros)) {
      throw new TypeError(`${name}.price must not exceed regular price`)
    }
  }
}
