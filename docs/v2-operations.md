# Payload GMC Ecommerce v2 operations and incident runbook

This runbook assumes the plugin, publication-state collection, host async ledger/outbox, worker queue, artifact store, and Merchant data source have all been deployed. Host operators own scheduling and queue infrastructure; the plugin owns command semantics and Google transport.

## Normal operating model

Use four complementary convergence paths:

1. Product hooks enqueue change/delete commands in the canonical write transaction; a missing ambient transaction is a hard `GMC_TRANSACTION_REQUIRED` failure, never an eventual-consistency fallback.
2. An authenticated on-demand endpoint handles explicit operator publication.
3. Bounded targeted dependency roots handle low-latency relation changes; a capacity-planned scheduled `catalog.publish` sweeps eligible products for missed invalidations.
4. A less-frequent `catalog.reconcile` proves remote existence and detects remote orphans; it removes them only under explicit exclusive-source ownership mode.

For artifact-backed feeds, schedule `feed.build` separately. For local inventory, schedule `localInventory.reconcile` according to inventory freshness requirements. Schedules create durable root commands; they must never call the command executor or Google directly.

The `/health` response identifies the plugin `instanceId` and current `commandSchemaVersion`. Treat either mismatch as a deployment-routing failure, not cosmetic metadata.

Each non-null local-inventory projection is the complete desired resource for one canonical offer/store, not a patch. A null or missing configured-store projection is a delete. Treat stale stock, store price, pickup, loyalty, or delivery data as a customer-facing correctness incident; do not rely on the slower catalog reconciliation cadence for inventory freshness.

Store retirement is also desired-state work. Move a code from `storeCodes` to `retiredStoreCodes`, run the full local-inventory reconciliation to aggregate success, wait for older offer-subject operations to terminate, verify no relevant DLQ/failure remains, and only then remove the retired code. Retired stores bypass the projector and emit deletes for every canonical offer; queued pre-retirement inserts are converted to deletes at execution. Commands for ProductInput and every store of one offer share the same offer-wide FIFO subject so inventory cannot overtake the ProductInput attempt. The active list may be empty while retired codes remain, allowing the final location to drain. Once retirement is proven complete, both lists may remain empty as an explicitly inactive, schema-stable capability; that state emits no local-inventory work.

A reasonable starting cadence—not a universal SLA—is:

| Operation                 | Initial cadence                                   | Purpose                           |
| ------------------------- | ------------------------------------------------- | --------------------------------- |
| Product hooks             | Every committed event                             | Low-latency content convergence   |
| Catalog publish           | Hourly                                            | Recover missed host invalidations |
| Catalog reconcile         | Capacity- and quota-driven; often weekly at scale | Remote existence/orphan repair    |
| Artifact feed build       | After material catalog changes and at least daily | Last-known-good provider feed     |
| Status refresh            | Daily for active products or on operator demand   | Read-only issue diagnostics       |
| Local inventory reconcile | Based on stock SLA, often 5–15 minutes            | Store-offer convergence           |

Use a stable, window-specific idempotency key for every schedule, for example `schedule:catalog-reconcile:2026-08-29`. A scheduler retry in the same window must resolve to the same root operation.

Do not enqueue a new full reconciliation while the previous root workflow is still active. The required async adapter enforces this atomically across authenticated API calls, schedules, and concurrent processes; scheduler preflight checks are advisory operator feedback only. A different-key on-demand request receives HTTP `409`, while replaying the active root's exact immutable key returns its retained operation. Estimate physical request volume before choosing cadence: online reconciliation normally needs a processed-product GET plus a ProductInput insert for each desired offer, and local inventory can add another ownership GET plus insert/delete per store. Read the account's current Merchant quota groups with `quotas.list`; a hard-coded request rate is only a conservative bootstrap value, not capacity evidence.

## What “successful” means

An HTTP `202` means only that the root command is durably accepted. A coordinator row completing means only that its bounded fan-out finished. The operation is successful only when `GET /gmc/v2/operations/:operationId` reports aggregate `succeeded` across the root and all descendants.

Treat terminal states as follows:

- `succeeded`: all relevant rows succeeded;
- `failed`: at least one row exhausted normal retry or failed permanently;
- `dead-lettered`: the queue moved at least one row to its DLQ and operator action is required;
- `cancelled`: explicitly terminated and not converged;
- `queued` or `running`: still active, even if the coordinator itself completed.

Persist root operation IDs in scheduler/audit output. Do not infer success from queue depth alone.

## Required telemetry

The adapter `health()` result should be measured from dependencies, not a constant. At minimum observe:

- ledger database connectivity and write latency;
- oldest pending/outbox row age;
- queue send/receive failures and approximate age of oldest message;
- active, queued, succeeded, failed, cancelled, and DLQ counts;
- worker heartbeat/deployment revision and claim-lock age;
- duplicate dispatch conflict and digest-mismatch counts;
- handler duration, attempt distribution, timeout count, and visibility extensions;
- Merchant request count, latency, status code, retry, throttling, and credential-refresh failures;
- publication states by status and age;
- feed build duration, product count, bytes, checksum, current artifact age, and promotion failure;
- immutable artifact count/bytes, unreferenced-artifact age, pointer-version count, and collector dry-run/delete totals;
- processed-product issue counts by severity/destination after status refresh;
- reconciliation desired/remote counts, orphan candidates, configured ownership mode, and dispatched orphan deletes.

Keep readiness and incident history distinct. A nonempty DLQ and newly dead
operations should degrade health immediately. Retain lifetime dead-operation
totals for audit, but do not let a remediated historical row poison readiness
forever; use an explicit recent-incident window or an auditable acknowledgement
state, and document that policy in the adapter runbook.

Never log credentials, bearer tokens, full private product descriptions, or unbounded Google response bodies. Log operation ID, root ID, command type, safe identity digest or approved offer ID, data-source name, attempt, status code, retryability, duration, and a bounded error code/message.

## Initial alert policy

Tune thresholds from measured production baselines. Useful initial alerts are:

- async health `error` for two checks, or `degraded` for 10 minutes;
- oldest committed outbox row older than two normal sweep intervals;
- oldest Merchant queue message older than the publication SLA;
- any DLQ message;
- command p95 duration above 70% of handler timeout;
- a claim lock older than visibility timeout;
- Merchant 401/403 beyond one token-refresh retry;
- sustained 429 responses or retry-budget exhaustion;
- publication `publish-pending`, `delete-pending`, or `failed` older than one reconciliation window;
- root workflow active beyond catalog-size-derived upper bound;
- artifact feed older than twice its scheduled cadence;
- artifact promotion/checksum/read-back failure;
- succeeded reconciliation `orphanCount` or `remoteCount` deviating sharply from baseline (treat counts on an active/failed workflow as partial);
- status issues with account suspension, destination rejection, or disapproval severity.

Page on data-loss/exposure risks: unexpected mass orphan candidates, mass deletes, credential compromise, wrong merchant/data source, poisoned projection, or corrupt current artifact. Ticket ordinary isolated product validation errors with the affected canonical path.

`GMC_PRODUCT_DATA_SOURCE_CONFLICT` is a stop-the-line ownership incident, not a retryable product or local-inventory error. Do not bypass it by changing the route or repeatedly replaying the command. Freeze all writers for that identity, inventory the actual owning source, and follow the reviewed source-migration procedure. `GMC_PROCESSED_PRODUCT_NOT_READY` is different: it is the expected retryable processing interval before active local inventory can attach to a newly accepted ProductInput.

## Safe operator commands

Every mutation requires an authenticated principal and an `Idempotency-Key`.

Run the non-mutating source preflight after every credential, Merchant source,
or projector-scope deployment and wait for aggregate success before publishing:

```bash
curl --fail-with-body \
  -X POST \
  -H 'Authorization: Bearer ...' \
  -H 'Idempotency-Key: deploy-2026-08-30-source-preflight' \
  https://cms.example.com/gmc/v2/data-sources/validate
```

The durable command verifies every configured source is an API-backed primary
source and checks every configured canonical feed language/label against its
routed source. Product projection identities receive the same control-plane
check immediately before their first product-plane operation. A terminal
`GMC_API_PRIMARY_DATA_SOURCE_REQUIRED` result is a deployment/configuration
failure, not a retry storm.

```bash
curl --fail-with-body \
  -X POST \
  -H 'Authorization: Bearer ...' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: incident-123-product-42-v1' \
  --data '{"productId":"42"}' \
  https://cms.example.com/gmc/v2/products/publish
```

Reusing that exact key is intentionally not a way to run the work again; it returns the original operation. Use a new, audited key only after deciding a new root command is required. The plugin's offer-level state/version guards still prevent an older projection from winning.

## Incident: queue or worker unavailable

1. Confirm ledger writes continue and hook transactions are not failing.
2. Inspect async health, oldest outbox age, queue age, worker heartbeat, and deployment revision.
3. Stop adding manual retries; immutable keys already retain the work.
4. Restore outbox publication or worker consumption.
5. Ensure stale claim locks are recovered according to the host ledger contract.
6. Watch aggregate root operations drain.
7. Run catalog reconciliation after the backlog reaches normal levels.

Do not bypass the ledger by invoking the executor from a web process. That loses ordering, correlation, retries, and transaction boundaries.

## Incident: Merchant throttling or transient 5xx

1. Check aggregate process count and account-wide concurrency.
2. Confirm the executor is singleton per process and the distributed rate-limit store is healthy if used.
3. Reduce queue consumer concurrency before increasing retry budgets.
4. Retain exponential backoff and jitter; do not hot-loop 429s.
5. Ensure visibility timeout remains several times the maximum handler duration.
6. Let retained operations retry; do not enqueue duplicate keys with changed content.
7. Run reconciliation after recovery.

The transport retries 408, 429, and retryable 5xx according to configured bounds. Permanent 4xx and `GMC_API_PRIMARY_DATA_SOURCE_REQUIRED` configuration errors fail without endless in-process retry. A distributed limiter reset more than one minute plus a small clock-skew allowance in the future is rejected instead of silently extending a durable handler. Handler timeout must still cover the host's full configured retry/wait envelope and production-size feed build.

## Incident: authentication failure

The Google client retries one Merchant 401 after coalescing a fresh OAuth token. Repeated 401, any unexplained 403, or OAuth token endpoint failure requires intervention.

1. Verify service-account identity, Merchant account access, clock synchronization, and secret version.
2. Check that new and old worker revisions resolve the intended credential during a rolling deploy.
3. Rotate/revoke credentials through the secret manager if compromise is possible.
4. Restart/drain workers only if the host credential client cannot refresh dynamically.
5. Resume retained operations and reconcile.

Never paste a private key or access token into an operation retry payload.

## Incident: projection validation failure

Projection validation is fail-closed and reports paths. No partial ProductInput is submitted.

1. Locate the failed operation and product ID.
2. Reproduce the projector against the same published database version.
3. Correct canonical source data or projector policy.
4. Increment `sourceVersion` through the normal host transaction.
5. dispatch a new product publication key;
6. refresh status after Google processes the input.

Do not weaken validation merely to make a queue green. If Google has introduced a new API attribute, the open ProductAttributes boundary can carry it to the API; add specification-correct TSV support before placing it in a built-in TSV feed.

A `maxCatalogPages` failure means the configured local-scan safety envelope is smaller than the observed catalog (or the host cursor contract is broken). Do not retry it indefinitely or raise the value blindly. Verify cursor progress and eligible counts, then size `maxCatalogPages` from the worst-case catalog, `batchSize`, terminal probe, growth margin, worker memory, and command-volume capacity. No operation that breaches the limit has produced an authoritative complete scan.

## Incident: stuck or failed publication state

Product and local-inventory publication state are read models guarded by source version, identity ownership, and atomic revision compare-and-set.

1. Inspect the operation/root lineage and underlying transport error.
2. Check whether a newer desired version already owns the identity.
3. Do not edit the hidden collection manually.
4. Repair the causal data/adapter/transport issue.
5. enqueue a new product publication or catalog reconciliation.
6. verify the state reaches `published` or `deleted` and the remote processed product agrees.

For a local-inventory row, inspect the processed identity, store code, canonical product owner, desired/applied versions and digests, and retained operation. `GMC_LOCAL_INVENTORY_SOURCE_VERSION_CONFLICT` means divergent canonical content reused one global source version; stop the affected subject and repair sequencing/projection determinism. Do not delete the row or increment a version by hand. A newer per-store claim must win even when an older independent workflow's child is delivered later.

If repeated CAS conflicts occur under normal load, inspect whether the host adapter/version lies within supported Payload versions and run the real database matrix against the exact adapter release.

## Incident: suspected mass deletion

1. Stop ingress by deploying `disabled: true`, disable every Merchant schedule, and scale the isolated Merchant worker to zero. `disabled` removes new plugin hooks/endpoints only; it does not pause or erase durable rows already queued.
2. Preserve ledger, publication-state, current database snapshot, and logs.
3. Identify the initiating reconciliation root and its durable `startedVersion` barrier (`startedAt` only for a host without global sequencing).
4. Compare configured `merchantId`, primary/additional data sources, `products.where`, projector output, and source-version feed snapshot against the last healthy deployment.
5. Quarantine queued `offer.delete` rows without marking them successful; preserve them for audit.
6. Correct the configuration or projection and publish desired products before resuming orphan deletion.
7. Resume with a bounded canary, then reconcile.

The reconciler scans only products whose `dataSource` is explicitly configured. In the default `orphanDeletion: 'disabled'` mode it reports candidates and dispatches no deletes. `exclusive-data-sources` is a destructive ownership attestation, not a performance option. Never enable it or broaden `additionalDataSourceIds` during an incident without inventorying and proving exclusive primary-source ownership.

## Incident: feed build or serving failure

If a build fails before promotion, the previous current artifact remains valid.

1. Confirm `readCurrent` still returns the last-known-good body/descriptor.
2. Determine whether failure came from catalog bounds, projection validation, serialization, immutable write, exact read-back, checksum/metadata, or pointer promotion.
3. Never promote an object manually without performing the same integrity verification.
4. Correct the cause and enqueue a new `feed.build` key.
5. fetch the public path, verify status/content type/ETag/body count, then verify provider fetch status.

If serving detects corruption in the current object it returns an error rather than serving bytes. Roll the pointer back atomically to a previously verified immutable descriptor, preserve the corrupt object for investigation, then rebuild.

## Incident: DLQ message

1. Page immediately and inspect the authoritative ledger row—not just the SQS body.
2. Determine permanent validation/configuration versus exhausted transient failure.
3. Fix the cause first.
4. Re-drive by transitioning the same retained operation through the host's audited recovery path, preserving operation/root IDs and ordered subject. Do not create a replacement row with the same idempotency key.
5. Confirm aggregate root status recomputes and reconciliation closes any unknown-delivery window.

DLQ deletion is the final cleanup step, never the recovery mechanism.

## Deployments and drains

Commands are schema-versioned because durable queues can outlive a deployment. A rolling deploy must keep a worker revision capable of every queued schema or explicitly drain before removing support.

RC31 emits schema 2 and intentionally does not execute RC30 schema-1 rows because local apply ownership cannot be inferred safely without `productId`. Before upgrading from RC30: stop schedules and new hook/API ingress, let every schema-1 workflow and descendant terminate or move it to an audited quarantine, prove no schema-1 row remains claimable, deploy web and workers together, then resume. Before rolling back after RC31 ingress, perform the symmetric schema-2 drain/quarantine.

- stop accepting a new schema until all workers understand it;
- bound ECS/Kubernetes termination grace to the handler design;
- stop claiming new work before shutdown;
- allow active handlers to finish where possible;
- tolerate termination/redelivery at every Merchant call boundary;
- keep queue visibility longer than worst-case handler runtime;
- never acknowledge the queue before ledger completion commits.

Run a canary root operation and health check after every worker/config deployment.

To pause safely, stop schedules and ingress first, then scale workers down after
drain (or quarantine retained rows under an audited procedure). Never make a
disabled executor ACK committed work without executing it; that would convert a
deployment flag into silent data loss.

## Rollback

Code rollback is safe only when the previous release understands every queued command schema and current publication-state schema.

1. Pause schedules and new command dispatch if compatibility is uncertain.
2. Drain or quarantine commands introduced by the new release.
3. roll back web/plugin and worker revisions together;
4. do not roll back the monotonic merchant version sequence;
5. keep the publication-state and async ledger data;
6. restore the last-known-good artifact pointer if feed output changed;
7. run a canary publish, then full reconciliation.

Never re-enable v1 against the same primary source as an emergency rollback while v2 work remains queued. That creates two writers with incompatible ownership/state models. A v1 rollback requires the controlled sequence in [the migration guide](./v2-migration.md).

## Routine audit

At least quarterly and after meaningful catalog/schema changes:

- rerun the async conformance suite and database matrix;
- simulate duplicate dispatch, rollback, worker crash, retry, DLQ, and artifact corruption;
- compare a sample of API canonical input, TSV rows, and processed products;
- verify data-source ownership and service-account least privilege;
- restore a backup into staging and prove source versions do not regress;
- review Google ProductAttributes/feed specification changes;
- load test full catalog/reconciliation/feed builds at production scale;
- verify alert delivery and named incident ownership.
