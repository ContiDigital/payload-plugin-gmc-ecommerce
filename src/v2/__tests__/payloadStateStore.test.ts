import type { Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import {
  createPayloadPublicationStateStore,
  GmcIdentityOwnershipError,
  GmcSourceVersionConflictError,
} from '../state/payloadStateStore.js'

const identity = { contentLanguage: 'en', feedLabel: 'US', offerId: 'sku-1' }

const payloadDouble = () => {
  const docs: Array<{ id: number } & Record<string, unknown>> = []
  let id = 0
  const update = vi.fn(
    (args: {
      data: Record<string, unknown>
      where: { and: Array<Record<string, { equals: unknown }>> }
    }) => {
      const matches = Object.fromEntries(
        args.where.and.flatMap((condition) =>
          Object.entries(condition).map(([field, value]) => [field, value.equals]),
        ),
      )
      const index = docs.findIndex((doc) =>
        Object.entries(matches).every(([field, value]) => doc[field] === value),
      )
      if (index < 0) {
        return Promise.resolve(null)
      }
      docs[index] = { ...docs[index], ...args.data, updatedAt: new Date().toISOString() }
      return Promise.resolve(docs[index])
    },
  )
  const payload = {
    create: vi.fn((args: { data: Record<string, unknown> }) => {
      if (docs.some((doc) => doc.key === args.data.key)) {
        return Promise.reject(Object.assign(new Error('unique constraint'), { status: 409 }))
      }
      const now = new Date().toISOString()
      const doc = { revision: 0, ...args.data, id: ++id, createdAt: now, updatedAt: now }
      docs.push(doc)
      return Promise.resolve(doc)
    }),
    db: {
      name: 'mongoose',
      updateOne: update,
    },
    find: vi.fn((args: { limit?: number; page?: number; where?: Record<string, unknown> }) => {
      const matches = (doc: Record<string, unknown>, where: Record<string, unknown>): boolean => {
        if (Array.isArray(where.and)) {
          return where.and.every((entry) => matches(doc, entry as Record<string, unknown>))
        }
        return Object.entries(where).every(([field, condition]) => {
          const predicate = condition as {
            equals?: unknown
            greater_than?: unknown
            not_equals?: unknown
          }
          if ('equals' in predicate) {
            return doc[field] === predicate.equals
          }
          if ('greater_than' in predicate) {
            if (typeof doc[field] === 'number' && typeof predicate.greater_than === 'number') {
              return doc[field] > predicate.greater_than
            }
            return String(doc[field]).localeCompare(String(predicate.greater_than)) > 0
          }
          if ('not_equals' in predicate) {
            return doc[field] !== predicate.not_equals
          }
          return true
        })
      }
      const filtered = docs.filter((doc) => {
        return matches(doc, args.where ?? {})
      })
      const limit = args.limit ?? 10
      const page = args.page ?? 1
      const start = (page - 1) * limit
      return Promise.resolve({
        docs: filtered.slice(start, start + limit),
        hasNextPage: start + limit < filtered.length,
      })
    }),
  } as unknown as Payload
  return { docs, payload, update }
}

const claim = (payload: Payload, overrides: Record<string, unknown> = {}) => ({
  desiredAt: '2026-08-29T12:00:00.000Z',
  desiredDigest: 'digest-1',
  desiredVersion: '100',
  identity,
  operationId: 'operation-1',
  payload,
  productId: 'product-1',
  ...overrides,
})

describe('Payload publication state store', () => {
  it('persists publication success and makes exact redelivery a no-op', async () => {
    const test = payloadDouble()
    const store = createPayloadPublicationStateStore({
      collectionSlug: 'gmc-publications-v2',
      dataSourceName: 'accounts/merchant-1/dataSources/source-1',
      merchantId: 'merchant-1',
    })
    const pending = await store.claimPublication(claim(test.payload))
    expect(pending.status).toBe('publish-pending')
    await store.markPublished({ ...claim(test.payload), publishedAt: '2026-08-29T12:00:00.000Z' })
    const updatesBeforeRedelivery = test.update.mock.calls.length
    const redelivery = await store.claimPublication(claim(test.payload))

    expect(redelivery).toMatchObject({
      publishedDigest: 'digest-1',
      publishedVersion: '100',
      status: 'published',
    })
    expect(test.update).toHaveBeenCalledTimes(updatesBeforeRedelivery)
  })

  it('prevents cross-product identity theft and same-version content divergence', async () => {
    const test = payloadDouble()
    const store = createPayloadPublicationStateStore({
      collectionSlug: 'gmc-publications-v2',
      dataSourceName: 'accounts/merchant-1/dataSources/source-1',
      merchantId: 'merchant-1',
    })
    await store.claimPublication(claim(test.payload))

    await expect(
      store.claimPublication(
        claim(test.payload, {
          operationId: 'operation-2',
          productId: 'product-2',
        }),
      ),
    ).rejects.toBeInstanceOf(GmcIdentityOwnershipError)
    await expect(
      store.claimPublication(
        claim(test.payload, {
          desiredDigest: 'different-digest',
          operationId: 'operation-3',
        }),
      ),
    ).rejects.toBeInstanceOf(GmcSourceVersionConflictError)
  })

  it('protects a desired claim made at the reconciliation boundary', async () => {
    const test = payloadDouble()
    const store = createPayloadPublicationStateStore({
      collectionSlug: 'gmc-publications-v2',
      dataSourceName: 'accounts/merchant-1/dataSources/source-1',
      merchantId: 'merchant-1',
    })
    await store.claimPublication(claim(test.payload))

    await expect(
      store.markDeletePending({
        deleteIfDesiredBefore: '2026-08-29T12:00:00.000Z',
        identity,
        operationId: 'reconcile-1',
        payload: test.payload,
      }),
    ).resolves.toBeNull()
    expect((await store.get({ identity, payload: test.payload }))?.status).toBe('publish-pending')
  })

  it('allows compare-and-set cleanup of a stale desired claim', async () => {
    const test = payloadDouble()
    const store = createPayloadPublicationStateStore({
      collectionSlug: 'gmc-publications-v2',
      dataSourceName: 'accounts/merchant-1/dataSources/source-1',
      merchantId: 'merchant-1',
    })
    await store.claimPublication(
      claim(test.payload, {
        desiredAt: '2026-08-29T11:59:59.000Z',
      }),
    )

    await expect(
      store.markDeletePending({
        deleteIfDesiredBefore: '2026-08-29T12:00:00.000Z',
        identity,
        operationId: 'reconcile-1',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ status: 'delete-pending' })
  })

  it('uses a durable desired-version barrier instead of worker clocks when supplied', async () => {
    const test = payloadDouble()
    const store = createPayloadPublicationStateStore({
      collectionSlug: 'gmc-publications-v2',
      dataSourceName: 'accounts/merchant-1/dataSources/source-1',
      merchantId: 'merchant-1',
    })
    await store.claimPublication(
      claim(test.payload, {
        desiredAt: '2026-08-29T11:00:00.000Z',
        desiredVersion: '200',
      }),
    )

    await expect(
      store.markDeletePending({
        deleteIfDesiredBefore: '2026-08-29T12:00:00.000Z',
        deleteIfDesiredVersionBefore: '200',
        identity,
        operationId: 'reconcile-sequenced',
        payload: test.payload,
      }),
    ).resolves.toBeNull()
  })

  it('does not mark an offer deleted after a newer desired claim wins the race', async () => {
    const test = payloadDouble()
    const store = createPayloadPublicationStateStore({
      collectionSlug: 'gmc-publications-v2',
      dataSourceName: 'accounts/merchant-1/dataSources/source-1',
      merchantId: 'merchant-1',
    })
    await store.claimPublication(claim(test.payload))
    await store.markDeletePending({
      identity,
      operationId: 'delete-operation',
      payload: test.payload,
      productId: 'product-1',
    })
    await store.claimPublication(
      claim(test.payload, {
        desiredAt: '2026-08-29T12:01:00.000Z',
        desiredDigest: 'digest-2',
        desiredVersion: '101',
        operationId: 'publish-operation',
      }),
    )

    await expect(
      store.markDeleted({
        identity,
        operationId: 'delete-operation',
        payload: test.payload,
        productId: 'product-1',
      }),
    ).resolves.toMatchObject({
      operationId: 'publish-operation',
      status: 'publish-pending',
    })
  })

  it('retains a monotonic deletion fence and only permits a newer publish', async () => {
    const test = payloadDouble()
    const store = createPayloadPublicationStateStore({
      collectionSlug: 'gmc-publications-v2',
      dataSourceName: 'accounts/merchant-1/dataSources/source-1',
      merchantId: 'merchant-1',
    })
    await store.claimPublication(claim(test.payload))
    await store.markDeletePending({
      deleteVersion: '101',
      identity,
      operationId: 'delete-operation',
      payload: test.payload,
      productId: 'product-1',
    })
    const deleted = await store.markDeleted({
      identity,
      operationId: 'delete-operation',
      payload: test.payload,
      productId: 'product-1',
    })

    expect(deleted).toMatchObject({ deleteVersion: '101', status: 'deleted' })
    await expect(
      store.claimPublication(
        claim(test.payload, {
          desiredDigest: 'stale-digest',
          desiredVersion: '101',
          operationId: 'stale-publish',
        }),
      ),
    ).resolves.toMatchObject({ deleteVersion: '101', status: 'deleted' })
    await expect(
      store.claimPublication(
        claim(test.payload, {
          desiredDigest: 'new-digest',
          desiredVersion: '102',
          operationId: 'new-publish',
        }),
      ),
    ).resolves.toMatchObject({
      deleteVersion: undefined,
      desiredVersion: '102',
      status: 'publish-pending',
    })
  })

  it('raises the retained fence when a newer delete redelivers after absence', async () => {
    const test = payloadDouble()
    const store = createPayloadPublicationStateStore({
      collectionSlug: 'gmc-publications-v2',
      dataSourceName: 'accounts/merchant-1/dataSources/source-1',
      merchantId: 'merchant-1',
    })
    await store.claimPublication(claim(test.payload, { desiredVersion: '100' }))
    await store.markDeletePending({
      deleteVersion: '100',
      identity,
      operationId: 'delete-100',
      payload: test.payload,
      productId: 'product-1',
    })
    await store.markDeleted({
      identity,
      operationId: 'delete-100',
      payload: test.payload,
      productId: 'product-1',
    })

    await expect(
      store.markDeletePending({
        deleteVersion: '200',
        identity,
        operationId: 'delete-200',
        payload: test.payload,
        productId: 'product-1',
      }),
    ).resolves.toMatchObject({ deleteVersion: '200', status: 'deleted' })
    await expect(
      store.claimPublication(
        claim(test.payload, {
          desiredDigest: 'digest-150',
          desiredVersion: '150',
          operationId: 'publish-150',
        }),
      ),
    ).resolves.toMatchObject({ deleteVersion: '200', status: 'deleted' })
  })

  it('refuses a stale delete after a newer desired version wins', async () => {
    const test = payloadDouble()
    const store = createPayloadPublicationStateStore({
      collectionSlug: 'gmc-publications-v2',
      dataSourceName: 'accounts/merchant-1/dataSources/source-1',
      merchantId: 'merchant-1',
    })
    await store.claimPublication(claim(test.payload, { desiredVersion: '102' }))

    await expect(
      store.markDeletePending({
        deleteVersion: '101',
        identity,
        operationId: 'stale-delete',
        payload: test.payload,
        productId: 'product-1',
      }),
    ).resolves.toBeNull()
    await expect(store.get({ identity, payload: test.payload })).resolves.toMatchObject({
      desiredVersion: '102',
      status: 'publish-pending',
    })
  })

  it('keyset-paginates active identities without rereading retained deleted fences', async () => {
    const test = payloadDouble()
    const store = createPayloadPublicationStateStore({
      collectionSlug: 'gmc-publications-v2',
      dataSourceName: 'accounts/merchant-1/dataSources/source-1',
      merchantId: 'merchant-1',
    })
    for (let index = 0; index < 501; index++) {
      await store.claimPublication(
        claim(test.payload, {
          identity: { ...identity, offerId: `sku-${String(index).padStart(3, '0')}` },
        }),
      )
    }

    const deletedIdentity = { ...identity, offerId: 'sku-000' }
    await store.markDeletePending({
      deleteVersion: '101',
      identity: deletedIdentity,
      operationId: 'delete-sku-000',
      payload: test.payload,
      productId: 'product-1',
    })
    await store.markDeleted({
      identity: deletedIdentity,
      operationId: 'delete-sku-000',
      payload: test.payload,
      productId: 'product-1',
    })

    await expect(
      store.listByProduct({ payload: test.payload, productId: 'product-1' }),
    ).resolves.toHaveLength(500)
  })
})
