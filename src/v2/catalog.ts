import type { Payload, Where } from 'payload'

import type {
  GmcCanonicalProduct,
  GmcDocumentID,
  GmcFeedSelector,
  NormalizedGmcV2Options,
} from './types.js'

import { canonicalizeProjection, canonicalJson } from './canonical.js'
import { GmcFeedLimitError } from './feed/limits.js'
import { normalizeGmcIdentityRoute } from './identity.js'

export const mergeGmcCursorWhere = (
  configured: undefined | Where,
  cursor: GmcDocumentID | undefined,
  productIds?: GmcDocumentID[],
): undefined | Where => {
  const clauses: Where[] = []
  if (configured) {
    clauses.push(configured)
  }
  if (productIds) {
    clauses.push({ id: { in: productIds } })
  }
  if (cursor !== undefined) {
    clauses.push({ id: { greater_than: cursor } })
  }
  if (clauses.length === 0) {
    return undefined
  }
  if (clauses.length === 1) {
    return clauses[0]
  }
  return { and: clauses }
}

const getNextCursor = (args: {
  batchSize: number
  current?: GmcDocumentID
  docs: Array<{ id: GmcDocumentID }>
}): GmcDocumentID | undefined => {
  if (args.docs.length > args.batchSize) {
    throw new TypeError('Payload returned an oversized canonical product page')
  }
  for (const doc of args.docs) {
    if (
      !doc ||
      !(
        (typeof doc.id === 'string' && doc.id.trim().length > 0) ||
        (typeof doc.id === 'number' && Number.isSafeInteger(doc.id))
      )
    ) {
      throw new TypeError('Payload returned a canonical product without a valid document ID')
    }
  }
  if (args.docs.length !== args.batchSize) {
    return undefined
  }
  const next = args.docs.at(-1)?.id
  if (next === undefined || next === args.current) {
    throw new TypeError('Canonical product keyset pagination did not advance')
  }
  return next
}

export const collectCanonicalProducts = async (args: {
  maxProducts?: number
  /**
   * Aggregate canonical ProductInput JSON budget. This bounds the in-memory
   * collection phase before a non-streaming feed formatter receives products.
   */
  maxProjectedBytes?: number
  options: NormalizedGmcV2Options
  payload: Payload
  projectionTime?: string
  selector?: GmcFeedSelector
}): Promise<GmcCanonicalProduct[]> => {
  const products: GmcCanonicalProduct[] = []
  let projectedBytes = 0
  let cursor: GmcDocumentID | undefined
  let pageIndex = 0
  const projectionTime = args.projectionTime ?? new Date().toISOString()
  do {
    const result = await args.payload.find({
      collection: args.options.products.collection,
      depth: args.options.products.fetchDepth,
      draft: false,
      limit: args.options.products.batchSize,
      overrideAccess: true,
      pagination: false,
      sort: 'id',
      where: mergeGmcCursorWhere(args.options.products.where, cursor),
    })
    const docs = result.docs as unknown as Array<{ id: GmcDocumentID } & Record<string, unknown>>
    for (const doc of docs) {
      // Payload draft-enabled collections can retain a draft-only document in
      // the main collection table. `draft: false` prevents version-overlay
      // reads, but it does not by itself prove that the returned row is live.
      // Match the single-product executor's fail-closed rule: an explicit
      // non-published status is authoritative absence. Collections without
      // drafts omit `_status` and remain eligible.
      if (typeof doc._status === 'string' && doc._status !== 'published') {
        continue
      }
      const projection = await args.options.products.project({
        doc,
        payload: args.payload,
        projectionTime,
      })
      const canonical = canonicalizeProjection(projection).products
      for (const product of canonical) {
        product.identity = normalizeGmcIdentityRoute(product.identity, args.options)
        if (
          args.selector &&
          (product.identity.contentLanguage !== args.selector.contentLanguage ||
            product.identity.feedLabel !== args.selector.feedLabel ||
            (product.identity.dataSourceOverride ?? '') !==
              (args.selector.dataSourceOverride ?? ''))
        ) {
          continue
        }
        if (args.maxProducts !== undefined && products.length >= args.maxProducts) {
          throw new GmcFeedLimitError(
            `Canonical feed exceeds its ${args.maxProducts.toLocaleString('en-US')} product safety limit`,
          )
        }
        const productBytes = Buffer.byteLength(canonicalJson(product.input), 'utf8')
        if (
          args.maxProjectedBytes !== undefined &&
          projectedBytes + productBytes > args.maxProjectedBytes
        ) {
          throw new GmcFeedLimitError(
            `Canonical feed projection exceeds its ${args.maxProjectedBytes.toLocaleString('en-US')} byte in-memory safety limit`,
          )
        }
        projectedBytes += productBytes
        products.push(product)
      }
    }
    cursor = getNextCursor({
      batchSize: args.options.products.batchSize,
      current: cursor,
      docs,
    })
    if (cursor !== undefined) {
      if (pageIndex + 1 >= args.options.products.maxCatalogPages) {
        throw new GmcFeedLimitError(
          `Canonical catalog scan exceeded its ${args.options.products.maxCatalogPages.toLocaleString('en-US')} page safety limit`,
        )
      }
      pageIndex += 1
    }
  } while (cursor !== undefined)
  return products
}
