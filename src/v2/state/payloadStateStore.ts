import type { Payload } from 'payload'

import type {
  GmcDocumentID,
  GmcPublicationClaim,
  GmcPublicationState,
  GmcPublicationStateStore,
} from '../types.js'

import { getIdentityKey } from '../canonical.js'
import { isGmcNonNegativeInt64String } from '../merchantWire.js'
import { atomicUpdatePublicationState } from './atomicStateUpdate.js'

type StateDocument = {
  createdAt?: string
  dataSourceName: string
  deleteVersion?: null | string
  desiredAt?: null | string
  desiredDigest?: null | string
  desiredVersion?: null | string
  error?: GmcPublicationState['error'] | null
  id: GmcDocumentID
  key: string
  merchantId: string
  observedAt?: null | string
  operationId: string
  productId?: null | string
  publishedAt?: null | string
  publishedDigest?: null | string
  publishedVersion?: null | string
  remoteMissing?: boolean | null
  remoteStatus?: null | Record<string, unknown>
  remoteVersion?: null | string
  revision: number
  status: GmcPublicationState['status']
  updatedAt: string
} & GmcPublicationState['identity']

const MAX_ACTIVE_STATES_PER_PRODUCT = 1_000

export class GmcIdentityOwnershipError extends Error {
  readonly code = 'GMC_IDENTITY_OWNERSHIP_CONFLICT'

  constructor(args: {
    existingProductId: GmcDocumentID
    identityKey: string
    productId: GmcDocumentID
  }) {
    super(
      `Google identity ${args.identityKey} is already owned by product ${String(args.existingProductId)}; product ${String(args.productId)} cannot publish it`,
    )
    this.name = 'GmcIdentityOwnershipError'
  }
}

export class GmcSourceVersionConflictError extends Error {
  readonly code = 'GMC_SOURCE_VERSION_CONFLICT'

  constructor(args: { identityKey: string; sourceVersion: string }) {
    super(
      `Google identity ${args.identityKey} produced different content for source version ${args.sourceVersion}`,
    )
    this.name = 'GmcSourceVersionConflictError'
  }
}

const asState = (doc: StateDocument, defaultDataSourceName: string): GmcPublicationState => ({
  deleteVersion: doc.deleteVersion ?? undefined,
  desiredAt: doc.desiredAt ?? undefined,
  desiredDigest: doc.desiredDigest ?? undefined,
  desiredVersion: doc.desiredVersion ?? undefined,
  error: doc.error ?? undefined,
  identity: {
    contentLanguage: doc.contentLanguage,
    dataSourceOverride:
      doc.dataSourceName === defaultDataSourceName ? undefined : doc.dataSourceName,
    feedLabel: doc.feedLabel,
    offerId: doc.offerId,
  },
  operationId: doc.operationId,
  productId: doc.productId ?? undefined,
  publishedAt: doc.publishedAt ?? undefined,
  publishedDigest: doc.publishedDigest ?? undefined,
  publishedVersion: doc.publishedVersion ?? undefined,
  remoteMissing: doc.remoteMissing ?? undefined,
  remoteStatus: doc.remoteStatus ?? undefined,
  remoteVersion: doc.remoteVersion ?? undefined,
  status: doc.status,
  updatedAt: doc.updatedAt,
})

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

const compareVersions = (left: null | string | undefined, right: string): number => {
  if (left == null) {
    return -1
  }
  if (!isGmcNonNegativeInt64String(left) || !isGmcNonNegativeInt64String(right)) {
    throw new TypeError('GMC publication state contains an invalid signed-int64 source version')
  }
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

export const createPayloadPublicationStateStore = (args: {
  collectionSlug: string
  dataSourceName: string
  merchantId: string
}): GmcPublicationStateStore => {
  const toState = (doc: StateDocument): GmcPublicationState => asState(doc, args.dataSourceName)
  const getKey = (identity: GmcPublicationState['identity']): string => {
    const dataSourceName = identity.dataSourceOverride ?? args.dataSourceName
    return `${args.merchantId}|${dataSourceName}|${getIdentityKey({ ...identity, dataSourceOverride: dataSourceName })}`
  }

  const findDocument = async (
    payload: Payload,
    identity: GmcPublicationState['identity'],
  ): Promise<null | StateDocument> => {
    const result = await payload.find({
      collection: args.collectionSlug as never,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      where: { key: { equals: getKey(identity) } },
    })
    return (result.docs[0] as unknown as StateDocument | undefined) ?? null
  }

  const createPending = async (claim: GmcPublicationClaim): Promise<StateDocument> => {
    const dataSourceName = claim.identity.dataSourceOverride ?? args.dataSourceName
    return await payloadCreate(claim.payload, {
      contentLanguage: claim.identity.contentLanguage,
      dataSourceName,
      desiredAt: claim.desiredAt,
      desiredDigest: claim.desiredDigest,
      desiredVersion: claim.desiredVersion,
      feedLabel: claim.identity.feedLabel,
      key: getKey(claim.identity),
      merchantId: args.merchantId,
      offerId: claim.identity.offerId,
      operationId: claim.operationId,
      productId: String(claim.productId),
      revision: 0,
      status: 'publish-pending',
    })
  }

  const payloadCreate = async (
    payload: Payload,
    data: Record<string, unknown>,
  ): Promise<StateDocument> => {
    return (await payload.create({
      collection: args.collectionSlug as never,
      data: data as never,
      overrideAccess: true,
    })) as unknown as StateDocument
  }

  const payloadUpdateIfCurrent = async (
    payload: Payload,
    existing: StateDocument,
    data: Record<string, unknown>,
  ): Promise<null | StateDocument> => {
    return atomicUpdatePublicationState({
      collectionSlug: args.collectionSlug,
      data: {
        ...data,
        revision: existing.revision + 1,
      },
      existing,
      payload,
    })
  }

  const claimPublication = async (claim: GmcPublicationClaim): Promise<GmcPublicationState> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await findDocument(claim.payload, claim.identity)
      if (!existing) {
        try {
          return toState(await createPending(claim))
        } catch (error) {
          if (!isDuplicateError(error)) {
            throw error
          }
          continue
        }
      }

      if (
        existing.productId != null &&
        existing.productId !== String(claim.productId) &&
        existing.status !== 'deleted'
      ) {
        throw new GmcIdentityOwnershipError({
          existingProductId: existing.productId,
          identityKey: existing.key,
          productId: claim.productId,
        })
      }

      // A delete fence is authoritative at the same or a newer source
      // version. This closes cross-subject races where a delayed offer.publish
      // reaches the state store after a newer projection already removed it.
      if (compareVersions(existing.deleteVersion, claim.desiredVersion) >= 0) {
        return toState(existing)
      }

      const comparison = compareVersions(existing.desiredVersion, claim.desiredVersion)
      if (comparison > 0) {
        return toState(existing)
      }
      if (
        comparison === 0 &&
        existing.desiredDigest != null &&
        existing.desiredDigest !== claim.desiredDigest
      ) {
        throw new GmcSourceVersionConflictError({
          identityKey: existing.key,
          sourceVersion: claim.desiredVersion,
        })
      }
      const exactPublished =
        comparison === 0 &&
        existing.desiredDigest === claim.desiredDigest &&
        existing.publishedDigest === claim.desiredDigest &&
        existing.publishedVersion === claim.desiredVersion &&
        existing.status === 'published'
      if (
        exactPublished &&
        existing.desiredAt === claim.desiredAt &&
        existing.operationId === claim.operationId
      ) {
        return toState(existing)
      }

      const updated = await payloadUpdateIfCurrent(
        claim.payload,
        existing,
        exactPublished
          ? {
              desiredAt: claim.desiredAt,
              operationId: claim.operationId,
            }
          : {
              deleteVersion: null,
              desiredAt: claim.desiredAt,
              desiredDigest: claim.desiredDigest,
              desiredVersion: claim.desiredVersion,
              error: null,
              operationId: claim.operationId,
              productId: String(claim.productId),
              status: 'publish-pending',
            },
      )
      if (updated) {
        return toState(updated)
      }
    }

    throw new Error(`Publication state remained contended for ${getKey(claim.identity)}`)
  }

  return {
    claimPublication,
    get: async ({ identity, payload }) => {
      const doc = await findDocument(payload, identity)
      return doc ? toState(doc) : null
    },
    listByProduct: async ({ payload, productId }) => {
      const states: GmcPublicationState[] = []
      let cursor: GmcDocumentID | undefined
      do {
        const result = await payload.find({
          collection: args.collectionSlug as never,
          depth: 0,
          limit: 500,
          overrideAccess: true,
          pagination: false,
          sort: 'id',
          where: {
            and: [
              { productId: { equals: String(productId) } },
              { status: { not_equals: 'deleted' } },
              ...(cursor === undefined ? [] : [{ id: { greater_than: cursor } }]),
            ],
          },
        })
        const docs = result.docs as unknown as StateDocument[]
        if (states.length + docs.length > MAX_ACTIVE_STATES_PER_PRODUCT) {
          throw new Error(
            `GMC product ${String(productId)} exceeds ${MAX_ACTIVE_STATES_PER_PRODUCT} active publication identities`,
          )
        }
        states.push(...docs.map(toState))
        const nextCursor = docs.length === 500 ? docs.at(-1)?.id : undefined
        if (nextCursor !== undefined && nextCursor === cursor) {
          throw new Error('GMC publication-state keyset pagination did not advance')
        }
        cursor = nextCursor
      } while (cursor !== undefined)
      return states
    },
    markDeleted: async ({ identity, operationId, payload, productId }) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const existing = await findDocument(payload, identity)
        if (!existing) {
          try {
            const dataSourceName = identity.dataSourceOverride ?? args.dataSourceName
            return toState(
              await payloadCreate(payload, {
                contentLanguage: identity.contentLanguage,
                dataSourceName,
                feedLabel: identity.feedLabel,
                key: getKey(identity),
                merchantId: args.merchantId,
                offerId: identity.offerId,
                operationId,
                productId: productId === undefined ? undefined : String(productId),
                revision: 0,
                status: 'deleted',
              }),
            )
          } catch (error) {
            if (!isDuplicateError(error)) {
              throw error
            }
            continue
          }
        }
        if (existing.status === 'deleted' || existing.operationId !== operationId) {
          return toState(existing)
        }
        const updated = await payloadUpdateIfCurrent(payload, existing, {
          desiredAt: null,
          desiredDigest: null,
          desiredVersion: null,
          error: null,
          operationId,
          productId: productId === undefined ? existing.productId : String(productId),
          publishedDigest: null,
          publishedVersion: null,
          status: 'deleted',
        })
        if (updated) {
          return toState(updated)
        }
      }
      throw new Error(`Publication state remained contended for ${getKey(identity)}`)
    },
    markDeletePending: async ({
      deleteIfDesiredBefore,
      deleteIfDesiredVersionBefore,
      deleteVersion,
      identity,
      operationId,
      payload,
      productId,
    }) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const existing = await findDocument(payload, identity)
        const effectiveDeleteVersion =
          deleteVersion ?? existing?.desiredVersion ?? existing?.deleteVersion ?? undefined
        if (
          existing?.desiredVersion != null &&
          effectiveDeleteVersion !== undefined &&
          compareVersions(existing.desiredVersion, effectiveDeleteVersion) > 0
        ) {
          return null
        }
        if (
          existing?.deleteVersion != null &&
          effectiveDeleteVersion !== undefined &&
          compareVersions(existing.deleteVersion, effectiveDeleteVersion) > 0
        ) {
          return null
        }
        if (
          deleteIfDesiredVersionBefore !== undefined &&
          existing?.desiredVersion != null &&
          compareVersions(existing.desiredVersion, deleteIfDesiredVersionBefore) >= 0 &&
          existing.status !== 'deleted'
        ) {
          return null
        }
        if (
          deleteIfDesiredVersionBefore === undefined &&
          deleteIfDesiredBefore !== undefined &&
          existing?.desiredAt != null &&
          existing.desiredAt >= deleteIfDesiredBefore &&
          existing.status !== 'deleted'
        ) {
          return null
        }
        if (
          existing?.productId != null &&
          productId !== undefined &&
          existing.productId !== String(productId) &&
          existing.status !== 'deleted'
        ) {
          return null
        }
        if (!existing) {
          try {
            const dataSourceName = identity.dataSourceOverride ?? args.dataSourceName
            return toState(
              await payloadCreate(payload, {
                contentLanguage: identity.contentLanguage,
                dataSourceName,
                deleteVersion: effectiveDeleteVersion,
                feedLabel: identity.feedLabel,
                key: getKey(identity),
                merchantId: args.merchantId,
                offerId: identity.offerId,
                operationId,
                productId: productId === undefined ? undefined : String(productId),
                revision: 0,
                status: 'delete-pending',
              }),
            )
          } catch (error) {
            if (!isDuplicateError(error)) {
              throw error
            }
            continue
          }
        }
        if (
          existing.status === 'deleted' &&
          deleteIfDesiredBefore === undefined &&
          deleteIfDesiredVersionBefore === undefined
        ) {
          if (
            effectiveDeleteVersion === undefined ||
            compareVersions(existing.deleteVersion, effectiveDeleteVersion) >= 0
          ) {
            return toState(existing)
          }
          // Google is already absent, but the higher deletion proof must still
          // advance atomically. Otherwise an intermediate delayed publish can
          // clear the older fence and resurrect the offer.
          const raisedFence = await payloadUpdateIfCurrent(payload, existing, {
            deleteVersion: effectiveDeleteVersion,
            operationId,
            productId: productId === undefined ? existing.productId : String(productId),
          })
          if (raisedFence) {
            return toState(raisedFence)
          }
          continue
        }
        const updated = await payloadUpdateIfCurrent(payload, existing, {
          deleteVersion: effectiveDeleteVersion ?? null,
          desiredAt: null,
          desiredDigest: null,
          desiredVersion: null,
          error: null,
          operationId,
          status: 'delete-pending',
        })
        if (updated) {
          return toState(updated)
        }
      }
      throw new Error(`Publication state remained contended for ${getKey(identity)}`)
    },
    markFailed: async ({ error, identity, operationId, payload }) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const existing = await findDocument(payload, identity)
        if (!existing || existing.operationId !== operationId) {
          return
        }
        if (await payloadUpdateIfCurrent(payload, existing, { error, status: 'failed' })) {
          return
        }
      }
      throw new Error(`Publication state remained contended for ${getKey(identity)}`)
    },
    markObserved: async ({
      identity,
      observedAt,
      payload,
      remoteMissing,
      remoteStatus,
      remoteVersion,
    }) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const existing = await findDocument(payload, identity)
        if (!existing) {
          return
        }
        if (
          await payloadUpdateIfCurrent(payload, existing, {
            observedAt,
            remoteMissing,
            remoteStatus: remoteStatus ?? null,
            remoteVersion: remoteVersion ?? null,
          })
        ) {
          return
        }
      }
      throw new Error(`Publication state remained contended for ${getKey(identity)}`)
    },
    markPublished: async (claim) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const existing = await findDocument(claim.payload, claim.identity)
        if (!existing) {
          throw new Error(`Publication state disappeared for ${getKey(claim.identity)}`)
        }
        if (
          existing.operationId !== claim.operationId ||
          existing.desiredDigest !== claim.desiredDigest ||
          existing.desiredVersion !== claim.desiredVersion
        ) {
          return toState(existing)
        }
        const updated = await payloadUpdateIfCurrent(claim.payload, existing, {
          error: null,
          publishedAt: claim.publishedAt,
          publishedDigest: claim.desiredDigest,
          publishedVersion: claim.desiredVersion,
          status: 'published',
        })
        if (updated) {
          return toState(updated)
        }
      }
      throw new Error(`Publication state remained contended for ${getKey(claim.identity)}`)
    },
  }
}
