import type { SanitizedCollectionConfig } from 'payload'

// ---------------------------------------------------------------------------
// "Is this document the one the public sees?"
// ---------------------------------------------------------------------------
//
// Merchant Center only ever mirrors live content, so every sync trigger has to
// be able to tell a live document from a pending draft. On a collection without
// drafts the question does not arise — the row is the document. On a drafts
// collection the answer is the document's `_status`, which is a string on most
// installs and a per-locale object when localized status is enabled.
//
// Anything unreadable counts as not live: refusing to sync a document costs a
// retry on the next save or scheduled run, while syncing a draft publishes
// unapproved copy to Google.

/** True when the collection keeps a draft timeline in front of its live row. */
export const collectionHasDrafts = (
  collection: Pick<SanitizedCollectionConfig, 'versions'> | undefined,
): boolean => Boolean(collection?.versions?.drafts)

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
 * True when `doc` is the version of the document that is live right now, and so
 * the version Merchant Center should be told about.
 */
export const isLiveDocument = (args: {
  collection: Pick<SanitizedCollectionConfig, 'versions'> | undefined
  doc: Record<string, unknown>
}): boolean => {
  if (!collectionHasDrafts(args.collection)) {
    return true
  }

  return statusIsPublished(args.doc._status)
}
