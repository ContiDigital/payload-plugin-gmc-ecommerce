import type { Field } from 'payload'
import type { Mock } from 'vitest'

import { vi } from 'vitest'

import { MC_FIELD_GROUP_NAME, MC_PRODUCT_ATTRIBUTES_FIELD_NAME } from '../../../../constants.js'

// ---------------------------------------------------------------------------
// Payload double for the sync suites
// ---------------------------------------------------------------------------
//
// Bookkeeping is persisted through the database adapter, so a double has to
// carry two things `payload.update()` never needed: the collection's field
// config, because the merge is field-aware, and a live row for the merge to
// happen against. Assertions then read the row that was actually written,
// which is what the database would have ended up holding.

/** A products collection shaped like the one the plugin injects its group into. */
export const productFields: Field[] = [
  { name: 'title', type: 'text' },
  { name: 'gallery', type: 'array', fields: [{ name: 'caption', type: 'text' }] },
  {
    name: MC_FIELD_GROUP_NAME,
    type: 'group',
    fields: [
      { name: 'enabled', type: 'checkbox' },
      { name: 'snapshot', type: 'json' },
      {
        name: 'identity',
        type: 'group',
        fields: [
          { name: 'offerId', type: 'text' },
          { name: 'contentLanguage', type: 'text' },
          { name: 'feedLabel', type: 'text' },
        ],
      },
      {
        name: 'customAttributes',
        type: 'array',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'value', type: 'text' },
        ],
      },
      {
        name: MC_PRODUCT_ATTRIBUTES_FIELD_NAME,
        type: 'group',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'description', type: 'textarea' },
          { name: 'brand', type: 'text' },
          { name: 'googleProductCategory', type: 'text' },
          { name: 'productTypes', type: 'array', fields: [{ name: 'value', type: 'text' }] },
        ],
      },
      {
        name: 'syncMeta',
        type: 'group',
        fields: [
          { name: 'state', type: 'text' },
          { name: 'dirty', type: 'checkbox' },
          { name: 'lastAction', type: 'text' },
          { name: 'lastError', type: 'text' },
          { name: 'lastSyncedAt', type: 'text' },
          { name: 'syncSource', type: 'text' },
        ],
      },
    ],
  },
]

/** A published product row, as the adapter would hand it back. */
export const buildRow = (overrides?: Record<string, unknown>) => ({
  id: 'prod-1',
  _status: 'published',
  gallery: [{ id: 'g1', caption: 'first' }],
  [MC_FIELD_GROUP_NAME]: {
    enabled: true,
    identity: {},
    [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: { title: 'Live attr title' },
    syncMeta: { dirty: false, state: 'idle' },
  },
  title: 'Live title',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

/**
 * A minimal in-memory stand-in for the database adapter: what `updateOne`
 * writes is what the next `findOne` reads back. Sync state is written and then
 * re-read within a single push, so a double that served a fixed row would hide
 * every bug that depends on the two agreeing.
 *
 * `row: null` stands for a product deleted underneath the caller. Pass
 * `rowsById` when a test drives more than one product through the same double.
 */
export const buildPayloadDouble = (
  args: {
    doc?: Record<string, unknown>
    row?: null | Record<string, unknown>
    rowsById?: Record<string, Record<string, unknown>>
  } = {},
): {
  collections: { products: { config: { fields: Field[] } } }
  db: {
    beginTransaction: Mock
    commitTransaction: Mock
    findOne: Mock
    rollbackTransaction: Mock
    updateOne: Mock
  }
  findByID: Mock
  logger: { error: Mock; info: Mock; warn: Mock }
  update: Mock
} => {
  const seeded: Record<string, null | Record<string, unknown>> = args.rowsById ?? {
    'prod-1': args.row === undefined ? buildRow() : args.row,
  }
  const store = new Map(Object.entries(seeded))

  return {
    collections: { products: { config: { fields: productFields } } },
    db: {
      beginTransaction: vi.fn().mockResolvedValue('txn-1'),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      findOne: vi.fn().mockImplementation((query: { where?: { id?: { equals?: unknown } } }) =>
        Promise.resolve(store.get(String(query?.where?.id?.equals)) ?? null),
      ),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      updateOne: vi
        .fn()
        .mockImplementation((write: { data: Record<string, unknown>; id: unknown }) => {
          store.set(String(write.id), write.data)

          return Promise.resolve(write.data)
        }),
    },
      findByID: vi.fn().mockResolvedValue(
      args.doc ?? {
        id: 'prod-1',
        // The document a sync reads mirrors the seeded row: a double whose two
        // views disagreed would make every attribute look edited-since-read.
        [MC_FIELD_GROUP_NAME]: {
          [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: { title: 'Live attr title' },
        },
      },
    ),
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    update: vi.fn(),
  }
}

type Adapter = { db: { updateOne: { mock: { calls: unknown[][] } } } }

/**
 * A row as written to the database. Deliberately loose: assertions reach deep
 * into the plugin's nested groups, and threading `unknown` through every hop
 * would bury what each test is actually checking.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WrittenRow = Record<string, any>

/** The `data` of the nth adapter write (default: the last one). */
export const writtenRow = (payload: Adapter, index?: number): WrittenRow => {
  const { calls } = payload.db.updateOne.mock
  const call = calls[index ?? calls.length - 1]

  if (!call) {
    throw new Error('no adapter write was made')
  }

  return (call[0] as { data: WrittenRow }).data
}

/** What the nth adapter write left under the plugin's field group. */
export const writtenMC = (payload: Adapter, index?: number): WrittenRow =>
  writtenRow(payload, index)[MC_FIELD_GROUP_NAME]
