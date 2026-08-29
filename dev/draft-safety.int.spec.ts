/**
 * Regression harness for the 2026-08-28 unpublish incident.
 *
 * A draft save on a published product raced the plugin's onChange push. The
 * push's bookkeeping write went through `payload.db.updateOne` (which blew up
 * on the `mc.attrs.productTypes` array table) and then fell back to a plain
 * `payload.update`, which merged the pending draft onto the live row and
 * unpublished it.
 *
 * These tests run against a REAL drizzle (sqlite) adapter with drafts enabled
 * and a second, unrelated array field on the same collection.
 */
import type { Payload } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import fs from 'fs'
import path from 'path'
import { buildConfig, getPayload } from 'payload'
import { payloadGmcEcommerce } from 'payload-plugin-gmc-ecommerce'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MC_FIELD_GROUP_NAME } from '../src/constants.js'
import { hasPendingDraft, writeMCState } from '../src/server/sync/mcStateWriter.js'
import { testEmailAdapter } from './helpers/testEmailAdapter.js'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

let payload: Payload

const dbFile = path.resolve(
  dirname,
  '.tmp',
  `draft-safety-${process.env.VITEST_WORKER_ID ?? process.pid}.db`,
)

/** The exact shape that failed in production: an mc group carrying an array field. */
const buildMCState = (state: string) => ({
  [MC_FIELD_GROUP_NAME]: {
    attrs: {
      additionalImageLinks: [{ url: 'https://example.com/a.jpg' }],
      productTypes: [{ value: 'Statues > Marble' }, { value: 'Garden' }],
      title: 'Synced Title',
    },
    enabled: true,
    identity: { contentLanguage: 'en', feedLabel: 'PRODUCTS', offerId: 'SKU-1' },
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
  } as never)) as Record<string, any> | null

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
          // An unrelated array field on the same collection — the direct
          // adapter write used to truncate this.
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

describe('draft-safe MC state persistence (real sqlite adapter)', () => {
  test('persists the production data shape — arrays included — and leaves the product published', async () => {
    const id = await createPublishedProduct('SKU-OK', 'Published Statue')

    await expect(writeMCState(payload, 'products', String(id), buildMCState('success'))).resolves.toBe(
      true,
    )

    const live = await readLiveRow(id)
    expect(live?._status).toBe('published')
    expect(live?.title).toBe('Published Statue')
    // The exact array that threw `NOT NULL constraint failed: mc_product_types.id`
    expect(live?.[MC_FIELD_GROUP_NAME]?.attrs?.productTypes?.map((r: any) => r.value)).toEqual([
      'Statues > Marble',
      'Garden',
    ])
    expect(live?.[MC_FIELD_GROUP_NAME]?.attrs?.productTypes?.every((r: any) => Boolean(r.id))).toBe(
      true,
    )
    expect(live?.[MC_FIELD_GROUP_NAME]?.attrs?.additionalImageLinks?.[0]?.url).toBe(
      'https://example.com/a.jpg',
    )
    expect(live?.[MC_FIELD_GROUP_NAME]?.syncMeta?.state).toBe('success')
    // Unrelated array field on the same collection is untouched.
    expect(live?.gallery?.map((r: any) => r.caption)).toEqual(['g1', 'g2'])
  }, 120_000)

  test('REGRESSION: a pending draft is never merged onto the live row and never unpublishes it', async () => {
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

    await expect(hasPendingDraft(payload, 'products', String(id))).resolves.toBe(true)
    await expect(writeMCState(payload, 'products', String(id), buildMCState('success'))).resolves.toBe(
      false,
    )

    live = await readLiveRow(id)
    expect(live?._status).toBe('published')
    expect(live?.title).toBe('Live Statue')
    expect(live?.gallery?.map((r: any) => r.caption)).toEqual(['g1', 'g2'])

    // The draft timeline is untouched too — no bookkeeping version was appended.
    const versions = (await payload.db.findVersions({
      collection: 'products',
      limit: 10,
      pagination: false,
      sort: '-updatedAt',
      where: { parent: { equals: id } },
    } as never)) as { docs: any[] }
    expect(versions.docs[0].version._status).toBe('draft')
    expect(versions.docs[0].version.title).toBe('DRAFT EDIT — not for the live row')

    // And once the draft is published, the next sync persists normally.
    await payload.update({
      id,
      collection: 'products' as never,
      data: { _status: 'published' } as never,
    })
    await expect(hasPendingDraft(payload, 'products', String(id))).resolves.toBe(false)
    await expect(writeMCState(payload, 'products', String(id), buildMCState('success'))).resolves.toBe(
      true,
    )

    live = await readLiveRow(id)
    expect(live?._status).toBe('published')
    expect(live?.title).toBe('DRAFT EDIT — not for the live row')
    expect(live?.[MC_FIELD_GROUP_NAME]?.syncMeta?.state).toBe('success')
  }, 120_000)

  test('DOCUMENTS WHY the raw adapter path was removed: db.updateOne truncates array tables', async () => {
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
    expect(raised).toBeInstanceOf(Error)
    expect((raised as Error).message).toMatch(/mc_product_types\.id/)

    // 2. The delete-then-insert is not transactional here, and every array field
    //    of the collection is registered for deletion — including `gallery`,
    //    which was not part of the payload at all.
    const live = await readLiveRow(id)
    expect(live?.gallery).toEqual([])
  }, 120_000)
})
