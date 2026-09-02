import type { Field } from 'payload'

import { describe, expect, test } from 'vitest'

import { mergeIntoRow } from '../rowPatch.js'

const isObjectId = (value: unknown): boolean =>
  typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)

describe('mergeIntoRow', () => {
  test('merges into a named group without dropping its untouched siblings', () => {
    const fields: Field[] = [
      {
        name: 'mc',
        type: 'group',
        fields: [
          { name: 'enabled', type: 'checkbox' },
          {
            name: 'syncMeta',
            type: 'group',
            fields: [
              { name: 'state', type: 'text' },
              { name: 'dirty', type: 'checkbox' },
            ],
          },
        ],
      },
    ]

    const merged = mergeIntoRow(
      { id: 1, mc: { enabled: true, syncMeta: { dirty: true, state: 'idle' } } },
      { mc: { syncMeta: { state: 'success' } } },
      fields,
    )

    expect(merged).toEqual({
      id: 1,
      mc: { enabled: true, syncMeta: { dirty: true, state: 'success' } },
    })
  })

  test('replaces a json field wholesale rather than merging stale keys into it', () => {
    const fields: Field[] = [{ name: 'snapshot', type: 'json' }]

    const merged = mergeIntoRow(
      { snapshot: { name: 'old', productAttributes: { gtin: '123', title: 'Old' } } },
      { snapshot: { name: 'new', productAttributes: { title: 'New' } } },
      fields,
    )

    expect(merged.snapshot).toEqual({
      name: 'new',
      productAttributes: { title: 'New' },
    })
  })

  test('replaces an array wholesale and assigns an id to every row that lacks one', () => {
    const fields: Field[] = [
      { name: 'tags', type: 'array', fields: [{ name: 'value', type: 'text' }] },
    ]

    const merged = mergeIntoRow(
      { tags: [{ id: 'existing', value: 'old' }] },
      { tags: [{ value: 'a' }, { value: 'b' }] },
      fields,
    )

    const tags = merged.tags as { id: unknown; value: string }[]
    expect(tags.map((row) => row.value)).toEqual(['a', 'b'])
    expect(tags.every((row) => isObjectId(row.id))).toBe(true)
    expect(tags[0].id).not.toBe(tags[1].id)
  })

  test('preserves ids already present on array rows', () => {
    const fields: Field[] = [
      { name: 'tags', type: 'array', fields: [{ name: 'value', type: 'text' }] },
    ]

    const merged = mergeIntoRow({}, { tags: [{ id: 'keep-me', value: 'a' }] }, fields)

    expect(merged.tags).toEqual([{ id: 'keep-me', value: 'a' }])
  })

  test('assigns ids to rows of arrays nested inside a group', () => {
    const fields: Field[] = [
      {
        name: 'mc',
        type: 'group',
        fields: [
          {
            name: 'attrs',
            type: 'group',
            fields: [
              { name: 'productTypes', type: 'array', fields: [{ name: 'value', type: 'text' }] },
            ],
          },
        ],
      },
    ]

    const merged = mergeIntoRow(
      {},
      { mc: { attrs: { productTypes: [{ value: 'Statues > Marble' }] } } },
      fields,
    )

    const rows = (merged.mc as { attrs: { productTypes: { id: unknown }[] } }).attrs.productTypes
    expect(isObjectId(rows[0].id)).toBe(true)
  })

  test('leaves row fields the patch does not mention untouched', () => {
    const fields: Field[] = [
      { name: 'title', type: 'text' },
      { name: 'gallery', type: 'array', fields: [{ name: 'caption', type: 'text' }] },
      { name: 'mc', type: 'group', fields: [{ name: 'enabled', type: 'checkbox' }] },
    ]

    const row = {
      id: 7,
      _status: 'published',
      gallery: [{ id: 'g1', caption: 'first' }],
      mc: { enabled: true },
      title: 'Live title',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    const merged = mergeIntoRow(row, { mc: { enabled: false } }, fields)

    expect(merged).toEqual({ ...row, mc: { enabled: false } })
  })

  test('descends through presentational and tab wrappers to reach named fields', () => {
    const fields: Field[] = [
      {
        type: 'tabs',
        tabs: [
          {
            fields: [
              {
                type: 'row',
                fields: [
                  { name: 'sku', type: 'text' },
                  {
                    type: 'collapsible',
                    fields: [
                      { name: 'links', type: 'array', fields: [{ name: 'url', type: 'text' }] },
                    ],
                    label: 'More',
                  },
                ],
              },
            ],
            label: 'Main',
          },
          {
            name: 'meta',
            fields: [{ name: 'blob', type: 'json' }],
          },
        ],
      },
    ]

    const merged = mergeIntoRow(
      { meta: { blob: { keep: false, stale: true } }, sku: 'A' },
      { links: [{ url: 'https://example.com' }], meta: { blob: { keep: true } } },
      fields,
    )

    expect(isObjectId((merged.links as { id: unknown }[])[0].id)).toBe(true)
    expect(merged.meta).toEqual({ blob: { keep: true } })
    expect(merged.sku).toBe('A')
  })

  test('assigns ids to block rows while preserving blockType', () => {
    const fields: Field[] = [
      {
        name: 'layout',
        type: 'blocks',
        blocks: [{ slug: 'hero', fields: [{ name: 'heading', type: 'text' }] }],
      },
    ]

    const merged = mergeIntoRow({}, { layout: [{ blockType: 'hero', heading: 'Hi' }] }, fields)

    const rows = merged.layout as { blockType: string; id: unknown }[]
    expect(rows[0].blockType).toBe('hero')
    expect(isObjectId(rows[0].id)).toBe(true)
  })

  test('passes through patch keys that match no configured field', () => {
    const merged = mergeIntoRow({ known: 1 }, { unknown: { nested: true } }, [
      { name: 'known', type: 'number' },
    ])

    expect(merged).toEqual({ known: 1, unknown: { nested: true } })
  })

  test('treats an explicit null as a value to write, not an absent key', () => {
    const fields: Field[] = [
      {
        name: 'mc',
        type: 'group',
        fields: [
          {
            name: 'syncMeta',
            type: 'group',
            fields: [{ name: 'lastError', type: 'text' }],
          },
        ],
      },
    ]

    const merged = mergeIntoRow(
      { mc: { syncMeta: { lastError: 'boom' } } },
      { mc: { syncMeta: { lastError: null } } },
      fields,
    )

    expect(merged).toEqual({ mc: { syncMeta: { lastError: null } } })
  })

  test('does not mutate the row it was given', () => {
    const fields: Field[] = [
      { name: 'mc', type: 'group', fields: [{ name: 'enabled', type: 'checkbox' }] },
    ]
    const row = { mc: { enabled: true } }

    mergeIntoRow(row, { mc: { enabled: false } }, fields)

    expect(row).toEqual({ mc: { enabled: true } })
  })
})
