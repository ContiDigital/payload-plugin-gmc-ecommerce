# Architecture

This document describes how the plugin gets a Payload product into Google
Merchant Center and keeps it there. Read [the README](../README.md) first for
the shape of the configuration; this is the model behind it.

## The data flow

```text
Payload save / delete
        │
        │  afterChange / afterDelete hook
        ▼
   product.publish  ──────────────────┐  durable command, dispatched through
   product.delete                     │  your async adapter
        │                             │
        │  worker executes            │
        ▼                             │
  re-read published doc               │
  run products.project                │
  canonicalize + digest               │
        │                             │
        ├──▶ offer.publish ───────────┼──▶ Merchant API productInputs.insert
        ├──▶ offer.delete  ───────────┼──▶ Merchant API productInputs.delete
        └──▶ localInventory.reconcile ┘
        │
        ▼
  gmc-publications-v2 row per offer (digest, status, timestamps)
```

Nothing calls Google inside a web request. A hook only writes a command; a
worker does the work. That is what makes a crash, a deploy, or a Google outage
recoverable rather than a lost update. The one exception is opt-in: with
`api.exposeWorkerEndpoint`, `POST /gmc/v2/worker/execute` runs a command
inline, for hosts whose queue delivers over HTTP. It is off by default and
requires a `workerAccess` function when it is on.

Product content flows one way. The plugin never adds editable Merchant fields
to your collection and never writes Google's data back onto a product. The only
thing it stores is publication bookkeeping, in its own hidden collection.

## The command vocabulary

Commands are plain JSON objects with a `type`, a `requestedAt` instant and
`schemaVersion: 2`. They are validated on the way in and on the way out
(`src/v2/commands.ts`), so a malformed or oversized command never reaches
Google.

| Command | What it does |
| --- | --- |
| `product.publish` | Re-reads one published product, projects it, claims its identities, and fans out `offer.publish` for each projected offer and `offer.delete` for identities it no longer owns. |
| `product.delete` | Emitted by the delete hook with the identities the document owned. Runs with `product.publish` semantics; with no document left, every identity is deleted. |
| `offer.publish` | Writes one canonical `ProductInput` to one data source. Carries its own content `digest`. |
| `offer.delete` | Deletes one offer from one data source, optionally fenced by `onlyIfDesiredBefore`. |
| `catalog.publish` | Pages the eligible catalog and dispatches one `product.publish` per product. Optionally restricted to a `productIds` set. |
| `catalog.reconcile` | Pages the catalog the same way, then lists Google's processed products itself, records what it sees on each publication row, and reports (or deletes) offers your catalog no longer wants. |
| `localInventory.reconcile` | Fans out per store, then per product, into `localInventory.apply`. |
| `localInventory.apply` | Writes or removes one store's inventory for one offer. |
| `feed.build` | Builds a canonical feed artifact and atomically promotes it. |
| `status.refresh` | Reads Google's processed product for a product's identities and records what Google says about it. |
| `dataSources.validate` | Checks every configured data source is an API primary source that accepts the identities you send it. |

Coordinator commands (`catalog.*`, `localInventory.reconcile`) never do the
work themselves; they page and dispatch children. Each page has a hard ceiling
(`products.maxCatalogPages`, `products.maxRemoteReconcilePages`) so a runaway
sweep fails loudly instead of enqueueing forever.

## Publication state

One hidden collection — `gmc-publications-v2` unless you rename it — holds one
row per Google offer, plus one row per offer/store pair when local inventory is
configured. The row is keyed by merchant id, data source, and identity
(`contentLanguage`, `feedLabel`, `offerId`); store rows add a `|store:<code>`
segment. It is indexed on `key`, `productId`, `status`, and `storeCode` and on
nothing else: it is a high-churn table and every extra index is paid on every
publish.

The fields that matter are `desiredAt` and `desiredDigest` (what the newest
accepted projection wants), `publishedAt` and `publishedDigest` (what Google
was last told), `productId` (which document owns this identity), `status`, and
`revision` (bumped on every write; used as the compare-and-set token).

| Status | Meaning | What moves it |
| --- | --- | --- |
| `publish-pending` | New desired content is claimed but not yet sent. | A claim wins; leaves on a successful insert. |
| `published` | Google was told `publishedDigest`. | A new claim with a different digest returns it to `publish-pending`. |
| `delete-pending` | Deletion is the desired state, not yet applied. | `offer.delete` starts; leaves when the delete lands. |
| `deleted` | The offer was removed from Google. | A later claim can re-open the row and republish. |
| `failed` | The last attempt against Google failed. | Carries the classified error; the next successful attempt clears it. |

A row is never hard-deleted. `deleted` rows are what let reconciliation tell
"we removed this on purpose" apart from "Google has something we never sent".

## Ordering and convergence

Two rules decide everything, and there is no third:

1. **`desiredAt` orders.** A claim whose `desiredAt` is strictly older than the
   row's loses and does nothing. A deletion stamps its own instant into
   `desiredAt`, so a publish command queued before a delete can never resurrect
   the offer, however late it runs.
2. **The digest skips.** If the row is already `published` with the same
   `desiredDigest`, there is nothing to send and the command short-circuits.
   This is what makes a re-publish of an unchanged catalog nearly free.

Neither rule needs a global version counter, a lock, or a FIFO queue. Commands
for one offer may be delivered out of order or twice; the pair above makes the
outcome the same either way. That is why the built-in adapter can honestly
report `orderedBySubject: false`.

What the rules do not cover, reconciliation heals. `catalog.reconcile` stamps
one `startedAt` on its whole run. Its first phase re-publishes the catalog
(each child verifying that Google really has the offer). Its second phase lists
the processed products Google holds, records the observation on each row it
keeps, and treats a remote offer as an orphan when there is no row for it, when
the row is already `deleted`, or when the row has no `desiredAt` at all or a
`desiredAt` that predates `startedAt` **and** re-reading the owning product
shows it is gone or no longer eligible. That last condition is what stops
reconciliation from deleting a product whose publish simply has not run yet.

Orphan handling is a report by default. `reconciliation.orphanDeletion:
'exclusive-data-sources'` is the only setting that deletes, and it is only
correct when this plugin is the sole writer to every configured data source.
Even then the delete carries `onlyIfDesiredBefore: startedAt`, so a concurrent
publish that claims the identity during the sweep makes the delete stand down.

## Projection and canonicalization

`products.project` is the only place product content comes from. The worker
re-reads the published document at execution time (not the version the hook
saw), calls `project`, and canonicalizes the result:

- Object keys are sorted and `undefined` values dropped, so the digest depends
  on content rather than on key order.
- Identity is validated: two-letter lowercase `contentLanguage`, an uppercase
  `feedLabel` of at most 20 characters, an `offerId` of at most 50.
- Wire shapes are validated: `Price` objects, int64-as-string fields, RFC 3339
  timestamps, Google's `availability`, `condition` and `digitalSourceType`
  enums, custom attributes, and the mutually exclusive
  `title`/`structuredTitle` and `description`/`structuredDescription` pairs.
- Everything else in `productAttributes` passes through untouched, so a new
  Merchant API attribute works without a plugin release.

What canonicalization deliberately does **not** do is enforce merchandising
policy. It does not require a title, a price or a link, and it does not impose
Google's length limits. A supplemental input is a legitimate `ProductInput`,
and Google's own product status is the authority on whether an offer is
approved. Use `status.refresh` to read that back.

## Out of scope

- **Pulling from Google.** There is no read-back of product content into
  Payload, no conflict resolution, no dirty flag. If Google and Payload
  disagree, Payload wins on the next publish.
- **An admin dashboard.** The plugin ships endpoints and a hidden state
  collection, not UI.
- **Ordering guarantees the database cannot give.** The plugin converges; it
  does not serialize. If you need strict per-offer FIFO you need a FIFO
  transport, and even then the rules above still apply.
- **Feeds as a second source of truth.** A feed is an export of the same
  canonical products. Registering one as another Merchant Center primary source
  for the same offers puts two writers on one identity.
- **Scheduling.** Nothing in the plugin runs on a timer. Something in your
  deployment has to run the queue and post the periodic sweeps; see
  [Operations](v2-operations.md).

## Where to go next

- [Setup](v2-setup.md) — from a Merchant Center account to a first publish.
- [Async adapter contract](v2-async-adapter.md) — running commands on your own
  queue.
- [Operations](v2-operations.md) — running the worker, schedules, incidents.
- [Migration](v2-migration.md) — from 1.x, or from a 2.0 release candidate.
