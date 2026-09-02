import type { Payload } from 'payload'

import { ValidationError } from 'payload'

import type {
  GmcDocumentID,
  GmcPublicationClaim,
  GmcPublicationState,
  GmcPublicationStateStore,
} from '../types.js'

import { getIdentityKey } from '../canonical.js'
import { atomicUpdatePublicationState } from './atomicStateUpdate.js'

type StateDocument = {
  createdAt?: string
  dataSourceName: string
  desiredAt?: null | string
  desiredDigest?: null | string
  error?: GmcPublicationState['error'] | null
  id: GmcDocumentID
  key: string
  merchantId: string
  observedAt?: null | string
  operationId: string
  productId?: null | string
  publishedAt?: null | string
  publishedDigest?: null | string
  remoteMissing?: boolean | null
  remoteStatus?: null | Record<string, unknown>
  remoteVersion?: null | string
  revision: number
  status: GmcPublicationState['status']
  storeCode?: null | string
  updatedAt: string
} & GmcPublicationState['identity']

const MAX_ACTIVE_STATES_PER_PRODUCT = 1_000
const MAX_CONTENTION_ATTEMPTS = 10
const PAGE_SIZE = 500

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

const asState = (doc: StateDocument, defaultDataSourceName: string): GmcPublicationState => ({
  desiredAt: doc.desiredAt ?? undefined,
  desiredDigest: doc.desiredDigest ?? undefined,
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
  remoteMissing: doc.remoteMissing ?? undefined,
  remoteStatus: doc.remoteStatus ?? undefined,
  remoteVersion: doc.remoteVersion ?? undefined,
  revision: doc.revision,
  status: doc.status,
  storeCode: doc.storeCode ?? undefined,
  updatedAt: doc.updatedAt,
})

/**
 * Payload's official adapters do not surface a driver-level duplicate-key
 * error. `create` runs field validation first, so a unique `key` collision
 * arrives as a Payload `ValidationError` (HTTP 400), not as a Postgres 23505 or
 * a Mongo 11000. Both shapes are still accepted: a custom adapter, or a race
 * that slips past validation into the driver, can raise either one.
 */
const isDuplicateError = (error: unknown): boolean => {
  if (error instanceof ValidationError) {
    return true
  }
  if (!error || typeof error !== 'object') {
    return false
  }
  const candidate = error as { code?: unknown; message?: unknown }
  return (
    candidate.code === 11000 ||
    (typeof candidate.message === 'string' && /duplicate|unique constraint/i.test(candidate.message))
  )
}

export const createPayloadPublicationStateStore = (args: {
  collectionSlug: string
  dataSourceName: string
  merchantId: string
}): GmcPublicationStateStore => {
  const toState = (doc: StateDocument): GmcPublicationState => asState(doc, args.dataSourceName)
  // Local-inventory rows share this collection with the base offer row for
  // the same identity. They are addressed by an extra `|store:<code>` key
  // segment so the two lifecycles never collide.
  const getKey = (identity: GmcPublicationState['identity'], storeCode?: string): string => {
    const dataSourceName = identity.dataSourceOverride ?? args.dataSourceName
    const base = `${args.merchantId}|${dataSourceName}|${getIdentityKey({ ...identity, dataSourceOverride: dataSourceName })}`
    return storeCode === undefined ? base : `${base}|store:${storeCode}`
  }

  const findDocument = async (
    payload: Payload,
    identity: GmcPublicationState['identity'],
    storeCode?: string,
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

  const identityColumns = (
    identity: GmcPublicationState['identity'],
    storeCode?: string,
  ): Record<string, unknown> => ({
    contentLanguage: identity.contentLanguage,
    dataSourceName: identity.dataSourceOverride ?? args.dataSourceName,
    feedLabel: identity.feedLabel,
    key: getKey(identity, storeCode),
    merchantId: args.merchantId,
    offerId: identity.offerId,
    ...(storeCode === undefined ? {} : { storeCode }),
  })

  const payloadUpdateIfCurrent = async (
    payload: Payload,
    existing: StateDocument,
    data: Record<string, unknown>,
  ): Promise<null | StateDocument> => {
    return atomicUpdatePublicationState<StateDocument>({
      collectionSlug: args.collectionSlug,
      data,
      existing,
      payload,
    })
  }

  const contended = (identity: GmcPublicationState['identity'], storeCode?: string): Error =>
    new Error(`Publication state remained contended for ${getKey(identity, storeCode)}`)

  /**
   * Shared claim rule block for both the base offer row (`storeCode`
   * undefined) and a local-inventory store row (`storeCode` set): ownership
   * by productId, `desiredAt` ordering, a same-digest-already-published
   * short-circuit, otherwise `publish-pending`.
   */
  const claimRow = async (
    claim: GmcPublicationClaim,
    storeCode?: string,
  ): Promise<GmcPublicationState> => {
    for (let attempt = 0; attempt < MAX_CONTENTION_ATTEMPTS; attempt++) {
      const existing = await findDocument(claim.payload, claim.identity, storeCode)
      if (!existing) {
        try {
          return toState(
            await payloadCreate(claim.payload, {
              ...identityColumns(claim.identity, storeCode),
              desiredAt: claim.desiredAt,
              desiredDigest: claim.desiredDigest,
              operationId: claim.operationId,
              productId: String(claim.productId),
              revision: 0,
              status: 'publish-pending',
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

      // A durable retry of an older projection must never overwrite the newer
      // desired content that already won. `desiredAt` is the host's own
      // ordering stamp for the source change, so it is the only ordering
      // signal the store needs.
      if (existing.desiredAt != null && existing.desiredAt > claim.desiredAt) {
        return toState(existing)
      }
      // Deletion is itself a desired state stamped at `deletedAt`. A publish
      // claim from that same instant is not newer evidence, so a tie must not
      // resurrect a deleted offer either.
      if (
        existing.status === 'deleted' &&
        existing.desiredAt != null &&
        existing.desiredAt >= claim.desiredAt
      ) {
        return toState(existing)
      }

      const alreadyPublished =
        existing.status === 'published' && existing.publishedDigest === claim.desiredDigest
      if (
        alreadyPublished &&
        existing.desiredAt === claim.desiredAt &&
        existing.operationId === claim.operationId
      ) {
        return toState(existing)
      }

      const updated = await payloadUpdateIfCurrent(
        claim.payload,
        existing,
        alreadyPublished
          ? { desiredAt: claim.desiredAt, operationId: claim.operationId }
          : {
              desiredAt: claim.desiredAt,
              desiredDigest: claim.desiredDigest,
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

    throw contended(claim.identity, storeCode)
  }

  const claimPublication = (claim: GmcPublicationClaim): Promise<GmcPublicationState> =>
    claimRow(claim)

  /**
   * Shared "publish, but only for the operation that still owns the row"
   * rule for both the base offer row and a local-inventory store row.
   */
  const markPublishedRow = async (
    claim: { publishedAt: string } & GmcPublicationClaim,
    storeCode?: string,
  ): Promise<GmcPublicationState> => {
    for (let attempt = 0; attempt < MAX_CONTENTION_ATTEMPTS; attempt++) {
      const existing = await findDocument(claim.payload, claim.identity, storeCode)
      if (!existing) {
        throw new Error(`Publication state disappeared for ${getKey(claim.identity, storeCode)}`)
      }
      if (
        existing.operationId !== claim.operationId ||
        existing.desiredDigest !== claim.desiredDigest
      ) {
        return toState(existing)
      }
      const updated = await payloadUpdateIfCurrent(claim.payload, existing, {
        error: null,
        publishedAt: claim.publishedAt,
        publishedDigest: claim.desiredDigest,
        status: 'published',
      })
      if (updated) {
        return toState(updated)
      }
    }
    throw contended(claim.identity, storeCode)
  }

  /**
   * Shared "fail, but only for the operation that still owns the row" rule
   * for both the base offer row and a local-inventory store row.
   */
  const markFailedRow = async (
    args: {
      error: GmcPublicationState['error']
      identity: GmcPublicationState['identity']
      operationId: string
      payload: Payload
    },
    storeCode?: string,
  ): Promise<void> => {
    for (let attempt = 0; attempt < MAX_CONTENTION_ATTEMPTS; attempt++) {
      const existing = await findDocument(args.payload, args.identity, storeCode)
      if (!existing || existing.operationId !== args.operationId) {
        return
      }
      if (
        await payloadUpdateIfCurrent(args.payload, existing, {
          error: args.error,
          status: 'failed',
        })
      ) {
        return
      }
    }
    throw contended(args.identity, storeCode)
  }

  return {
    claimLocalInventory: ({ storeCode, ...claim }) => claimRow(claim, storeCode),
    claimPublication,
    get: async ({ identity, payload }) => {
      const doc = await findDocument(payload, identity)
      return doc ? toState(doc) : null
    },
    getLocalInventory: async ({ identity, payload, storeCode }) => {
      const doc = await findDocument(payload, identity, storeCode)
      return doc ? toState(doc) : null
    },
    listByProduct: async ({ payload, productId }) => {
      const states: GmcPublicationState[] = []
      let cursor: GmcDocumentID | undefined
      do {
        const result = await payload.find({
          collection: args.collectionSlug as never,
          depth: 0,
          limit: PAGE_SIZE,
          overrideAccess: true,
          pagination: false,
          sort: 'id',
          where: {
            and: [
              { productId: { equals: String(productId) } },
              { status: { not_equals: 'deleted' } },
              // Local-inventory rows share this collection but are owned by a
              // different lifecycle; offer reconciliation must not see them.
              { storeCode: { equals: null } },
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
        const nextCursor = docs.length === PAGE_SIZE ? docs.at(-1)?.id : undefined
        if (nextCursor !== undefined && nextCursor === cursor) {
          throw new Error('GMC publication-state keyset pagination did not advance')
        }
        cursor = nextCursor
      } while (cursor !== undefined)
      return states
    },
    markDeleted: async ({ deletedAt, identity, operationId, payload, productId }) => {
      for (let attempt = 0; attempt < MAX_CONTENTION_ATTEMPTS; attempt++) {
        const existing = await findDocument(payload, identity)
        if (!existing) {
          try {
            return toState(
              await payloadCreate(payload, {
                ...identityColumns(identity),
                desiredAt: deletedAt,
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
        // `desiredAt` keeps the deletion instant rather than being cleared: a
        // publish claim requested at or before it is stale evidence and must
        // not resurrect the offer.
        const updated = await payloadUpdateIfCurrent(payload, existing, {
          desiredAt: deletedAt,
          desiredDigest: null,
          error: null,
          operationId,
          productId: productId === undefined ? (existing.productId ?? null) : String(productId),
          publishedDigest: null,
          status: 'deleted',
        })
        if (updated) {
          return toState(updated)
        }
      }
      throw contended(identity)
    },
    markDeletePending: async ({
      deletedAt,
      identity,
      onlyIfDesiredBefore,
      operationId,
      payload,
      productId,
    }) => {
      for (let attempt = 0; attempt < MAX_CONTENTION_ATTEMPTS; attempt++) {
        const existing = await findDocument(payload, identity)
        // A reconciliation sweep may only remove identities the projection had
        // already stopped desiring when the sweep started.
        if (
          onlyIfDesiredBefore !== undefined &&
          existing?.desiredAt != null &&
          existing.desiredAt >= onlyIfDesiredBefore &&
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
            return toState(
              await payloadCreate(payload, {
                ...identityColumns(identity),
                desiredAt: deletedAt,
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
        // An already-deleted row is only terminal for an unconditional delete.
        // A reconciliation sweep supplies `onlyIfDesiredBefore` precisely
        // because Google may still hold the product after a failed delete, so
        // it must be able to re-enter `delete-pending` and repair the orphan.
        if (existing.status === 'deleted' && onlyIfDesiredBefore === undefined) {
          return toState(existing)
        }
        const updated = await payloadUpdateIfCurrent(payload, existing, {
          desiredAt: deletedAt,
          desiredDigest: null,
          error: null,
          operationId,
          status: 'delete-pending',
        })
        if (updated) {
          return toState(updated)
        }
      }
      throw contended(identity)
    },
    markFailed: (args) => markFailedRow(args),
    markLocalInventoryFailed: ({ storeCode, ...args }) => markFailedRow(args, storeCode),
    markLocalInventoryPublished: ({ storeCode, ...claim }) => markPublishedRow(claim, storeCode),
    markObserved: async ({
      identity,
      observedAt,
      payload,
      remoteMissing,
      remoteStatus,
      remoteVersion,
    }) => {
      for (let attempt = 0; attempt < MAX_CONTENTION_ATTEMPTS; attempt++) {
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
      throw contended(identity)
    },
    markPublished: (claim) => markPublishedRow(claim),
  }
}
