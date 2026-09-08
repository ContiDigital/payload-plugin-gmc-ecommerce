/**
 * Shared scaffolding for the documentation samples in this directory.
 *
 * Each sample file holds one code block from README.md or docs/v2-*.md. The
 * block itself is reproduced verbatim; anything a compiler needs but a reader
 * does not — a database adapter, the host's generated Payload types, a
 * collection definition — lives here.
 */
import type { CollectionConfig } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'

/** Stands in for the host's generated `Product` type from payload-types.ts. */
export type Product = {
  description?: string
  id: string
  image?: { url?: string }
  inStock?: boolean
  price: number
  sku: string
  slug: string
  stock: number
  title: string
}

/** Stands in for a host's generated `Promotion` type. */
export type Promotion = {
  ends?: string
  id: string
  price?: number
  products?: Array<{ id: string }>
  starts?: string
}

export const Products: CollectionConfig = {
  slug: 'products',
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'sku', type: 'text', required: true, unique: true },
  ],
  versions: { drafts: true },
}

export const db = sqliteAdapter({ client: { url: 'file:./docs-samples.db' } })
