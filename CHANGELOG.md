# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.2] - 2026-08-29

### Fixed

- **Critical: a bookkeeping write could unpublish a live product.** When a product had a pending draft version, the plugin's sync-state write reached `payload.update()` without a `draft` argument. Payload resolves that operation's base document with `getLatestCollectionVersion`, which returns the *latest* version — the draft — and then writes the merged result, `_status: 'draft'` included, straight onto the live row. A staff (or API) "save draft" on a published product followed by an `onChange` push therefore unpublished it. Sync state is now written only when there is no pending draft, always with an explicit `draft: false`, and `_status` is never sent.
- **Critical: the direct database-adapter write corrupted array fields.** `payload.db.updateOne()` routes through `upsertRow`, which documents itself as a full-row replace that "does not support partial updates". Two failures were reproduced against a real drizzle adapter: (1) array rows were written without the `id` that Payload's `baseIDField` `beforeChange` hook normally generates, so `mc.attrs.productTypes` inserts hit `insert into mc_product_types (_order, _parent_id, id, value) values ($1, $2, default, $3)` against a `varchar PRIMARY KEY NOT NULL` column and failed; and (2) `transformForWrite` registers *every* array field of the collection for deletion, including ones absent from the payload, so a partial `mc` write truncated unrelated array fields on the same collection — non-transactionally, so the deletes survived the failed insert. The direct-adapter path has been removed.
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
