import type { Payload } from 'payload'

import { ValidationError } from 'payload'
import { vi } from 'vitest'

import type { GmcPublicationStateStore } from '../../types.js'

import { createPayloadPublicationStateStore } from '../../state/payloadStateStore.js'

export const MEMORY_STATE_COLLECTION = 'gmc-publications-v2'

export type MemoryStateDocument = { id: number } & Record<string, unknown>

const matches = (doc: Record<string, unknown>, where: Record<string, unknown>): boolean => {
  if (Array.isArray(where.and)) {
    return where.and.every((entry) => matches(doc, entry as Record<string, unknown>))
  }
  return Object.entries(where).every(([field, condition]) => {
    const predicate = condition as {
      equals?: unknown
      greater_than?: unknown
      not_equals?: unknown
    }
    if ('equals' in predicate) {
      if (predicate.equals === null) {
        return doc[field] === null || doc[field] === undefined
      }
      return doc[field] === predicate.equals
    }
    if ('greater_than' in predicate) {
      if (typeof doc[field] === 'number' && typeof predicate.greater_than === 'number') {
        return doc[field] > predicate.greater_than
      }
      return String(doc[field]).localeCompare(String(predicate.greater_than)) > 0
    }
    if ('not_equals' in predicate) {
      return doc[field] !== predicate.not_equals
    }
    return true
  })
}

/**
 * A Mongo-shaped Payload double backed by a Map-like array. `create` rejects a
 * duplicate `key` with the error the real adapters raise: field validation runs
 * before the driver, so a unique collision surfaces as a Payload
 * `ValidationError`, never as a driver duplicate-key code.
 *
 * `delegate` receives every request for a collection other than the publication
 * state collection, so one Payload object can serve both the product collection
 * an executor reads and the state rows its store writes.
 */
export const createPayloadStateDouble = (
  options: {
    beforeFind?: () => Promise<void>
    collectionSlug?: string
    delegate?: Partial<Payload>
  } = {},
) => {
  const collectionSlug = options.collectionSlug ?? MEMORY_STATE_COLLECTION
  const docs: MemoryStateDocument[] = []
  let id = 0
  const update = vi.fn(
    (args: {
      data: Record<string, unknown>
      where: { and: Array<Record<string, { equals: unknown }>> }
    }) => {
      const criteria = Object.fromEntries(
        args.where.and.flatMap((condition) =>
          Object.entries(condition).map(([field, value]) => [field, value.equals]),
        ),
      )
      const index = docs.findIndex((doc) =>
        Object.entries(criteria).every(([field, value]) => doc[field] === value),
      )
      if (index < 0) {
        return Promise.resolve(null)
      }
      docs[index] = { ...docs[index], ...args.data }
      return Promise.resolve(docs[index])
    },
  )
  const create = vi.fn((args: { collection?: string; data: Record<string, unknown> }) => {
    if (args.collection !== undefined && args.collection !== collectionSlug) {
      const delegated = options.delegate?.create
      if (!delegated) {
        throw new TypeError(`memory state double received a create for ${args.collection}`)
      }
      return (delegated as (value: unknown) => Promise<unknown>)(args)
    }
    if (docs.some((doc) => doc.key === args.data.key)) {
      return Promise.reject(
        new ValidationError({
          collection: collectionSlug,
          errors: [{ label: 'Key', message: 'Value must be unique', path: 'key' }],
        }),
      )
    }
    const now = new Date().toISOString()
    const doc = {
      revision: 0,
      ...args.data,
      id: ++id,
      createdAt: now,
      updatedAt: now,
    } as MemoryStateDocument
    docs.push(doc)
    return Promise.resolve(doc)
  })
  const find = vi.fn(
    async (args: {
      collection?: string
      limit?: number
      page?: number
      where?: Record<string, unknown>
    }) => {
      if (args.collection !== undefined && args.collection !== collectionSlug) {
        const delegated = options.delegate?.find
        if (!delegated) {
          throw new TypeError(`memory state double received a find for ${args.collection}`)
        }
        return (await (delegated as (value: unknown) => Promise<unknown>)(args)) as never
      }
      await options.beforeFind?.()
      const filtered = docs.filter((doc) => matches(doc, args.where ?? {}))
      const limit = args.limit ?? 10
      const page = args.page ?? 1
      const start = (page - 1) * limit
      return {
        docs: filtered.slice(start, start + limit),
        hasNextPage: start + limit < filtered.length,
      }
    },
  )
  const payload = {
    ...options.delegate,
    create,
    db: { name: 'mongoose', updateOne: update },
    find,
  } as unknown as Payload
  return { create, docs, find, payload, update }
}

/**
 * A real `GmcPublicationStateStore` — the shipped Payload implementation over
 * the in-memory Payload double above — with every method wrapped in a spy so
 * tests can assert call shape without replacing the claim rules.
 */
export const createMemoryPublicationStateStore = (
  options: {
    beforeFind?: () => Promise<void>
    collectionSlug?: string
    dataSourceName?: string
    delegate?: Partial<Payload>
    merchantId?: string
  } = {},
) => {
  const collectionSlug = options.collectionSlug ?? MEMORY_STATE_COLLECTION
  const double = createPayloadStateDouble({
    beforeFind: options.beforeFind,
    collectionSlug,
    delegate: options.delegate,
  })
  const real = createPayloadPublicationStateStore({
    collectionSlug,
    dataSourceName: options.dataSourceName ?? 'accounts/123456/dataSources/987654321',
    merchantId: options.merchantId ?? '123456',
  })
  const store = Object.fromEntries(
    Object.entries(real).map(([name, method]) => [
      name,
      vi.fn((method as (value: never) => unknown).bind(real)),
    ]),
  ) as unknown as GmcPublicationStateStore
  return { ...double, store }
}
