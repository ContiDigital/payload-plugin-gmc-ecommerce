import type { Payload, RequestContext } from 'payload'

import { createPluginLogger } from '../utilities/logger.js'
import { buildInternalSyncContext } from './hookContext.js'

// ---------------------------------------------------------------------------
// Draft-safe persistence of plugin-owned Merchant Center bookkeeping
// ---------------------------------------------------------------------------
//
// WHY THIS MODULE EXISTS
//
// The plugin owns a small amount of bookkeeping on the product document
// (`mc.syncMeta.*`, `mc.snapshot`, `mc.attrs.*`, `mc.identity.*`).  Persisting
// it must never change the document's publication state and must never move
// content between the draft timeline and the live row.
//
// Two approaches were tried and one of them is unsafe:
//
//  1. `payload.db.updateOne()` (direct adapter write).  REJECTED.
//     `upsertRow` — the function every drizzle adapter routes `updateOne`
//     through — documents itself as "adapter function replaces the entire row
//     and does not support partial updates"
//     (@payloadcms/drizzle/dist/upsertRow/index.js).  Two concrete failures
//     were reproduced against a real sqlite adapter:
//       a. Array rows are written without an `id`.  Payload normally fills
//          that in through the `baseIDField` beforeChange hook
//          (payload/dist/fields/baseFields/baseIDField.js:12), which the raw
//          adapter path skips, so the insert becomes
//          `insert into mc_product_types (_order,_parent_id,id,value)
//           values ($1,$2,default,$3)` against a `varchar PRIMARY KEY NOT NULL`
//          column -> NOT NULL violation.
//       b. `transformForWrite` registers EVERY array field of the collection
//          in `rowToInsert.arrays`, even the ones absent from the partial
//          payload, and `upsertRow` then deletes their existing rows before
//          re-inserting nothing.  A partial `mc` write therefore truncates
//          unrelated array fields on the same collection.  On adapters older
//          than the `shouldUseOptimizedUpsertRow` fast path this happens even
//          for scalar-only writes.  The adapter call is not transactional
//          without a `req`, so the deletes survive the failed insert.
//
//  2. `payload.update()` (collection API).  USED, but only when it is safe.
//     `updateByID` resolves its base document with `getLatestCollectionVersion`
//     (payload/dist/collections/operations/updateByID.js:78), which returns the
//     LATEST version — the pending draft — whenever drafts are enabled
//     (payload/dist/versions/getLatestCollectionVersion.js:33-44,55-56).
//     With `draft` falsy, `isSavingDraft` is false
//     (payload/dist/collections/operations/utilities/update.js:29) and the
//     merged document (draft content, `_status: 'draft'`) is written straight
//     onto the LIVE row (update.js:225,245-253).  That is how a bookkeeping
//     write unpublished a live product.
//
// THE RULE
//
// Bookkeeping is written to the live row with `payload.update({ draft: false })`
// ONLY when there is no pending draft in front of it.  `_status` is never
// passed: with no pending draft the base document Payload merges onto is the
// live row itself, so its status is preserved verbatim (forcing `_status`
// would instead publish a draft that appeared after the check).  When a
// pending draft does exist the write is skipped with a warning — `mc.syncMeta.dirty`
// stays true, so the next publish or scheduled sync persists it.

export const PENDING_DRAFT_SKIP_MESSAGE =
  'MC state not persisted: pending draft; will persist on next publish/sync'

export const UNKNOWN_DRAFT_STATE_SKIP_MESSAGE =
  'MC state not persisted: draft state could not be determined; will persist on next publish/sync'

type VersionDoc = {
  version?: {
    _status?: unknown
  }
}

type PayloadWithVersionAccess = {
  collections?: Record<
    string,
    {
      config?: {
        versions?: {
          drafts?: unknown
        }
      }
    }
  >
  db?: {
    findVersions?: (args: Record<string, unknown>) => Promise<{ docs?: VersionDoc[] }>
  }
} & Payload

/** True when the collection stores drafts (i.e. a live row can sit behind a newer version). */
export const collectionHasDrafts = (payload: Payload, collectionSlug: string): boolean => {
  const config = (payload as PayloadWithVersionAccess).collections?.[collectionSlug]?.config

  return Boolean(config?.versions?.drafts)
}

/**
 * `_status` is a string on most installs and a per-locale object when
 * localized status is enabled. Anything else (missing/unknown) counts as
 * not-published so the caller fails safe.
 */
const statusIsPublished = (status: unknown): boolean => {
  if (typeof status === 'string') {
    return status === 'published'
  }

  if (status && typeof status === 'object') {
    const values = Object.values(status as Record<string, unknown>)
    return values.length > 0 && values.every((value) => value === 'published')
  }

  return false
}

/**
 * A pending draft is a `latest` version whose `_status` is not published.
 * Its content has not been merged into the live row yet, so any non-draft
 * `payload.update()` would carry it — and its draft status — onto that row.
 */
export const hasPendingDraft = async (
  payload: Payload,
  collectionSlug: string,
  productId: string,
): Promise<boolean> => {
  if (!collectionHasDrafts(payload, collectionSlug)) {
    return false
  }

  const findVersions = (payload as PayloadWithVersionAccess).db?.findVersions
  if (typeof findVersions !== 'function') {
    // Drafts are on but the version timeline is unreadable — assume the worst.
    return true
  }

  const result = (await findVersions.call((payload as PayloadWithVersionAccess).db, {
    collection: collectionSlug,
    limit: 1,
    pagination: false,
    sort: '-updatedAt',
    where: {
      and: [{ parent: { equals: productId } }, { latest: { equals: true } }],
    },
  })) as { docs?: VersionDoc[] } | undefined

  const latest = result?.docs?.[0]
  if (!latest) {
    // Drafts enabled but no version row yet — the live row is the only copy.
    return false
  }

  return !statusIsPublished(latest.version?._status)
}

const isNotFoundError = (error: unknown): boolean => {
  const status = (error as { status?: unknown })?.status
  const name = (error as { name?: unknown })?.name

  return status === 404 || name === 'NotFound'
}

/**
 * Persist plugin-owned MC state without changing publication state or content.
 *
 * Returns `true` when the state was written, `false` when it was intentionally
 * skipped (pending draft, indeterminate draft state, or a deleted product).
 * Any other adapter/validation failure is rethrown for the caller to handle.
 */
export const writeMCState = async (
  payload: Payload,
  collectionSlug: string,
  productId: string,
  data: Record<string, unknown>,
): Promise<boolean> => {
  const log = createPluginLogger(payload.logger, { operation: 'writeMCState', productId })

  let pendingDraft: boolean
  try {
    pendingDraft = await hasPendingDraft(payload, collectionSlug, productId)
  } catch (error) {
    log.warn(UNKNOWN_DRAFT_STATE_SKIP_MESSAGE, {
      collection: collectionSlug,
      error: error instanceof Error ? error.message : String(error),
    })

    return false
  }

  if (pendingDraft) {
    log.warn(PENDING_DRAFT_SKIP_MESSAGE, { collection: collectionSlug })

    return false
  }

  try {
    await payload.update({
      id: productId,
      collection: collectionSlug as never,
      context: buildInternalSyncContext({
        skipCollectionHooks: true,
      } as RequestContext),
      data: data as never,
      depth: 0,
      // Explicit: never create or promote a draft version from a bookkeeping write.
      draft: false,
      overrideAccess: true,
    })
  } catch (error) {
    if (isNotFoundError(error)) {
      log.warn('Skipped MC-state write because product no longer exists', {
        collection: collectionSlug,
      })

      return false
    }

    throw error
  }

  return true
}
