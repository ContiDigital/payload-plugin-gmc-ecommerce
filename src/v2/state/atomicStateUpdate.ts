import type { Payload } from 'payload'

import type { GmcPublicationState } from '../types.js'

type StateDocument = {
  createdAt?: string
  dataSourceName: string
  deleteVersion?: null | string
  desiredAt?: null | string
  desiredDigest?: null | string
  desiredVersion?: null | string
  error?: GmcPublicationState['error'] | null
  id: number | string
  key: string
  merchantId: string
  observedAt?: null | string
  operationId: string
  productId?: null | string
  publishedAt?: null | string
  publishedDigest?: null | string
  publishedVersion?: null | string
  remoteMissing?: boolean | null
  remoteStatus?: null | Record<string, unknown>
  remoteVersion?: null | string
  revision: number
  status: GmcPublicationState['status']
  storeCode?: string
  updatedAt: string
} & GmcPublicationState['identity']

type DatabaseAdapterShape = {
  client?: {
    execute: (statement: { args: unknown[]; sql: string }) => Promise<{
      rows?: Array<Record<string, unknown>>
    }>
  }
  name?: string
  pool?: {
    query: (
      query: string,
      values: unknown[],
    ) => Promise<{
      rows: Array<Record<string, unknown>>
    }>
  }
  schemaName?: string
  tableNameMap?: Map<string, string>
  updateOne: (args: Record<string, unknown>) => Promise<unknown>
}

const FIELD_COLUMNS = {
  deleteVersion: 'delete_version',
  desiredAt: 'desired_at',
  desiredDigest: 'desired_digest',
  desiredVersion: 'desired_version',
  error: 'error',
  observedAt: 'observed_at',
  operationId: 'operation_id',
  productId: 'product_id',
  publishedAt: 'published_at',
  publishedDigest: 'published_digest',
  publishedVersion: 'published_version',
  remoteMissing: 'remote_missing',
  remoteStatus: 'remote_status',
  remoteVersion: 'remote_version',
  revision: 'revision',
  status: 'status',
  updatedAt: 'updated_at',
} as const

const snakeCase = (value: string): string =>
  value
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/[^A-Z\d]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()

const quoteIdentifier = (value: string): string => {
  if (!/^[A-Z_]\w*$/i.test(value)) {
    throw new TypeError(`Unsafe database identifier for GMC publication state: ${value}`)
  }
  return `"${value}"`
}

const resolveTableName = (db: DatabaseAdapterShape, collectionSlug: string): string => {
  const logicalName = snakeCase(collectionSlug)
  const tableName = db.tableNameMap?.get(logicalName) ?? logicalName
  quoteIdentifier(tableName)
  return tableName
}

const normalizeDate = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    return new Date(value).toISOString()
  }
  throw new TypeError('GMC publication state database returned an invalid date')
}

const normalizeString = (value: unknown, field: string): string => {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString()
  }
  throw new TypeError(`GMC publication state database returned an invalid ${field}`)
}

const normalizeJson = (value: unknown): Record<string, unknown> | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value === 'string') {
    return JSON.parse(value) as Record<string, unknown>
  }
  return value as Record<string, unknown>
}

const fromRawRow = (row: Record<string, unknown>): StateDocument => ({
  id: row.id as number | string,
  contentLanguage: normalizeString(row.content_language, 'contentLanguage'),
  createdAt: normalizeDate(row.created_at),
  dataSourceName: normalizeString(row.data_source_name, 'dataSourceName'),
  deleteVersion:
    row.delete_version === null || row.delete_version === undefined
      ? undefined
      : normalizeString(row.delete_version, 'deleteVersion'),
  desiredAt: normalizeDate(row.desired_at),
  desiredDigest:
    row.desired_digest === null || row.desired_digest === undefined
      ? undefined
      : normalizeString(row.desired_digest, 'desiredDigest'),
  desiredVersion:
    row.desired_version === null || row.desired_version === undefined
      ? undefined
      : normalizeString(row.desired_version, 'desiredVersion'),
  error: normalizeJson(row.error) as GmcPublicationState['error'],
  feedLabel: normalizeString(row.feed_label, 'feedLabel'),
  key: normalizeString(row.key, 'key'),
  merchantId: normalizeString(row.merchant_id, 'merchantId'),
  observedAt: normalizeDate(row.observed_at),
  offerId: normalizeString(row.offer_id, 'offerId'),
  operationId: normalizeString(row.operation_id, 'operationId'),
  productId:
    row.product_id === null || row.product_id === undefined
      ? undefined
      : normalizeString(row.product_id, 'productId'),
  publishedAt: normalizeDate(row.published_at),
  publishedDigest:
    row.published_digest === null || row.published_digest === undefined
      ? undefined
      : normalizeString(row.published_digest, 'publishedDigest'),
  publishedVersion:
    row.published_version === null || row.published_version === undefined
      ? undefined
      : normalizeString(row.published_version, 'publishedVersion'),
  remoteMissing:
    row.remote_missing === null || row.remote_missing === undefined
      ? undefined
      : Boolean(row.remote_missing),
  remoteStatus: normalizeJson(row.remote_status),
  remoteVersion:
    row.remote_version === null || row.remote_version === undefined
      ? undefined
      : normalizeString(row.remote_version, 'remoteVersion'),
  revision: Number(row.revision),
  status: normalizeString(row.status, 'status') as GmcPublicationState['status'],
  storeCode:
    row.store_code === null || row.store_code === undefined
      ? undefined
      : normalizeString(row.store_code, 'storeCode'),
  updatedAt: normalizeDate(row.updated_at) ?? new Date(0).toISOString(),
})

const sqlValue = (key: keyof typeof FIELD_COLUMNS, value: unknown, sqlite: boolean): unknown => {
  if (value === undefined) {
    throw new TypeError(`Atomic GMC state update cannot write undefined to ${key}`)
  }
  if (value === null) {
    return null
  }
  if (key === 'error' || key === 'remoteStatus') {
    return JSON.stringify(value)
  }
  if (sqlite && typeof value === 'boolean') {
    return value ? 1 : 0
  }
  return value
}

/**
 * Payload's public bulk update first selects matching IDs and then updates by
 * ID. That is intentionally hook-friendly, but it is not a compare-and-set.
 * Publication state requires the revision predicate to remain attached to the
 * write itself, so the default store uses each official adapter's atomic write
 * primitive. Custom Payload database adapters must provide a custom state
 * store instead of silently degrading concurrency safety.
 */
export const atomicUpdatePublicationState = async (args: {
  collectionSlug: string
  data: Record<string, unknown>
  existing: StateDocument
  payload: Payload
}): Promise<null | StateDocument> => {
  const db = args.payload.db as unknown as DatabaseAdapterShape
  const updatedAt = new Date().toISOString()
  const data = { ...args.data, updatedAt }

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
    return updated ? (updated as StateDocument) : null
  }

  if (db.name !== 'postgres' && db.name !== 'sqlite') {
    throw new TypeError(
      `The default GMC publication state store does not support Payload database adapter ${db.name ?? 'unknown'}; configure publicationState.store with an atomic implementation`,
    )
  }

  const entries = Object.entries(data) as Array<[keyof typeof FIELD_COLUMNS, unknown]>
  for (const [key] of entries) {
    if (!(key in FIELD_COLUMNS)) {
      throw new TypeError(`Unsupported GMC publication state update field: ${key}`)
    }
  }
  const tableName = resolveTableName(db, args.collectionSlug)
  const qualifiedTable =
    db.name === 'postgres' && db.schemaName
      ? `${quoteIdentifier(db.schemaName)}.${quoteIdentifier(tableName)}`
      : quoteIdentifier(tableName)
  const sqlite = db.name === 'sqlite'
  const values = entries.map(([key, value]) => sqlValue(key, value, sqlite))
  const setters = entries.map(
    ([key], index) => `${quoteIdentifier(FIELD_COLUMNS[key])} = ${sqlite ? '?' : `$${index + 1}`}`,
  )
  const idIndex = entries.length + 1
  const revisionIndex = entries.length + 2
  const query = `UPDATE ${qualifiedTable} SET ${setters.join(', ')} WHERE "id" = ${sqlite ? '?' : `$${idIndex}`} AND "revision" = ${sqlite ? '?' : `$${revisionIndex}`} RETURNING *`
  values.push(args.existing.id, args.existing.revision)

  if (sqlite) {
    if (!db.client) {
      throw new TypeError('Payload SQLite adapter did not expose its initialized client')
    }
    const result = await db.client.execute({ args: values, sql: query })
    const row = result.rows?.[0]
    return row ? fromRawRow(row) : null
  }

  if (!db.pool) {
    throw new TypeError('Payload Postgres adapter did not expose its initialized primary pool')
  }
  const result = await db.pool.query(query, values)
  const row = result.rows[0]
  return row ? fromRawRow(row) : null
}
