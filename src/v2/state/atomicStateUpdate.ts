import type { Payload } from 'payload'

/**
 * Payload's Drizzle adapters derive a table name with the `to-snake-case`
 * package (`create.js`: `this.tableNameMap.get(toSnakeCase(collection.slug))`).
 * That package is a transitive dependency of the adapters, not of this plugin,
 * so its algorithm is reproduced here rather than imported.
 */
const HAS_SPACE = /\s/
const HAS_SEPARATOR = /[-.:_]/
const HAS_CAMEL = /[a-z][A-Z]|[A-Z][a-z]/
const SEPARATOR_SPLITTER = /[\W_]+(.|$)/g
const CAMEL_SPLITTER = /(.)([A-Z]+)/g

const unseparate = (value: string): string =>
  value.replace(SEPARATOR_SPLITTER, (_match, next: string) => (next ? ` ${next}` : ''))

const uncamelize = (value: string): string =>
  value.replace(
    CAMEL_SPLITTER,
    (_match, previous: string, uppers: string) =>
      `${previous} ${uppers.toLowerCase().split('').join(' ')}`,
  )

const toNoCase = (value: string): string => {
  if (HAS_SPACE.test(value)) {
    return value.toLowerCase()
  }
  if (HAS_SEPARATOR.test(value)) {
    return (unseparate(value) || value).toLowerCase()
  }
  if (HAS_CAMEL.test(value)) {
    return uncamelize(value).toLowerCase()
  }
  return value.toLowerCase()
}

const WHITESPACE = /\s/g

const toSpaceCase = (value: string): string => unseparate(toNoCase(value)).trim()

export const toSnakeCase = (value: string): string => toSpaceCase(value).replace(WHITESPACE, '_')

export type AtomicStateRow = {
  id: number | string
  revision: number
}

type DrizzleUpdateBuilder = {
  set: (values: Record<string, unknown>) => {
    where: (condition: unknown) => {
      returning: (fields: Record<string, unknown>) => PromiseLike<unknown[]>
    }
  }
}

type DatabaseAdapterShape = {
  drizzle?: {
    update: (table: unknown) => DrizzleUpdateBuilder
  }
  name?: string
  /**
   * `DrizzleAdapter.operators` (`@payloadcms/drizzle` `types.d.ts`) exposes the
   * adapter's own `drizzle-orm` comparison builders. Using them keeps the SQL
   * expression in the same `drizzle-orm` copy that owns `db.drizzle`, and
   * spares this plugin a direct `drizzle-orm` dependency.
   */
  operators?: {
    and: (...conditions: unknown[]) => unknown
    equals: (column: unknown, value: unknown) => unknown
  }
  tableNameMap?: Map<string, string>
  tables?: Record<string, Record<string, unknown>>
  updateOne: (args: Record<string, unknown>) => Promise<unknown>
}

/**
 * Payload's public bulk update first selects matching IDs and then updates by
 * ID. That is intentionally hook-friendly, but it is not a compare-and-set.
 * Publication state requires the revision predicate to remain attached to the
 * write itself, so the default store uses each official adapter's atomic write
 * primitive: `db.updateOne` with a revision filter on Mongo, and a single
 * `UPDATE ... WHERE id = ? AND revision = ? RETURNING` statement built through
 * `db.drizzle` on Postgres and SQLite. Custom Payload database adapters must
 * provide a custom state store instead of silently degrading concurrency
 * safety.
 *
 * The returned document is the caller's `existing` row with `data` applied.
 * Every column this store writes is written here, so the projection is exact
 * and avoids depending on how each driver decodes `RETURNING *` values.
 */
export const atomicUpdatePublicationState = async <T extends AtomicStateRow>(args: {
  collectionSlug: string
  data: Record<string, unknown>
  existing: T
  payload: Payload
}): Promise<null | T> => {
  const db = args.payload.db as unknown as DatabaseAdapterShape
  const data: Record<string, unknown> = {
    ...args.data,
    revision: args.existing.revision + 1,
    updatedAt: new Date().toISOString(),
  }

  if (db.name === 'mongoose') {
    const updated = await db.updateOne({
      collection: args.collectionSlug,
      data,
      where: {
        and: [
          { id: { equals: args.existing.id } },
          { revision: { equals: args.existing.revision } },
        ],
      },
    })
    return updated ? (updated as T) : null
  }

  if (db.name !== 'postgres' && db.name !== 'sqlite') {
    throw new TypeError(
      `The default GMC publication state store does not support Payload database adapter ${db.name ?? 'unknown'}; configure publicationState.store with an atomic implementation`,
    )
  }
  if (!db.drizzle || !db.operators) {
    throw new TypeError(
      `Payload ${db.name} adapter did not expose its initialized Drizzle instance and operators`,
    )
  }

  const logicalName = toSnakeCase(args.collectionSlug)
  const tableName = db.tableNameMap?.get(logicalName) ?? logicalName
  const table = db.tables?.[tableName]
  if (!table) {
    throw new TypeError(`GMC publication state table ${tableName} is not registered`)
  }

  const columns: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(data)) {
    if (value === undefined) {
      throw new TypeError(`Atomic GMC state update cannot write undefined to ${field}`)
    }
    if (!(field in table)) {
      throw new TypeError(`Unsupported GMC publication state update field: ${field}`)
    }
    // Drizzle owns driver encoding for every column type this store writes:
    // `json` fields are `jsonb` on Postgres and `text(..., { mode: 'json' })`
    // on SQLite, so both accept a plain object and stringify it themselves.
    // `date` fields are `timestamp(..., { mode: 'string' })` on Postgres and
    // `text` on SQLite, so both accept an ISO string.
    columns[field] = value
  }

  const rows = await db.drizzle
    .update(table)
    .set(columns)
    .where(
      db.operators.and(
        db.operators.equals(table.id, args.existing.id),
        db.operators.equals(table.revision, args.existing.revision),
      ),
    )
    .returning({ id: table.id })

  return rows.length > 0 ? ({ ...args.existing, ...data } as T) : null
}
