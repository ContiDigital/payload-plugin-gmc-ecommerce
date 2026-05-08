# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
