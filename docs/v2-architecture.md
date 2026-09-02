# Payload GMC Ecommerce v2 architecture

## Status

This document is the normative architecture for the 2.0 release. Legacy source
may remain in the development repository for historical testing, but the v2
package artifact exports and ships no 1.x hooks, sync engine, or detached job
runtime.

## Mission

The plugin publishes canonical Payload commerce data to Google Merchant Center.
It is a one-way publication system:

```text
Payload canonical data
        |
        v
host projection -> validated ProductInput -> canonical feed / Merchant API
                                                |
                                                v
                                      read-only Google diagnostics
```

Google output is never written back into the host's product content. Processed
Google products, issues, and performance data are operational read models only.

## Non-negotiable invariants

1. **One authority.** Host product data and the configured projection are the
   only authority for submitted product content.
2. **No product shadow.** The plugin does not inject editable Merchant Center
   attributes, custom attributes, snapshots, dirty flags, or sync tokens into
   product documents.
3. **No pull.** Google product content is never merged into Payload products.
4. **No detached execution.** The plugin never uses `setImmediate`, an
   unobserved promise, or process-local job state for background work.
5. **Durability is required.** Every automatic, batch, scheduled, delete,
   reconcile, and feed-build operation is dispatched through a host-provided
   durable async adapter.
6. **Bounded workers.** A worker command is explicit, serializable, retryable,
   and returns its final result. Coordinators fan out durable child commands
   instead of hiding unbounded work in an HTTP request.
7. **Ordered subjects.** The async adapter guarantees at-least-once delivery
   and serialization for commands sharing a subject key.
8. **Global causal version.** Every root workflow carries one restore-safe,
   globally ordered signed-int64 source version which all descendants inherit;
   future registrations allocate it at activation. Product timestamps and
   later child-row IDs are not deletion/reconciliation ordering boundaries.
9. **Idempotent transport.** Repeated execution of a command converges on the
   same desired Google state.
10. **Draft safety.** Projections read the published document. A pending draft
    can trigger reconciliation but is never submitted.
11. **Lifecycle completeness.** Create, publish, update, promotion/stock
    invalidation, unpublish, disable, identity change, and deletion all converge
    through the same desired-state path.
12. **Canonical feeds.** Feed output is deterministic, stable-column,
    correctly escaped, checksummed, and generated from the same projected
    ProductInput used by the API publisher.
13. **Last-known-good delivery.** Artifact-backed feeds never replace a healthy
    feed with a partial or failed build.
14. **No raw product adapter writes.** Publication bookkeeping cannot mutate,
    version, unpublish, or corrupt a product document.
15. **Observable failure.** Dispatch, projection, transport, processing, and
    reconciliation failures have durable identifiers and machine-readable
    outcomes.
16. **Dependency completeness.** Canonical relation changes and temporal
    boundaries which alter projection without changing a Product enter the
    same plugin-owned catalog workflow.
17. **Destructive ownership is explicit.** Reconciliation detects remote
    orphan candidates by default; deletion requires an explicit attestation
    that every configured primary data source is exclusive to this instance.
18. **Fail-closed projection reads.** A host dependency/read-model failure
    aborts publication; it must never become silently missing title, promo,
    taxonomy, color, media, price, or inventory data.
19. **One Merchant ingestion mode.** V2.0 writes complete ProductInputs only
    to verified API-backed primary sources. Canonical feeds are exports/read
    models and must not be registered as competing Merchant primary sources for
    the same identities.
20. **No implicit source transfer.** A processed identity is language + feed
    label + offer ID. Multiple configured sources must have disjoint immutable
    scopes, and publication rejects an identity currently owned by another
    source before Google's insert API can move it.

## Public boundaries

### Host product source

The host configures:

- the Payload product collection;
- a stable identity resolver;
- a projector from a published host document to a complete `ProductInput`;
- optional query constraints and fetch depth.

Returning `products: []` from the projector means the product must not exist in
the configured Google primary source. It is an authoritative desired state,
not a temporary skip. The plugin also treats a missing/unpublished document or
one outside `products.where` as absent.

The projector starts from canonical host data. It must not depend on plugin
state from a previous publication.

The executor asks Payload for `draft: false` and additionally rejects a row
whose explicit `_status` is not `published`. This second guard matters because
adapters and hooks can surface partial or draft-shaped documents even when a
caller requested the published view. Collections without `_status` remain
supported.

### Canonical dependencies

`catalogDependencies` lets the host declare non-Product collections whose
published values participate in projection. `catalogGlobalDependencies`
provides the same invalidation path for Payload Globals. A selector returns
only the projection-relevant content. The plugin compares current/previous
selections, adds change/delete hooks to collections and change hooks to
Globals, and transactionally dispatches a bounded `catalog.publish` root. A
dependency can resolve a complete targeted Product ID set; the plugin stores
one coordinator and pages children in the worker, caps the set at 1,000, and
falls back to a full scan when the resolver returns `null` or exceeds the cap. The
host does not implement a parallel Merchant fan-out engine. Immediate event
idempotency includes the complete before/after event envelope so an A → B → A
→ B sequence cannot incorrectly reuse the first A → B operation.

Media is a dependency when a URL or MIME-type change can alter an embedded
projected relation without updating Product. The same rule applies to every
host relation: declare it, or use a canonical read model whose own version and
change event enter this workflow. Selectors suppress irrelevant edits; they do
not make an omitted projection dependency safe.

Time-dependent data may additionally return future instants from `scheduleAt`.
Those roots are immutable delayed operations. They contain no materialized
product payload: when they fire, the plugin re-reads current canonical state
and creates fresh product children. An obsolete boundary is therefore a safe
extra convergence sweep. Delayed delivery requires an adapter which advertises
and implements `scheduledDelivery`.

### Async adapter

The host adapter receives a serializable command, subject key, and idempotency
key. It persists the command before reporting success. Its contract requires:

- durable storage;
- at-least-once delivery;
- ordered execution per subject;
- retry support;
- a durable operation ID;
- mandatory ambient transactions for automatic hooks, with fail-closed `GMC_TRANSACTION_REQUIRED` enforcement before dispatch;
- adapter-owned transactions for on-demand/coordinator dispatches that are not coupled to a canonical write;
- atomic reuse of the original operation for a duplicate idempotency key,
  including after terminal completion (never supersede it);
- parent/root workflow correlation and aggregate descendant status;
- measured health and durable operation lookup.
- durable not-before delivery when `scheduledDelivery` is declared.
- one restore-safe, globally monotonic source version per activated root, inherited exactly by every descendant;
- atomic exclusion of overlapping full catalog-reconciliation roots for the complete instance-scoped catalog subject.

Payload Jobs may be offered as an optional adapter. Fine's Gallery uses its
AsyncOperations ledger, outbox, SQS, and ECS executor. Neither implementation
is hard-coded into the plugin core.

### Command executor

Workers import the plugin's bounded executor and pass it a Payload instance and
one command. The worker owns its process lifetime; the plugin owns command
validation and Merchant Center behavior.

Initial command vocabulary:

- `product.publish`
- `product.delete`
- `offer.publish` (internal transport command)
- `offer.delete` (internal transport command)
- `catalog.publish`
- `catalog.reconcile`
- `feed.build`
- `status.refresh`
- `localInventory.reconcile`
- `localInventory.apply` (internal transport command)

Commands are schema-versioned. Breaking command changes require a new command
schema version or an explicit migration path because old commands may remain in
durable queues during deployment. RC31 is schema 2: the internal
`localInventory.apply` command now carries its canonical `productId`, which is
part of durable per-store causal fencing. A schema-1 RC30 queue must be drained
or quarantined before a schema-2-only worker is deployed.

### Feed delivery

The plugin owns Google-specific serialization and feed endpoints. A feed
definition pins:

- feed ID;
- a pinned content language, feed label, and optional data-source route;
- format and stable columns;
- path and authentication policy;
- dynamic or artifact-backed delivery;
- artifact store when artifact-backed.

TSV is the first built-in format. Custom format adapters can add XML or another
Google-supported representation without changing the canonical projection.

Feed format compatibility does not make the endpoint a second Merchant input.
Google models API and file upload as distinct data sources, and ProductInput
mutations require an API source. V2.0 therefore declares `api-primary` as its
only Merchant ingestion mode and treats every feed as a canonical export. A
file-primary mode would require different mutation, deletion, fetch, and
reconciliation semantics and is outside this release.

Artifact publication is two-phase: build and validate an immutable artifact,
then atomically promote one small pointer. A failed build leaves the previous
artifact available. Immutable object keys, current pointers, operation lookup,
and ledger health are all scoped by `instanceId`; `feedId` and operation type
alone are not valid tenant boundaries for a shared adapter or artifact store.
The store exposes the pointer descriptor separately from the body. On replay,
the executor uses that descriptor to reject stale work cheaply and reads back
the exact immutable object before accepting an equal-version prior promotion.

Local inventory has a separate hidden state collection because Google's
whole-resource LocalInventory mutation has no product `versionNumber` or
conditional-write fence. One CAS row per processed identity/store retains the
greatest root-causal source version, desired digest, canonical product owner,
operation, and applied result. This state complements—not replaces—offer-wide
FIFO: it closes dispatch inversion between independent roots, while FIFO closes
live overlap at the irreversible Google side-effect boundary.

Both canonical collection and serialization are bounded. The configured byte
limit is enforced against aggregate canonical ProductInput JSON before a
formatter runs and again against the finished representation. It does not
include JavaScript object overhead or eliminate simultaneous buffers, so hosts
must size workers with additional headroom. Immutable artifact retention must
be pointer-aware; elapsed age alone cannot prove an object is unreachable.

Payload keyset pagination prevents offset drift and bounds each read, but it is
not a database-wide point-in-time transaction. Concurrent catalog commits may
be observed on different pages. Hooks and later builds converge that moving
view; hosts requiring a strict snapshot must project from a versioned read
model.

## Desired-state execution

### Single product

1. A Payload hook or authenticated endpoint dispatches `product.publish`.
2. The worker reloads the published document.
3. If the document no longer exists or the projector returns `products: []`, the worker
   deletes the last known identity when one exists.
4. Otherwise the worker validates and canonicalizes the complete ProductInput.
5. It computes a deterministic digest.
6. It verifies the configured Data Sources v1 resource is `input: API`, primary,
   and compatible with the identity. Multi-source topology must be completely
   scoped and pairwise disjoint.
7. It reads the processed product immediately before insertion and rejects a
   different owning source; otherwise it publishes the complete input.
8. It records operational state outside the Product collection.
9. If a newer command was queued for the same subject, ordered execution makes
   that command the final authority.

### Batch

`catalog.publish` is a coordinator. It resolves stable product IDs and
dispatches a durable `product.publish` child command for each subject. It does
not execute an unbounded `Promise.all` against Google. A targeted dependency
root intersects its canonical ID set with the configured Product eligibility
query; an omitted set performs the full keyset scan. Future schedule roots
always re-resolve the catalog rather than trusting a stale captured target set.

### Reconciliation

Reconciliation first stamps the complete desired identity set behind one stable
barrier, then scans processed Google products owned by explicitly configured
primary sources. The durable executor sequence is mandatory: the root carries
`startedVersion` through every continuation and compares versions without
worker-clock assumptions. It schedules missing/changed publications and counts
remote orphan candidates. The default is detect-only. Only
`orphanDeletion: 'exclusive-data-sources'` conditionally schedules candidates
for deletion, and that setting is a host attestation that every configured
source is a dedicated primary source. The delete repeats the same barrier comparison immediately
before transport, so a later desired claim wins even when the catalog changes
during the scan. Reconciliation is the recovery mechanism for failures outside
a host database transaction.

Offer deletions also retain a monotonic `deleteVersion` in publication state.
This is separate from FIFO ordering: it closes the race between reconciliation
work under a catalog subject and an on-change publish under a product subject.
An older or equal delayed publish is skipped; only a strictly newer canonical
source version can clear the fence and recreate the offer.

Processed-status refresh follows the same bounded coordinator rule: multiple
identities fan into one ordered `status.refresh` child per offer. A single
worker row never serially polls an unbounded identity set.

## Operational state

Publication state lives in a plugin-owned, non-versioned collection or a
host-supplied state adapter. It is keyed by merchant/data source/language/feed
label/offer ID and may contain:

- host product reference;
- desired and published digest/version;
- retained deletion-version fence;
- desired lifecycle action;
- durable operation ID;
- attempt and error summary;
- last published and processed timestamps;
- Google product name and issue summary.

This state is never merged into product content and is safe to rebuild through
reconciliation.

The built-in store is revisioned and uses the official database adapters'
atomic conditional write primitives. Payload's public bulk update is not a
compare-and-set because it selects IDs before performing per-ID updates. The
default store therefore supports SQLite, PostgreSQL, and MongoDB explicitly;
another adapter requires a host-supplied atomic store.

## Security

- User endpoints require the configured Payload access function.
- Worker endpoints require a separate machine-auth policy.
- Public feeds are explicitly public or use a configured feed authorization
  callback; they never inherit an accidental anonymous default.
- Request bodies and command envelopes are validated before dispatch or
  execution.
- Logs and command payloads contain product identifiers, not credentials or
  customer data.

## Compatibility and migration

The v2 API is intentionally breaking. A v1 host migrates by:

1. defining a complete projection and stable identity;
2. installing a durable async adapter;
3. shadow-comparing v1 output with v2 canonical output;
4. enabling v2 publication against a canary set;
5. enabling batch reconciliation;
6. disabling v1 hooks and schedulers;
7. removing v1 Product fields and child/version tables with an explicit host
   migration.

The plugin does not silently delete v1 schema. Host migrations remain explicit
and reviewable.

## Release gates

The 2.0 release cannot be declared production-ready until tests prove:

- no detached execution paths remain;
- adapter configuration fails closed;
- draft saves never publish draft data;
- edits, identity changes, deletes, and retries converge in order;
- batch coordinators fan out durable child work;
- feed/API output originates from the same canonical input;
- TSV quoting, repeated fields, money, dimensions, and intervals match Google's
  specification;
- last-known-good artifacts survive failed builds;
- PostgreSQL, MongoDB, and SQLite integration behavior;
- minimum and current supported Payload versions;
- packed-artifact integration in a real host application.
- duplicate async dispatch reuses one operation rather than superseding it;
- root workflow status remains non-terminal until every descendant is terminal;
- immutable artifacts are read back and verified before pointer promotion;
- a forced same-revision race converges on SQLite, PostgreSQL, and MongoDB.
