import type { Payload } from 'payload'

import type {
  GmcDocumentID,
  GmcLocalInventoryPublicationClaim,
  GmcLocalInventoryPublicationState,
  GmcLocalInventoryPublicationStateStore,
} from '../types.js'

import { getIdentityKey } from '../canonical.js'
import { isGmcNonNegativeInt64String } from '../merchantWire.js'
import { atomicUpdatePublicationState } from './atomicStateUpdate.js'

type StateDocument = {
  contentLanguage: string
  createdAt?: string
  dataSourceName: string
  desiredAt: string
  desiredDigest: string
  desiredVersion: string
  error?: GmcLocalInventoryPublicationState['error'] | null
  feedLabel: string
  id: GmcDocumentID
  key: string
  merchantId: string
  offerId: string
  operationId: string
  productId: string
  publishedAt?: null | string
  publishedDigest?: null | string
  publishedVersion?: null | string
  revision: number
  status: GmcLocalInventoryPublicationState['status']
  storeCode: string
  updatedAt: string
}

const encodeKeyPart = (value: string): string => `${value.length}:${value}`

const compareVersions = (left: string, right: string): number => {
  if (!isGmcNonNegativeInt64String(left) || !isGmcNonNegativeInt64String(right)) {
    throw new TypeError(
      'GMC local-inventory publication state contains an invalid signed-int64 source version',
    )
  }
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

const isDuplicateError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false
  }
  const candidate = error as { code?: unknown; message?: unknown; status?: unknown }
  return (
    candidate.code === 11000 ||
    candidate.status === 409 ||
    (typeof candidate.message === 'string' &&
      /duplicate|unique constraint/i.test(candidate.message))
  )
}

export class GmcLocalInventorySourceVersionConflictError extends Error {
  readonly code = 'GMC_LOCAL_INVENTORY_SOURCE_VERSION_CONFLICT'

  constructor(args: { key: string; sourceVersion: string }) {
    super(
      `Local inventory ${args.key} produced different content for source version ${args.sourceVersion}`,
    )
    this.name = 'GmcLocalInventorySourceVersionConflictError'
  }
}

export const createPayloadLocalInventoryPublicationStateStore = (args: {
  collectionSlug: string
  dataSourceName: string
  merchantId: string
}): GmcLocalInventoryPublicationStateStore => {
  const getKey = (
    identity: GmcLocalInventoryPublicationState['identity'],
    storeCode: string,
  ): string => {
    const dataSourceName = identity.dataSourceOverride ?? args.dataSourceName
    return [args.merchantId, dataSourceName, getIdentityKey(identity), storeCode]
      .map(encodeKeyPart)
      .join('|')
  }

  const asState = (doc: StateDocument): GmcLocalInventoryPublicationState => {
    if (
      !isGmcNonNegativeInt64String(doc.desiredVersion) ||
      (doc.publishedVersion !== null &&
        doc.publishedVersion !== undefined &&
        !isGmcNonNegativeInt64String(doc.publishedVersion)) ||
      !['failed', 'publish-pending', 'published'].includes(doc.status) ||
      !doc.desiredAt ||
      !doc.desiredDigest ||
      !doc.operationId ||
      !doc.productId ||
      !doc.storeCode
    ) {
      throw new TypeError('GMC local-inventory publication store returned an invalid row')
    }
    return {
      desiredAt: doc.desiredAt,
      desiredDigest: doc.desiredDigest,
      desiredVersion: doc.desiredVersion,
      error: doc.error ?? undefined,
      identity: {
        contentLanguage: doc.contentLanguage,
        dataSourceOverride:
          doc.dataSourceName === args.dataSourceName ? undefined : doc.dataSourceName,
        feedLabel: doc.feedLabel,
        offerId: doc.offerId,
      },
      operationId: doc.operationId,
      productId: doc.productId,
      publishedAt: doc.publishedAt ?? undefined,
      publishedDigest: doc.publishedDigest ?? undefined,
      publishedVersion: doc.publishedVersion ?? undefined,
      status: doc.status,
      storeCode: doc.storeCode,
      updatedAt: doc.updatedAt,
    }
  }

  const findDocument = async (
    payload: Payload,
    identity: GmcLocalInventoryPublicationState['identity'],
    storeCode: string,
  ): Promise<null | StateDocument> => {
    const result = await payload.find({
      collection: args.collectionSlug as never,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      where: { key: { equals: getKey(identity, storeCode) } },
    })
    return (result.docs[0] as unknown as StateDocument | undefined) ?? null
  }

  const createPending = async (
    claim: GmcLocalInventoryPublicationClaim,
  ): Promise<StateDocument> => {
    const dataSourceName = claim.identity.dataSourceOverride ?? args.dataSourceName
    return (await claim.payload.create({
      collection: args.collectionSlug as never,
      data: {
        contentLanguage: claim.identity.contentLanguage,
        dataSourceName,
        desiredAt: claim.desiredAt,
        desiredDigest: claim.desiredDigest,
        desiredVersion: claim.desiredVersion,
        feedLabel: claim.identity.feedLabel,
        key: getKey(claim.identity, claim.storeCode),
        merchantId: args.merchantId,
        offerId: claim.identity.offerId,
        operationId: claim.operationId,
        productId: String(claim.productId),
        revision: 0,
        status: 'publish-pending',
        storeCode: claim.storeCode,
      } as never,
      overrideAccess: true,
    })) as unknown as StateDocument
  }

  const updateIfCurrent = async (
    payload: Payload,
    existing: StateDocument,
    data: Record<string, unknown>,
  ): Promise<null | StateDocument> => {
    return await atomicUpdatePublicationState<StateDocument>({
      collectionSlug: args.collectionSlug,
      data,
      existing,
      payload,
    })
  }

  const claim = async (
    value: GmcLocalInventoryPublicationClaim,
  ): Promise<GmcLocalInventoryPublicationState> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await findDocument(value.payload, value.identity, value.storeCode)
      if (!existing) {
        try {
          return asState(await createPending(value))
        } catch (error) {
          if (!isDuplicateError(error)) {
            throw error
          }
          continue
        }
      }

      const comparison = compareVersions(existing.desiredVersion, value.desiredVersion)
      if (comparison > 0) {
        return asState(existing)
      }
      if (comparison === 0 && existing.desiredDigest !== value.desiredDigest) {
        throw new GmcLocalInventorySourceVersionConflictError({
          key: existing.key,
          sourceVersion: value.desiredVersion,
        })
      }

      const updated = await updateIfCurrent(value.payload, existing, {
        desiredAt: value.desiredAt,
        desiredDigest: value.desiredDigest,
        desiredVersion: value.desiredVersion,
        error: null,
        operationId: value.operationId,
        productId: String(value.productId),
        status: 'publish-pending',
      })
      if (updated) {
        return asState(updated)
      }
    }
    throw new Error(
      `Local-inventory publication state remained contended for ${getKey(value.identity, value.storeCode)}`,
    )
  }

  return {
    claim,
    get: async ({ identity, payload, storeCode }) => {
      const doc = await findDocument(payload, identity, storeCode)
      return doc ? asState(doc) : null
    },
    markFailed: async ({ error, identity, operationId, payload, storeCode }) => {
      if (!error) {
        throw new TypeError('GMC local-inventory failure state requires an error')
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        const existing = await findDocument(payload, identity, storeCode)
        if (!existing || existing.operationId !== operationId) {
          return
        }
        if (await updateIfCurrent(payload, existing, { error, status: 'failed' })) {
          return
        }
      }
      throw new Error(
        `Local-inventory publication state remained contended for ${getKey(identity, storeCode)}`,
      )
    },
    markPublished: async (value) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const existing = await findDocument(value.payload, value.identity, value.storeCode)
        if (!existing) {
          throw new Error(
            `Local-inventory publication state disappeared for ${getKey(value.identity, value.storeCode)}`,
          )
        }
        if (
          existing.operationId !== value.operationId ||
          existing.desiredDigest !== value.desiredDigest ||
          existing.desiredVersion !== value.desiredVersion
        ) {
          return asState(existing)
        }
        const updated = await updateIfCurrent(value.payload, existing, {
          error: null,
          publishedAt: value.publishedAt,
          publishedDigest: value.desiredDigest,
          publishedVersion: value.desiredVersion,
          status: 'published',
        })
        if (updated) {
          return asState(updated)
        }
      }
      throw new Error(
        `Local-inventory publication state remained contended for ${getKey(value.identity, value.storeCode)}`,
      )
    },
  }
}
