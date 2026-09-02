# Migration from payload-plugin-gmc-ecommerce 1.x to 2.0

V2 is a replacement ownership model, not an in-place toggle. V1 stores editable Merchant fields and sync metadata on Products, supports pull/conflict modes, and may use Payload Jobs or external sync endpoints. V2 derives complete output from canonical host data, writes only hidden operational state, and requires a durable host adapter for every background operation.

Never operate v1 and v2 writers against the same primary data source at the same time.

## Breaking changes

- Node 18 and 20 are end-of-life and no longer supported. Run web and workers on Node `^22.12.0 || >=24.0.0` before installing v2.
- The package root exports v2. The 1.x engine is not included in the v2 package; retain a separately pinned 1.x application artifact for the rollback window.
- Pull sync, conflict resolution, Merchant-to-Payload writes, editable `mc` product fields, dirty tracking, mapping collections, sync logs, dashboard actions, and plugin-managed long-running execution are not part of v2.
- `productIngestion: { mode: 'api-primary' }`, `async`, `products.project`, `products.resolveIdentities`, `access`, `workerAccess`, and at least one canonical export feed are required.
- Every configured data source must be an API-backed primary product source. Plugin feeds are exports and must not be registered as competing Merchant primary file sources for the same identities.
- Multiple configured sources require complete, pairwise-disjoint immutable language/label scopes. ProductInput insert can move an existing processed identity; v2 refuses that implicit transfer with `GMC_PRODUCT_DATA_SOURCE_CONFLICT`.
- Artifact stores require `put`, exact immutable `read`, atomic `promote`, pointer-only `readCurrentDescriptor`, and matched body/descriptor `readCurrent`; every operation receives `instanceId` and must isolate both objects and current pointers by that namespace.
- Async `getOperation` and ledger health receive `instanceId` and must exclude rows belonging to every other plugin instance.
- Product projection returns `products: []` for authoritative absence, not `null` or a partial patch.
- `sourceVersion` is a mandatory monotonic int64 string for a projection.
- Every worker execution must override it with a durable global ledger sequence; its offset must exceed prior remote versions and survive restore.
- On-demand and batch API calls return durable operation receipts, not completion.
- Operation status is aggregate across the root and every descendant.
- The built-in product and local-inventory publication-state stores support official SQLite, PostgreSQL, and MongoDB adapters; custom adapters need custom atomic stores for each configured state domain.
- RC31 uses command schema 2. Drain or quarantine all RC30 schema-1 workflows before upgrade; once schema-2 commands exist, rollback requires the symmetric drain/quarantine.

## Phase 0: freeze ownership decisions

Document and approve:

- which host fields and relations are canonical for every submitted attribute;
- how variants map to stable offer IDs;
- feed labels, languages, destinations, data sources, and local stores;
- eligibility and unpublish semantics;
- which legacy Merchant-only values, if any, must be promoted into canonical host fields;
- the monotonic version and dependency-invalidation design;
- the durable ledger/queue ownership and operator SLA.
- whether every configured primary data source is exclusive to this plugin;
  default reconciliation to detect-only until that inventory is proven.

The migration must not preserve an unused editable Merchant shadow “just in case.” If a value matters, choose a canonical source field and migrate it there before v2. If it does not matter, explicitly retire it.

A data-source move is a separately approved migration, not an ordinary v2 publish. Stop every old writer, snapshot identity/source ownership, validate the new API-primary source and its scope, perform the bounded transfer with an audited operator tool or remove the old ProductInput before v2 publication, verify the resulting processed source, then reconcile plugin state. Never expose a generic runtime flag which lets routine retries move products between sources.

## Phase 1: inventory the v1 deployment

Capture a production inventory before changing code:

- all v1 config and sync modes;
- every field mapping and transform;
- `mc.enabled`, identity overrides, data-source overrides, attrs, custom attributes, snapshot, and sync metadata usage;
- mapping, sync-log, and job collections;
- Payload Jobs tasks/queues/schedules and external cron endpoints;
- code calling v1 services or endpoints;
- Merchant account/data-source ownership;
- current remote offer count, identities, versions, issues, and source names;
- current TSV/provider endpoints and their canonical source;
- local-inventory behavior and stores.

Search host code and database usage rather than assuming an admin feature was unused. Export a bounded audit snapshot with sensitive content protected.

## Phase 2: build the canonical commerce projection

Implement one host projection used by both API publication and plugin-owned feeds. Where practical, build it on the channel-neutral inventory/read model already used for Pinterest or other exports, but do not assume another provider's schema is Google-complete.

For every representative product class prove:

- stable identity and correct variants;
- correct URLs, images, prices, sales, availability, identifiers, taxonomy, and labels;
- full disappearance when disabled/unpublished/ineligible;
- deterministic output for a stable data snapshot;
- one restore-safe global root-causal sequence, exact descendant inheritance,
  and activation-time allocation for future schedules;
- relation/read-model failures abort instead of emitting degraded output;
- media URL/MIME changes and every other independently mutable relation enter
  the plugin dependency workflow;
- no read from `mc`, Google snapshots, publication state, or current remote content.

Create golden fixtures comparing legacy effective Merchant output to v2 canonical output. Classify every difference as an intentional correction, migrated canonical value, or blocker.

## Phase 2.5: release and consumer package boundary

Treat plugin publication and host deployment as two independently authorized
changes:

1. Test one immutable release-candidate tarball from outside the consumer
   repository. Record its package version and SHA-256 digest.
2. Do not copy that tarball into the consumer repository, commit a `file:`
   dependency, publish it, tag it, or deploy it as part of compatibility
   testing.
3. The plugin repository owner reviews the exact candidate, runs every stable
   release gate—including exact-artifact install smoke and the isolated public
   packaged-transport lifecycle against a designated Merchant test source—and
   alone authorizes publication of `2.0.0` to the package registry. The live
   smoke proves Google API-primary validation and one uniquely namespaced
   insert/read/update/delete lifecycle; it does not replace the deterministic
   executor/adapter/feed/state suites or any consumer deployment proof.
4. Only after the registry confirms `2.0.0` exists should a host replace its
   prior dependency with exact registry version `2.0.0`, regenerate the
   lockfile, and verify the installed package metadata and integrity.
5. Re-run the complete host test/build/migration suite against the registry
   package. Passing those checks still does not authorize deployment; follow
   the host's separate change-control process for the dark deployment and live
   rollout phases below.

This boundary prevents a local compatibility artifact from becoming an
undeclared production supply-chain dependency and ensures that a reusable
plugin release does not silently deploy any consumer.

## Phase 3: deploy infrastructure dark

Deploy without enabling v2 hooks or endpoints:

- async ledger schema and immutable GMC uniqueness invariant;
- Payload database transactions enabled for Product, dependency-collection, and dependency-Global writes; automatic v2 hooks deliberately fail when `req.transactionID` is absent;
- parent/root lineage and aggregate status query;
- transactional outbox integration;
- dedicated ordered worker queue and DLQ;
- singleton plugin executor and distributed rate limit where needed;
- publication-state collection migration matching the plugin-owned contract:
  unique indexed `key`; indexed `productId`, `status`, and `storeCode`; plus
  `merchantId`, `dataSourceName`, `contentLanguage`, `feedLabel`, `offerId`,
  `operationId`, `revision`, `desiredAt`, `desiredDigest`, `publishedDigest`,
  `publishedAt`, `observedAt`, `remoteMissing`, `remoteVersion`,
  `remoteStatus`, and `error` with timestamps enabled and versions disabled;
- local-inventory publication-state collection migration matching the plugin-owned contract:
  unique indexed `key`; indexed `merchantId`, `dataSourceName`,
  `contentLanguage`, `feedLabel`, `offerId`, `storeCode`, `productId`, `status`,
  `operationId`, `revision`, `desiredAt`, and `desiredVersion`; plus
  `desiredDigest`, `publishedDigest`, `publishedVersion`, `publishedAt`, and
  `error`, with timestamps enabled and versions disabled;
- artifact store and current-pointer mechanism;
- health checks, metrics, dashboards, and alerts;
- service-account secret and least-privilege IAM.

Set plugin `disabled: true` while migrations and worker registration land. This suppresses new plugin hooks/endpoints; it does not pause previously committed rows, so keep Merchant schedules off and the Merchant worker scaled to zero until the schema and handler are ready. Run the [async conformance suite](./v2-async-adapter.md) against the deployed infrastructure, including 100-way duplicate dispatch and transaction rollback.

Fine's must complete every gate in [the ECS deployment mapping](./v2-fines-ecs.md). Its v2 adapter uses the dedicated immutable enqueue path described there; the general superseding helper retained for unrelated email/media/promotion work is not a conforming substitute.

## Phase 4: shadow validation with no production writes

Run the projector and feed builder against production-like snapshots without pointing worker commands at the production data source. Options include:

- pure fixture/golden execution;
- artifact feed generation to a non-registered path;
- a dedicated Merchant test/canary data source;
- transport recording in a test harness.

Compare:

- total documents and total offers;
- identity set and duplicate detection;
- per-field canonical values and digest;
- API input versus TSV row semantics;
- feed bytes, row widths, encoding, and provider validation;
- expected removals from ineligibility and identity changes;
- worst-case projection/build time and memory.

Do not use the production primary source for an uncontrolled shadow writer.

## Phase 5: canary

Use a dedicated data source or an explicitly bounded offer cohort whose ownership cannot overlap with v1. Canary all lifecycle paths:

1. draft-only create;
2. first publish;
3. update and duplicate delivery;
4. related price/promotion/stock invalidation;
5. variant addition and removal;
6. offer identity change;
7. unpublish and eligibility removal;
8. document delete;
9. missing remote repair;
10. orphan detection with deletion disabled;
11. owned orphan deletion only after exclusive-source attestation;
12. status refresh and item issues, including multi-offer fan-out;
13. local inventory insert/delete if configured;
14. artifact build/read-back/promotion/serving;
15. worker crash/redelivery and DLQ recovery;
16. aggregate workflow completion.
17. reverse-causal delivery of independent local-inventory roots, proving the newer per-store claim wins without an older Google write;
18. artifact promotion crash replay, proving exact immutable-object verification and no divergent rebuild;

Record evidence and operator sign-off. A green coordinator row without green descendants is not evidence.

## Phase 6: production cutover

Prepare one reversible change window.

1. Pause v1 schedules, external cron, job dispatch, admin actions, and dependency hooks.
2. Drain or account for every v1 queued/in-flight operation.
3. Disable v1 product hooks and worker routes.
4. Verify no remaining process can write the production data source through v1.
5. Deploy the v2 plugin configuration, async adapter, worker handler, queue routing, state migration, projection, and feed definitions.
6. Enable v2 hooks and authenticated endpoints.
7. Enqueue one bounded canary publication and verify aggregate success/processed output.
8. Enqueue full `catalog.publish` and monitor descendants.
9. Build/promote the production artifact export and validate its downstream-provider URL; confirm it is not registered as a competing Merchant primary source.
10. Run `catalog.reconcile` in detect-only mode only after the complete desired sweep has succeeded; review orphan candidates.
11. Enable `exclusive-data-sources` and rerun only after the ownership inventory and bounded canary delete are signed off.
12. Monitor queue/outbox/DLQ, publication states, Merchant responses/issues, feed freshness, and remote counts throughout the window.

The reconciliation order is intentional. Publishing desired state first minimizes any orphan-delete risk and establishes v2 ownership records.

## Legacy schema cleanup

Do not let the plugin automatically delete legacy fields or collections. Cleanup is a separate, backed-up host migration after the rollback window.

Candidates include:

- Product `mc` group and its nested array tables;
- `mc.syncMeta.syncToken` and other v1 bookkeeping;
- mapping and sync-log collections;
- Payload Job tasks/queues/schedules used only by v1;
- admin imports/components/routes;
- old API keys, cron endpoints, worker routes, and IAM;
- old feed endpoints and provider registrations.

Before removal:

1. prove application code no longer reads the schema;
2. take a restorable backup/export;
3. retain audit data according to business/legal policy;
4. remove code before database columns where rolling deploys could still reference them;
5. test the generated migration against a production-sized restore;
6. explicitly approve destructive database changes.

V2 does not require keeping `mc` fields hidden or read-only after cutover. They should eventually be removed so there is one visible authority.

## Rollback before legacy cleanup

Rollback is possible only after stopping v2 safely.

1. Pause v2 schedules and hook deployment.
2. Pause the Merchant queue and inventory every queued/running v2 operation.
3. Allow claimed writes to finish or quarantine them; never start v1 while v2 live writes can resume.
4. Preserve the v2 ledger, publication state, and source-version sequence.
5. Disable v2 hooks/endpoints/workers.
6. Re-enable the known-good v1 deployment and its schema together.
7. Reconcile v1 desired state carefully, accounting for offers changed by the canary/cutover.

Do not roll back the host's globally monotonic canonical revision values. If v1 cannot tolerate the new host schema, use a forward fix instead of operating two writers.

After legacy schema cleanup, rollback requires restoring both application and database snapshots and is a materially more disruptive recovery. Treat cleanup as the end of the rollback window.

## Post-cutover acceptance

Keep v2 in heightened observation until all are true:

- multiple scheduled publish and reconciliation cycles succeed end to end;
- no v1 queue, route, hook, or service-account usage remains;
- root workflow status and child counts agree with ledger queries;
- publication-state pending/failed age is within SLA;
- remote count and sampled fields match canonical projection;
- every configured feed is current and provider fetches succeed;
- status refresh shows understood/triaged item issues;
- a controlled worker restart/redelivery converges;
- the incident runbook and rollback have named owners;
- production load stays inside queue, rate-limit, memory, and timeout bounds.

Only then retire the pinned 1.x rollback artifact and schedule the explicit schema cleanup.
