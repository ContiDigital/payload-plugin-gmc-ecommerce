/**
 * Regression harness for the 2026-08-28 unpublish incident.
 *
 * A draft save on a published product raced the plugin's onChange push, and the
 * push's bookkeeping write went through `payload.update()`, which merged the
 * pending draft onto the live row and unpublished it.
 *
 * `writeMCState` now writes the live row through the adapter instead, so it
 * touches neither the version timeline nor the document's editorial identity.
 * These tests hold that contract against a REAL drizzle (sqlite) adapter with
 * drafts enabled and a second, unrelated array field on the same collection.
 */
import type { Payload } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import fs from 'fs'
import path from 'path'
import { buildConfig, getPayload } from 'payload'
import { payloadGmcEcommerce } from 'payload-plugin-gmc-ecommerce/legacy'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MC_FIELD_GROUP_NAME } from '../src/constants.js'
import { writeMCState } from '../src/server/sync/mcStateWriter.js'
import { testEmailAdapter } from './helpers/testEmailAdapter.js'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

let payload: Payload

const dbFile = path.resolve(
  dirname,
  '.tmp',
  `draft-safety-${process.pid}.db`,
)

/** The exact shape that failed in production: an mc group carrying array fields. */
const buildMCState = (state: string) => ({
  [MC_FIELD_GROUP_NAME]: {
    attrs: {
      additionalImageLinks: [{ url: 'https://example.com/a.jpg' }],
      productTypes: [{ value: 'Statues > Marble' }, { value: 'Garden' }],
      title: 'Synced Title',
    },
    snapshot: { name: 'accounts/1/products/en~PRODUCTS~SKU-1' },
    syncMeta: {
      dirty: false,
      lastAction: 'saveSync',
      lastError: null,
      lastSyncedAt: new Date().toISOString(),
      state,
      syncSource: 'push',
    },
  },
})

const readLiveRow = async (id: number | string) =>
  (await payload.db.findOne({
    collection: 'products',
    where: { id: { equals: id } },
  } as never)) as null | Record<string, any>

const readVersions = async (id: number | string) =>
  (
    (await payload.db.findVersions({
      collection: 'products',
      limit: 50,
      pagination: false,
      sort: '-updatedAt',
      where: { parent: { equals: id } },
    } as never)) as { docs: any[] }
  ).docs

beforeAll(async () => {
  fs.mkdirSync(path.resolve(dirname, '.tmp'), { recursive: true })
  fs.rmSync(dbFile, { force: true })

  const config = await buildConfig({
    admin: { importMap: { baseDir: path.resolve(dirname) } },
    collections: [
      {
        slug: 'products',
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'sku', type: 'text', required: true },
          // An unrelated array field on the same collection — a partial
          // adapter write truncates this.
          { name: 'gallery', type: 'array', fields: [{ name: 'caption', type: 'text' }] },
        ],
        versions: { drafts: true },
      },
      {
        slug: 'categories',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'googleCategoryId', type: 'text' },
        ],
      },
    ],
    db: sqliteAdapter({ client: { url: `file:${dbFile}` } }),
    email: testEmailAdapter,
    plugins: [
      payloadGmcEcommerce({
        access: () => true,
        collections: {
          categories: {
            googleCategoryIdField: 'googleCategoryId',
            nameField: 'name',
            slug: 'categories',
          },
          products: { fieldMappings: [], identityField: 'sku', slug: 'products' },
        },
        dataSourceId: 'ds',
        defaults: { contentLanguage: 'en', currency: 'USD', feedLabel: 'PRODUCTS' },
        getCredentials: async () => ({
          credentials: { client_email: 'a@b.c', private_key: 'k' },
          type: 'json',
        }),
        merchantId: 'm',
        sync: { mode: 'manual', permanentSync: true },
      }),
    ],
    secret: 'gmc-draft-safety-secret-key-123456',
    typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  })

  payload = await getPayload({ config })
}, 120_000)

afterAll(async () => {
  if (typeof payload?.db?.destroy === 'function') {
    await payload.db.destroy()
  }
  fs.rmSync(dbFile, { force: true })
})

const createPublishedProduct = async (sku: string, title: string) => {
  const created = (await payload.create({
    collection: 'products' as never,
    data: {
      _status: 'published',
      gallery: [{ caption: 'g1' }, { caption: 'g2' }],
      mc: { enabled: true, identity: { offerId: sku } },
      sku,
      title,
    } as never,
  })) as Record<string, any>

  return created.id as number | string
}

describe('MC state persistence against a real sqlite adapter', () => {
  test('persists the production data shape — arrays included — and leaves the product published', async () => {
    const id = await createPublishedProduct('SKU-OK', 'Published Statue')

    await expect(
      writeMCState(payload, 'products', String(id), buildMCState('success')),
    ).resolves.toBe(true)

    const live = await readLiveRow(id)
    expect(live?._status).toBe('published')
    expect(live?.title).toBe('Published Statue')
    // The exact array that threw `NOT NULL constraint failed: mc_product_types.id`.
    expect(live?.[MC_FIELD_GROUP_NAME]?.attrs?.productTypes?.map((r: any) => r.value)).toEqual([
      'Statues > Marble',
      'Garden',
    ])
    expect(live?.[MC_FIELD_GROUP_NAME]?.attrs?.additionalImageLinks?.[0]?.url).toBe(
      'https://example.com/a.jpg',
    )
    expect(live?.[MC_FIELD_GROUP_NAME]?.syncMeta?.state).toBe('success')
    // Unrelated array field on the same collection is untouched.
    expect(live?.gallery?.map((r: any) => r.caption)).toEqual(['g1', 'g2'])
  }, 120_000)

  test('appends no version row and changes no editorial field', async () => {
    const id = await createPublishedProduct('SKU-TIMELINE', 'Timeline Statue')

    const before = await readLiveRow(id)
    const versionsBefore = await readVersions(id)

    await expect(
      writeMCState(payload, 'products', String(id), buildMCState('success')),
    ).resolves.toBe(true)

    const after = await readLiveRow(id)
    const versionsAfter = await readVersions(id)

    expect(versionsAfter).toHaveLength(versionsBefore.length)
    expect(after?._status).toBe(before?._status)
    expect(after?.title).toBe(before?.title)
    expect(after?.sku).toBe(before?.sku)
    expect(after?.createdAt).toBe(before?.createdAt)
    expect(after?.gallery).toEqual(before?.gallery)
    expect(after?.[MC_FIELD_GROUP_NAME]?.syncMeta?.state).toBe('success')
  }, 120_000)

  test('DOCUMENTS A REMAINING COST: `updatedAt` still moves, because the adapter forces it', async () => {
    // `@payloadcms/drizzle/dist/transform/write/traverseFields.js:384` stamps
    // `updatedAt` with `new Date()` on every write, whatever the caller passes.
    // No write to the product row can avoid it, so bookkeeping cannot be made
    // invisible to `updatedAt` while it lives on the product document at all.
    // Eliminating this means moving sync state onto its own collection.
    const id = await createPublishedProduct('SKU-TOUCHED', 'Touched Statue')

    const before = await readLiveRow(id)
    await writeMCState(payload, 'products', String(id), buildMCState('success'))
    const after = await readLiveRow(id)

    expect(Date.parse(after!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before!.updatedAt))
  }, 120_000)

  test('REGRESSION: a pending draft keeps its content, its `latest` flag, and never reaches the live row', async () => {
    const id = await createPublishedProduct('SKU-DRAFT', 'Live Statue')

    await payload.update({
      id,
      collection: 'products' as never,
      data: { title: 'DRAFT EDIT — not for the live row' } as never,
      draft: true,
    })

    // Sanity: the draft save itself left the live row alone.
    let live = await readLiveRow(id)
    expect(live?._status).toBe('published')
    expect(live?.title).toBe('Live Statue')

    const versionsBefore = await readVersions(id)

    // The bookkeeping write now succeeds instead of being skipped.
    await expect(
      writeMCState(payload, 'products', String(id), buildMCState('success')),
    ).resolves.toBe(true)

    live = await readLiveRow(id)
    expect(live?._status).toBe('published')
    expect(live?.title).toBe('Live Statue')
    expect(live?.gallery?.map((r: any) => r.caption)).toEqual(['g1', 'g2'])
    expect(live?.[MC_FIELD_GROUP_NAME]?.syncMeta?.state).toBe('success')

    // The editor's pending draft is exactly where they left it: same content,
    // same count, and still the version the admin edit view will load.
    const versionsAfter = await readVersions(id)
    expect(versionsAfter).toHaveLength(versionsBefore.length)
    expect(versionsAfter[0].version._status).toBe('draft')
    expect(versionsAfter[0].version.title).toBe('DRAFT EDIT — not for the live row')
    expect(versionsAfter[0].latest).toBe(true)

    // And publishing the draft afterwards still works normally.
    await payload.update({
      id,
      collection: 'products' as never,
      data: { _status: 'published' } as never,
    })

    live = await readLiveRow(id)
    expect(live?._status).toBe('published')
    expect(live?.title).toBe('DRAFT EDIT — not for the live row')
  }, 120_000)

  test('reports a skipped write for a product that has been deleted', async () => {
    const id = await createPublishedProduct('SKU-GONE', 'Doomed Statue')
    await payload.delete({ id, collection: 'products' as never })

    await expect(
      writeMCState(payload, 'products', String(id), buildMCState('success')),
    ).resolves.toBe(false)
  }, 120_000)

  test('a failed write rolls back instead of leaving array tables emptied', async () => {
    // `upsertRow` empties and re-inserts every array table of the collection
    // before the main row settles. Untransacted, a failure part-way through
    // leaves unrelated arrays destroyed — which is exactly what the partial
    // adapter write below demonstrates.
    const id = await createPublishedProduct('SKU-ROLLBACK', 'Rollback Statue')

    await expect(
      writeMCState(payload, 'products', String(id), {
        [MC_FIELD_GROUP_NAME]: {
          attrs: {
            // Two rows claiming the same primary key: the insert fails after
            // every array table of the collection has already been emptied.
            productTypes: [
              { id: 'duplicate-row-id', value: 'Statues' },
              { id: 'duplicate-row-id', value: 'Garden' },
            ],
          },
        },
      }),
    ).rejects.toThrow()

    const live = await readLiveRow(id)
    expect(live?.title).toBe('Rollback Statue')
    expect(live?.gallery?.map((r: any) => r.caption)).toEqual(['g1', 'g2'])
    expect(live?._status).toBe('published')
  }, 120_000)

  test('DOCUMENTS WHY the merge is field-aware: a partial adapter write truncates array tables', async () => {
    const id = await createPublishedProduct('SKU-RAW', 'Raw Adapter Probe')

    let raised: unknown
    try {
      await (payload.db as any).updateOne({
        collection: 'products',
        data: {
          [MC_FIELD_GROUP_NAME]: { attrs: { productTypes: [{ value: 'Statues > Marble' }] } },
          updatedAt: null,
        },
        options: { upsert: false },
        select: { id: true },
        where: { id: { equals: id } },
      })
    } catch (error) {
      raised = error
    }

    // 1. Array rows arrive without the id that `baseIDField`'s beforeChange hook
    //    would have generated, so the insert violates the PK's NOT NULL.
    //    `mergeIntoRow` supplies those ids.
    expect(raised).toBeInstanceOf(Error)
    expect((raised as Error).message).toMatch(/mc_product_types.*null/s)

    // 2. The delete-then-insert is not transactional here, and every array field
    //    of the collection is registered for deletion — including `gallery`,
    //    which was not part of the payload at all. `mergeIntoRow` carries every
    //    array across from the live row, which is what keeps this from
    //    happening on the real write path (asserted above).
    const live = await readLiveRow(id)
    expect(live?.gallery).toEqual([])
  }, 120_000)
})
