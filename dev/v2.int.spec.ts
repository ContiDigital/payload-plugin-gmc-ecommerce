import type { Payload } from 'payload'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig, getPayload } from 'payload'
import {
  createGmcCommandExecutor,
  createPayloadLocalInventoryPublicationStateStore,
  createPayloadPublicationStateStore,
  type GmcAsyncAdapter,
  type GmcAsyncDispatchArgs,
  type GmcCommand,
  normalizeGmcV2Options,
  payloadGmcEcommerceV2,
  type PayloadGmcEcommerceV2Options,
} from 'payload-plugin-gmc-ecommerce/v2'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { testEmailAdapter } from './helpers/testEmailAdapter.js'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const databaseFile = path.resolve(dirname, '.tmp', `v2-${process.pid}.db`)
const databaseKind = process.env.GMC_V2_TEST_DATABASE ?? 'sqlite'

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required for the ${databaseKind} v2 integration test`)
  }
  return value
}

const databaseAdapter = () => {
  if (databaseKind === 'mongodb') {
    return mongooseAdapter({ url: requiredEnvironment('GMC_V2_MONGODB_URL') })
  }
  if (databaseKind === 'postgres') {
    return postgresAdapter({
      pool: { connectionString: requiredEnvironment('GMC_V2_POSTGRES_URL') },
      push: true,
    })
  }
  if (databaseKind !== 'sqlite') {
    throw new Error(`Unsupported GMC_V2_TEST_DATABASE: ${databaseKind}`)
  }
  return sqliteAdapter({
    client: { url: `file:${databaseFile}` },
    // Payload's SQLite adapter intentionally defaults transactions off. v2
    // automatic hooks require a real atomic canonical-write + outbox boundary.
    transactionOptions: {},
  })
}

let payload: Payload
let options: PayloadGmcEcommerceV2Options
const dispatched: GmcAsyncDispatchArgs[] = []

const asyncAdapter: GmcAsyncAdapter = {
  name: 'sqlite-integration-outbox',
  dispatch: vi.fn((args) => {
    dispatched.push(args)
    return Promise.resolve({
      operationId: `operation-${dispatched.length}`,
      state: 'queued' as const,
    })
  }),
  getOperation: () => Promise.resolve(null),
  health: () =>
    Promise.resolve({
      checkedAt: '2026-08-29T12:00:00.000Z',
      status: 'ok',
    }),
}

beforeAll(async () => {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true })
  fs.rmSync(databaseFile, { force: true })

  options = {
    access: () => true,
    async: asyncAdapter,
    dataSourceId: '987654321',
    feeds: [
      {
        id: 'primary',
        access: 'public',
        delivery: 'dynamic',
        path: '/feeds/google.tsv',
        selector: { contentLanguage: 'en', feedLabel: 'US' },
      },
    ],
    getCredentials: () =>
      Promise.resolve({
        type: 'json',
        credentials: { client_email: 'merchant@example.test', private_key: 'not-used' },
      }),
    localInventory: {
      project: ({ doc, storeCode }) => [
        {
          identity: {
            contentLanguage: 'en',
            feedLabel: 'US',
            offerId: String(doc.sku),
          },
          inventory: {
            localInventoryAttributes: { availability: 'IN_STOCK', quantity: '1' },
            storeCode,
          },
          storeCode,
        },
      ],
      storeCodes: ['store-1'],
    },
    merchantId: '123456',
    products: {
      batchSize: 2,
      collection: 'products',
      fetchDepth: 0,
      project: ({ doc }) => ({
        products: [
          {
            contentLanguage: 'en',
            feedLabel: 'US',
            offerId: String(doc.sku),
            productAttributes: {
              availability: 'IN_STOCK',
              description: String(doc.description),
              imageLink: String(doc.imageUrl),
              link: `https://example.test/products/${String(doc.sku)}`,
              price: { amountMicros: String(doc.priceMicros), currencyCode: 'USD' },
              title: String(doc.title),
            },
          },
        ],
        sourceVersion: String(doc.sourceVersion),
      }),
      resolveIdentities: ({ doc }) => [
        {
          contentLanguage: 'en',
          feedLabel: 'US',
          offerId: String(doc.sku),
        },
      ],
    },
    // This suite writes with `disableTransaction: true` to exercise the
    // fail-closed path; requireTransaction must be opted in explicitly for
    // that assertion to keep its meaning now that ambient transactions are
    // opt-in by default.
    requireTransaction: true,
  }

  const config = await buildConfig({
    collections: [
      {
        slug: 'products',
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'description', type: 'textarea', required: true },
          { name: 'sku', type: 'text', required: true, unique: true },
          { name: 'imageUrl', type: 'text', required: true },
          { name: 'priceMicros', type: 'text', required: true },
          { name: 'sourceVersion', type: 'number', required: true },
        ],
        versions: { drafts: true },
      },
    ],
    db: databaseAdapter(),
    email: testEmailAdapter,
    plugins: [payloadGmcEcommerceV2(options)],
    secret: 'gmc-v2-integration-secret-123456789',
    typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  })

  payload = await getPayload({ config })
  if (databaseKind === 'mongodb') {
    // MongoDB cannot commit a transaction while a lazily initialized model is
    // concurrently changing the collection catalog. Materialize every Payload
    // model and its indexes before the first transactional test write.
    const models = Object.values(
      (payload.db as unknown as { collections: Record<string, { init: () => Promise<unknown> }> })
        .collections,
    )
    await Promise.all(models.map((model) => model.init()))
  }
}, 120_000)

afterAll(async () => {
  if (typeof payload?.db?.destroy === 'function') {
    await payload.db.destroy()
  }
  fs.rmSync(databaseFile, { force: true })
})

describe(`GMC v2 against the real Payload ${databaseKind} adapter`, () => {
  it('installs isolated non-versioned publication state without mutating Product fields', () => {
    expect(payload.collections['gmc-publications-v2']).toBeDefined()
    expect(payload.collections['gmc-local-inventory-publications-v2']).toBeDefined()
    const products = payload.config.collections.find((collection) => collection.slug === 'products')
    expect(products?.fields.map((field) => ('name' in field ? field.name : undefined))).toEqual([
      'title',
      'description',
      'sku',
      'imageUrl',
      'priceMicros',
      'sourceVersion',
      'updatedAt',
      'createdAt',
      '_status',
    ])
    const state = payload.config.collections.find(
      (collection) => collection.slug === 'gmc-publications-v2',
    )
    expect(state?.versions).toBeFalsy()
    const localState = payload.config.collections.find(
      (collection) => collection.slug === 'gmc-local-inventory-publications-v2',
    )
    expect(localState?.versions).toBeFalsy()
  })

  it('rejects non-transactional writes before the canonical row can commit', async () => {
    await expect(
      payload.create({
        collection: 'products',
        data: {
          _status: 'published',
          description: 'must not commit',
          imageUrl: 'https://example.test/non-transactional.jpg',
          priceMicros: '1000000',
          sku: 'NO-TRANSACTION-CREATE',
          sourceVersion: 1,
          title: 'Must not commit',
        },
        disableTransaction: true,
      }),
    ).rejects.toMatchObject({ code: 'GMC_TRANSACTION_REQUIRED' })

    const absent = await payload.find({
      collection: 'products',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { sku: { equals: 'NO-TRANSACTION-CREATE' } },
    })
    expect(absent.docs).toHaveLength(0)

    const deletable = await payload.create({
      collection: 'products',
      data: {
        _status: 'published',
        description: 'must survive rejected delete',
        imageUrl: 'https://example.test/non-transactional-delete.jpg',
        priceMicros: '1000000',
        sku: 'NO-TRANSACTION-DELETE',
        sourceVersion: 2,
        title: 'Must survive rejected delete',
      },
    })
    await expect(
      payload.delete({
        collection: 'products',
        disableTransaction: true,
        id: deletable.id,
      }),
    ).rejects.toMatchObject({ code: 'GMC_TRANSACTION_REQUIRED' })
    await expect(
      payload.findByID({ collection: 'products', id: deletable.id, overrideAccess: true }),
    ).resolves.toMatchObject({ id: deletable.id })
  })

  it('persists claims, deletion fences, exact redelivery, and ownership protection', async () => {
    const store = createPayloadPublicationStateStore({
      collectionSlug: 'gmc-publications-v2',
      dataSourceName: 'accounts/123456/dataSources/987654321',
      merchantId: '123456',
    })
    const identity = { contentLanguage: 'en', feedLabel: 'US', offerId: 'STATE-1' }
    const claim = {
      desiredAt: '2026-08-29T12:00:00.000Z',
      desiredDigest: 'digest-1',
      desiredVersion: '1',
      identity,
      operationId: 'state-operation-1',
      payload,
      productId: 'product-1',
    }

    expect((await store.claimPublication(claim)).status).toBe('publish-pending')
    await store.markPublished({ ...claim, publishedAt: '2026-08-29T12:00:00.000Z' })
    expect(await store.claimPublication(claim)).toMatchObject({
      publishedDigest: 'digest-1',
      publishedVersion: '1',
      status: 'published',
    })
    await expect(
      store.claimPublication({
        ...claim,
        operationId: 'state-operation-2',
        productId: 'product-2',
      }),
    ).rejects.toThrow(/already owned by product product-1/i)

    await store.markDeletePending({
      deleteVersion: '2',
      identity,
      operationId: 'state-delete-2',
      payload,
      productId: 'product-1',
    })
    await expect(
      store.markDeleted({
        identity,
        operationId: 'state-delete-2',
        payload,
        productId: 'product-1',
      }),
    ).resolves.toMatchObject({ deleteVersion: '2', status: 'deleted' })
    await expect(
      store.markDeletePending({
        deleteVersion: '4',
        identity,
        operationId: 'state-delete-4',
        payload,
        productId: 'product-1',
      }),
    ).resolves.toMatchObject({ deleteVersion: '4', status: 'deleted' })
    await expect(
      store.claimPublication({
        ...claim,
        desiredDigest: 'stale-digest',
        desiredVersion: '3',
        operationId: 'state-stale-publish-3',
      }),
    ).resolves.toMatchObject({ deleteVersion: '4', status: 'deleted' })
    await expect(
      store.claimPublication({
        ...claim,
        desiredDigest: 'digest-5',
        desiredVersion: '5',
        operationId: 'state-publish-5',
      }),
    ).resolves.toMatchObject({ desiredVersion: '5', status: 'publish-pending' })
  })

  it('atomically resolves two workers that read the same publication revision', async () => {
    const store = createPayloadPublicationStateStore({
      collectionSlug: 'gmc-publications-v2',
      dataSourceName: 'accounts/123456/dataSources/987654321',
      merchantId: '123456',
    })
    const identity = { contentLanguage: 'en', feedLabel: 'US', offerId: 'STATE-RACE-1' }
    const baseClaim = {
      desiredAt: '2026-08-29T12:00:00.000Z',
      desiredDigest: 'digest-1',
      desiredVersion: '1',
      identity,
      operationId: 'race-operation-1',
      payload,
      productId: 'race-product-1',
    }
    await store.claimPublication(baseClaim)

    let releaseReads: (() => void) | undefined
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    let synchronizedReads = 0
    const racingPayload = new Proxy(payload, {
      get: (target, property, receiver) => {
        if (property !== 'find') {
          return Reflect.get(target, property, receiver) as unknown
        }
        return async (...args: Parameters<Payload['find']>) => {
          const result = await target.find(...args)
          if (args[0].collection === 'gmc-publications-v2' && synchronizedReads < 2) {
            synchronizedReads++
            if (synchronizedReads === 2) {
              releaseReads?.()
            }
            await readsReleased
          }
          return result
        }
      },
    })

    await Promise.all([
      store.claimPublication({
        ...baseClaim,
        desiredAt: '2026-08-29T12:01:00.000Z',
        desiredDigest: 'digest-2',
        desiredVersion: '2',
        operationId: 'race-operation-2',
        payload: racingPayload,
      }),
      store.claimPublication({
        ...baseClaim,
        desiredAt: '2026-08-29T12:02:00.000Z',
        desiredDigest: 'digest-3',
        desiredVersion: '3',
        operationId: 'race-operation-3',
        payload: racingPayload,
      }),
    ])

    await expect(store.get({ identity, payload })).resolves.toMatchObject({
      desiredDigest: 'digest-3',
      desiredVersion: '3',
      operationId: 'race-operation-3',
      status: 'publish-pending',
    })
  })

  it('durably fences stale and divergent local-inventory snapshots', async () => {
    const store = createPayloadLocalInventoryPublicationStateStore({
      collectionSlug: 'gmc-local-inventory-publications-v2',
      dataSourceName: 'accounts/123456/dataSources/987654321',
      merchantId: '123456',
    })
    const identity = { contentLanguage: 'en', feedLabel: 'US', offerId: 'LOCAL-STATE-1' }
    const claim = {
      desiredAt: '2026-08-29T12:00:00.000Z',
      desiredDigest: 'a'.repeat(64),
      desiredVersion: '100',
      identity,
      operationId: 'local-operation-100',
      payload,
      productId: 'product-1',
      storeCode: 'store-1',
    }

    await expect(store.claim(claim)).resolves.toMatchObject({
      desiredVersion: '100',
      status: 'publish-pending',
    })
    await store.markPublished({ ...claim, publishedAt: '2026-08-29T12:01:00.000Z' })
    await expect(
      store.claim({
        ...claim,
        desiredAt: '2026-08-29T12:02:00.000Z',
        desiredDigest: 'b'.repeat(64),
        desiredVersion: '101',
        operationId: 'local-operation-101',
      }),
    ).resolves.toMatchObject({ desiredVersion: '101', status: 'publish-pending' })
    await expect(
      store.claim({
        ...claim,
        desiredDigest: 'stale',
        desiredVersion: '99',
        operationId: 'local-operation-99',
      }),
    ).resolves.toMatchObject({ desiredDigest: 'b'.repeat(64), desiredVersion: '101' })
    await expect(
      store.claim({
        ...claim,
        desiredDigest: 'divergent',
        desiredVersion: '101',
        operationId: 'local-operation-divergent',
      }),
    ).rejects.toMatchObject({ code: 'GMC_LOCAL_INVENTORY_SOURCE_VERSION_CONFLICT' })
  })

  it('never projects pending draft content when a durable command executes', async () => {
    dispatched.length = 0
    const created = await payload.create({
      collection: 'products',
      data: {
        _status: 'published',
        description: 'live description',
        imageUrl: 'https://example.test/live.jpg',
        priceMicros: '1000000',
        sku: 'DRAFT-SAFE-1',
        sourceVersion: 1,
        title: 'Live title',
      },
    })
    dispatched.length = 0

    await payload.update({
      id: created.id,
      collection: 'products',
      data: { sourceVersion: 2, title: 'Unpublished draft title' },
      draft: true,
    })
    const coordinator = dispatched.at(-1)
    expect(coordinator?.command.type).toBe('product.publish')
    expect(coordinator?.req).toBeDefined()

    dispatched.length = 0
    const execute = createGmcCommandExecutor(normalizeGmcV2Options(options), {
      transport: {} as never,
    })
    await execute({
      command: coordinator!.command,
      operationId: 'execute-draft-safe-1',
      payload,
      sourceVersion: '1000000',
    })

    const offer = dispatched.find((entry) => entry.command.type === 'offer.publish')
    expect(offer?.command).toMatchObject({
      type: 'offer.publish',
      input: { productAttributes: { title: 'Live title' } },
      sourceVersion: '1000000',
    })
  })

  it('treats a draft-only product as absent when its durable command executes', async () => {
    dispatched.length = 0
    await payload.create({
      collection: 'products',
      data: {
        _status: 'draft',
        description: 'draft-only description',
        imageUrl: 'https://example.test/draft-only.jpg',
        priceMicros: '1000000',
        sku: 'DRAFT-ONLY-1',
        sourceVersion: 1,
        title: 'Draft-only title',
      },
      draft: true,
    })
    const coordinator = dispatched.at(-1)
    expect(coordinator?.command.type).toBe('product.publish')

    dispatched.length = 0
    const execute = createGmcCommandExecutor(normalizeGmcV2Options(options), {
      transport: {} as never,
    })
    await execute({
      command: coordinator!.command,
      operationId: 'execute-draft-only-1',
      payload,
      sourceVersion: '1000001',
    })

    expect(dispatched.map((entry) => entry.command)).toEqual([])
  })

  it('turns unpublish into deletion of the previously owned identity', async () => {
    dispatched.length = 0
    const created = await payload.create({
      collection: 'products',
      data: {
        _status: 'published',
        description: 'published description',
        imageUrl: 'https://example.test/unpublish.jpg',
        priceMicros: '1000000',
        sku: 'UNPUBLISH-1',
        sourceVersion: 1,
        title: 'Published title',
      },
    })
    dispatched.length = 0

    await payload.update({
      id: created.id,
      collection: 'products',
      data: { _status: 'draft' },
      unpublishAllLocales: true,
    })
    const coordinator = dispatched.at(-1)
    expect(coordinator?.command).toMatchObject({
      type: 'product.publish',
      previousIdentities: [{ contentLanguage: 'en', feedLabel: 'US', offerId: 'UNPUBLISH-1' }],
    })

    dispatched.length = 0
    const execute = createGmcCommandExecutor(normalizeGmcV2Options(options), {
      transport: {} as never,
    })
    await execute({
      command: coordinator!.command,
      operationId: 'execute-unpublish-1',
      payload,
      sourceVersion: '1000002',
    })

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.command).toMatchObject({
      type: 'offer.delete',
      expectedProductId: created.id,
      identity: { contentLanguage: 'en', feedLabel: 'US', offerId: 'UNPUBLISH-1' },
    })
  })

  it('cursor-paginates every published product exactly once', async () => {
    for (let index = 0; index < 5; index++) {
      await payload.create({
        collection: 'products',
        data: {
          _status: 'published',
          description: `description ${index}`,
          imageUrl: `https://example.test/${index}.jpg`,
          priceMicros: '1000000',
          sku: `PAGE-${index}`,
          sourceVersion: index + 10,
          title: `Product ${index}`,
        },
      })
    }
    const expected = await payload.find({
      collection: 'products',
      depth: 0,
      draft: false,
      limit: 100,
      overrideAccess: true,
      pagination: false,
      select: { id: true },
    })
    const expectedIds = new Set(expected.docs.map((doc) => String(doc.id)))
    const observedIds = new Set<string>()
    const execute = createGmcCommandExecutor(normalizeGmcV2Options(options), {
      transport: {} as never,
    })
    const pending: GmcCommand[] = [
      {
        type: 'catalog.publish',
        cause: 'manual',
        requestedAt: '2026-08-29T12:00:00.000Z',
        schemaVersion: 2,
      },
    ]
    let operation = 0

    while (pending.length > 0) {
      const command = pending.shift()!
      dispatched.length = 0
      await execute({
        command,
        operationId: `page-${++operation}`,
        payload,
        sourceVersion: String(2_000_000 + operation),
      })
      for (const entry of dispatched) {
        if (entry.command.type === 'product.publish') {
          observedIds.add(String(entry.command.productId))
        } else if (entry.command.type === 'catalog.publish') {
          pending.push(entry.command)
        }
      }
    }

    expect(observedIds).toEqual(expectedIds)
  })
})
