import type { Field } from 'payload'

import { randomBytes } from 'crypto'

// ---------------------------------------------------------------------------
// Field-aware merge of a plugin patch into a raw collection row
// ---------------------------------------------------------------------------
//
// `writeMCState` persists bookkeeping by reading the live row, merging its
// patch into it, and writing the whole row back through the database adapter.
// The adapter replaces the row wholesale, so the merged object has to be a
// faithful, complete document — which means the merge has to know what each
// key actually *is*:
//
//   * groups and named tabs are containers -> recurse, so a patch that touches
//     `mc.syncMeta.state` cannot drop `mc.enabled`.
//   * `json` fields are opaque values -> replace wholesale. Merging them would
//     leave keys from a previous Merchant Center snapshot fused into the new
//     one.
//   * arrays and blocks are value lists -> replace wholesale, never merged
//     element-wise. Their rows need an `id`: Payload normally fills that in
//     via the `baseIDField` beforeChange hook, which the adapter path skips,
//     and the column is a NOT NULL primary key.
//
// Rows that already carry an `id` keep it, so untouched arrays round-trip
// through a read/write cycle unchanged.

/** Matches the shape Payload's `baseIDField` generates (a 24-char hex ObjectId). */
const newArrayRowId = (): string => randomBytes(12).toString('hex')

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Presentational fields (`row`, `collapsible`) and unnamed tabs hold their
 * children at the parent's level, so their children are indexed as if they
 * were declared inline.
 */
const indexFieldsByName = (fields: Field[]): Map<string, Field> => {
  const index = new Map<string, Field>()

  const visit = (candidates: Field[]): void => {
    for (const field of candidates) {
      if (field.type === 'tabs') {
        for (const tab of field.tabs) {
          if ('name' in tab && tab.name) {
            // A named tab behaves exactly like a group.
            index.set(tab.name, { ...tab, type: 'group' } as Field)
          } else {
            visit(tab.fields)
          }
        }
        continue
      }

      if (field.type === 'row' || field.type === 'collapsible') {
        visit(field.fields)
        continue
      }

      if ('name' in field && field.name) {
        index.set(field.name, field)
      }
    }
  }

  visit(fields)

  return index
}

const withRowIds = (rows: unknown[]): unknown[] =>
  rows.map((row) => {
    if (!isPlainObject(row)) {
      return row
    }

    return row.id === undefined || row.id === null ? { ...row, id: newArrayRowId() } : row
  })

/**
 * Merge `patch` into `row` under the guidance of `fields`.
 *
 * Keys absent from the patch are left exactly as the row had them; `undefined`
 * in the patch means "not supplied", while `null` is a value that gets written.
 * Neither argument is mutated.
 */
export const mergeIntoRow = (
  row: Record<string, unknown>,
  patch: Record<string, unknown>,
  fields: Field[],
): Record<string, unknown> => {
  const index = indexFieldsByName(fields)
  const merged: Record<string, unknown> = { ...row }

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue
    }

    const field = index.get(key)

    if (field && (field.type === 'array' || field.type === 'blocks') && Array.isArray(value)) {
      merged[key] = withRowIds(value)
      continue
    }

    if (field?.type === 'group' && isPlainObject(value)) {
      const existing = isPlainObject(merged[key]) ? merged[key] : {}
      merged[key] = mergeIntoRow(existing, value, field.fields)
      continue
    }

    merged[key] = value
  }

  return merged
}
