# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0-rc.35] - 2026-08-30

### Stable release-gate fidelity

- Make `test:live` build first and import the plugin exclusively through its public package root, so the isolated Google smoke verifies the packaged transport surface rather than unpublished internal source paths.
- Define the live gate's exact evidence: API-primary source validation, ProductInput insert, processed-product observation, complete update, delete convergence, and already-absent idempotent delete against a uniquely namespaced test identity with cleanup.
- Stop treating that external transport lifecycle as proof of host deployment behavior. Executor, batch/feed, reconciliation, state-store, local-inventory, and durable-adapter semantics remain mandatory deterministic/real-database gates, while each consumer separately owns migration and deployment authorization.

## [2.0.0-rc.34] - 2026-08-30

### Release and consumer boundary

- Separate plugin release readiness from any consuming application's deployment authorization: the repository owner alone verifies and publishes stable `2.0.0`, after which each host installs the exact registry version, regenerates its lockfile, and passes its own migration and deployment gates.
- Prohibit vendoring release tarballs or committing pre-release `file:` dependencies in consumer repositories. Immutable tarballs remain valid only as external, local compatibility fixtures before the registry release exists.
- Correct the Fine's reference runbook to require the current schema-2 package rather than the superseded RC32 artifact while retaining dark ingress until its owner-controlled migration and staging gates pass.

## [2.0.0-rc.33] - 2026-08-30

### Current Merchant v1 vocabulary

- Accept the current Merchant API v1 `LIMITED_AVAILABILITY` product availability instead of rejecting a valid API projection, preserve it for API writes, and translate it to Google's documented `in_stock` product-file value rather than inventing `limited_availability`.
- Reject `PREORDER` and `BACKORDER` projections without their required `availabilityDate` before they can produce a guaranteed Merchant item issue.
- Correct the built-in TSV destination translation to Google's documented text-feed vocabulary: API `YOUTUBE_SHOPPING` now emits `Youtube_merchandise`, `YOUTUBE_AFFILIATE` emits `Youtube_affiliate`, and `VEHICLE_ADS` emits the documented `vehicle_ads` spelling.
- Continue to fail closed for API destinations with no documented TSV representation, including `YOUTUBE_SHOPPING_CHECKOUT` and `FREE_VEHICLE_LISTINGS`, instead of guessing a plausible but unverified text value. API publication remains available, and hosts can supply a custom feed adapter when Google or another provider defines a lossless format.

## [2.0.0-rc.32] - 2026-08-30

### Schema-stable local inventory

- Permit an explicitly configured `localInventory` capability to have empty active and retired store lists. This is an inert state that dispatches no store work while retaining the hidden causal publication collection, generated Payload types, and migration schema across developer, CI, and production environments.
- Updated the Fine's reference integration to configure local inventory structurally even when its store-code secret is absent. Production store activation remains deployment-configured, but Payload schema generation can no longer silently omit `gmc-local-inventory-publications-v2`.
- Added configuration and disabled-plugin regression coverage for the empty schema-stable state. Store retirement semantics remain unchanged: active stores must still move through `retiredStoreCodes` and complete deletion reconciliation before both lists become empty.

## [2.0.0-rc.31] - 2026-08-30

### Causal LocalInventory safety

- Added a hidden, non-versioned, CAS-backed local-inventory publication collection and public custom-store contract. It retains the greatest root-causal source version and exact desired digest per Merchant identity/store, rejects equal-version divergence, and prevents a delayed child from an older independent workflow from replacing newer store inventory.
- Added the canonical `productId` to every durable `localInventory.apply` command, fenced local mutations against current base-product ownership/state before and after Google control-plane reads, and revalidated the per-store claim immediately before whole-resource insert/delete.
- Advanced the durable command wire contract to schema 2. RC30 schema-1 rows must be drained or quarantined before upgrade; Fine's remains dark and has no live v2 rows.
- Added SQLite/PostgreSQL/MongoDB integration coverage for the local state collection, including stale-claim retention and equal-version divergent-content rejection. Host deployments now require an owner-generated migration for both hidden state collections.

### Replay, isolation, and configuration hardening

- Made `readCurrentDescriptor` mandatory for artifact stores. Feed-build replay now skips an obsolete source version from the pointer alone and verifies the exact immutable artifact before accepting an equal-version prior promotion, closing the promotion-before-ledger-completion crash window.
- Hash caller idempotency keys with instance and operation type before storing them, keeping raw credentials or sensitive caller tokens out of the durable ledger while preserving semantic isolation and bounded Fine's keys.
- Reject route-language collisions across static, dynamic, optional, and wildcard Payload routes; reject malformed nested custom-store/rate-limit configuration; scope async health/status, subjects, artifacts, and public health identity to `instanceId`; and fail status refresh on cross-source ownership instead of reporting a false remote absence.

### Release-chain security

- Dropped end-of-life Node 18/20 support and raised the runtime/CI floor to Node 22.12 LTS; Fine's already requires Node 24.
- Upgraded the security-sensitive test, compiler, Payload-compatible Next.js 16, image, browser, DOM, React, and package tooling so the release candidate does not rely on known-critical Vitest UI or SWC downloader versions. Added narrow patched-version overrides for vulnerable transitive build/test packages whose parents have not yet refreshed their ranges; the full release suite and adapter matrix verify those resolved versions. Both the complete and production-only pnpm audits now report zero known vulnerabilities; production audit remains a separate release hard gate because the npm artifact intentionally bundles no host framework dependencies.

## [2.0.0-rc.30] - 2026-08-30

### Artifact read isolation

- Independently verify that every artifact-backed feed read returns a descriptor in the exact requested `instanceId/feedId/sourceVersion-checksum.extension` namespace before serving bytes.
- Added cross-instance, cross-feed, and descriptor/key-divergence regression cases, and strengthened executor coverage to assert the complete instance-prefixed descendant subject.

## [2.0.0-rc.29] - 2026-08-30

### Multi-instance control-plane and artifact isolation

- Made `instanceId` mandatory on async operation lookup and health calls so shared durable adapters cannot expose or aggregate another plugin instance's ledger rows.
- Made `instanceId` mandatory on every artifact-store operation and included `instanceId/feedId` in generated immutable descriptor keys, preventing shared object stores and current pointers from colliding across plugin instances.
- Updated the Fine's PostgreSQL/S3 reference mapping with exact raw-subject scoping, instance-namespaced immutable objects and pointers, and real-PostgreSQL cross-instance lookup/descendant-isolation proofs.
- Reject request bodies on mutations whose complete intent is represented by the route, rather than silently accepting options that the batch operation will not execute.
- Reserved `.` and `..` as invalid instance IDs now that the identifier is a durable storage namespace.

## [2.0.0-rc.28] - 2026-08-30

### Exact HTTP intent boundaries

- Reject unknown fields in single-product publish/status bodies and in the optional durable-worker HTTP envelope instead of silently accepting intent the plugin will not execute.
- Reject leading/trailing whitespace in operation and root-operation IDs rather than normalizing distinct external identifiers onto one ledger identity.
- Changed the release pipeline to package and smoke one exact tarball after verification, transfer it with a SHA-256 manifest, and publish those same bytes without rebuilding in the npm job.

## [2.0.0-rc.27] - 2026-08-30

### Deployment runbook accuracy

- Corrected the migration runbook to distinguish Fine's implemented immutable GMC enqueue from its intentionally retained general superseding helper. Operators are no longer told that the current v2 adapter uses the non-conforming path.
- Added exact-package smoke coverage preventing public examples from reintroducing Merchant-specific eligibility or revision shadows.

## [2.0.0-rc.26] - 2026-08-30

### Canonical host projection contract

- Removed public examples that implied independently editable Merchant-specific eligibility or revision fields. V2 guidance now uses channel-neutral canonical catalog signals and explicitly prohibits recreating `merchantEnabled` or `merchantVersion` shadows in host schemas.
- Promoted the adapter-enforced full-reconciliation exclusion rule into the top-level requirements, including exact-key replay, different-key conflict, nonterminal descendant, and complete raw-subject semantics.

## [2.0.0-rc.25] - 2026-08-30

### Multi-instance reconciliation isolation

- Scoped atomic full-reconciliation exclusivity to the complete raw catalog subject. A shared durable adapter can now reconcile independent Merchant/plugin instances concurrently while still rejecting overlapping roots within each instance.
- Documented the indexed Fine's PostgreSQL implementation and expanded exact-package smoke coverage to verify the public workflow-conflict export and stable error contract.

## [2.0.0-rc.24] - 2026-08-30

### Atomic reconciliation exclusivity

- Made atomic, adapter-enforced exclusivity a required v2 capability for full `catalog.reconcile` roots. Authenticated API calls, schedules, and concurrent processes can no longer create overlapping reconciliation workflows under different idempotency keys.
- Added the exported `GmcAsyncWorkflowConflictError` contract and stable HTTP `409` behavior. Exact immutable-key replay still returns the retained active operation; different keys are rejected rather than incorrectly coalesced, and lineage-bearing continuations remain valid.
- Updated the Fine's ECS reference mapping to perform same-key resolution and the active-workflow query under its global PostgreSQL GMC insertion lock, with scheduler preflight retained only as friendly early feedback.

## [2.0.0-rc.23] - 2026-08-30

### Fine's deployment isolation contract

- Corrected the Fine's ECS reference deployment after a final task-role review: the Merchant worker receives only the Postgres/Scheduler links, Merchant/Payload configuration, Merchant queue URL, and `GetObject`/`PutObject` access below `gmc-feeds/v2/*`; unrelated application secrets, links, queue URLs, bucket listing/deletion, and canonical snapshot access are excluded.
- Corrected the serial Pinterest worker contract to use read-only canonical inventory-snapshot access instead of the Merchant artifact prefix policy.
- Documented the exact daily artifact and weekly full-reconciliation schedule, the retained-workflow non-overlap guard, production `quotas.list` requirement, and production-scale capacity gate.

## [2.0.0-rc.22] - 2026-08-30

### Root-causal ordering and targeted dependency publication

- Corrected workflow freshness semantics: every immediate root now supplies one globally ordered source version which every continuation and child must inherit exactly. Later child-ledger allocation can no longer make an older catalog sweep outrank a newer live Product event.
- Defined safe temporal activation: a future schedule is an immutable registration, then receives one freshly allocated and durably retained global source version when its boundary becomes active. Retries and every scheduled descendant reuse that value, closing the opposite failure mode where an old registration ID could suppress a legitimate time-derived update.
- Added bounded targeted dependency roots. Collection and Global dependencies can return the complete current/previous affected Product ID set, no work, or a full-sweep fallback. Target lists are validated, canonicalized, capped at 1,000 IDs, included in immutable intent, intersected with Product eligibility, and paged by durable worker coordinators rather than fanned out in a Payload transaction.
- Updated the Fine's ECS reference mapping with targeted category/media/promotion/Deal invalidation, activation-sequence retention, strict descendant validation, least-privilege Merchant artifact access, calendar-valid artifact timestamps, capacity-driven reconciliation guidance, and the requirement to derive actual request limits from Merchant `quotas.list` before rollout.

## [2.0.0-rc.21] - 2026-08-30

### Wire correctness, durable observability, and immutable packaging

- Replaced generic lowercasing of Google text-feed enums with explicit specification mappings. Pickup SLA values now serialize as `2-day` through `6-day` and `multi-week`, enum sentinels remain blank, and unknown future values fail closed instead of emitting plausible but invalid TSV.
- Wrapped OAuth, Merchant request, and response-stream transport failures in stable `GMC_GOOGLE_TRANSPORT` errors so network `TypeError`s remain retryable while malformed credentials, projections, invariants, and other deterministic `TypeError`s terminate without burning a durable retry budget.
- Made every durable command and nested identity envelope exact. Unknown fields now reject at producer and consumer boundaries instead of being silently ignored under a valid idempotency digest.
- Added bounded workflow observability: adapters expose the requested coordinator's state separately from aggregate state and can return fixed-size completed-page reconciliation totals for orphan, delete, remote, and page counts. The Fine's reference adapter computes them in one PostgreSQL aggregate, with real-database proof that malformed partial page output contributes nothing.
- Extended Fine's Merchant ledger and FIFO redrive budget from five to one shared fifteen-attempt constant, preserving per-offer blocking order while allowing asynchronous ProductInput processing to converge before dependent local inventory is dead-lettered.
- Hardened RFC 3339 boundaries across async health/operation timelines, feed generation and artifact metadata, dependency schedules, and the exported host timestamp validator. Calendar-invalid dates no longer normalize silently, and operation chronology compares actual instants rather than offset-bearing strings.
- Made package smoke testing non-destructive and immutable-artifact aware: it can install a caller-supplied tarball, never deletes repository-wide `*.tgz` files, and asserts that obsolete v1 setup guides are absent from the v2 package while all v2 runbooks ship.

## [2.0.0-rc.20] - 2026-08-30

### Merchant API error contract and host deployment hardening

- Parse the current AIP-193 `google.rpc.ErrorInfo` response contract and preserve Google's stable `details.metadata.REASON`, bounded developer message, and field location on `GoogleApiError`. Durable host failures now carry an actionable `GOOGLE_<REASON>` code instead of status-only diagnostics.
- Drive retry decisions with stable Merchant reasons where available: transient internal, rate, and concurrent-modification failures back off even when the HTTP status alone is ambiguous, while daily/account quota exhaustion does not amplify through local and queue retries. HTTP status remains the compatibility fallback for sub-APIs that have not rolled out ErrorInfo.
- Hardened the Fine's reference deployment after an end-to-end SST review: all registered queue links are now registry-derived (including `WatermarkQueue`), the Scheduler role is limited to the seven main queue ARNs, ECS `iam:PassRole` is limited to the Scheduler and MediaConvert roles, and the canonical artifact envelope is 50,000 products / 128 MiB so it exceeds the existing ~28,000-row catalog with bounded headroom.
- Expanded the owner-generated migration gate to enumerate the complete publication-state field, index, uniqueness, deletion-fence, timestamp, and versions contract.

## [2.0.0-rc.19] - 2026-08-30

### Transactional host verification

- Updated the Fine's ECS deployment mapping after enabling real Payload PostgreSQL transactions in the host. The installed plugin and actual durable adapter now have commit/rollback proofs for Product hooks, collection dependencies, and Global dependencies on one atomic outbox boundary.
- Kept the deployment explicitly dark and non-production-ready until the owner-generated migration, production API-primary source/credential validation, shadow comparison, canary, failure-recovery exercises, and production-scale load evidence are complete.

## [2.0.0-rc.18] - 2026-08-30

### Processed-product ownership for local inventory

- Fence every local-inventory insert and delete with a processed-product ownership read. If another data source owns the identity, terminal `GMC_PRODUCT_DATA_SOURCE_CONFLICT` now prevents mutation of that source's inventory.
- Treat the asynchronous interval between ProductInput acceptance and processed-product visibility as retryable `GMC_PROCESSED_PRODUCT_NOT_READY` for active inventory inserts. A missing processed product already satisfies deletion/retirement intent and completes without a remote delete.
- Document the extra processed-product read in account-wide quota and source-migration planning.

## [2.0.0-rc.17] - 2026-08-30

### Final-store retirement

- Permit `localInventory.storeCodes` to be empty while one or more codes remain in `retiredStoreCodes`, allowing the last active Business Profile location to run the same deletion-only reconciliation and drain protocol as every other retired store.
- Continue to reject an empty local-inventory feature, overlapping active/retired ownership, duplicate codes, unsafe codes, and more than 1,000 combined codes.

## [2.0.0-rc.16] - 2026-08-30

### Merchant ownership and wire safety

- Made multi-source routing fail closed: with more than one API-primary source, every source must expose a complete immutable language/label scope and every scope must be pairwise disjoint before any product-plane call.
- Added a processed-product ownership read immediately before every ProductInput insert. A different owning source now raises terminal `GMC_PRODUCT_DATA_SOURCE_CONFLICT` and performs no insert, preventing Google's insert method from silently moving the identity.
- Rejects duplicate processed identities across different projector routes and serializes routed variants on one route-independent offer subject.
- Centralized non-negative signed-int64 validation with a 19-digit lexical bound before `BigInt` conversion, including source versions, product integer attributes, prices, local inventory, artifacts, transport responses, and HTTP inputs.

### Local inventory lifecycle

- Added `localInventory.retiredStoreCodes`. Retired stores bypass projection and emit deletion-only work for every canonical offer until a complete reconciliation proves cleanup. Queued pre-retirement inserts become deletes at execution, while removed/unknown stores fail without remote mutation. Active and retired codes are normalized, disjoint, and bounded to 1,000 total.
- Corrected the operator contract to document offer-wide FIFO serialization across ProductInput and every local-inventory store write.

### Fine's durability and scale proof

- Replaced Fine's unbounded workflow-row materialization with one constant-size PostgreSQL aggregate for state precedence, descendant counts, workflow timestamps, and a representative failure.
- Added real PostgreSQL proof that the installed plugin plus Fine's actual immutable adapter commit the canonical Product and pending outbox row atomically, and roll both back when a later hook fails.
- Added private `no-store` and `nosniff` headers to every v2 JSON control-plane response while retaining explicit public/private feed caching.

## [2.0.0-rc.15] - 2026-08-30

### Fine's dark rollout gate

- Documented Fine's strict `GOOGLE_MERCHANT_V2_ENABLED` cutover flag. Merchant IDs alone no longer activate v2 in the reference deployment; the flag remains false until migration, real Payload transaction, API-primary source, worker-health, and canary gates all pass.
- Added an exact installed-package PostgreSQL 3.84.1 regression proof in Fine's host suite for the disabled-transaction `Promise<null>` behavior fixed in RC14.

## [2.0.0-rc.14] - 2026-08-30

### Transaction proof hardening

- Fixed automatic-hook transaction detection to await and validate Payload's resolved transaction handle. An adapter with transactions disabled leaves a truthy `Promise<null>` on `req.transactionID`; RC13 mistook that wrapper for a live transaction and could allow a canonical commit without an atomic outbox insert.
- Added a real PostgreSQL regression configuration with `transactionOptions: false` proving `GMC_TRANSACTION_REQUIRED` is raised before the canonical row commits and before the async adapter is called.
- Made the portable integration matrix transaction-honest: SQLite explicitly enables its opt-in transactions, MongoDB runs as a replica set with collections initialized before transactional writes, and PostgreSQL covers both enabled commit behavior and disabled fail-closed behavior.

### Verification

- Retained the deterministic 552-test release suite and added the real disabled-transaction PostgreSQL proof to the SQLite/PostgreSQL/MongoDB adapter matrix.

## [2.0.0-rc.13] - 2026-08-30

### Fine's deployment hardening

- Corrected the Fine's deployment checklist to use its configured `/merchant-center/v2/data-sources/validate` route rather than the plugin's default `/gmc/v2` base path.
- Tightened the reference host's Merchant control-plane access to `admin` and `owner`; ordinary sales edits already converge through transactional plugin hooks and no longer grant account-wide publish, reconcile, feed-build, or operational-state access.

## [2.0.0-rc.12] - 2026-08-30

### Merchant source ownership

- Made `productIngestion: { mode: 'api-primary' }` an explicit required v2 contract. Structured canonical ProductInput is the authority; TSV/XML/custom feeds remain canonical export/read models and must not be registered as a competing Merchant primary file source for the same offers.
- Added Data Sources v1 control-plane transport and strict response parsing. Every configured source must resolve by exact account/name/ID as `input: API` with a primary-product source; file, supplemental, mismatched, malformed, and oversized resources fail closed.
- Verify the routed source immediately before every physical ProductInput, processed-product, reconciliation, and local-inventory operation. Source language/feed-label restrictions must accept the canonical identity. Verified reads are coalesced and cached for five minutes but still consume the same distributed rate limit and retry policy as every Merchant request.
- Added the authenticated `POST /gmc/v2/data-sources/validate` durable preflight. It performs no product-plane writes, verifies every configured API-primary source and canonical feed scope through the production worker, and returns auditable workflow status.

### Durable failure semantics

- Exported `classifyGmcCommandError()` so host workers can distinguish terminal validation/configuration/Google 4xx failures from transient infrastructure and Google 408/429/5xx failures without parsing error messages.
- Updated the Fine's ECS reference worker to persist terminal plugin failures as dead and ACK once, while preserving retry/NACK behavior for transient failures.

### Verification

- Expanded the deterministic suite to 552 tests across 54 files with direct source-response, source-scope, no-write preflight, rate-limit, transport-route, endpoint, cache, and durable error-classification coverage.

## [2.0.0-rc.11] - 2026-08-30

### Transactional hook enforcement

- Automatic Product, catalog-dependency collection, and catalog-dependency Global hooks now require an ambient Payload database transaction. A missing `req.transactionID` fails before projection or durable dispatch with the exported `GmcTransactionalHookRequiredError` and stable `GMC_TRANSACTION_REQUIRED` code.
- Closed the silent canonical-commit/outbox crash gap in hosts that declare a transaction-aware adapter while disabling Payload transactions or passing `disableTransaction: true`. On-demand, scheduled, coordinator, and continuation dispatches remain valid through an adapter-owned transaction because they are not coupled to a simultaneous canonical mutation.
- Documented database transactions as a deployment prerequisite and promoted Fine's current `transactionOptions: false` setting to an explicit production blocker requiring owner review and commit/rollback proof.

### Verification

- Expanded the deterministic suite to 536 tests across 52 files with direct fail-closed coverage across Product change/delete and collection/Global dependency hooks. Real Payload integration proves a non-transactional create cannot commit, a non-transactional delete cannot remove its row, and enabled transactions still carry automatic operations through the supported adapter path.

## [2.0.0-rc.10] - 2026-08-30

### Merchant wire-contract correctness

- Added one exact protobuf Timestamp parser shared by canonical ProductInput and LocalInventory validation. Calendar dates, offsets, the legal year range, one-to-nine fractional digits, and interval ordering are now checked at nanosecond precision across both resources.
- Made every known Product `Price` fail closed at the plugin boundary: only `amountMicros` and `currencyCode` are accepted, micros must be a non-negative signed-int64 string, and currencies must be uppercase ISO 4217 identifiers. This now covers regular, sale, automatic-pricing minimum, maximum-retail, and cost-of-goods prices.
- Enforced canonical product sale-price currency and ordering before either feed serialization or Merchant transport. Legacy Payload interval wrappers remain normalized, while unknown interval fields and ambiguous legacy/API field mixtures are rejected.
- Cross-validates each local store price and loyalty benefit against its canonical online offer before durable child dispatch. Store prices must retain the canonical currency; loyalty member prices use the store price when present and otherwise cannot exceed the canonical product price.

### Verification

- Expanded the deterministic suite to 534 tests across 52 files, including direct rejection coverage for malformed/extended Product Prices, cost-of-goods validation, sale-price currency/order, malformed timestamps and intervals, nanosecond ordering, canonical/local currency drift, and loyalty prices above the online offer.

## [2.0.0-rc.9] - 2026-08-30

### Merchant Inventories v1 completeness

- Added API-native local-inventory loyalty programs: member price/effective interval, cashback, points, shipping benefit, and program/tier labels. Labels and benefits remain canonical product/store derivations; they are never independently editable Merchant shadow fields.
- Updated the LocalInventory writable allowlist for Google's 2026 `localShippingLabel`, recursive `customAttributes`, and `loyaltyPrograms` additions. Output-only and unknown root, attribute, loyalty, interval, and Price fields now fail closed before durable transport.
- Tightened runtime wire validation: required availability, 64-character Business Profile store codes, 100-character local shipping labels, exact string int64/Price shapes, local price/currency consistency, case-insensitive loyalty identity uniqueness, and 256 KiB serialized input bounds.
- Replaced permissive JavaScript date parsing with protobuf-compatible RFC 3339 validation across legal calendar dates, UTC offsets, open/equal intervals, the Timestamp year range, and one-to-nine fractional digits. Nanosecond ordering is preserved rather than truncated to milliseconds.

### Verification

- Added direct tests for the complete current loyalty resource, malformed untyped Price objects, unknown/output fields, case-insensitive duplicates, price/currency invariants, exact store/label/input bounds, and nanosecond interval behavior.

## [2.0.0-rc.8] - 2026-08-30

### Canonical projection and feeds

- Added API-native recursive `CustomAttribute.groupValues` support to both ProductInput and local inventory. One shared fail-closed boundary strips only Payload row IDs, requires exactly one non-empty value/group at every node, rejects unknown fields and normalized sibling-name collisions, and enforces 2,500-node, 102,400-character, 10,240-character-per-node, and 20-level limits. The built-in TSV format rejects grouped attributes rather than flattening them incorrectly.
- Hardened TSV output against schema drift and wire mismatches. ProductInput root fields and ProductAttributes now require explicit text-feed mappings, generic names normalize to Google-compatible snake case, ambiguous strong/generic column collisions reject, destination/energy/size enums use defined feed spellings, unsupported enum values fail closed, and every row retains the header's full trailing width.
- Excluded explicit draft-shaped rows from canonical collection/feed passes, even when an adapter returns them for `draft: false`. Conditional feed responses now retain content type, cache policy, ETag, and `nosniff` headers on `304 Not Modified`.
- Made exact authoritative input-size boundaries deterministic and preserved plugin-owned int64 `versionNumber` control by rejecting projector-supplied ProductInput root fields outside the explicit writable set.

### Durable orchestration and state

- Added `catalogGlobalDependencies`, giving Payload Globals the same selector-aware, scheduled, durable catalog invalidation workflow as collection dependencies. Collection event idempotency now includes complete current/previous selected documents so cyclic A → B → A → B transitions cannot reuse stale operations while exact retries still deduplicate.
- Added `products.maxCatalogPages` (default 10,000; maximum 1,000,000) as a hard safety ceiling for dynamic/artifact feed collection, catalog publication, desired reconciliation, and local-inventory reconciliation. Every continuation carries a validated page index and fails before emitting a truncated authoritative scan.
- Bounded publication-state scans to 1,000 active identities per product and excluded retained deleted fences from default fan-out. Custom state stores are held to the same contract before transport work begins.
- Stopped spawning local-inventory children for an empty online projection; authoritative ProductInput absence now removes attached local inventory without creating a guaranteed poison command. Direct product deletion also retains the authoritative command source version in the offer deletion fence.
- Made scheduled catalog command times deterministic and retained exact future boundaries through command validation and replay.

### Fine's ECS reference deployment

- Added strict Deal-of-the-Month Global invalidation and propagated relation/read-model failures rather than converting them into absent canonical content.
- Changed outbox ordering from an account-wide advisory lock to a per-subject lock, preserving FIFO for one Merchant subject while allowing unrelated subjects to publish concurrently. Real PostgreSQL tests prove 100-command same-subject order and cross-subject progress.
- Enforced `scheduled_for <= now()` in the database claim, rounded SQS/EventBridge delivery up so a command cannot run early, and validates an existing same-name EventBridge schedule byte-for-byte on create conflicts.
- Derived Merchant claim leases from the configured handler timeout with a five-second guard and capped the lease at 31 minutes, so a 30-minute isolated handler cannot be redelivered while still running.
- Split readiness from incident history: only dead operations in the current 24-hour health window degrade readiness, while lifetime dead counts remain visible for audit. Production configuration now fails fast on missing Merchant credentials, artifact bucket/public HTTPS URL, or scheduler role.

### Verification

- Expanded deterministic v2 coverage to 522 tests across 52 files, retained the real SQLite/PostgreSQL/MongoDB integration matrix, and added scheduler-conflict, global-dependency, scan-ceiling, active-state-bound, recursive-custom-attribute, row-width, and PostgreSQL concurrency proofs.

## [2.0.0-rc.7] - 2026-08-30

### Safety

- Made remote orphan deletion fail closed. Reconciliation now detects and reports `orphanCount` in every deployment, dispatches no orphan deletes by default, and requires the explicit `exclusive-data-sources` ownership mode before returning a nonzero `orphanDeleteCount`.
- Hardened published-document resolution across real Payload draft lifecycles. An explicit non-published `_status` is authoritative absence even when an adapter returns a document for `draft: false`; create hooks no longer derive synthetic previous identities. Real SQLite coverage now proves draft-only create, pending draft over a live product, unpublish, and deletion behavior.
- Bounded processed-status work by fanning multi-offer refreshes into one durable, offer-ordered child per identity instead of serially polling up to 1,000 remote offers in one handler.
- Tightened distributed limiter reservations to one minute plus clock skew and rejects multi-window reset times. Artifact read-back now rejects untrimmed content types as well as controls, oversize metadata, byte mismatch, and checksum mismatch.

### Fine's ECS reference deployment

- Replaced Fine's best-effort per-product enrichment loader on the authoritative Merchant path. Category, color, and promotion state is now loaded through bounded published keyset pages, read failures and malformed/duplicate canonical rows fail the operation, shared reads coalesce by immutable `projectionTime`, and rejected cache promises are evicted for durable retry.
- Fixed a canonical inventory defect where a promotion with explicit `promoProducts` and no category could be treated as global in full-catalog projection. Fine's now filters the complete active-promotion table through one shared applicability predicate before Merchant custom labels/shipping are derived.
- Added `media` to plugin-owned catalog dependencies so URL/MIME changes cannot leave embedded image/video output stale.
- Made destructive Fine's reconciliation require `GOOGLE_MERCHANT_DATA_SOURCE_EXCLUSIVE=true`; missing/false remains detect-only and malformed values fail startup. Fine's also caps remote reconciliation at 100 pages (100,000 offers).
- Set explicit Fine's transport bounds (four attempts total, 20-second request timeout, 30-second maximum backoff) and a 30-minute isolated Merchant handler with a three-hour SQS visibility lease, 60-second handled-failure retry, and timeout fail-stop behavior.
- Strengthened immutable replay validation to compare scheduled delivery and denormalized parent/root lineage as well as command digest and raw subject; the ordered publisher validates those denormalized fields before SQS publication.

### Documentation

- Documented detect-only versus exclusive-source reconciliation, true pause semantics (`disabled` does not cancel durable rows), primary-source ownership, moving keyset feed views versus strict snapshots, relation-read fail-closed requirements, pointer-aware artifact retention, worker timeout sizing, and the updated four-service/six-queue Fine's topology.

## [2.0.0-rc.6] - 2026-08-29

### Documentation

- Updated the verified Fine's ECS mapping with the subject-ordered PostgreSQL outbox publisher and completed 100-way real-Postgres adapter proof. The remaining production gate is testing the owner-generated migration itself, not the enqueue/publication algorithm built from a pushed scratch schema.

## [2.0.0-rc.5] - 2026-08-29

### Fixed

- Added a plugin-owned semantic command digest for durable adapter conflicts. It covers every execution-relevant field while excluding diagnostic `requestedAt`, so replaying one HTTP `Idempotency-Key` or dependency hook reuses the original immutable operation instead of falsely conflicting because the retry occurred at a later wall-clock instant.

## [2.0.0-rc.4] - 2026-08-29

### Fixed

- Bounded aggregate canonical ProductInput JSON before feed formatting, preventing a catalog of individually valid but very large projections from exhausting worker/request memory before the serialized-size guard ran.
- Enabled configurations now fail fast unless Merchant account and data-source IDs are canonical positive int64 resource identifiers; deliberately disabled configurations may retain inert local placeholders.
- Hook idempotency now hashes the actual saved/deleted document and resolved cleanup identities, so distinct writes sharing one database timestamp cannot collapse into a stale durable operation.
- Added an optional durable executor `sourceVersion` override and execution-pinned `projectionTime`, allowing a global async-ledger sequence to order time-driven and same-timestamp derivations across every worker.
- Mutation/worker endpoints now enforce the 1 MiB limit while reading unknown-length request streams, before JSON parsing, and the optional worker bridge accepts the same durable source-version override as direct execution.
- An idempotent delete against an already-deleted offer now atomically raises a newer deletion fence before skipping transport, preventing a delayed intermediate-version publish from resurrecting it.
- Reconciliation continuations retain the root durable sequence and use it as the desired-state barrier, eliminating cross-worker clock skew from orphan decisions when a ledger sequence is available.
- Untrusted error objects can no longer inject invalid/non-error HTTP status codes; malformed status values are logged and redacted as 500 responses.
- Distributed limiter denials now reject implausibly distant reset times and use a bounded skew backoff, preventing Node's long-timer clamp from becoming a hot loop.

### Added

- Plugin-owned `catalogDependencies` hooks for canonical relation collections, with projection-input selection, change suppression, deletes, and optional exact future boundaries through durable `scheduledDelivery`.
- Async dispatch now carries an optional durable `scheduledFor` not-before value; conforming adapters include the schedule in immutable-key conflicts and never expose it before commit/time.

### Operations

- Documented peak-memory headroom and pointer-aware immutable artifact retention. Blind age expiration is explicitly unsafe because it can delete the current last-known-good feed.
- Fine's measured health now treats a ready GMC backlog older than 15 minutes as degraded and reports explicit reason codes alongside ledger/SQS/DLQ measurements.

## [2.0.0-rc.3] - 2026-08-29

### Fixed

- Added durable deletion-version fences so cross-subject reconciliation races cannot resurrect or delete an offer at an older/equal canonical source version.

## [2.0.0-rc.2] - 2026-08-29

### Changed

- Hardened the published package boundary so no legacy runtime constants, validation implementation, type runtime, engine, hooks, collections, or admin modules are physically shipped.
- Added HTTP 408 to the v2 Merchant transport retry classification.

## [2.0.0-rc.1] - 2026-08-29

### Breaking

- The package root is now v2: a strictly one-way desired-state publisher and canonical feed engine. The historical bidirectional 1.x API is not exported or shipped; rollback artifacts must remain pinned to 1.x during migration.
- Removed v2 concepts of pull sync, conflict resolution, editable Merchant shadow fields, dirty flags, sync snapshots, and plugin-managed process-local background work.
- A host-provided durable async adapter is mandatory. It must atomically retain one operation per idempotency key, join host transactions or an outbox, deliver at least once, serialize by subject, preserve parent/root lineage, expose aggregate workflow status, and report measured health.
- Host projection now returns complete API-native ProductInput records plus a monotonic int64 `sourceVersion`; `products: []` is authoritative absence.
- Artifact-backed feeds require exact immutable read-back verification before atomic pointer promotion.

### Added

- Schema-versioned bounded commands for product/offer publication and deletion, catalog publish/reconciliation, feed builds, status refresh, and local-inventory reconciliation/application.
- Mandatory worker executor boundary with durable parent/root fan-out, deterministic idempotency keys, per-offer ordering subjects, retries, request timeouts, OAuth token coalescing, and optional distributed rate limiting.
- Deterministic canonicalization and SHA-256 content digests shared by API publication and feeds, with strict core Merchant validation and a forward-compatible API ProductAttributes boundary.
- Google Merchant API v1 ProductInput, processed-product, status, and local-inventory transport with idempotent not-found deletion behavior.
- Dynamic and last-known-good artifact feed delivery, a fail-closed deterministic Google TSV serializer, selectors, size/product limits, ETags, and explicit feed access.
- Hidden non-versioned publication-state collection with identity ownership, monotonic source-version protection, real adapter-level compare-and-set for SQLite/PostgreSQL/MongoDB, and custom-store support.
- Two-phase reconciliation with a stable desired-state barrier, explicit configured-data-source ownership, remote-existence verification, and conditional orphan deletion.
- Authenticated on-demand/batch/status/feed/inventory endpoints, durable operation lookup, measured health, and an optional independently authenticated worker bridge.
- Real SQLite, PostgreSQL, and MongoDB integration matrix, forced state races, draft safety/lifecycle tests, packaging smoke tests, Payload minimum/current compatibility CI, and optional safe live Merchant smoke coverage.
- Complete v2 architecture, setup, async adapter, Fine's ECS deployment, operations, and 1.x migration runbooks.

### Security

- Credentials resolve only in worker transport and are never serialized into durable commands.
- Mutation endpoints require an authenticated user, explicit access policy, bounded body, and caller idempotency key. Feed access is explicit and protected feed responses are never publicly cacheable.
- Commands, async adapter results, feed artifacts, identities, projections, and local-inventory input fail closed at runtime boundaries.
- Reconciliation scans/deletes only explicitly configured primary data sources; later desired claims win deletion races.

### Migration

- V1 and v2 must never write the same primary data source concurrently. Follow `docs/v2-migration.md`; legacy product fields and collections are not deleted automatically.

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
