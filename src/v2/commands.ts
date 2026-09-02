import { createHash } from 'node:crypto'

import type { MCProductIdentity } from '../types/index.js'

import { canonicalizeProductInput, canonicalJson, getProcessedIdentityKey } from './canonical.js'
import { canonicalizeLocalInventoryInput } from './localInventory.js'
import { isGmcNonNegativeInt64String } from './merchantWire.js'
import {
  GMC_V2_COMMAND_SCHEMA_VERSION,
  GMC_V2_COMMAND_TYPES,
  GMC_V2_MAX_TARGETED_PRODUCT_IDS,
  type GmcCatalogPublishCommand,
  type GmcCommand,
  type GmcCommandCause,
  type GmcDataSourcesValidateCommand,
  type GmcDocumentID,
  type GmcLocalInventoryApplyCommand,
  type GmcLocalInventoryInput,
  type GmcOfferDeleteCommand,
  type GmcOfferPublishCommand,
  type GmcProductDeleteCommand,
  type GmcProductPublishCommand,
  type GmcProjectedProductInput,
} from './types.js'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })

const MAX_COMMAND_BYTES = 1_048_576
const MAX_IDENTITIES_PER_COMMAND = 1_000
const IDENTITY_FIELDS = new Set(['contentLanguage', 'dataSourceOverride', 'feedLabel', 'offerId'])
const COMMAND_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  'catalog.publish': new Set([
    'cause',
    'cursor',
    'pageIndex',
    'productIds',
    'requestedAt',
    'schemaVersion',
    'type',
  ]),
  'catalog.reconcile': new Set([
    'cursor',
    'pageIndex',
    'pageToken',
    'phase',
    'requestedAt',
    'schemaVersion',
    'startedAt',
    'startedVersion',
    'type',
  ]),
  'dataSources.validate': new Set(['requestedAt', 'schemaVersion', 'type']),
  'feed.build': new Set(['feedId', 'requestedAt', 'schemaVersion', 'type']),
  'localInventory.apply': new Set([
    'identity',
    'inventory',
    'productId',
    'requestedAt',
    'schemaVersion',
    'storeCode',
    'type',
  ]),
  'localInventory.reconcile': new Set([
    'cursor',
    'pageIndex',
    'productId',
    'requestedAt',
    'schemaVersion',
    'storeCode',
    'type',
  ]),
  'offer.delete': new Set([
    'deleteIfDesiredBefore',
    'deleteIfDesiredVersionBefore',
    'expectedProductId',
    'identity',
    'requestedAt',
    'schemaVersion',
    'sourceVersion',
    'type',
  ]),
  'offer.publish': new Set([
    'input',
    'productId',
    'requestedAt',
    'schemaVersion',
    'sourceVersion',
    'type',
    'verifyRemote',
  ]),
  'product.delete': new Set([
    'cause',
    'identities',
    'productId',
    'requestedAt',
    'schemaVersion',
    'type',
  ]),
  'product.publish': new Set([
    'cause',
    'previousIdentities',
    'productId',
    'requestedAt',
    'schemaVersion',
    'type',
  ]),
  'status.refresh': new Set(['identities', 'productId', 'requestedAt', 'schemaVersion', 'type']),
}

const isDocumentID = (value: unknown): value is GmcDocumentID => {
  return (
    (typeof value === 'string' &&
      value === value.trim() &&
      value.length > 0 &&
      value.length <= 512 &&
      !hasControlCharacters(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  )
}

const compareDocumentIDs = (left: GmcDocumentID, right: GmcDocumentID): number => {
  if (typeof left === typeof right) {
    if (left === right) {
      return 0
    }
    return left < right ? -1 : 1
  }
  return typeof left === 'number' ? -1 : 1
}

export const canonicalizeGmcTargetProductIds = (value: unknown): GmcDocumentID[] => {
  if (!Array.isArray(value) || !value.every(isDocumentID)) {
    throw new TypeError('targeted catalog productIds must contain valid document IDs')
  }
  const unique = new Map<string, GmcDocumentID>()
  for (const id of value) {
    unique.set(`${typeof id}:${String(id)}`, id)
  }
  return [...unique.values()].sort(compareDocumentIDs)
}

const isIdentity = (value: unknown): value is MCProductIdentity => {
  if (!isRecord(value)) {
    return false
  }

  return (
    Object.keys(value).every((field) => IDENTITY_FIELDS.has(field)) &&
    typeof value.contentLanguage === 'string' &&
    /^[a-z]{2}$/.test(value.contentLanguage) &&
    typeof value.feedLabel === 'string' &&
    /^[A-Z0-9_-]{1,20}$/.test(value.feedLabel) &&
    typeof value.offerId === 'string' &&
    value.offerId === value.offerId.trim() &&
    value.offerId.length > 0 &&
    value.offerId.length <= 50 &&
    !hasControlCharacters(value.offerId) &&
    (value.dataSourceOverride === undefined ||
      (typeof value.dataSourceOverride === 'string' &&
        value.dataSourceOverride === value.dataSourceOverride.trim() &&
        value.dataSourceOverride.length > 0 &&
        value.dataSourceOverride.length <= 256 &&
        !hasControlCharacters(value.dataSourceOverride)))
  )
}

const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return false
  }
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

const isCause = (value: unknown): value is GmcCommandCause => {
  return [
    'api',
    'delete',
    'manual',
    'publish',
    'reconcile',
    'schedule',
    'unpublish',
    'update',
  ].includes(String(value))
}

export function assertGmcCommand(value: unknown): asserts value is GmcCommand {
  if (!isRecord(value)) {
    throw new TypeError('GMC command must be an object')
  }

  let serialized: string
  try {
    serialized = canonicalJson(value)
  } catch (error) {
    throw new TypeError('GMC command must contain only finite, acyclic JSON values', {
      cause: error,
    })
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_COMMAND_BYTES) {
    throw new TypeError(`GMC command must not exceed ${MAX_COMMAND_BYTES} serialized bytes`)
  }

  if (value.schemaVersion !== GMC_V2_COMMAND_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported GMC command schema version: ${String(value.schemaVersion)}`)
  }

  if (!GMC_V2_COMMAND_TYPES.includes(value.type as never)) {
    throw new TypeError(`Unsupported GMC command type: ${String(value.type)}`)
  }

  const supportedFields = COMMAND_FIELDS[String(value.type)]
  const unsupportedFields = Object.keys(value).filter((field) => !supportedFields?.has(field))
  if (unsupportedFields.length > 0) {
    throw new TypeError(
      `${String(value.type)} contains unsupported field${unsupportedFields.length === 1 ? '' : 's'}: ${unsupportedFields.sort().join(', ')}`,
    )
  }

  if (!isIsoDate(value.requestedAt)) {
    throw new TypeError('GMC command requestedAt must be an ISO date string')
  }

  if (value.type === 'product.publish') {
    if (!isDocumentID(value.productId) || !isCause(value.cause)) {
      throw new TypeError('product.publish requires a productId and valid cause')
    }
    if (
      value.previousIdentities !== undefined &&
      (!Array.isArray(value.previousIdentities) ||
        value.previousIdentities.length > MAX_IDENTITIES_PER_COMMAND ||
        !value.previousIdentities.every(isIdentity))
    ) {
      throw new TypeError('product.publish previousIdentities must contain valid identities')
    }
  }

  if (value.type === 'product.delete') {
    if (
      !Array.isArray(value.identities) ||
      value.identities.length > MAX_IDENTITIES_PER_COMMAND ||
      !value.identities.every(isIdentity)
    ) {
      throw new TypeError('product.delete identities must contain valid identities')
    }
    if (value.productId !== undefined && !isDocumentID(value.productId)) {
      throw new TypeError('product.delete productId must be a string or finite number')
    }
    if (!['delete', 'reconcile', 'unpublish'].includes(String(value.cause))) {
      throw new TypeError('product.delete requires a delete, reconcile, or unpublish cause')
    }
  }

  if (value.type === 'offer.publish') {
    if (!isDocumentID(value.productId) || !isRecord(value.input)) {
      throw new TypeError('offer.publish requires productId and input')
    }
    if (!isGmcNonNegativeInt64String(value.sourceVersion)) {
      throw new TypeError('offer.publish requires a non-negative signed int64 sourceVersion')
    }
    if (value.verifyRemote !== undefined && typeof value.verifyRemote !== 'boolean') {
      throw new TypeError('offer.publish verifyRemote must be a boolean')
    }
    canonicalizeProductInput({
      input: value.input as GmcProjectedProductInput,
      sourceVersion: value.sourceVersion,
    })
  }

  if (value.type === 'offer.delete') {
    if (!isIdentity(value.identity)) {
      throw new TypeError('offer.delete requires a valid identity')
    }
    if (value.expectedProductId !== undefined && !isDocumentID(value.expectedProductId)) {
      throw new TypeError('offer.delete expectedProductId must be a string or finite number')
    }
    if (value.deleteIfDesiredBefore !== undefined && !isIsoDate(value.deleteIfDesiredBefore)) {
      throw new TypeError('offer.delete deleteIfDesiredBefore must be an ISO date string')
    }
    if (
      value.deleteIfDesiredVersionBefore !== undefined &&
      !isGmcNonNegativeInt64String(value.deleteIfDesiredVersionBefore)
    ) {
      throw new TypeError(
        'offer.delete deleteIfDesiredVersionBefore must be a non-negative signed int64 string',
      )
    }
    if (value.sourceVersion !== undefined && !isGmcNonNegativeInt64String(value.sourceVersion)) {
      throw new TypeError('offer.delete sourceVersion must be a non-negative signed int64 string')
    }
  }

  if (value.type === 'catalog.reconcile') {
    if (value.phase !== undefined && value.phase !== 'desired' && value.phase !== 'remote') {
      throw new TypeError('catalog.reconcile phase must be desired or remote')
    }
    if (
      value.pageToken !== undefined &&
      (typeof value.pageToken !== 'string' || !value.pageToken || value.pageToken.length > 2_048)
    ) {
      throw new TypeError('catalog.reconcile pageToken must be a non-empty string')
    }
    if (
      value.pageIndex !== undefined &&
      (typeof value.pageIndex !== 'number' ||
        !Number.isSafeInteger(value.pageIndex) ||
        value.pageIndex < 0 ||
        value.pageIndex > 1_000_000)
    ) {
      throw new TypeError('catalog.reconcile pageIndex must be a bounded non-negative integer')
    }
    if (value.cursor !== undefined && !isDocumentID(value.cursor)) {
      throw new TypeError('catalog.reconcile cursor must be a valid document ID')
    }
    if (value.cursor !== undefined && (value.phase === 'remote' || value.pageToken !== undefined)) {
      throw new TypeError('catalog.reconcile cursor is valid only in the desired phase')
    }
    if (value.pageToken !== undefined && value.phase !== 'remote') {
      throw new TypeError('catalog.reconcile pageToken requires the remote phase')
    }
    if (value.startedAt !== undefined && !isIsoDate(value.startedAt)) {
      throw new TypeError('catalog.reconcile startedAt must be an ISO date string')
    }
    if (value.startedVersion !== undefined && !isGmcNonNegativeInt64String(value.startedVersion)) {
      throw new TypeError(
        'catalog.reconcile startedVersion must be a non-negative signed int64 string',
      )
    }
    if (value.startedVersion !== undefined && value.startedAt === undefined) {
      throw new TypeError('catalog.reconcile startedVersion requires startedAt')
    }
    if (value.phase === 'remote' && value.startedAt === undefined) {
      throw new TypeError('catalog.reconcile remote phase requires startedAt')
    }
  }

  if (value.type === 'catalog.publish') {
    if (!['api', 'delete', 'manual', 'schedule', 'update'].includes(String(value.cause))) {
      throw new TypeError(
        'catalog.publish requires an api, delete, manual, schedule, or update cause',
      )
    }
    if (value.cursor !== undefined && !isDocumentID(value.cursor)) {
      throw new TypeError('catalog.publish cursor must be a valid document ID')
    }
    if (value.productIds !== undefined) {
      if (
        !Array.isArray(value.productIds) ||
        value.productIds.length === 0 ||
        value.productIds.length > GMC_V2_MAX_TARGETED_PRODUCT_IDS ||
        !value.productIds.every(isDocumentID)
      ) {
        throw new TypeError(
          `catalog.publish productIds must contain 1-${GMC_V2_MAX_TARGETED_PRODUCT_IDS} valid document IDs`,
        )
      }
      const productIds = value.productIds
      const canonical = canonicalizeGmcTargetProductIds(productIds)
      if (
        canonical.length !== productIds.length ||
        canonical.some((id, index) => id !== productIds[index])
      ) {
        throw new TypeError('catalog.publish productIds must be unique and in canonical order')
      }
    }
    if (
      value.pageIndex !== undefined &&
      (typeof value.pageIndex !== 'number' ||
        !Number.isSafeInteger(value.pageIndex) ||
        value.pageIndex < 0 ||
        value.pageIndex > 1_000_000)
    ) {
      throw new TypeError('catalog.publish pageIndex must be a bounded non-negative integer')
    }
  }

  if (value.type === 'localInventory.reconcile') {
    if (value.productId !== undefined && !isDocumentID(value.productId)) {
      throw new TypeError('localInventory.reconcile productId must be a string or finite number')
    }
    if (value.cursor !== undefined && !isDocumentID(value.cursor)) {
      throw new TypeError('localInventory.reconcile cursor must be a string or finite number')
    }
    if (value.productId !== undefined && value.cursor !== undefined) {
      throw new TypeError('localInventory.reconcile cannot contain both productId and cursor')
    }
    if (
      value.pageIndex !== undefined &&
      (typeof value.pageIndex !== 'number' ||
        !Number.isSafeInteger(value.pageIndex) ||
        value.pageIndex < 0 ||
        value.pageIndex > 1_000_000)
    ) {
      throw new TypeError(
        'localInventory.reconcile pageIndex must be a bounded non-negative integer',
      )
    }
    if (value.productId !== undefined && value.pageIndex !== undefined) {
      throw new TypeError('localInventory.reconcile productId cannot have a pageIndex')
    }
    if (
      value.storeCode !== undefined &&
      (typeof value.storeCode !== 'string' ||
        value.storeCode !== value.storeCode.trim() ||
        !value.storeCode ||
        [...value.storeCode].length > 64 ||
        hasControlCharacters(value.storeCode))
    ) {
      throw new TypeError('localInventory.reconcile storeCode must contain 1-64 safe characters')
    }
  }

  if (value.type === 'localInventory.apply') {
    if (!isIdentity(value.identity)) {
      throw new TypeError('localInventory.apply requires a valid identity')
    }
    if (
      !isDocumentID(value.productId) ||
      typeof value.storeCode !== 'string' ||
      value.storeCode !== value.storeCode.trim() ||
      value.storeCode.length === 0 ||
      [...value.storeCode].length > 64 ||
      hasControlCharacters(value.storeCode)
    ) {
      throw new TypeError(
        'localInventory.apply requires a productId and a storeCode containing 1-64 safe characters',
      )
    }
    if (value.inventory !== null) {
      if (!isRecord(value.inventory) || !isRecord(value.inventory.localInventoryAttributes)) {
        throw new TypeError('localInventory.apply inventory is invalid')
      }
      if (value.inventory.storeCode !== value.storeCode) {
        throw new TypeError('localInventory.apply storeCode must match inventory.storeCode')
      }
      canonicalizeLocalInventoryInput(value.inventory as GmcLocalInventoryInput)
    }
  }

  if (
    value.type === 'feed.build' &&
    (typeof value.feedId !== 'string' || !/^[\w.-]{1,100}$/.test(value.feedId))
  ) {
    throw new TypeError('feed.build requires a feedId')
  }

  if (value.type === 'status.refresh') {
    if (value.productId === undefined && value.identities === undefined) {
      throw new TypeError('status.refresh requires productId or identities')
    }
    if (value.productId !== undefined && !isDocumentID(value.productId)) {
      throw new TypeError('status.refresh productId must be a valid document ID')
    }
    if (
      value.identities !== undefined &&
      (!Array.isArray(value.identities) ||
        value.identities.length === 0 ||
        value.identities.length > MAX_IDENTITIES_PER_COMMAND ||
        !value.identities.every(isIdentity))
    ) {
      throw new TypeError('status.refresh identities must contain valid identities')
    }
  }
}

/**
 * Return the durable idempotency fingerprint for a validated command.
 *
 * `requestedAt` is deliberately excluded: it is diagnostic transport metadata,
 * not business intent. HTTP retries and hook redeliveries can reconstruct the
 * same semantic command at a later wall-clock instant and must resolve to the
 * original immutable operation. Every field that can affect execution remains
 * covered, including the command type, schema version, identity, projection,
 * source-version fences, pagination cursors, and reconciliation boundaries.
 */
export const getGmcCommandIdempotencyDigest = (command: GmcCommand): string => {
  assertGmcCommand(command)
  const { requestedAt: _requestedAt, ...semanticCommand } = command
  return createHash('sha256').update(canonicalJson(semanticCommand)).digest('hex')
}

const now = (): string => new Date().toISOString()

export const createCatalogPublishCommand = (args: {
  cause: GmcCatalogPublishCommand['cause']
  cursor?: GmcDocumentID
  productIds?: GmcDocumentID[]
  requestedAt?: string
}): GmcCatalogPublishCommand => ({
  type: 'catalog.publish',
  cause: args.cause,
  cursor: args.cursor,
  productIds:
    args.productIds === undefined ? undefined : canonicalizeGmcTargetProductIds(args.productIds),
  requestedAt: args.requestedAt ?? now(),
  schemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
})

export const createDataSourcesValidateCommand = (
  args: {
    requestedAt?: string
  } = {},
): GmcDataSourcesValidateCommand => ({
  type: 'dataSources.validate',
  requestedAt: args.requestedAt ?? now(),
  schemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
})

export const createProductPublishCommand = (args: {
  cause: GmcProductPublishCommand['cause']
  previousIdentities?: MCProductIdentity[]
  productId: GmcDocumentID
  requestedAt?: string
}): GmcProductPublishCommand => ({
  type: 'product.publish',
  cause: args.cause,
  previousIdentities: args.previousIdentities,
  productId: args.productId,
  requestedAt: args.requestedAt ?? now(),
  schemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
})

export const createProductDeleteCommand = (args: {
  cause: GmcProductDeleteCommand['cause']
  identities: MCProductIdentity[]
  productId?: GmcDocumentID
  requestedAt?: string
}): GmcProductDeleteCommand => ({
  type: 'product.delete',
  cause: args.cause,
  identities: args.identities,
  productId: args.productId,
  requestedAt: args.requestedAt ?? now(),
  schemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
})

export const createOfferPublishCommand = (args: {
  input: GmcProjectedProductInput
  productId: GmcDocumentID
  requestedAt?: string
  sourceVersion: string
  verifyRemote?: boolean
}): GmcOfferPublishCommand => ({
  type: 'offer.publish',
  input: args.input,
  productId: args.productId,
  requestedAt: args.requestedAt ?? now(),
  schemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
  sourceVersion: args.sourceVersion,
  verifyRemote: args.verifyRemote,
})

export const createOfferDeleteCommand = (args: {
  deleteIfDesiredBefore?: string
  deleteIfDesiredVersionBefore?: string
  expectedProductId?: GmcDocumentID
  identity: MCProductIdentity
  requestedAt?: string
  sourceVersion?: string
}): GmcOfferDeleteCommand => ({
  type: 'offer.delete',
  deleteIfDesiredBefore: args.deleteIfDesiredBefore,
  deleteIfDesiredVersionBefore: args.deleteIfDesiredVersionBefore,
  expectedProductId: args.expectedProductId,
  identity: args.identity,
  requestedAt: args.requestedAt ?? now(),
  schemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
  sourceVersion: args.sourceVersion,
})

export const createLocalInventoryApplyCommand = (args: {
  identity: MCProductIdentity
  inventory: GmcLocalInventoryInput | null
  productId: GmcDocumentID
  requestedAt?: string
  storeCode: string
}): GmcLocalInventoryApplyCommand => ({
  type: 'localInventory.apply',
  identity: args.identity,
  inventory: args.inventory,
  productId: args.productId,
  requestedAt: args.requestedAt ?? now(),
  schemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
  storeCode: args.storeCode,
})

export const getGmcCommandSubject = (command: GmcCommand, instanceId?: string): string => {
  let subject: string
  if (command.type === 'localInventory.apply') {
    subject = `offer:${getProcessedIdentityKey(command.identity)}`
  } else if (command.type === 'offer.publish') {
    subject = `offer:${getProcessedIdentityKey(command.input)}`
  } else if (command.type === 'offer.delete') {
    subject = `offer:${getProcessedIdentityKey(command.identity)}`
  } else if (command.type === 'status.refresh' && command.identities?.length === 1) {
    subject = `offer:${getProcessedIdentityKey(command.identities[0])}`
  } else if ('productId' in command && command.productId !== undefined) {
    subject = `product:${String(command.productId)}`
  } else if (command.type === 'feed.build') {
    subject = `feed:${command.feedId}`
  } else {
    subject = 'catalog'
  }
  return instanceId ? `gmc:${instanceId}:${subject}` : subject
}
