import type { Field, Payload } from 'payload'

import { createPluginLogger } from '../utilities/logger.js'
import { mergeIntoRow } from './rowPatch.js'

// ---------------------------------------------------------------------------
// Persistence of plugin-owned Merchant Center bookkeeping
// ---------------------------------------------------------------------------
//
// WHY THIS MODULE EXISTS
//
// The plugin owns a small amount of bookkeeping on the product document
// (`mc.syncMeta.*`, `mc.snapshot`).  Persisting it must not touch the
// document's editorial identity in any way: not its publication state, not its
// content, not its `updatedAt`, and not its version timeline.
//
// `payload.update()` cannot satisfy that, in either of its forms:
//
//  1. The `id` form resolves its base document with `getLatestCollectionVersion`
//     (payload/dist/collections/operations/updateByID.js:65-71), which returns
//     the LATEST version — the pending draft — whenever drafts are enabled
//     (payload/dist/versions/getLatestCollectionVersion.js:33-44,55-56).  With
//     `draft` falsy, `isSavingDraft` is false and the merged document (draft
//     content, `_status: 'draft'`) is written straight onto the LIVE row
//     (payload/dist/collections/operations/utilities/update.js:29,191).  That
//     is how a bookkeeping write unpublished a live product on 2026-08-28.
//
//  2. The `where` form avoids that rebase — it loads the base document with
//     `payload.db.find`, i.e. the main row
//     (payload/dist/collections/operations/update.js:90-99) — but both forms
//     still call `saveVersion` unconditionally (update.js:203).  Every write
//     would therefore append a version row and bump `updatedAt`, and
//     `createVersion` clears `latest` on every earlier version of the parent
//     (@payloadcms/drizzle/dist/createVersion.js:41-50).  A bookkeeping write
//     landing while an editor has a pending draft would demote that draft out
//     of `latest`, so the admin edit view would stop showing their unsaved
//     work.  Trading an unpublish for a silently disappearing draft is not a
//     fix.
//
// THE RULE
//
// Bookkeeping never goes through the collection API.  It reads the live row,
// merges its patch into it, and writes that row back through the adapter.  No
// version row is appended, `_status` and every content field survive verbatim
// because they are carried across from the row, the pending draft keeps
// `latest`, and the write does not depend on the host honouring a
// `skipCollectionHooks` convention because no hook runs at all.
//
// `updatedAt` is the one thing that still moves: the drizzle adapter stamps it
// on every write whatever the caller passes
// (@payloadcms/drizzle/dist/transform/write/traverseFields.js:384), so no write
// to the product row can avoid it.
//
// `mergeIntoRow` supplies the field-awareness the adapter needs: the adapter
// replaces the row wholesale and does not generate array-row ids, so the merged
// document has to be complete and every array row has to carry an `id`.  See
// `rowPatch.ts`.
//
// ATOMICITY
//
// The read and the write run in one transaction.  That matters more here than
// for an ordinary write: on a drizzle adapter `upsertRow` rewrites the main row
// and then deletes and re-inserts every locale, relationship, array and block
// table in separate statements, so an untransacted failure part-way through can
// leave unrelated arrays emptied — the failure mode `dev/draft-safety.int.spec`
// reproduces for a partial write.  Wrapped, that failure rolls back instead.
//
// What the transaction does NOT do is make the write conditional.  Under the
// usual read-committed isolation a delete committed after the read is not
// blocked, and drizzle's `upsertRow` writes through `onConflictDoUpdate`
// (@payloadcms/drizzle/dist/upsertRow/index.js:25-56), so on that adapter a
// product deleted mid-flight can still be re-inserted by the bookkeeping
// write.  Mongo has no such path — `updateOne` matches nothing — which is why
// the result is checked rather than discarded.
//
// Hosts that run `transactionOptions: false` get no transaction — Payload's own
// writes have the same exposure there — so `beginTransaction` returning nothing
// is a supported outcome, not an error.
//
// KNOWN LIMIT
//
// A transaction serialises the read and the write; it does not make the write
// conditional.  A published edit committed just before the read is still
// overwritten by a caller that assembled its patch earlier.  Callers that care
// pass a patch factory and decide against the freshly-read row — that is how
// the push keeps a product dirty when an editor saved during the Merchant
// Center round-trip.  Removing the hazard entirely means moving sync state off
// the product document and onto its own compare-and-set row; that is deliberate
// follow-up work, not something this module can do alone.

export const PRODUCT_MISSING_SKIP_MESSAGE =
  'MC state not persisted: the product no longer exists'

/**
 * Caller-facing counterpart of {@link PRODUCT_MISSING_SKIP_MESSAGE}.
 *
 * Deliberately does not name a cause: callers reach it both when the product
 * was deleted mid-flight and when the write itself failed, and the log at the
 * point of failure carries the specific reason.
 */
export const STATE_NOT_PERSISTED_WARNING =
  'Merchant Center accepted the operation, but the result could not be recorded on the product.'

type PayloadWithCollections = {
  collections?: Record<string, { config?: { fields?: Field[] } }>
} & Payload

const collectionFields = (payload: Payload, collectionSlug: string): Field[] => {
  const fields = (payload as PayloadWithCollections).collections?.[collectionSlug]?.config?.fields

  if (!fields) {
    throw new Error(
      `Cannot persist Merchant Center state: collection "${collectionSlug}" is not registered on this Payload instance`,
    )
  }

  return fields
}

/**
 * A patch, or a function that builds one from the row as it stands right now.
 *
 * The factory form lets a caller resolve a conflict it can detect — the push
 * uses it to leave `mc.syncMeta.dirty` set when an editor saved while the
 * Merchant Center round-trip was in flight.
 */
export type MCStatePatch =
  | ((row: Record<string, unknown>) => Record<string, unknown>)
  | Record<string, unknown>

/**
 * Persist plugin-owned MC state without changing publication state, content, or
 * version history. (`updatedAt` still moves — see the note above.)
 *
 * Returns `true` when the state was written and `false` when the product has
 * been deleted underneath the caller. Adapter failures are thrown so a caller
 * can never mistake a failed write for a successful one.
 */
export const writeMCState = async (
  payload: Payload,
  collectionSlug: string,
  productId: string,
  patch: MCStatePatch,
): Promise<boolean> => {
  const log = createPluginLogger(payload.logger, { operation: 'writeMCState', productId })
  const fields = collectionFields(payload, collectionSlug)

  const transactionID = await payload.db.beginTransaction?.()
  const req = transactionID ? ({ transactionID } as never) : undefined

  try {
    const row = (await payload.db.findOne({
      collection: collectionSlug,
      req,
      where: { id: { equals: productId } },
    } as never)) as null | Record<string, unknown>

    if (!row) {
      log.warn(PRODUCT_MISSING_SKIP_MESSAGE, { collection: collectionSlug })

      if (transactionID) {
        await payload.db.commitTransaction(transactionID)
      }

      return false
    }

    // The result is read back rather than discarded: mongo's `updateOne`
    // matches nothing and reports no error when the product was deleted
    // between the read and the write, so a discarded result would let this
    // return `true` for a write that never landed.
    const written = await payload.db.updateOne({
      id: productId,
      collection: collectionSlug,
      data: mergeIntoRow(row, typeof patch === 'function' ? patch(row) : patch, fields),
      req,
    } as never)

    if (transactionID) {
      await payload.db.commitTransaction(transactionID)
    }

    if (!written) {
      log.warn(PRODUCT_MISSING_SKIP_MESSAGE, { collection: collectionSlug })

      return false
    }

    return true
  } catch (error) {
    if (transactionID) {
      await payload.db.rollbackTransaction(transactionID)
    }

    throw error
  }
}
