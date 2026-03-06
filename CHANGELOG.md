# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - Unreleased

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
