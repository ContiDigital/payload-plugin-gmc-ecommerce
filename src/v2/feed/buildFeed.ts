import { createHash } from 'node:crypto'

import type {
  GmcArtifactDescriptor,
  GmcArtifactFeedConfig,
  GmcCanonicalProduct,
  GmcFeedConfig,
  GmcFeedFormatAdapter,
  GmcFeedFormatResult,
  GmcFeedSelector,
} from '../types.js'

import { getIdentityKey } from '../canonical.js'
import { isGmcRfc3339Timestamp } from '../merchantWire.js'
import { GMC_V2_DEFAULT_FEED_LIMITS, GmcFeedLimitError } from './limits.js'
import { gmcTsvFormat } from './tsv.js'

export type GmcBuiltFeed = {
  checksum: string
  feedId: string
  generatedAt: string
  productCount: number
} & GmcFeedFormatResult

/** Every immutable descriptor field an at-least-once replay must re-verify. */
export const GMC_ARTIFACT_DESCRIPTOR_FIELDS = [
  'byteLength',
  'checksum',
  'contentType',
  'createdAt',
  'generatedAt',
  'key',
] as const

export type GmcPublishedFeedArtifact = {
  artifact: GmcArtifactDescriptor
  promotion: 'promoted' | 'stale'
}

const hasControlCharacters = (value: string): boolean => {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

const assertFormatMetadata = (args: {
  contentType: unknown
  extension: unknown
  formatId: string
}): void => {
  if (
    typeof args.contentType !== 'string' ||
    args.contentType !== args.contentType.trim() ||
    args.contentType.length === 0 ||
    args.contentType.length > 255 ||
    hasControlCharacters(args.contentType)
  ) {
    throw new TypeError(`Feed format ${args.formatId} returned an invalid content type`)
  }
  if (
    typeof args.extension !== 'string' ||
    !/^[A-Z0-9][\w.-]{0,31}$/i.test(args.extension) ||
    args.extension.includes('..')
  ) {
    throw new TypeError(`Feed format ${args.formatId} returned an invalid file extension`)
  }
}

/**
 * `generatedAt` orders artifact promotion, so it also names the immutable
 * object. Colons and dots are replaced so the key stays safe for object stores
 * and filesystems alike while preserving lexicographic order.
 */
export const gmcArtifactKeySegment = (generatedAt: string): string =>
  generatedAt.replace(/[.:]/g, '-')

export const assertFeedArtifactDescriptor = (args: {
  descriptor: GmcArtifactDescriptor
  feedId?: string
  instanceId?: string
}): void => {
  const descriptor = args.descriptor
  if (!descriptor || typeof descriptor !== 'object') {
    throw new TypeError('Feed artifact descriptor is missing')
  }
  if (!Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 0) {
    throw new TypeError('Feed artifact descriptor byte length is invalid')
  }
  if (!/^[a-f0-9]{64}$/.test(descriptor.checksum)) {
    throw new TypeError('Feed artifact descriptor checksum is invalid')
  }
  if (
    typeof descriptor.contentType !== 'string' ||
    descriptor.contentType !== descriptor.contentType.trim() ||
    descriptor.contentType.length === 0 ||
    descriptor.contentType.length > 255 ||
    hasControlCharacters(descriptor.contentType)
  ) {
    throw new TypeError('Feed artifact content type is invalid')
  }
  if (!isGmcRfc3339Timestamp(descriptor.createdAt)) {
    throw new TypeError('Feed artifact creation time is invalid')
  }
  if (
    typeof descriptor.key !== 'string' ||
    descriptor.key.trim().length === 0 ||
    descriptor.key.length > 1_024 ||
    hasControlCharacters(descriptor.key)
  ) {
    throw new TypeError('Feed artifact key is invalid')
  }
  if (!isGmcRfc3339Timestamp(descriptor.generatedAt)) {
    throw new TypeError('Feed artifact generation time is invalid')
  }
  if ((args.feedId === undefined) !== (args.instanceId === undefined)) {
    throw new TypeError('Feed artifact namespace requires both instanceId and feedId')
  }
  if (args.feedId !== undefined && args.instanceId !== undefined) {
    const safeNamespace = (value: string): boolean =>
      /^[\w.-]{1,100}$/.test(value) && value !== '.' && value !== '..'
    if (!safeNamespace(args.instanceId) || !safeNamespace(args.feedId)) {
      throw new TypeError('Feed artifact namespace is invalid')
    }
    const expectedPrefix = `${args.instanceId}/${args.feedId}/${gmcArtifactKeySegment(descriptor.generatedAt)}-${descriptor.checksum}.`
    const extension = descriptor.key.slice(expectedPrefix.length)
    if (
      !descriptor.key.startsWith(expectedPrefix) ||
      !/^[A-Z0-9][\w.-]{0,31}$/i.test(extension) ||
      extension.includes('..')
    ) {
      throw new TypeError('Feed artifact key is outside the requested instance/feed namespace')
    }
  }
}

export const assertFeedArtifactIntegrity = (args: {
  body: Uint8Array
  descriptor: GmcArtifactDescriptor
  feedId?: string
  instanceId?: string
  maxSerializedBytes?: number
}): void => {
  if (!(args.body instanceof Uint8Array)) {
    throw new TypeError('Feed artifact body must be a Uint8Array')
  }
  assertFeedArtifactDescriptor(args)
  const maxSerializedBytes =
    args.maxSerializedBytes ?? GMC_V2_DEFAULT_FEED_LIMITS.maxSerializedBytes
  if (args.body.byteLength > maxSerializedBytes) {
    throw new GmcFeedLimitError(
      `Feed artifact exceeds its ${maxSerializedBytes.toLocaleString('en-US')} byte safety limit`,
    )
  }
  if (args.descriptor.byteLength !== args.body.byteLength) {
    throw new TypeError('Feed artifact byte length does not match its descriptor')
  }
  const checksum = createHash('sha256').update(args.body).digest('hex')
  if (args.descriptor.checksum !== checksum) {
    throw new TypeError('Feed artifact checksum does not match its descriptor')
  }
}

const matchesSelector = (product: GmcCanonicalProduct, selector: GmcFeedSelector): boolean => {
  return (
    product.identity.contentLanguage === selector.contentLanguage &&
    product.identity.feedLabel === selector.feedLabel &&
    (product.identity.dataSourceOverride ?? '') === (selector.dataSourceOverride ?? '')
  )
}

const resolveFormat = (feed: GmcFeedConfig): GmcFeedFormatAdapter => {
  return !feed.format || feed.format === 'tsv' ? gmcTsvFormat : feed.format
}

const assertUniqueProducts = (products: readonly GmcCanonicalProduct[]): void => {
  const identities = new Set<string>()
  for (const product of products) {
    const key = getIdentityKey(product.identity)
    if (identities.has(key)) {
      throw new TypeError(`Canonical feed contains duplicate Google identity ${key}`)
    }
    identities.add(key)
  }
}

export const buildCanonicalFeed = async (args: {
  feed: GmcFeedConfig
  generatedAt?: string
  products: readonly GmcCanonicalProduct[]
}): Promise<GmcBuiltFeed> => {
  const generatedAt = args.generatedAt ?? new Date().toISOString()
  if (!isGmcRfc3339Timestamp(generatedAt)) {
    throw new TypeError('generatedAt must be an ISO date string')
  }

  const products = args.products.filter((product) => matchesSelector(product, args.feed.selector))
  const maxProducts = args.feed.limits?.maxProducts ?? GMC_V2_DEFAULT_FEED_LIMITS.maxProducts
  if (products.length > maxProducts) {
    throw new GmcFeedLimitError(
      `Feed ${args.feed.id} contains ${products.length.toLocaleString('en-US')} products, exceeding its ${maxProducts.toLocaleString('en-US')} product safety limit`,
    )
  }
  assertUniqueProducts(products)
  const format = resolveFormat(args.feed)
  const serialized = await format.serialize({
    feedId: args.feed.id,
    generatedAt,
    products,
    selector: args.feed.selector,
  })
  if (!(serialized.body instanceof Uint8Array)) {
    throw new TypeError(`Feed format ${format.id} returned a non-binary body`)
  }
  assertFormatMetadata({
    contentType: serialized.contentType,
    extension: serialized.extension,
    formatId: format.id,
  })
  const maxSerializedBytes =
    args.feed.limits?.maxSerializedBytes ?? GMC_V2_DEFAULT_FEED_LIMITS.maxSerializedBytes
  if (serialized.body.byteLength > maxSerializedBytes) {
    throw new GmcFeedLimitError(
      `Feed ${args.feed.id} serialized to ${serialized.body.byteLength.toLocaleString('en-US')} bytes, exceeding its ${maxSerializedBytes.toLocaleString('en-US')} byte safety limit`,
    )
  }
  return {
    ...serialized,
    checksum: createHash('sha256').update(serialized.body).digest('hex'),
    feedId: args.feed.id,
    generatedAt,
    productCount: products.length,
  }
}

export const publishFeedArtifact = async (args: {
  feed: GmcArtifactFeedConfig
  generatedAt?: string
  instanceId: string
  products: readonly GmcCanonicalProduct[]
}): Promise<GmcPublishedFeedArtifact> => {
  if (
    !/^[\w.-]{1,100}$/.test(args.instanceId) ||
    args.instanceId === '.' ||
    args.instanceId === '..'
  ) {
    throw new TypeError('Feed artifact instanceId must contain 1-100 safe characters')
  }
  const built = await buildCanonicalFeed(args)
  const descriptor: GmcArtifactDescriptor = {
    byteLength: built.body.byteLength,
    checksum: built.checksum,
    contentType: built.contentType,
    createdAt: built.generatedAt,
    generatedAt: built.generatedAt,
    // A checksum alone is not a unique immutable descriptor: two builds may
    // have identical bytes but distinct generation metadata.
    key: `${args.instanceId}/${args.feed.id}/${gmcArtifactKeySegment(built.generatedAt)}-${built.checksum}.${built.extension}`,
  }

  await args.feed.artifactStore.put({
    body: built.body,
    descriptor,
    feedId: args.feed.id,
    instanceId: args.instanceId,
  })
  const stored = await args.feed.artifactStore.read({
    artifact: descriptor,
    feedId: args.feed.id,
    instanceId: args.instanceId,
  })
  if (!stored) {
    throw new TypeError(`Feed artifact ${descriptor.key} was not readable after storage`)
  }
  assertFeedArtifactIntegrity({
    ...stored,
    maxSerializedBytes: args.feed.limits?.maxSerializedBytes,
  })
  for (const field of GMC_ARTIFACT_DESCRIPTOR_FIELDS) {
    if (stored.descriptor[field] !== descriptor[field]) {
      throw new TypeError(`Stored feed artifact ${field} does not match the build descriptor`)
    }
  }
  const promotion = await args.feed.artifactStore.promote({
    artifact: descriptor,
    feedId: args.feed.id,
    instanceId: args.instanceId,
  })
  if (promotion !== 'promoted' && promotion !== 'stale') {
    throw new TypeError('Feed artifact store returned an invalid promotion result')
  }
  return { artifact: descriptor, promotion }
}
