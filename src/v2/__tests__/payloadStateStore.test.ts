import type { Payload } from 'payload'

import { describe, expect, it } from 'vitest'

import { atomicUpdatePublicationState, toSnakeCase } from '../state/atomicStateUpdate.js'
import {
  createPayloadPublicationStateStore,
  GmcIdentityOwnershipError,
} from '../state/payloadStateStore.js'
import { createPayloadStateDouble } from './helpers/memoryStateStore.js'

const COLLECTION = 'gmc-publications-v2'
const identity = { contentLanguage: 'en', feedLabel: 'US', offerId: 'sku-1' }
const DELETED_AT = '2026-08-29T12:05:00.000Z'

const payloadDouble = (options: { beforeFind?: () => Promise<void> } = {}) =>
  createPayloadStateDouble({ beforeFind: options.beforeFind, collectionSlug: COLLECTION })

const newStore = () =>
  createPayloadPublicationStateStore({
    collectionSlug: COLLECTION,
    dataSourceName: 'accounts/merchant-1/dataSources/source-1',
    merchantId: 'merchant-1',
  })

const claim = (payload: Payload, overrides: Record<string, unknown> = {}) => ({
  desiredAt: '2026-08-29T12:00:00.000Z',
  desiredDigest: 'digest-1',
  identity,
  operationId: 'operation-1',
  payload,
  productId: 'product-1',
  ...overrides,
})

describe('Payload publication state store', () => {
  it('claims, publishes, and treats exact redelivery as a no-op', async () => {
    const test = payloadDouble()
    const store = newStore()

    const pending = await store.claimPublication(claim(test.payload))
    expect(pending).toMatchObject({
      desiredDigest: 'digest-1',
      revision: 0,
      status: 'publish-pending',
    })
    expect(pending.storeCode).toBeUndefined()

    const published = await store.markPublished({
      ...claim(test.payload),
      publishedAt: '2026-08-29T12:00:05.000Z',
    })
    expect(published).toMatchObject({
      publishedDigest: 'digest-1',
      revision: 1,
      status: 'published',
    })

    const writesBefore = test.update.mock.calls.length
    await expect(store.claimPublication(claim(test.payload))).resolves.toMatchObject({
      publishedDigest: 'digest-1',
      status: 'published',
    })
    expect(test.update).toHaveBeenCalledTimes(writesBefore)
  })

  it('re-stamps a published row when the same digest is desired again later', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))
    await store.markPublished({
      ...claim(test.payload),
      publishedAt: '2026-08-29T12:00:05.000Z',
    })

    await expect(
      store.claimPublication(
        claim(test.payload, {
          desiredAt: '2026-08-29T13:00:00.000Z',
          operationId: 'operation-2',
        }),
      ),
    ).resolves.toMatchObject({
      desiredAt: '2026-08-29T13:00:00.000Z',
      operationId: 'operation-2',
      publishedDigest: 'digest-1',
      status: 'published',
    })
  })

  it('ignores a claim that carries an older desiredAt than the stored one', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload, { desiredAt: '2026-08-29T12:05:00.000Z' }))

    await expect(
      store.claimPublication(
        claim(test.payload, {
          desiredAt: '2026-08-29T12:00:00.000Z',
          desiredDigest: 'stale-digest',
          operationId: 'stale-operation',
        }),
      ),
    ).resolves.toMatchObject({
      desiredAt: '2026-08-29T12:05:00.000Z',
      desiredDigest: 'digest-1',
      operationId: 'operation-1',
    })
  })

  it('accepts a newer digest for the same identity', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))

    await expect(
      store.claimPublication(
        claim(test.payload, {
          desiredAt: '2026-08-29T12:05:00.000Z',
          desiredDigest: 'digest-2',
          operationId: 'operation-2',
        }),
      ),
    ).resolves.toMatchObject({
      desiredDigest: 'digest-2',
      operationId: 'operation-2',
      status: 'publish-pending',
    })
  })

  it('prevents cross-product identity theft', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))

    await expect(
      store.claimPublication(
        claim(test.payload, { operationId: 'operation-2', productId: 'product-2' }),
      ),
    ).rejects.toBeInstanceOf(GmcIdentityOwnershipError)
  })

  it('resolves two concurrent creates for the same new identity to one row', async () => {
    let readers = 0
    let release: (() => void) | undefined
    const bothRead = new Promise<void>((resolve) => {
      release = resolve
    })
    const test = payloadDouble({
      beforeFind: async () => {
        readers++
        if (readers === 2) {
          release?.()
        }
        if (readers <= 2) {
          await bothRead
        }
      },
    })
    const store = newStore()

    const [first, second] = await Promise.all([
      store.claimPublication(claim(test.payload, { operationId: 'operation-a' })),
      store.claimPublication(
        claim(test.payload, {
          desiredAt: '2026-08-29T12:01:00.000Z',
          desiredDigest: 'digest-b',
          operationId: 'operation-b',
        }),
      ),
    ])

    expect(test.docs).toHaveLength(1)
    expect(test.create).toHaveBeenCalledTimes(2)
    expect(first.status).toBe('publish-pending')
    expect(second.status).toBe('publish-pending')
    await expect(store.get({ identity, payload: test.payload })).resolves.toMatchObject({
      desiredDigest: 'digest-b',
      operationId: 'operation-b',
    })
  })

  it('rethrows a create failure that is not a duplicate key', async () => {
    const test = payloadDouble()
    const store = newStore()
    test.create.mockRejectedValueOnce(new Error('connection reset'))

    await expect(store.claimPublication(claim(test.payload))).rejects.toThrow('connection reset')
  })

  it('refuses to delete an identity a newer projection still desires', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))

    await expect(
      store.markDeletePending({
        deletedAt: DELETED_AT,
        identity,
        onlyIfDesiredBefore: '2026-08-29T12:00:00.000Z',
        operationId: 'reconcile-1',
        payload: test.payload,
      }),
    ).resolves.toBeNull()
    await expect(store.get({ identity, payload: test.payload })).resolves.toMatchObject({
      status: 'publish-pending',
    })
  })

  it('deletes an identity whose desired claim predates the sweep', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload, { desiredAt: '2026-08-29T11:59:59.000Z' }))

    const pending = await store.markDeletePending({
      deletedAt: DELETED_AT,
      identity,
      onlyIfDesiredBefore: '2026-08-29T12:00:00.000Z',
      operationId: 'reconcile-1',
      payload: test.payload,
    })
    expect(pending).toMatchObject({ desiredAt: DELETED_AT, status: 'delete-pending' })

    await expect(
      store.markDeleted({
        deletedAt: DELETED_AT,
        identity,
        operationId: 'reconcile-1',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ publishedDigest: undefined, status: 'deleted' })
  })

  it('refuses to delete an identity owned by another product', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))

    await expect(
      store.markDeletePending({
        deletedAt: DELETED_AT,
        identity,
        operationId: 'delete-1',
        payload: test.payload,
        productId: 'product-2',
      }),
    ).resolves.toBeNull()
  })

  it('records a delete for an identity that has no state row yet', async () => {
    const test = payloadDouble()
    const store = newStore()

    await expect(
      store.markDeletePending({
        deletedAt: DELETED_AT,
        identity,
        operationId: 'orphan-1',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ revision: 0, status: 'delete-pending' })
    await expect(
      store.markDeletePending({
        deletedAt: DELETED_AT,
        identity,
        operationId: 'orphan-2',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ status: 'delete-pending' })
  })

  it('republishes an identity claimed after it was deleted', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))
    await store.markDeletePending({
      deletedAt: DELETED_AT,
      identity,
      operationId: 'delete-1',
      payload: test.payload,
      productId: 'product-1',
    })
    const deleted = await store.markDeleted({
      deletedAt: DELETED_AT,
      identity,
      operationId: 'delete-1',
      payload: test.payload,
      productId: 'product-1',
    })
    expect(deleted).toMatchObject({ status: 'deleted' })

    await expect(
      store.claimPublication(
        claim(test.payload, {
          desiredAt: '2026-08-29T12:10:00.000Z',
          desiredDigest: 'digest-2',
          operationId: 'operation-2',
          productId: 'product-2',
        }),
      ),
    ).resolves.toMatchObject({
      desiredDigest: 'digest-2',
      productId: 'product-2',
      status: 'publish-pending',
    })
  })

  it('stamps a deletion instant so a stale publish claim can never resurrect it', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))
    await store.markDeletePending({
      deletedAt: DELETED_AT,
      identity,
      operationId: 'delete-1',
      payload: test.payload,
      productId: 'product-1',
    })
    await expect(
      store.markDeleted({
        deletedAt: DELETED_AT,
        identity,
        operationId: 'delete-1',
        payload: test.payload,
        productId: 'product-1',
      }),
    ).resolves.toMatchObject({ desiredAt: DELETED_AT, desiredDigest: undefined, status: 'deleted' })

    // The offer.publish redelivery below was requested strictly before the
    // delete and must be reported back unchanged rather than re-arming a
    // publish.
    await expect(
      store.claimPublication(
        claim(test.payload, {
          desiredAt: '2026-08-29T12:04:00.000Z',
          desiredDigest: 'digest-stale',
          operationId: 'stale-publish',
        }),
      ),
    ).resolves.toMatchObject({ operationId: 'delete-1', status: 'deleted' })
  })

  it('lets an equal-instant publish claim reopen a deleted row', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))
    await store.markDeletePending({
      deletedAt: DELETED_AT,
      identity,
      operationId: 'delete-1',
      payload: test.payload,
      productId: 'product-1',
    })
    await store.markDeleted({
      deletedAt: DELETED_AT,
      identity,
      operationId: 'delete-1',
      payload: test.payload,
      productId: 'product-1',
    })

    // One reconciliation root stamps its desired-state children and its orphan
    // sweep with the same instant. The desired projection is the better
    // evidence at that instant, so the tie must reopen the row instead of
    // leaving the offer deleted until the next reconciliation.
    await expect(
      store.claimPublication(
        claim(test.payload, {
          desiredAt: DELETED_AT,
          desiredDigest: 'digest-tie',
          operationId: 'tie-publish',
        }),
      ),
    ).resolves.toMatchObject({
      desiredDigest: 'digest-tie',
      operationId: 'tie-publish',
      status: 'publish-pending',
    })
  })

  it('accepts a publish claim requested after the deletion instant', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))
    await store.markDeletePending({
      deletedAt: DELETED_AT,
      identity,
      operationId: 'delete-1',
      payload: test.payload,
      productId: 'product-1',
    })
    await store.markDeleted({
      deletedAt: DELETED_AT,
      identity,
      operationId: 'delete-1',
      payload: test.payload,
      productId: 'product-1',
    })

    await expect(
      store.claimPublication(
        claim(test.payload, {
          desiredAt: '2026-08-29T12:06:00.000Z',
          desiredDigest: 'digest-new',
          operationId: 'newer-publish',
        }),
      ),
    ).resolves.toMatchObject({
      desiredDigest: 'digest-new',
      operationId: 'newer-publish',
      status: 'publish-pending',
    })
  })

  it('lets a reconciliation sweep re-enter delete-pending on an already-deleted row', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))
    await store.markDeletePending({
      deletedAt: DELETED_AT,
      identity,
      operationId: 'delete-1',
      payload: test.payload,
      productId: 'product-1',
    })
    await store.markDeleted({
      deletedAt: DELETED_AT,
      identity,
      operationId: 'delete-1',
      payload: test.payload,
      productId: 'product-1',
    })
    await expect(store.get({ identity, payload: test.payload })).resolves.toMatchObject({
      status: 'deleted',
    })

    // Google can still hold the product after a failed delete. The sweep must
    // be able to re-arm the delete rather than being told the row is done.
    await expect(
      store.markDeletePending({
        deletedAt: DELETED_AT,
        identity,
        onlyIfDesiredBefore: '2026-08-29T13:00:00.000Z',
        operationId: 'reconcile-orphan',
        payload: test.payload,
        productId: 'product-1',
      }),
    ).resolves.toMatchObject({ operationId: 'reconcile-orphan', status: 'delete-pending' })
  })

  it('leaves an already-deleted row alone for an unconditional delete', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))
    await store.markDeletePending({
      deletedAt: DELETED_AT,
      identity,
      operationId: 'delete-1',
      payload: test.payload,
      productId: 'product-1',
    })
    await store.markDeleted({
      deletedAt: DELETED_AT,
      identity,
      operationId: 'delete-1',
      payload: test.payload,
      productId: 'product-1',
    })
    const writesBefore = test.update.mock.calls.length

    await expect(
      store.markDeletePending({
        deletedAt: DELETED_AT,
        identity,
        operationId: 'delete-2',
        payload: test.payload,
        productId: 'product-1',
      }),
    ).resolves.toMatchObject({ operationId: 'delete-1', status: 'deleted' })
    expect(test.update).toHaveBeenCalledTimes(writesBefore)
  })

  it('does not mark an offer deleted after a newer desired claim wins the race', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))
    await store.markDeletePending({
      deletedAt: DELETED_AT,
      identity,
      operationId: 'delete-operation',
      payload: test.payload,
      productId: 'product-1',
    })
    await store.claimPublication(
      claim(test.payload, {
        desiredAt: '2026-08-29T12:06:00.000Z',
        desiredDigest: 'digest-2',
        operationId: 'publish-operation',
      }),
    )

    await expect(
      store.markDeleted({
        deletedAt: DELETED_AT,
        identity,
        operationId: 'delete-operation',
        payload: test.payload,
        productId: 'product-1',
      }),
    ).resolves.toMatchObject({ operationId: 'publish-operation', status: 'publish-pending' })
  })

  it('creates a deleted row for an identity that never had state', async () => {
    const test = payloadDouble()
    const store = newStore()

    await expect(
      store.markDeleted({
        deletedAt: DELETED_AT,
        identity,
        operationId: 'delete-1',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ status: 'deleted' })
  })

  it('only publishes, fails, or observes the operation that still owns the row', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))

    await expect(
      store.markPublished({
        ...claim(test.payload, { desiredDigest: 'other-digest' }),
        publishedAt: '2026-08-29T12:00:05.000Z',
      }),
    ).resolves.toMatchObject({ status: 'publish-pending' })

    await store.markFailed({
      error: { code: 'HTTP_400', message: 'rejected', retryable: false },
      identity,
      operationId: 'someone-else',
      payload: test.payload,
    })
    await expect(store.get({ identity, payload: test.payload })).resolves.toMatchObject({
      status: 'publish-pending',
    })

    await store.markFailed({
      error: { code: 'HTTP_400', message: 'rejected', retryable: false },
      identity,
      operationId: 'operation-1',
      payload: test.payload,
    })
    await expect(store.get({ identity, payload: test.payload })).resolves.toMatchObject({
      error: { code: 'HTTP_400', message: 'rejected', retryable: false },
      status: 'failed',
    })

    await store.markObserved({
      identity,
      observedAt: '2026-08-29T12:10:00.000Z',
      payload: test.payload,
      remoteMissing: false,
      remoteStatus: { destinationStatuses: [] },
      remoteVersion: '77',
    })
    await expect(store.get({ identity, payload: test.payload })).resolves.toMatchObject({
      remoteMissing: false,
      remoteVersion: '77',
    })
  })

  it('ignores publish, fail, and observe calls for an identity with no row', async () => {
    const test = payloadDouble()
    const store = newStore()

    await expect(
      store.markPublished({ ...claim(test.payload), publishedAt: '2026-08-29T12:00:05.000Z' }),
    ).rejects.toThrow(/Publication state disappeared/)
    await expect(
      store.markFailed({
        error: { message: 'nope' },
        identity,
        operationId: 'operation-1',
        payload: test.payload,
      }),
    ).resolves.toBeUndefined()
    await expect(
      store.markObserved({
        identity,
        observedAt: '2026-08-29T12:10:00.000Z',
        payload: test.payload,
        remoteMissing: true,
      }),
    ).resolves.toBeUndefined()
  })

  it('gives up when every compare-and-set attempt loses its revision', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))
    test.update.mockResolvedValue(null)

    await expect(
      store.claimPublication(
        claim(test.payload, { desiredDigest: 'digest-2', operationId: 'operation-2' }),
      ),
    ).rejects.toThrow(/remained contended/)
    expect(test.update).toHaveBeenCalledTimes(10)
  })

  it('keyset-paginates active identities and hides deleted and local-inventory rows', async () => {
    const test = payloadDouble()
    const store = newStore()
    for (let index = 0; index < 501; index++) {
      await store.claimPublication(
        claim(test.payload, {
          identity: { ...identity, offerId: `sku-${String(index).padStart(3, '0')}` },
        }),
      )
    }
    test.docs.push({
      id: 10_001,
      key: 'merchant-1|local|store-1',
      productId: 'product-1',
      revision: 0,
      status: 'published',
      storeCode: 'store-1',
      updatedAt: '2026-08-29T12:00:00.000Z',
    })

    const deletedIdentity = { ...identity, offerId: 'sku-000' }
    await store.markDeletePending({
      deletedAt: DELETED_AT,
      identity: deletedIdentity,
      operationId: 'delete-sku-000',
      payload: test.payload,
      productId: 'product-1',
    })
    await store.markDeleted({
      deletedAt: DELETED_AT,
      identity: deletedIdentity,
      operationId: 'delete-sku-000',
      payload: test.payload,
      productId: 'product-1',
    })

    await expect(
      store.listByProduct({ payload: test.payload, productId: 'product-1' }),
    ).resolves.toHaveLength(500)
  })

  it('refuses to page a product that owns more identities than the store cap', async () => {
    const test = payloadDouble()
    const store = newStore()
    for (let index = 0; index < 1_001; index++) {
      await store.claimPublication(
        claim(test.payload, {
          identity: { ...identity, offerId: `sku-${String(index).padStart(4, '0')}` },
        }),
      )
    }

    await expect(
      store.listByProduct({ payload: test.payload, productId: 'product-1' }),
    ).rejects.toThrow(/exceeds 1000 active publication identities/)
  })

  it('routes a claim with a data-source override to its own identity key', async () => {
    const test = payloadDouble()
    const store = newStore()
    const overridden = { ...identity, dataSourceOverride: 'accounts/merchant-1/dataSources/alt' }

    await expect(
      store.claimPublication(claim(test.payload, { identity: overridden })),
    ).resolves.toMatchObject({ identity: overridden })
    await expect(store.get({ identity, payload: test.payload })).resolves.toBeNull()
  })
})

describe('local-inventory rows folded into the main store', () => {
  it('claims independent rows per store and keeps them out of listByProduct', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimPublication(claim(test.payload))

    const storeA = await store.claimLocalInventory({
      ...claim(test.payload, { desiredDigest: 'inventory-a' }),
      storeCode: 'store-a',
    })
    const storeB = await store.claimLocalInventory({
      ...claim(test.payload, { desiredDigest: 'inventory-b', operationId: 'operation-b' }),
      storeCode: 'store-b',
    })

    expect(storeA).toMatchObject({
      desiredDigest: 'inventory-a',
      status: 'publish-pending',
      storeCode: 'store-a',
    })
    expect(storeB).toMatchObject({
      desiredDigest: 'inventory-b',
      status: 'publish-pending',
      storeCode: 'store-b',
    })
    // One product row plus two independent store rows.
    expect(test.docs).toHaveLength(3)

    const active = await store.listByProduct({ payload: test.payload, productId: 'product-1' })
    expect(active).toHaveLength(1)
    expect(active[0]?.storeCode).toBeUndefined()

    await expect(
      store.getLocalInventory({ identity, payload: test.payload, storeCode: 'store-a' }),
    ).resolves.toMatchObject({ desiredDigest: 'inventory-a', storeCode: 'store-a' })
    await expect(
      store.getLocalInventory({ identity, payload: test.payload, storeCode: 'store-b' }),
    ).resolves.toMatchObject({ desiredDigest: 'inventory-b', storeCode: 'store-b' })
  })

  it('ignores a local-inventory claim that carries an older desiredAt than the stored one', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimLocalInventory({
      ...claim(test.payload, { desiredAt: '2026-08-29T12:05:00.000Z' }),
      storeCode: 'store-1',
    })

    await expect(
      store.claimLocalInventory({
        ...claim(test.payload, {
          desiredAt: '2026-08-29T12:00:00.000Z',
          desiredDigest: 'stale-digest',
          operationId: 'stale-operation',
        }),
        storeCode: 'store-1',
      }),
    ).resolves.toMatchObject({
      desiredAt: '2026-08-29T12:05:00.000Z',
      desiredDigest: 'digest-1',
      operationId: 'operation-1',
      storeCode: 'store-1',
    })
  })

  it('treats exact redelivery of an already-published local-inventory claim as a no-op', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimLocalInventory({ ...claim(test.payload), storeCode: 'store-1' })
    await store.markLocalInventoryPublished({
      ...claim(test.payload),
      publishedAt: '2026-08-29T12:00:05.000Z',
      storeCode: 'store-1',
    })

    const writesBefore = test.update.mock.calls.length
    await expect(
      store.claimLocalInventory({ ...claim(test.payload), storeCode: 'store-1' }),
    ).resolves.toMatchObject({ publishedDigest: 'digest-1', status: 'published' })
    expect(test.update).toHaveBeenCalledTimes(writesBefore)
  })

  it('only publishes or fails the operation that currently owns the local-inventory row', async () => {
    const test = payloadDouble()
    const store = newStore()
    await store.claimLocalInventory({ ...claim(test.payload), storeCode: 'store-1' })

    await store.markLocalInventoryFailed({
      error: { message: 'transient', retryable: true },
      identity,
      operationId: 'someone-else',
      payload: test.payload,
      storeCode: 'store-1',
    })
    await expect(
      store.getLocalInventory({ identity, payload: test.payload, storeCode: 'store-1' }),
    ).resolves.toMatchObject({ status: 'publish-pending' })

    await store.markLocalInventoryFailed({
      error: { message: 'rejected', retryable: false },
      identity,
      operationId: 'operation-1',
      payload: test.payload,
      storeCode: 'store-1',
    })
    await expect(
      store.getLocalInventory({ identity, payload: test.payload, storeCode: 'store-1' }),
    ).resolves.toMatchObject({ error: { message: 'rejected', retryable: false }, status: 'failed' })

    await expect(
      store.getLocalInventory({ identity, payload: test.payload, storeCode: 'store-2' }),
    ).resolves.toBeNull()
  })
})

describe('atomicUpdatePublicationState', () => {
  const existing = { id: 7, key: 'k', revision: 3, status: 'publish-pending' }

  const drizzleDouble = (name: 'postgres' | 'sqlite', rows: Array<{ id: number }>) => {
    const table = {
      id: { column: 'id' },
      revision: { column: 'revision' },
      status: { column: 'status' },
      updatedAt: { column: 'updated_at' },
    }
    const captured: { columns?: Record<string, unknown>; where?: unknown } = {}
    const payload = {
      db: {
        name,
        drizzle: {
          update: (target: unknown) => {
            expect(target).toBe(table)
            return {
              set: (columns: Record<string, unknown>) => {
                captured.columns = columns
                return {
                  where: (condition: unknown) => {
                    captured.where = condition
                    return { returning: () => Promise.resolve(rows) }
                  },
                }
              },
            }
          },
        },
        operators: {
          and: (...conditions: unknown[]) => ({ and: conditions }),
          equals: (column: unknown, value: unknown) => ({ column, equals: value }),
        },
        tableNameMap: new Map([['gmc_publications_v2', 'gmc_publications_v2']]),
        tables: { gmc_publications_v2: table },
      },
    } as unknown as Payload
    return { captured, payload, table }
  }

  it('derives Payload table names the way the Drizzle adapters do', () => {
    expect(toSnakeCase('gmc-publications-v2')).toBe('gmc_publications_v2')
    expect(toSnakeCase('gmc-local-inventory-publications-v2')).toBe(
      'gmc_local_inventory_publications_v2',
    )
    expect(toSnakeCase('products')).toBe('products')
    expect(toSnakeCase('myCollection')).toBe('my_collection')
    expect(toSnakeCase('my collection')).toBe('my_collection')
  })

  it('compare-and-sets through drizzle and projects the applied row', async () => {
    const test = drizzleDouble('postgres', [{ id: 7 }])

    const updated = await atomicUpdatePublicationState({
      collectionSlug: 'gmc-publications-v2',
      data: { status: 'published' },
      existing,
      payload: test.payload,
    })

    expect(updated).toMatchObject({ id: 7, key: 'k', revision: 4, status: 'published' })
    expect(test.captured.columns).toMatchObject({ revision: 4, status: 'published' })
    expect(typeof (test.captured.columns as { updatedAt: string }).updatedAt).toBe('string')
    expect(test.captured.where).toEqual({
      and: [
        { column: test.table.id, equals: 7 },
        { column: test.table.revision, equals: 3 },
      ],
    })
  })

  it('returns null when another worker already advanced the revision', async () => {
    const test = drizzleDouble('sqlite', [])

    await expect(
      atomicUpdatePublicationState({
        collectionSlug: 'gmc-publications-v2',
        data: { status: 'published' },
        existing,
        payload: test.payload,
      }),
    ).resolves.toBeNull()
  })

  it('rejects undefined values and columns the table does not have', async () => {
    const test = drizzleDouble('postgres', [{ id: 7 }])

    await expect(
      atomicUpdatePublicationState({
        collectionSlug: 'gmc-publications-v2',
        data: { status: undefined },
        existing,
        payload: test.payload,
      }),
    ).rejects.toThrow(/cannot write undefined to status/)
    await expect(
      atomicUpdatePublicationState({
        collectionSlug: 'gmc-publications-v2',
        data: { desiredVersion: '1' },
        existing,
        payload: test.payload,
      }),
    ).rejects.toThrow(/Unsupported GMC publication state update field: desiredVersion/)
  })

  it('reports an unregistered table and an unsupported adapter', async () => {
    const test = drizzleDouble('postgres', [{ id: 7 }])

    await expect(
      atomicUpdatePublicationState({
        collectionSlug: 'other-collection',
        data: { status: 'published' },
        existing,
        payload: test.payload,
      }),
    ).rejects.toThrow(/table other_collection is not registered/)
    await expect(
      atomicUpdatePublicationState({
        collectionSlug: 'gmc-publications-v2',
        data: { status: 'published' },
        existing,
        payload: { db: { name: 'custom-adapter' } } as unknown as Payload,
      }),
    ).rejects.toThrow(/does not support Payload database adapter custom-adapter/)
    await expect(
      atomicUpdatePublicationState({
        collectionSlug: 'gmc-publications-v2',
        data: { status: 'published' },
        existing,
        payload: { db: { name: 'sqlite' } } as unknown as Payload,
      }),
    ).rejects.toThrow(/did not expose its initialized Drizzle instance/)
  })
})
