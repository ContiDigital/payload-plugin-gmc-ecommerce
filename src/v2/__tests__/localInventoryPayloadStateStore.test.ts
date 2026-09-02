import type { Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import {
  createPayloadLocalInventoryPublicationStateStore,
  GmcLocalInventorySourceVersionConflictError,
} from '../state/localInventoryPayloadStateStore.js'

const identity = { contentLanguage: 'en', feedLabel: 'US', offerId: 'sku-1' }

const payloadDouble = () => {
  const docs: Array<{ id: number } & Record<string, unknown>> = []
  let id = 0
  const updateOne = vi.fn(
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
      if (index < 0) {return Promise.resolve(null)}
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
    db: { name: 'mongoose', updateOne },
    find: vi.fn((args: { where?: { key?: { equals?: unknown } } }) =>
      Promise.resolve({
        docs: docs.filter((doc) => doc.key === args.where?.key?.equals).slice(0, 1),
      }),
    ),
  } as unknown as Payload
  return { docs, payload, updateOne }
}

const makeStore = () =>
  createPayloadLocalInventoryPublicationStateStore({
    collectionSlug: 'gmc-local-inventory-publications-v2',
    dataSourceName: 'accounts/merchant-1/dataSources/source-1',
    merchantId: 'merchant-1',
  })

const makeClaim = (payload: Payload, overrides: Record<string, unknown> = {}) => ({
  desiredAt: '2026-08-30T12:00:00.000Z',
  desiredDigest: 'a'.repeat(64),
  desiredVersion: '100',
  identity,
  operationId: 'operation-100',
  payload,
  productId: 'product-1',
  storeCode: 'store-1',
  ...overrides,
})

describe('Payload local-inventory publication state store', () => {
  it('retains the greatest causal version and refuses equal-version divergence', async () => {
    const test = payloadDouble()
    const store = makeStore()
    await expect(store.claim(makeClaim(test.payload))).resolves.toMatchObject({
      desiredVersion: '100',
      status: 'publish-pending',
    })
    await expect(
      store.claim(
        makeClaim(test.payload, {
          desiredDigest: 'b'.repeat(64),
          desiredVersion: '101',
          operationId: 'operation-101',
        }),
      ),
    ).resolves.toMatchObject({ desiredDigest: 'b'.repeat(64), desiredVersion: '101' })
    await expect(
      store.claim(
        makeClaim(test.payload, {
          desiredDigest: 'stale',
          desiredVersion: '99',
          operationId: 'operation-99',
        }),
      ),
    ).resolves.toMatchObject({ desiredDigest: 'b'.repeat(64), desiredVersion: '101' })
    await expect(
      store.claim(
        makeClaim(test.payload, {
          desiredDigest: 'divergent',
          desiredVersion: '101',
          operationId: 'operation-divergent',
        }),
      ),
    ).rejects.toBeInstanceOf(GmcLocalInventorySourceVersionConflictError)
  })

  it('marks only the currently claimed operation published or failed', async () => {
    const test = payloadDouble()
    const store = makeStore()
    const claim = makeClaim(test.payload)
    await store.claim(claim)
    await store.markFailed({
      error: { message: 'temporary', retryable: true },
      identity,
      operationId: 'not-current',
      payload: test.payload,
      storeCode: 'store-1',
    })
    await expect(
      store.get({ identity, payload: test.payload, storeCode: 'store-1' }),
    ).resolves.toMatchObject({ status: 'publish-pending' })

    await store.markPublished({ ...claim, publishedAt: '2026-08-30T12:01:00.000Z' })
    await expect(
      store.get({ identity, payload: test.payload, storeCode: 'store-1' }),
    ).resolves.toMatchObject({
      publishedDigest: 'a'.repeat(64),
      publishedVersion: '100',
      status: 'published',
    })
  })

  it('isolates state by store and by length-delimited identity namespace', async () => {
    const test = payloadDouble()
    const store = makeStore()
    await store.claim(makeClaim(test.payload))
    await store.claim(
      makeClaim(test.payload, {
        desiredDigest: 'b'.repeat(64),
        operationId: 'operation-store-2',
        storeCode: 'store-2',
      }),
    )

    expect(test.docs).toHaveLength(2)
    await expect(
      store.get({ identity, payload: test.payload, storeCode: 'store-2' }),
    ).resolves.toMatchObject({ desiredDigest: 'b'.repeat(64), storeCode: 'store-2' })
  })
})
