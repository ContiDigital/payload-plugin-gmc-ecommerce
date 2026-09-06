# v2 durable async adapter contract

The async adapter is a correctness boundary, not a convenience interface. The plugin deliberately has no in-process fallback. If the adapter cannot provide every declared capability, configuration fails.

`globalSourceVersion: true` is a contractual assertion: every retained operation must map deterministically to a globally monotonic non-negative signed-int64 execution version which survives retries, concurrent workers, database restore, and deployment rollback. A projector-local timestamp is not a substitute because deletes and reconciliation cross product/catalog subjects.

## Required behavior

### Durable dispatch

`dispatch()` must commit an authoritative ledger row before returning `{ operationId, state }`. Publishing to a queue without a ledger row is insufficient. The queue is delivery; the ledger is ownership, idempotency, status, and audit history.

Every automatic Product, collection-dependency, and Global-dependency hook requires an ambient `args.req.transactionID`; the plugin throws `GMC_TRANSACTION_REQUIRED` before dispatch if Payload transactions are disabled or the caller uses `disableTransaction`. The adapter must join that exact transaction and leave queue publication in a transactional outbox which becomes visible only after commit. Publishing an SQS message inside an uncommitted Payload transaction is invalid: another connection can consume it before the product exists. Writing the ledger row in a separate transaction is also invalid because a crash can land the canonical commit without its operation (or the reverse).

Authenticated on-demand, scheduled, coordinator, and continuation dispatches are not coupled to a simultaneous canonical write. They may create their own adapter transaction when no request transaction exists, but they retain every other durability and ordering requirement.

### Dispatch idempotency

`idempotencyKey` means immutable-operation reuse:

```text
first dispatch(K, command C)  -> operation 101
retry dispatch(K, command C)  -> operation 101
later dispatch(K, command C)  -> operation 101 (even if terminal)
dispatch(K, different C)      -> hard conflict / invariant violation
```

The check and insert must be atomic. A read followed by an unconstrained insert is not enough. Use a database uniqueness constraint over the complete GMC key retention horizon and compare `getGmcCommandIdempotencyDigest(command)` on conflict. The plugin-owned digest covers every execution-relevant field but deliberately excludes `requestedAt`, which is diagnostic metadata reconstructed at a different wall-clock instant during an HTTP retry or hook redelivery. Do not substitute a hash of the complete command: that turns a valid replay into a false immutable-content conflict.

Do not implement this by marking an in-flight row `superseded` and inserting another row. The original worker can already be executing, producing two live operations and violating per-subject ordering.

Merchant transport idempotency is separate. The executor still uses full inserts, Google `versionNumber`, idempotent 404 deletes, desired-state ownership, and revisioned state because queues are at-least-once.

### Exclusive full reconciliation

`exclusiveCatalogReconciliation: true` is also mandatory. The adapter must atomically permit at most one root `catalog.reconcile` workflow for the same catalog subject whose root or descendants are nonterminal. Scope by the complete raw subject so one adapter can safely serve independent plugin instances without making their reconciliations block each other. A preflight status read in an endpoint or scheduler is useful for operator feedback but cannot satisfy this capability: two callers can both observe no active workflow and race their inserts.

Perform the exclusivity check in the same transaction and under the same global GMC insertion lock used for the new root ledger row. The required order is:

1. acquire the adapter's global GMC insertion lock;
2. resolve the immutable idempotency key;
3. if that exact key already exists with matching intent, return its retained operation—even when it is the active reconciliation;
4. only for a new root `catalog.reconcile` (no parent or root lineage), query for any reconciliation root with a nonterminal root or descendant;
5. if one exists, throw the exported `GmcAsyncWorkflowConflictError` with its operation ID; otherwise insert the new root before releasing the lock.

Do not coalesce a different idempotency key onto the active root. Without retaining an immutable alias, a later replay of the new key would violate the key contract. The generic authenticated endpoint converts the standard error to HTTP `409`; a host scheduler may catch it and record a successful `active-reconciliation` skip. Continuation commands carry root lineage and must not be rejected by this root-only guard.

### Durable delayed dispatch

`scheduledDelivery` is optional unless configuration uses a dependency `scheduleAt`. An adapter declaring it must persist `args.scheduledFor` on the same immutable registration row, include it in immutable-key conflict checks, defer queue visibility until that instant, and preserve transaction/outbox ordering. It must never acknowledge an in-memory timer as durable delivery.

A scheduled catalog root deliberately re-reads canonical data when it runs; it does not carry a future ProductInput or target-ID snapshot. When the not-before boundary activates, the adapter must atomically allocate and retain one fresh global causal version before plugin execution. Every continuation and Product child inherits that exact activation version. The older registration-row sequence is too stale, while independent child-row sequences can let one old batch outrank newer live events. If a date is later edited or the dependency is deleted, an old boundary still converges current canonical state. Adapters may cancel obsolete schedules as an optimization, but correctness must not depend on cancellation.

### Subject ordering

Commands with the same `subject` must start in dispatch order and must not overlap. Different subjects may run concurrently.

The supplied subject can exceed an infrastructure transport limit. For example, SQS FIFO `MessageGroupId` is limited to 128 characters. Store the original subject for audit and hash it deterministically for the transport group:

```ts
const messageGroupId = `gmc-${sha256(subject)}`
```

Never truncate the right side of a subject; truncation can collapse distinct identities into one group or change group membership across versions.

### Workflow correlation and status

Every child dispatch includes:

- `parentOperationId`: the command which directly created it;
- `rootOperationId`: the original API/hook/scheduled operation.

The ledger should index both. For a root row, set `rootOperationId` to its own ID after insert or use an equivalent workflow key. A child inherits the supplied root unchanged through every continuation.

`getOperation()` must scope the requested row and every aggregated descendant to `args.instanceId`, normally by requiring the retained raw subject to start with the exact `gmc:${instanceId}:` namespace. Returning an operation owned by another plugin instance is an authorization and control-plane isolation failure. It must then report aggregate workflow state. The root cannot be `succeeded` merely because its coordinator handler returned while offer children are still queued. Recommended precedence:

1. any dead-lettered descendant → `dead-lettered`;
2. any permanently failed descendant → `failed`;
3. any running descendant → `running`;
4. any queued/pending descendant → `queued`;
5. root and all descendants succeeded → `succeeded`;
6. a deliberately cancelled complete workflow → `cancelled`.

Populate `childCounts` across all descendants, not only direct children. Populate `requestedState` with the requested ledger row's own mapped state so operators can distinguish coordinator completion from workflow completion.

For `catalog.reconcile`, aggregate every successfully completed remote page into the bounded `reconciliation` summary. `pagesCompleted`, `remoteCount`, `orphanCount`, and `orphanDeleteCount` are additive page totals. The summary can be partial while `state` is active or failed, so never interpret it without the aggregate workflow state. Do not materialize descendants in application memory to compute it; use a fixed-size database aggregate over indexed root lineage and retained command results.

Aggregation must remain bounded in the application process. Compute counts, precedence inputs, minimum start, maximum finish, and one representative failure in the database; do not load every descendant row into Node.js. A full-catalog workflow can contain hundreds of thousands of retained children, and operation lookup is itself a production control-plane endpoint.

### Health

`health()` receives the same `args.instanceId`. Ledger counts, lag, failures, and heartbeat/progress measurements must be scoped to that instance. Shared queue-level measurements may remain transport-wide, but should be identified as shared in `details`. It returns a measured result, not a constant. At minimum inspect:

- primary ledger connectivity;
- outbox lag and oldest pending enqueue;
- queue connectivity/attributes;
- oldest visible message age;
- DLQ depth;
- worker heartbeat/progress;
- any operation stuck beyond its lock/visibility budget.

Return `error` when dispatch or execution is unavailable, `degraded` for elevated lag or recoverable partial impairment, and `ok` only when the path is usable. The plugin health endpoint returns HTTP 503 for `error`.

## Worker contract

The worker must treat the ledger row as authoritative. Do not route on a mutable queue envelope after claim.

1. Parse the envelope enough to locate an operation.
2. Atomically claim a claimable row with a lock token and expiry.
3. Read the command and root ID from the claimed row.
4. Validate the command through the plugin executor.
5. Execute using one process-level executor instance.
6. Persist the complete result before acknowledging the message.
7. On retryable failure, persist the safe error and throw/NACK.
8. On permanent validation/configuration failure, persist terminal failure and ACK to avoid a poison loop.
9. On shutdown, stop polling and drain within the platform deadline; rely on idempotent redelivery when a long operation outlives that deadline.

```ts
const execute = createGmcCommandExecutor(normalizeGmcV2Options(options))

export async function runClaimedGmcOperation(row: ClaimedRow, payload: Payload) {
  const result = await execute({
    command: row.input.command,
    operationId: String(row.id),
    rootOperationId: row.rootOperationId ?? String(row.id),
    payload,
    sourceVersion: String(row.rootCausalSourceVersion),
  })
  return result
}
```

If the ledger primary key is a never-reused global sequence, a deployment may derive an immediate root's signed-int64 Merchant sequence from it with a fixed, migration-safe offset. Descendants must retain that root value even when their own rows are allocated later. A future registration instead allocates one new sequence value at activation and persists it before work. Every result must exceed all causally earlier versions sent for the owned data sources, increase across processes, and never move backward after restore. If those conditions cannot be guaranteed, persist a dedicated sequence. The executor rejects a missing version; there is no timestamp/projector fallback for worker execution.

The adapter should preserve `GmcCommandExecutionResult` in the ledger. Coordinators return dispatched operation receipts and counts which are useful for audits, but the adapter's indexed parent/root fields—not nested output JSON—are the source for aggregate status. Nested results may feed the fixed-size `reconciliation` aggregate; they must never replace indexed lineage or be returned wholesale from the operations endpoint.

Use the exported `classifyGmcCommandError(error)` at the claimed-worker boundary. `retryable: false` covers plugin validation/invariant failures and non-transient Google responses; persist those as terminal failures and ACK. Unknown infrastructure errors, transient Google 408/429/5xx responses, and `GMC_PROCESSED_PRODUCT_NOT_READY` remain retryable. The last signal covers ProductInput processing latency before active local inventory can attach; configure enough durable attempts and delay/backoff to span that asynchronous interval. Do not infer permanence from message text.

`GMC_LOCAL_INVENTORY_SOURCE_VERSION_CONFLICT` is also terminal. It means two different desired LocalInventory resources claimed one global source version for the same processed identity/store, which violates the host's causal-sequence or deterministic-projection contract. Retrying the same bytes cannot choose a correct winner.

### Rolling command-schema deployments

Persist the command schema version as part of the authoritative ledger JSON and validate it only in the claimed worker. Never rewrite retained command bodies to the current version. A rolling deployment may accept a new schema only after every claiming worker understands it; removing old-schema support requires a proven drain or audited quarantine.

RC31 advances from schema 1 to schema 2 because internal `localInventory.apply` commands now require the canonical `productId`. This release deliberately rejects schema-1 rows rather than guessing ownership at execution time. Stop schedules and hook/API ingress, drain or quarantine every RC30 row, deploy web and worker revisions together, verify health reports `commandSchemaVersion: 2`, then resume. Rollback to RC30 is unsafe after schema-2 rows exist unless they are first drained or quarantined.

## Retries, timeouts, and quotas

The plugin retries retryable Merchant errors within one command using bounded exponential backoff. The durable queue retries a failed command across attempts. Size the handler timeout for both layers:

```text
worst request time × (maxRetries + 1)
+ sum(backoff delays)
+ projection/state/ledger overhead
```

The worker timeout should not be treated as cancellation unless the runtime actually aborts the handler. Many JavaScript queue libraries release the consumer while the original promise continues. Subject ordering therefore also requires the ledger lock and visibility timeout to prevent a second live owner.

The built-in limiter is shared by one executor instance. With multiple ECS tasks or Node processes, configure `rateLimit.store` with an atomic distributed implementation or impose an equivalent account-wide queue rate. Queue concurrency alone limits simultaneous handlers, not requests per minute.

## Status mapping

Map host states into the plugin vocabulary:

| Host meaning                                  | `GmcAsyncOperation.state` |
| --------------------------------------------- | ------------------------- |
| outbox pending, queued, scheduled, retry wait | `queued`                  |
| claimed/processing                            | `running`                 |
| completed and aggregate descendants complete  | `succeeded`               |
| terminal application failure                  | `failed`                  |
| retry budget exhausted / DLQ                  | `dead-lettered`           |
| explicitly cancelled                          | `cancelled`               |

`attempts` is the count of claims/executions, not enqueue/publish attempts.

## Minimum conformance suite

A host adapter is not production-ready until integration tests prove:

1. 100 concurrent dispatches with one key create exactly one row and return one ID.
2. Re-dispatch after success, failure, and dead-letter returns that same ID.
3. Reusing a key with a different command is rejected.
4. A rolled-back Payload transaction creates neither a visible row nor a queue message.
5. A committed transaction becomes deliverable only after commit.
6. Two commands on one subject never overlap and retain order across retry.
7. Two different subjects can execute concurrently.
8. At-least-once duplicate envelopes produce one live claim.
9. A process crash after Merchant success but before ledger completion converges on retry.
10. Root status remains queued/running while any descendant is non-terminal.
11. A descendant failure/dead letter makes the root aggregate fail/dead-letter.
12. A continuation preserves the original root ID.
13. Queue publish failure is recovered by the outbox without losing the row.
14. Publish-success/ledger-promotion failure is recoverable without double live ownership.
15. Health changes under a stopped worker, growing outbox, and non-empty DLQ.
16. A delayed dispatch survives restart/transaction commit, never runs early, atomically retains one activation-time global source version, reuses it on retry and every descendant, and fails closed on an immutable-key schedule mismatch.
17. Independent local-inventory roots dispatched in reverse causal order retain the newer per-identity/store claim and never send the older whole-resource replacement.
18. Schema-1 rows cannot be claimed by a schema-2-only worker, and the documented drain/quarantine procedure prevents mixed-version poison loops during rollout or rollback.

## Payload Jobs

Payload Jobs can be used only through an adapter which adds the guarantees above. Registering a Payload task and calling `payload.jobs.queue()` does not by itself prove per-subject FIFO execution, immutable-key reuse, aggregate workflow status, or transaction-aware delivery.

`payloadJobsAsyncAdapter()` is the built-in adapter which supplies those missing pieces:

```ts
import { payloadGmcEcommerceV2, payloadJobsAsyncAdapter } from 'payload-plugin-gmc-ecommerce/v2'

payloadGmcEcommerceV2({
  async: payloadJobsAsyncAdapter({ queue: 'gmc' }),
  // ...
})
```

| Option           | Default           | Meaning                                                     |
| ---------------- | ----------------- | ----------------------------------------------------------- |
| `queue`          | `gmc`             | Payload Jobs queue name.                                     |
| `taskSlug`       | `gmc-command`     | Registered task slug; a host collision throws at build time. |
| `collectionSlug` | `gmc-operations`  | Ledger collection slug; a host collision throws.             |
| `retries`        | `5`               | Durable retries after the first attempt, exponential from 30s. |

Its `install()` hook adds a hidden, unversioned `gmc-operations` collection and registers the task. That ledger — not `payload-jobs` — is the authority: Payload deletes a job row when it succeeds (`deleteJobOnComplete` defaults to true), so the immutable key, lineage, result and audit history must live somewhere Payload does not garbage-collect. `read` access follows the plugin's `access` option; create/update/delete are closed and every plugin write uses `overrideAccess: true`.

Guarantees it does provide:

- **Transaction-aware delivery.** With a hook `req`, the ledger row, the queue message and the row's `jobId` promotion all commit in the host transaction, so a rollback leaves neither a visible operation nor a runnable job.
- **Immutable-key reuse.** `key` is uniquely indexed. Dispatch reads by key first (which also keeps a PostgreSQL host transaction out of a constraint abort) and treats the unique index as the atomic decision; a lost race reads the retained winner. A different `getGmcCommandIdempotencyDigest(command)` for the same key raises `GmcAsyncIdempotencyConflictError`. A committed row whose queue publication was lost (`jobId` null) is re-queued by a later dispatch of the same key, and `health()` counts it as backlog.
- **Durable delayed dispatch.** `scheduledFor` is retained on the immutable row and passed to Payload as `waitUntil`, so `scheduledDelivery: true` is declared and dependency `scheduleAt` is usable.
- **Aggregate workflow status.** `getOperation()` scopes to `instanceId`, resolves the root through retained lineage, and computes descendant counts with six bounded `payload.count` queries — never by loading descendants into Node.
- **Terminal-vs-retry separation.** The worker classifies with `classifyGmcCommandError()`. A non-retryable failure persists `failed`, a retryable failure with an exhausted budget persists `dead-lettered`, and both acknowledge the job so a poison loop cannot burn the queue. A retryable failure with budget left persists `queued` plus the error and rethrows so Payload schedules the backoff.

Known limitations to weigh before choosing it:

- **No per-subject FIFO.** Payload Jobs runs the queue by claim order and concurrency, not by message group, so the adapter declares `orderedBySubject: false`. The executor's `desiredAt`/digest fencing still converges out-of-order delivery, but a deployment which needs strict per-subject serialization wants a FIFO transport instead.
- **No `exclusiveCatalogReconciliation`.** Two concurrent `catalog.reconcile` roots with different keys are not rejected; schedule reconciliation from one caller.
- **No `reconciliation` summary** on `getOperation()`, because Payload's Local API has no bounded database aggregate over retained result JSON.
- **Something must run the queue.** Use `jobs.autoRun` on a long-lived host; on serverless platforms `autoRun` must not be used, so drive `/api/payload-jobs/run` from an external scheduler.
