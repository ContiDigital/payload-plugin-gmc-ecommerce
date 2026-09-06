# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - Unreleased

2.0 replaces the 1.x sync engine with a one-way publisher. Payload product data
is the only authority: a host projector turns each published product into a
complete Merchant API `ProductInput`, and every Merchant Center write runs as a
durable command in a worker. Nothing is written back onto products.

### Breaking changes

- **The package root exports 2.0.** The 1.x engine, admin dashboard, `./client`
  and `./rsc` entry points, field-mapping and sync-log collections, pull sync,
  conflict resolution, dirty tracking, and the `mc` product field group are
  gone. 1.x continues on the `release/1.x` branch (1.3.0 is the last 1.x line);
  keep a 1.x install pinned until you have migrated. See
  [docs/v2-migration.md](docs/v2-migration.md).
- **New options.** `payloadGmcEcommerce({ merchantId, dataSourceId,
  getCredentials, async, products: { collection, project, resolveIdentities } })`
  is the required core. `access` defaults to admin-only. `feeds`,
  `catalogDependencies`, `catalogGlobalDependencies`, `localInventory`,
  `reconciliation`, `rateLimit`, `requireTransaction`, `instanceId`, `api`,
  `additionalDataSourceIds`, and `publicationState.collectionSlug` are optional.
  `workerAccess` is required only with `api.exposeWorkerEndpoint`.
- **Async adapter contract.** An adapter is `{ name, dispatch, getOperation,
  health }` plus optional `install` and `capabilities: { scheduledDelivery?,
  orderedBySubject? }`. Ordering per subject is a documented expectation, not a
  gate. The worker calls `createGmcCommandExecutor(options)({ command,
  operationId, rootOperationId, payload })`.
- **Projection.** `products.project` returns `{ products, sourceVersion?,
  warnings? }`. `sourceVersion` is optional and, when present, is sent to Google
  as `versionNumber`. `products: []` means the document must not exist in
  Merchant Center.
- **Publication state.** One hidden, non-versioned collection
  (`gmc-publications-v2` by default) holds product and local-inventory rows.
  Rows carry `desiredAt`, `desiredDigest`, `publishedAt`, `publishedDigest`,
  `status`, `revision`, and `storeCode`; indexes are `key` (unique),
  `productId`, `status`, `storeCode`. Hosts upgrading from a 2.0 release
  candidate must migrate: `deleteVersion`, `desiredVersion`, and
  `publishedVersion` are dropped, `storeCode` is added, and the separate
  `gmc-local-inventory-publications-v2` collection is removed.
- **Commands (wire schema 2).** `offer.publish` carries `digest` and optional
  `versionNumber`; `localInventory.apply` carries `digest`; `offer.delete` uses
  `onlyIfDesiredBefore`. Release-candidate fields (`sourceVersion` on
  offer commands, `deleteVersion`, `deleteIfDesiredVersionBefore`,
  `startedVersion`, `verifyRemote`, `deleteIfDesiredBefore`) are accepted and
  ignored for one release so queued rows drain cleanly.
- **Feed artifacts.** Descriptors carry `generatedAt` instead of
  `sourceVersion`. A release-candidate pointer without `generatedAt` is logged
  and rebuilt over on the next build.
- **TSV output.** The shipping column uses Google's named-sub-attribute header
  (`shipping(country:region:postal_code:location_id:location_group_name:service:price:min_handling_time:max_handling_time:min_transit_time:max_transit_time)`)
  and always emits all eleven positions; scalar cells are no longer quoted;
  the pickup SLA column is `pickup_SLA`; attributes with no documented TSV
  column are omitted with a warning instead of failing the build.
- **Types.** `MCProductAttributes.taxes` and `MCTax` are removed (Merchant
  API v1 has no such field).
- **Runtime.** Node `^22.12.0 || >=24.0.0`; Payload `>=3.37.0 <4.0.0`.

### Added

- `payloadJobsAsyncAdapter()` — a built-in durable adapter on Payload Jobs.
  It registers one task and one queue, keeps its own `gmc-operations` ledger
  (idempotent by key, aggregate workflow status, health), joins the request
  transaction when a hook dispatches, and supports scheduled delivery through
  `waitUntil`. A host runs it with `payload.jobs.run({ queue: 'gmc' })` or
  `jobs.autoRun`.
- `requireTransaction` option. Off by default: an automatic hook that runs
  without an ambient transaction warns once per process and dispatches.
  On, the hook fails closed with `GMC_TRANSACTION_REQUIRED`.
- `GmcAsyncAdapter.install` so an adapter can add its own collections and
  Payload Jobs tasks to the config.
- Draft autosave suppression: a draft save over a document that was already a
  draft dispatches nothing.
- Reconciliation re-reads the product before treating a stale row as an
  orphan, so a product whose publish has not yet run is never deleted.
- Feed builds return and log `warnings` for unmapped attributes.
- `hasDefaultPluginAccess` (admin-only) as the default `access`.

### Fixed

Defects found in the 2.0 release candidates, all covered by tests:

- `catalog.reconcile` re-fetched and re-inserted every unchanged product on
  every run; it now skips products whose published digest matches.
- Concurrent creation of the same publication row crashed instead of retrying
  because the duplicate-key check never matched Payload's `ValidationError`.
- Mandatory ambient transactions broke stock SQLite installs and any caller
  using `disableTransaction`.
- `product.delete` without a `productId` deleted nothing.
- A hard-deleted product could be re-created in Merchant Center by a retrying
  publish; deletions now carry the deletion instant.
- Feed checksums depended on the process locale (`localeCompare`); rows are
  sorted by code unit.
- Shipping sub-attributes beyond country, region, service, and price were
  silently dropped from TSV.
- Valid `ProductInput`s were rejected: supplemental inputs without title or
  price, product detail values over 150 characters, `legacyLocal`.
- A local rate-limit queue overflow was retried like a Google 429; a
  distributed rate-limit store error dead-lettered the command.
- Google error responses up to 64 MiB were retained on error objects and
  written to logs; responses are capped at 8 MiB and bodies are not retained.
- The optional worker endpoint parsed and validated the body before checking
  `workerAccess`.
- The publication-state store wrote raw SQL through undocumented adapter
  internals; it now uses `payload.db.drizzle` and `payload.db.updateOne`.
- About fifteen indexes on the high-churn publication table, including one on
  `revision`, are trimmed to the four that are queried.

### Removed

- The global monotonic source-version ordering contract and its adapter
  capability flags (`globalSourceVersion`, `exclusiveCatalogReconciliation`,
  `workflowStatus`, `transactionAware`, `durable`, `delivery`).
- Custom publication-state stores (`publicationState.store`,
  `localInventory.publicationState`).
- `productIngestion` (single-valued) and the requirement to configure at least
  one feed.
- `GmcSourceVersionConflictError`, `GmcLocalInventorySourceVersionConflictError`,
  `createPayloadLocalInventoryPublicationStateStore`,
  `buildGmcLocalInventoryPublicationCollection`.
- Per-insert processed-product ownership reads for single-data-source
  installs (kept when more than one data source is configured).

## [1.3.0] - 2026-08-29

### Fixed

- **Critical: bookkeeping writes no longer touch the document's editorial identity.** 1.2.2 stopped a bookkeeping write from unpublishing a live product by refusing to write whenever a pending draft existed. That left three problems: the check and the write were separate operations, so a draft created in between still hit the unguarded path; a legitimate write was silently dropped whenever an editor had a draft open; and every write still appended a version row. `writeMCState` no longer uses the collection API in either of its forms. It reads the live row, merges the plugin's fields into it, and writes that row back through the database adapter, inside a transaction. No version row is appended, `_status` and every content field survive verbatim, the write always lands, and there is no window in which a draft can appear.
- **A bookkeeping write could hide an editor's pending draft.** Routing the write through `payload.update({ where })` — the obvious fix for the rebase — still calls `saveVersion`, and `createVersion` clears `latest` on every earlier version of the parent (`@payloadcms/drizzle/dist/createVersion.js`). A write landing while an editor had a draft open would have demoted that draft out of `latest`, so the admin edit view would stop showing their unsaved work. The adapter path appends no version at all, so the draft is untouched. Covered by `dev/draft-safety.int.spec.ts`.
- **A completed push could silently revert a concurrent edit and mark it synced.** The push rebuilt the entire `mc` group from a document read before the Merchant Center round-trip and wrote it back wholesale, including `dirty: false`. An edit saved during that round-trip was reverted _and_ de-dirtied, so Merchant Center stayed stale while the product reported a successful sync. The push now persists only what it produced — bookkeeping, the fetched snapshot, and attributes preparation derived — and assembles that patch against the row as it stands at write time. `mc.attrs` and `mc.customAttributes` are no longer written back at all.
- **A push can no longer report content as synced that it never sent.** Before calling Merchant Center the push stamps `mc.syncMeta.syncToken`; `beforeChange` clears that token on every save. If the token is gone when the push returns, the product stays `dirty` and the result carries a warning naming the situation, instead of being marked clean.
- **Draft saves no longer trigger a Merchant Center push.** The `afterChange` hook now enqueues a push only for a document that is actually live. Previously every draft save spent a Merchant Center write re-sending the already-published content, and the result was then discarded.
- **Skipped state writes are no longer reported as success.** All four call sites ignored `writeMCState`'s return value and returned `success: true` regardless. Push now returns a warning, pull returns `success: false`, and initial sync records a failure. Adapter failures are thrown rather than swallowed.
- **An untransacted bookkeeping failure could empty unrelated array fields.** `upsertRow` rewrites the main row and then deletes and re-inserts every array, block, locale and relationship table in separate statements. Wrapping the read and the write in one transaction means a failure part-way through rolls back instead of leaving those tables emptied, and stops `onConflictDoUpdate` from re-inserting a product that was deleted between the read and the write. Proven against a real adapter.
- **Derived attributes are converted to Payload storage shape before being persisted.** `resolveGoogleCategory` returns `productTypes` as a `string[]`, while the document stores `[{ value }]` rows. Persisting the wire shape would have handed the adapter array rows it cannot give a primary key to — after it had already emptied that array's table.
- **`reverseTransformProduct` is now idempotent.** Its array conversion did `String(v)` unconditionally, so a value already in storage shape — which a field mapping can produce — became `[{ value: '[object Object]' }]`. A row that already carries the target key now passes through untouched, id included.
- **A write that matched no row is no longer reported as a success.** Mongo's `updateOne` matches nothing and reports no error when the product was deleted between the read and the write; the result was being discarded. It is now checked.
- **The push stamps its sync token before reading the content it sends.** Stamping afterwards left a gap in which a save could land: Merchant Center would receive the stale content and the push's own fresh token would then certify it clean. The read now sits inside the push's error handling, so a failure there records an error instead of stranding the product in `state: 'syncing'`.
- **The push still records what it sent.** `mc.attrs` is what `refreshSnapshot` and `pullProduct` compare the remote product against, and with the default `permanentSync: false` — or for mappings defined in the runtime mappings collection, which `beforeChange` never applies — the push write-back is the only thing that puts those values there. Narrowing the write-back without this would have left those comparisons reporting phantom lag and made `newest-wins` skip matching remote products. Each attribute is written only where the row still holds what the push read, so an editor's mid-push change is preserved, and attributes that already match are skipped so an unchanged push does not churn the array tables.
- **`STATE_NOT_PERSISTED_WARNING` no longer claims the product was deleted.** Callers reach it both when the product vanished and when the write itself failed; the specific reason is in the log at the point of failure.
- **`refreshSnapshot` and `deleteFromMC` no longer report a clean success when nothing was recorded.** `updateSyncMeta` swallowed both the skip and the failure; it now returns the outcome and both callers surface a warning.
- **Initial sync clears the dirty flag it was queued by** (1.2.2 and earlier wiped `syncMeta` wholesale, which had the same effect; the narrowed patch in this release would otherwise have left every initially-synced product dirty forever) **and fills only attributes the live row still lacks.**
- **A pull no longer clears a dirty flag it never saw**, and invalidates any in-flight push token so a push cannot certify content the pull has just overwritten. Applies to both `pullProduct` and `pullAll`.
- **Batch push no longer counts an unrecorded push as a clean success.** A push that Merchant Center accepted but could not record locally may have orphaned a remote listing; it is now reported as a failure with its reason, so scheduled runs surface it.
- **Identity seeding reads the live row, not the document the push started from.** An identity an editor filled in during the Merchant Center round-trip was being overwritten with the defaults the push had resolved earlier, which would have left every later push targeting the old remote object.
- **A pull merges remote data onto the attributes as they stand at write time.** Merging against the document the pull read before fetching erased any attribute edited during the fetch. Applies to `pullProduct` and `pullAll`.
- **Initial sync leaves the product queued when it raced a save.** It clears `dirty` because it has just sent the product, unless the live row went dirty while the request was in flight.

### Added

- `SyncResult.statePersisted` — `false` when Merchant Center accepted the operation but its outcome could not be recorded locally. `success` describes the remote call; this describes the local record of it. Consumers that need to escalate or retry should read this field rather than pattern-matching `warning`.
- `mc.syncMeta.syncToken` (hidden, read-only): the marker a push uses to detect an edit that landed while Merchant Center was being updated. **This adds a nullable column; run a migration or schema push when upgrading.**
- `src/server/sync/rowPatch.ts` — a field-aware merge of a plugin patch into a raw collection row. Groups and named tabs recurse, `json` fields are replaced wholesale rather than fused with a previous snapshot, and array and block rows get the id that Payload's `baseIDField` hook would normally have generated.
- `src/server/sync/publicationState.ts` — `isLiveDocument` / `collectionHasDrafts`, including localized `_status` handling.
- `prepareProductForSync` now returns `derivedAttributes`: the attributes it computed that the document does not already own, in storage shape. This is the only thing a push is allowed to write back to `mc.attrs`, which is what keeps `initialOnly` mapping seeds and resolved categories working without re-asserting editorial values.

### Changed

- `writeMCState` accepts a patch or a function of the freshly-read row, so a caller can resolve a conflict it can detect.
- `hasPendingDraft` and `collectionHasDrafts` are gone from `mcStateWriter`; the write no longer needs to inspect the version timeline. `collectionHasDrafts` lives in `publicationState.ts`.

### Known limits

- `updatedAt` still moves on every bookkeeping write: the drizzle adapter stamps it unconditionally (`transform/write/traverseFields.js`), so no write to the product row can avoid it. Removing this means moving sync state onto its own collection.
- Read-merge-write is serialised by a transaction but is not conditional. This is a narrower window than 1.2.2's, but it is reachable in one case 1.2.2 was not: 1.2.2 skipped the write entirely whenever a pending draft existed, so a publish could not race it. 1.3.0 always writes, so a publish committing inside the read-write window is overwritten by the row the write had already read. Set against that, 1.2.2 lost the bookkeeping outright in that case and still carried the unpublish race that motivated this branch. Under read-committed isolation a delete committed after the read is not blocked, and drizzle writes through `onConflictDoUpdate`, so on that adapter a product deleted mid-flight can still be re-inserted by the bookkeeping write. Mongo has no such path. Hosts running `transactionOptions: false` get no transaction at all — Payload's own writes have the same exposure there.
- Unpublishing a product, or setting `mc.enabled: false`, does not remove it from Merchant Center. Only deleting the Payload document does. This is long-standing behaviour, now documented rather than implied.

### Internal

- `src/server/sync/__tests__/helpers/payloadDouble.ts` — a small in-memory adapter double, so a write is visible to the next read. Sync state is written and re-read within a single push; a double serving a fixed row hid the concurrency behaviour entirely.
- `dev/draft-safety.int.spec.ts` (real sqlite, drafts enabled) now proves: the production data shape persists with the product still published; no version row is appended and no editorial field changes; a pending draft keeps its content _and_ its `latest` flag while the bookkeeping write still succeeds; a deleted product reports a skipped write; a failed write rolls back instead of emptying unrelated array tables; and, as a standing record, that `updatedAt` still moves and that a partial adapter write truncates arrays.

## [1.2.2] - 2026-08-29

### Fixed

- **Critical: a bookkeeping write could unpublish a live product.** When a product had a pending draft version, the plugin's sync-state write reached `payload.update()` without a `draft` argument. Payload resolves that operation's base document with `getLatestCollectionVersion`, which returns the _latest_ version — the draft — and then writes the merged result, `_status: 'draft'` included, straight onto the live row. A staff (or API) "save draft" on a published product followed by an `onChange` push therefore unpublished it. Sync state is now written only when there is no pending draft, always with an explicit `draft: false`, and `_status` is never sent.
- **Critical: the direct database-adapter write corrupted array fields.** `payload.db.updateOne()` routes through `upsertRow`, which documents itself as a full-row replace that "does not support partial updates". Two failures were reproduced against a real drizzle adapter: (1) array rows were written without the `id` that Payload's `baseIDField` `beforeChange` hook normally generates, so `mc.attrs.productTypes` inserts hit `insert into mc_product_types (_order, _parent_id, id, value) values ($1, $2, default, $3)` against a `varchar PRIMARY KEY NOT NULL` column and failed; and (2) `transformForWrite` registers _every_ array field of the collection for deletion, including ones absent from the payload, so a partial `mc` write truncated unrelated array fields on the same collection — non-transactionally, so the deletes survived the failed insert. The direct-adapter path has been removed.
- Pull sync (single and bulk) and initial sync wrote MC state the same unguarded way and had the same unpublish hazard. All four write sites now share one draft-safe writer.

### Changed

- Sync-state persistence lives in `src/server/sync/mcStateWriter.ts` (`writeMCState`, `hasPendingDraft`, `collectionHasDrafts`). When a pending draft exists the write is skipped and logged as `MC state not persisted: pending draft; will persist on next publish/sync`; `mc.syncMeta.dirty` stays `true`, so the next publish or scheduled sync persists it. An indeterminate draft state (unreadable version timeline) skips the same way rather than risking a clobber.
- Because the direct-adapter path is gone, sync-state writes once again go through `payload.update()` — as they did in 1.2.0 and earlier — so they bump `updatedAt` and append a version on versioned collections. Correctness over write volume: the adapter shortcut is not safe on any adapter that lacks the `shouldUseOptimizedUpsertRow` fast path (Payload < ~3.80), where it truncated array fields even for scalar-only writes.

### Internal

- New unit suite `src/server/sync/__tests__/mcStateWriter.test.ts` covers drafts detection (including a localized `_status` object), the pending-draft refusal, the `draft: false` write shape, indeterminate draft state, and deleted-product handling.
- New real-adapter suite `dev/draft-safety.int.spec.ts` (sqlite, `versions.drafts: true`, plus an unrelated array field on the same collection) proves: the production data shape — `mc.attrs.productTypes` included — now persists and the product stays published; a pending draft is never merged onto the live row; and, as a standing record of why the shortcut was removed, that `db.updateOne` both throws on `mc_product_types.id` and truncates the unrelated array.
- `pushSync.test.ts`'s direct-write assertions were replaced with draft-safety assertions at the `pushProduct` level.

## [1.2.1] - 2026-07-09

### Fixed

- Merchant Center push bookkeeping now writes through Payload's database adapter when available, avoiding product collection hooks and draft version creation for sync metadata updates.
- Postgres/SQLite adapter writes include Payload's `updatedAt: null` timestamp-skip signal, and MongoDB adapter writes pass `timestamps: false`, preventing Merchant Center bookkeeping from surfacing as a staff-facing content edit on supported adapters.
- Direct sync-state writes use an ID `where` selector plus `upsert: false` options so missing products are treated as no-ops instead of falling back to a full `payload.update`.
- Product sync hooks now also honor host-app `context.skipCollectionHooks` during bulk/internal writes.
- `deepMerge` now handles cyclic and deeply nested source objects without overflowing the stack, while still correctly merging repeated sibling object references.

### Internal

- Added regression coverage for direct write arguments, missing-row behavior, `skipCollectionHooks`, cyclic/deep merge inputs, and repeated source object references.

## [1.2.0] - 2026-05-08

### Added

- **`videoLinks` product attribute** - first-class support for Google Merchant Center's `video_link` field
  - New `videoLinks?: MCUrlArrayField` on `MCProductAttributes`. Stored in Payload as `[{ url: string }]` (max 10 entries), transmitted to Merchant Center as `string[]`. Same shape semantics as `additionalImageLinks`.
  - Auto-rendered admin field with blocking inline validation: rejects URLs that are missing `http(s)://` or longer than 2000 characters (Google's published limits).
  - `videoLinks` is round-trip safe: pulled products from MC convert `string[]` back to `[{ url }]` for storage, mirroring `additionalImageLinks`.
  - `buildUpdateMask` emits `product_attributes.video_links` for consumers using the Merchant API `productInputs.patch` endpoint directly. (Note: the plugin's own sync uses `productInputs.insert`, which is a full-record replace - clearing `videoLinks` on a stored doc will clear it in MC on the next push.)

### Notes

- `additionalImageLinks` validation is unchanged; this release does not retroactively block existing data.
- Google's video requirements: URLs must be publicly reachable by Googlebot; raw video files (`.mp4`, `.mov`, `.mpg`, `.mpeg`, `.wmv`, `.avi`, `.flv`, `.mpegps`) or YouTube URLs; max 2000 chars; max 10 per product. See https://support.google.com/merchants/answer/15216925.

### Internal

- Forward and reverse transformers consolidate URL-array handling via a single `URL_ARRAY_FIELDS` set covering `additionalImageLinks` and `videoLinks`. Behavior for `additionalImageLinks` is unchanged and covered by existing tests.

## [1.1.0] - 2026-04-03

### Added

- **Local Inventory sync** - new `localInventory` config option enables syncing in-stock products to Google's Inventories sub-API for Local Inventory Ads and Free Local Listings
  - Automatic sync: when a product is pushed to MC and is `IN_STOCK`, a local inventory entry is inserted for the configured store; when not in-stock, the entry is deleted
  - Custom `availabilityResolver` callback for fine-grained control over which products appear as locally available
  - Batch reconciliation endpoint (`POST /gmc/local-inventory/reconcile`) to ensure all in-stock products have local inventory entries
  - Worker endpoint (`POST /gmc/worker/local-inventory/reconcile`) for external cron/scheduler triggers
  - New `MerchantService.reconcileLocalInventory()` method for programmatic access
  - Optional `pickup.sla` configuration for "Pickup Later" support (e.g., `'same day'`, `'6-day'`, `'multi-week'`). Note: `pickupMethod` is deprecated by Google (Sep 2024) and is NOT submitted.
- New Google API client methods: `insertLocalInventory()`, `deleteLocalInventory()`, `listLocalInventories()` targeting the Inventories sub-API (`inventories/v1`)
- Exported types: `LocalInventoryConfig`, `LocalInventoryAvailability`, `LocalInventoryInput`, `LocalInventoryPickupConfig`, `LocalInventoryPickupSla`, `LocalInventorySyncResult`

### Fixed

- `salePriceEffectiveDate` fields changed from Payload `date` type to `text` type - Google Merchant API requires full ISO 8601 timestamps (e.g. `2026-04-03T00:00:00.000Z`), not date-only strings; the `date` field type truncated timestamps and caused sale price effective dates to be rejected or misinterpreted

## [1.0.1] - 2026-03-18

### Fixed

- Analytics performance data not loading - MC Reports API returns `offer_id` in lowercase in `product_performance_view`; query now lowercases the offerId for performance lookups
- Reports API response parsing - results are wrapped in view-specific keys (`productPerformanceView`, `productView`) that were not being unwrapped
- Date parsing - MC returns dates as `{year, month, day}` objects, not strings; now correctly formatted as `YYYY-MM-DD`
- Status query now requests `status_per_reporting_context` for per-destination approval details (SHOPPING_ADS, FREE_LISTINGS, etc.)
- `buildProductStatusEntries` now properly parses MC's `statusPerReportingContext` array into readable status entries

## [1.0.0] - 2026-03-07

### Added

- Bi-directional product sync with Google Merchant Center via Merchant API v1
- Three sync modes: manual, onChange (auto-push on save), scheduled (cron)
- Declarative field mappings with transform presets (toMicros, extractAbsoluteUrl, toArray, etc.)
- Per-product sync controls (enable/disable, identity overrides, data source overrides)
- Admin dashboard with sync controls, sync log viewer, and field mapping editor
- Auto-injected Merchant Center tab on products collection
- Initial sync for bulk-pushing all products to MC
- Pull all with conflict resolution (mc-wins, payload-wins, newest-wins)
- Batch operations (push dirty, push by filter, push by IDs)
- Per-product analytics from MC Reports API (impressions, clicks, CTR, conversions)
- Token bucket rate limiter with configurable concurrency and queue depth
- Exponential backoff retry with jitter for 429/5xx responses
- Scheduled sync via Payload Jobs (autoRun) or external API-key-authenticated endpoint
- Health check endpoints (shallow and deep with API connectivity validation)
- Sync log collection with automatic TTL cleanup
- Dirty tracking for efficient incremental sync
- Structured logging with `[GMC]` prefix via Payload's pino logger
- Timing-safe API key comparison for cron endpoint authentication
- Inbound rate limiting with memory-bounded bucket storage
