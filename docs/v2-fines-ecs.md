# Fine's Gallery ECS AsyncOperations deployment mapping

This review maps plugin v2 onto the actual `~/src/finesgallery-beta` async pipeline inspected through 2026-08-30. Merchant behavior remains entirely in the plugin. Fine's owns only the generic host responsibilities every Payload application must own: canonical product projection, credential resolution, durable adapter, task registration, and infrastructure.

## Implementation status on 2026-08-30

Fine's pipeline was a strong base, but its superseding `enqueueAsyncOperation()` could not be used unchanged as a conforming v2 adapter. The v2 host mapping described below is now implemented in the working tree: it has a separate immutable enqueue, a `gmcCommand` contract, a dedicated FIFO queue/worker, a commit-ordered subject publisher, aggregate lineage status, S3 artifact publication, deterministic schedules, and a complete canonical projector.

Already compatible:

- `asyncOperations` is the authoritative durable ledger;
- transactional calls can join `req.transactionID` and defer publication to an outbox sweep;
- SQS/ECS provides at-least-once delivery;
- FIFO queues support message-group serialization;
- a PostgreSQL advisory-lock outbox drain sends earlier unpublished rows for the same raw subject in ledger-ID order before the target, so concurrent post-commit network calls cannot reverse FIFO arrival order;
- the worker validates an envelope, atomically claims a row, then routes from authoritative ledger `type` and `input`;
- completion/failure output, attempts, locks, DLQ behavior, correlation IDs, and graceful drain already exist;
- the publish-before-promote gap and unknown-delivery state have explicit recovery paths.

Defects the implementation had to remediate:

1. `src/lib/jobs/enqueueAsyncOperation.ts` supersedes every in-flight row with the same key and inserts a fresh operation. GMC requires immutable key reuse. An original row may already be processing, so supersede can create concurrent live Google writes.
2. The partial unique index covers only in-flight rows. A retry after completion creates another row instead of returning the original operation.
3. `AsyncOperationType`, `TASK_CONTRACTS`, `WORKER_REGISTRY`, and `TASK_TO_QUEUE` have no `gmcCommand` entry.
4. `asyncOperations` has no `parentOperationId` or `rootOperationId`, so batch status cannot aggregate descendants.
5. Existing operation status is row-local. A completed catalog coordinator can appear successful while hundreds of offer children remain queued or fail later.
6. `BusinessOpsQueue` has a 60-second handler budget; worst-case Merchant retry/timeout policy can exceed it. `NightlyCronQueue` has a long budget but is standard, concurrency one, and shared with unrelated work, so it does not provide per-offer FIFO semantics or appropriate isolation.
7. The current task contract derives its own key/group from domain input. The GMC adapter must retain the plugin's exact immutable key and raw subject, while hashing the subject for SQS's 128-character group limit.
8. Releasing the insertion-order transaction before separate `SendMessage` calls allowed two committed rows for one subject to race into FIFO in reverse order. A subject-aware ordered publisher now serializes both first delivery and recovery, performs the promotion CAS on the same PostgreSQL connection, and keeps local-inventory writes correctly ordered even though Google's local-inventory API has no offer `versionNumber` fence.

Those code defects are now remediated. The scratch-schema adapter proof now passes 100-way duplicate collapse, 100 distinct same-subject operations in exact FIFO publish order, transaction visibility, rollback/lock release, retry timestamp reuse, immutable-content conflict rejection, and the installed plugin's canonical-row/outbox commit and later-hook rollback behavior with Fine's actual adapter on real PostgreSQL. It now covers Product hooks, collection dependencies, and Global dependencies rather than proving only the Product path.

Fine's release candidate has removed `transactionOptions: false`; Payload mutations now use real PostgreSQL transactions. The host's PostgreSQL harness defaults to the same configuration, and the real-adapter proofs show canonical Product/dependency writes and immutable operations commit together and both disappear on rollback. Transaction propagation was also added to affected nested invoice, payment-ledger, category-order, watermark, cache-revalidation, promotion, and media workflows so enabling the adapter does not silently move their writes onto another connection. `GMC_TRANSACTION_REQUIRED` remains an intentional fail-closed guard against any environment or call path that disables the transaction.

This does **not** make the deployment live-ready by itself. Fine's still ships v2 dark behind strict `GOOGLE_MERCHANT_V2_ENABLED=false`; IDs alone never install active hooks or authorize remote work. Production remains blocked on the owner-generated/applied/rollback-tested schema migration, production secret/data-source validation, shadow comparison, canary execution, load testing, and live Merchant verification. RC31 adds the `gmc-local-inventory-publications-v2` collection and command schema 2; RC32 makes that collection structurally present even when the deployment has no active or retired store. The owner-generated migration must include it, and the dark deployment must prove there are no retained schema-1 v2 rows before rollout. Every generated migration must also be checked for a PostgreSQL enum value that is added and then used in the same transaction; split that change across migrations if Payload generates that shape.

## Required thin host task

Add one host task, not one task per GMC action:

```ts
type GmcCommandTaskInput = {
  command: GmcCommand
  commandDigest: string
  idempotencyKey: string
  parentOperationId?: string
  rootOperationId?: string
  subject: string
}
```

`commandDigest` must be `getGmcCommandIdempotencyDigest(command)`, not a hash of the complete serialized command. The plugin helper excludes diagnostic `requestedAt` while covering every execution-relevant field, so a legitimate retry returns the retained operation and a semantic key collision still fails hard.

The task input schema should validate envelope bounds and then call the plugin's `assertGmcCommand()` for the nested command. Do not duplicate command-specific Google validation in Fine's.

Contract mapping:

```ts
export const gmcCommandContract = {
  type: 'gmcCommand',
  inputSchema: gmcCommandTaskInputSchema,
  queue: 'MerchantQueue',
  idempotencyKey: (input) => input.idempotencyKey,
  subject: (input) => ({
    collection: 'gmc-workflows',
    id: input.rootOperationId ?? input.idempotencyKey,
  }),
  messageGroupId: (input) => `gmc-${sha256(input.subject)}`,
}
```

`messageGroupId` must hash the complete raw subject. With an `instanceId` up to 100 characters plus the encoded offer identity, direct use can exceed SQS FIFO's 128-character limit.

The handler is only a bridge:

```ts
const executors = new WeakMap<BasePayload, ReturnType<typeof createGmcCommandExecutor>>()

export async function runGmcCommand({ payload, input, operationId }: HandlerArgs) {
  let execute = executors.get(payload)
  if (!execute) {
    execute = createGmcCommandExecutor(normalizeGmcV2Options(gmcOptions))
    executors.set(payload, execute)
  }

  return execute({
    command: input.command,
    operationId: String(operationId),
    rootOperationId: input.rootOperationId ?? String(operationId),
    payload,
    sourceVersion: gmcSourceVersionForOperation(operationId),
  })
}
```

Do not put projection, TSV serialization, Google REST calls, publication state, reconciliation, or local-inventory behavior in this handler.

The task contract must accept only the plugin's current schema-2 command. RC31 and later `localInventory.apply` includes `productId`; Fine's must not synthesize it in the worker or relabel a schema-1 command. Because the feature is dark, the expected upgrade path is to assert zero retained v2 commands, install the owner-published exact `2.0.0` registry package and deploy its worker together, then keep ingress disabled until the owner-generated migration and staging gates pass. A release-candidate tarball may be used externally for local compatibility proof, but it must not be vendored or retained as a committed `file:` dependency.

## Immutable GMC enqueue path

Do not change supersede semantics globally; Fine's email/media/promotion tasks currently rely on them. Add a GMC-specific `enqueueUniqueAsyncOperation()` mode or a generic immutable mode.

The required PostgreSQL invariant is one retained row per GMC idempotency key. Fine's implementation uses a nullable, unique `immutableKey` column: non-GMC rows leave it null, while every GMC row writes the plugin key. PostgreSQL permits multiple nulls and enforces one retained GMC row per non-null key. This is equivalent to the following partial invariant while remaining expressible in Payload schema:

```sql
CREATE UNIQUE INDEX async_operations_gmc_key_unique
ON async_operations (idempotency_key)
WHERE type = 'gmcCommand';
```

The enqueue transaction must:

1. validate the command and compute a canonical digest;
2. attempt to insert the ledger row;
3. on unique conflict, select the existing GMC row;
4. compare stored command digest, raw subject, scheduled delivery instant, and parent/root lineage;
5. return the existing ID when identical;
6. throw a permanent invariant error when the same key names different content;
7. publish only when this transaction created the row;
8. in an ambient Payload transaction, leave the created row for the existing outbox after commit.

For a new root `catalog.reconcile`, the same global GMC advisory lock must also query all retained reconciliation roots and descendants for that complete raw catalog subject and reject the insert with `GmcAsyncWorkflowConflictError` while any member is nonterminal. Subject scoping lets a shared adapter serve independent plugin instances without cross-account blocking and uses Fine's `(type, rawSubject, status)` ledger index to avoid scanning product roots. This check occurs only after same-key replay resolution, so an exact retry still returns the active root. It occurs before insert, so different API keys and scheduler/API races cannot create overlapping full workflows. Fine's cron status query remains an early, friendly skip; it is not the correctness boundary.

PostgreSQL `INSERT ... ON CONFLICT ...` or a unique-violation retry is required. Payload's public read-then-create sequence alone does not close the race. Never mark the incumbent superseded in immutable mode.

The adapter then maps the result:

```ts
dispatch: async ({
  command,
  idempotencyKey,
  parentOperationId,
  payload,
  req,
  rootOperationId,
  subject,
}) => {
  const row = await enqueueUniqueAsyncOperation({
    payload,
    req,
    type: 'gmcCommand',
    input: {
      command,
      commandDigest: getGmcCommandIdempotencyDigest(command),
      idempotencyKey,
      parentOperationId,
      rootOperationId,
      subject,
    },
  })
  return {
    operationId: String(row.operationId),
    state: row.published === 'sqs' ? 'queued' : 'pending',
  }
}
```

The passed `req` is mandatory in the collection hooks. Fine's existing outbox delay of roughly one to two minutes is acceptable for content convergence and preferable to a message outrunning the database commit.

## Ledger schema and workflow status

Add indexed, read-only fields:

```text
parentOperationId  nullable bigint -> async_operations.id
rootOperationId    nullable bigint -> async_operations.id
commandDigest      nullable text
rawSubject         nullable text
immutableKey       nullable unique text
```

For a root insert, set `rootOperationId = id` in the same database transaction or treat null as self consistently. Children store both IDs supplied by the plugin. Continuations must retain the original root.

`getOperation()` requires the exact plugin `instanceId`, rejects a requested row whose retained raw subject is outside `gmc:${instanceId}:`, applies the same predicate to every descendant aggregate, resolves the root, and uses one fixed-size PostgreSQL aggregate for counts, minimum start, maximum finish, one representative failure, and completed reconciliation-page totals. It never materializes descendants in the application process. `requestedState` reports the requested coordinator row; `state` follows the aggregate precedence in `v2-async-adapter.md`. The bounded `reconciliation` summary totals only validated completed remote-page results and can therefore be partial until aggregate success. Measured ledger health uses the same instance predicate. Index `(root_operation_id, status)` and `(parent_operation_id, status)`; do not issue one Payload query per child.

Recommended response mapping:

```ts
{
  operationId: String(row.id),
  parentOperationId: row.parentOperationId ? String(row.parentOperationId) : undefined,
  rootOperationId: String(rootId),
  commandType: row.input.command.type,
  attempts: row.attemptCount,
  submittedAt: row.createdAt,
  startedAt: aggregate.minLockedAt,
  finishedAt: aggregate.isTerminal ? aggregate.maxCompletedAt : undefined,
  state: aggregateState,
  childCounts: aggregateDescendantCounts,
  error: safeMappedError,
}
```

## Dedicated Merchant queue

Add `MerchantQueue` as FIFO. A sound initial profile for Fine's current plugin defaults is:

```ts
MerchantQueue: {
  fifo: true,
  reservedConcurrency: 4,
  handlerTimeoutSeconds: 30 * 60,
  visibilityTimeoutSeconds: 30 * 60 * 6,
  failureVisibilityTimeoutSeconds: 60,
  maxReceiveCount: 5,
  batchSize: 1,
  batchWindowSeconds: 0,
}
```

This is an initial bound, not a substitute for load testing. The configured plugin `products.batchSize` begins at 25 so coordinator dispatch stays bounded, `maxRemoteReconcilePages: 100` caps one pass at 100,000 remote offers, and multi-offer status refresh fans to one child per offer. Fine's worker has a 120-second ECS stop window, shorter than this handler ceiling; Merchant commands are therefore required to tolerate shutdown/redelivery. The three-hour visibility lease protects crash recovery. A caught failure or timeout resets visibility to 60 seconds; on timeout the isolated worker stops polling and fail-stops after a five-second reset grace so the leaked promise cannot race redelivery.

Keep `MerchantQueue` separate from `NightlyCronQueue`: catalog continuations need a catalog subject, offer writes need offer subjects, and unrelated Pinterest/ranking work must not head-of-line block Merchant recovery.

Fine's creates one singleton plugin executor per worker process and configures an atomic PostgreSQL `rateLimit.store` over the existing `payload_kv` table. A transaction-scoped advisory lock serializes the per-account counter across rolling ECS overlap and future horizontal scaling, so multiple processes cannot multiply the deployed ceiling. Production enablement requires `GOOGLE_MERCHANT_MAX_REQUESTS_PER_MINUTE`, derived from the account's current `quotas.list` response; 60 requests/minute is only the dark/non-production fallback, not rollout evidence. Fine's explicitly uses four HTTP attempts total (`maxRetries: 3`), 20-second request timeouts, and a 30-second maximum backoff; those bounds plus limiter waits fit below the handler ceiling with margin for coordinator/state work. The isolated Merchant queue retries a recorded handler failure after 60 seconds with one shared fifteen-attempt ledger/redrive budget, giving `GMC_PROCESSED_PRODUCT_NOT_READY` a bounded processing window without weakening cross-source ownership checks or allowing the ledger and DLQ thresholds to drift. Re-run the 50k-product/128MiB artifact load test before cutover and whenever the projection grows.

Fine's builds the canonical artifact daily at 09:15 UTC and runs the much more expensive catalog reconciliation Sundays at 09:30 UTC. The authenticated cron boundary queries the retained root and every descendant and skips a new full reconciliation while any prior member remains nonterminal. The immutable adapter independently enforces the same invariant atomically for every root dispatch and returns the plugin's standard workflow-conflict error, closing scheduler/API and API/API races. Reconciliation cadence must remain capacity-driven: at approximately 28,000 offers, even a nominal 60 requests/minute can require about 15.5 hours for the online GET+insert pair before local-inventory calls or retries. A schedule is not capacity proof.

The Merchant ECS task receives only the Postgres and Scheduler links and an explicit allowlist of Payload URL/media metadata, Google Merchant credentials/configuration, and the inventory artifact bucket name. It receives only the Merchant queue URL. Its task role can read/write objects only below `gmc-feeds/v2/*`; immutable descriptor keys and current pointers are further namespaced by `fines-gallery/<feedId>` so a shared bucket cannot cross plugin instances. It cannot list/delete the bucket or access canonical snapshots. The serial Pinterest feed task separately has read-only inventory-bucket access. Stripe, Resend, DocuSign, CallRail, OpenAI/Anthropic, Pinterest, socials, legacy-database, and unrelated application secrets are intentionally absent from the Merchant task.

## Projection in Fine's

Fine's still supplies a projector because only the host knows its canonical Product, variant, promotion, inventory, URL, media, taxonomy, and price rules. This is configuration, not a separate Merchant integration.

Fine's declares `categories`, `colors`, `media`, and `promos` through the plugin's `catalogDependencies` option, and `dealOfTheMonth` through `catalogGlobalDependencies`. Selectors expose only fields consumed by canonical projection. Complete reverse resolvers target category relations, all four Product media relation fields, the union of current/previous promotion products/categories/exclusions, and both old/new Deal products. Sitewide or untargeted promotions and color derivation safely retain the full-catalog fallback; sets above 1,000 also become one full root. The plugin appends hooks and owns paging/fan-out, so the canonical Payload transaction inserts one coordinator rather than thousands of children. Promotion `startDate` and `endDate` remain full-catalog durable boundaries through EventBridge Scheduler because a target set captured when staff edited the promotion can be stale when the boundary fires. The generic legacy `endPromotion` operation remains responsible for Fine's own Product pricing fields, not Merchant publication.

The projector consumes the same channel-neutral inventory model used by current TSV/Pinterest exports where practical. Its former request-rendering context loader swallowed color/promotion read failures and queried per product; that is unsafe for authoritative publication. The implemented Merchant path now loads complete published category/color/promotion tables with bounded keyset pages, fails closed on any read/malformed-page error, coalesces the context by immutable `projectionTime`, and filters promotions to the current product before passing labels/shipping policy into the GMC projection. It outputs a complete `ProductInput` on every call—never merges against a previous Google snapshot. Merchant-specific policy such as feed labels, Google taxonomy, custom labels, destinations, and shipping is expressed in this one projector and remains read-only derived output.

Fine's defaults reconciliation to detect-only. It selects `exclusive-data-sources` only when deployment sets `GOOGLE_MERCHANT_DATA_SOURCE_EXCLUSIVE=true`; any other nonempty value fails startup. Set that attestation only after verifying `GOOGLE_MERCHANT_DATA_SOURCE` is a dedicated primary API source written by this plugin instance alone.

Fine's worker derives each immediate root's int64 source version from the never-reused global AsyncOperations PostgreSQL sequence plus a fixed `2_000_000_000_000_000` migration epoch. Every immutable GMC enqueue takes one transaction-scoped global advisory lock before ID allocation, so root versions follow commit visibility even when canonical transactions on different rows race. Every continuation and child retains that root value; its later row ID is delivery identity, never fresher canonical intent. After commit, a second PostgreSQL advisory-lock boundary drains unpublished rows for each raw subject in ascending ID order and performs each publish-promotion CAS on the same connection; scheduled recovery uses the same drain. This is ordered across ECS/web processes, same-millisecond saves, dependency events, first-publish/recovery races, and scheduled reconciliation, and it exceeds every timestamp-microsecond value emitted by prerelease builds. Restore/cutover must preserve the ledger sequence, activation records, and publication state; if a remote product ever carries a version at or above the current epoch-plus-sequence, raise the epoch in a reviewed release before writing. The projector's `updatedAt` maximum remains only a fallback for non-worker feed canonicalization.

A future catalog registration has an older row ID because it is persisted when the dependency is saved, but the canonical temporal event occurs later. At activation Fine's takes the same global ordering lock, advances the AsyncOperations sequence once, and inserts an immutable root-version record in `payload_kv` before plugin execution. Retries read that record; every scheduled descendant retains it. This makes the boundary newer than earlier live events without giving separately allocated children inconsistent freshness.

The existing inventory snapshot is an excellent artifact-build source only if it has a commit/version boundary and exactly matches the projector contract. Do not let API publication project from live relational data while the canonical feed projects from a differently timed snapshot without a deliberate consistency policy.

## Cutover gates for Fine's

1. [x] Add immutable GMC enqueue and focused uniqueness tests.
2. [x] Remove `transactionOptions: false` and make the PostgreSQL harness transactional by default. Isolated real-PostgreSQL suites prove the installed plugin and Fine adapter commit Product, collection-dependency, and Global-dependency writes with their outbox rows and roll both back when a later hook fails. Repeat those proofs on the owner-generated production-like migration/schema before cutover.
3. [ ] Generate, review, apply, and rollback-test the owner-created Payload migration for lineage/immutable fields and indexes plus the complete v2 publication-state contract: unique indexed `key`; indexed identity/scope/status/operation/revision/desired-time fields; digest, signed-int64 version and `deleteVersion` fences; published/observed timestamps; remote status/missing/version; structured error; timestamps enabled and versions disabled. Verify `(root_operation_id,status)`, `(parent_operation_id,status)`, and `(type,raw_subject,status)` plus the retained unique `immutable_key`. Retire v1 shadow schema only in the later cleanup migration after rollback retention.
4. [x] Register `gmcCommand` exhaustively in types, contracts, queue map, and worker registry.
5. [x] Define `MerchantQueue`, DLQ, alarms, URLs, and isolated worker consumption in SST; derive web producer links from the authoritative queue registry; give each worker task role consume permission only on its allowlisted queue; restrict Merchant publication to `MerchantQueue`; isolate the Merchant environment and links; scope feed-artifact IAM to `gmc-feeds/v2/*`; give Pinterest read-only snapshot access; assign MediaConvert, CloudFront, inventory-write, Scheduler, and `iam:PassRole` capabilities only to the pools that need them; and scope the Scheduler target role to the seven main queue ARNs.
6. [x] Implement measured `health()` and aggregate `getOperation()`.
7. [x] Configure one plugin-owned Fine's projection and product artifact feed; no v2 Merchant fields are added to Products.
8. [x] Run the adapter conformance suite against a real PostgreSQL scratch schema, including rollback, 100-way duplicate dispatch, 100 distinct same-subject FIFO publication, and immutable replay/conflict behavior. Repeat against the exact owner-generated migration under gate 3.
9. [ ] Run Fine's configured durable `POST /merchant-center/v2/data-sources/validate` preflight to aggregate success, then shadow-compare canonical API input and generated export rows against current production output, including product-specific promo isolation and relation-read failure behavior; confirm the export URL is not registered as another Merchant primary source.
10. [ ] Verify `GOOGLE_MERCHANT_DATA_SOURCE` resolves as an `input: API` primary source, accepts the configured language/label, and has no other writer before setting `GOOGLE_MERCHANT_DATA_SOURCE_EXCLUSIVE=true`; otherwise retain the detect-only default.
11. [ ] Canary a dedicated data source or tightly bounded offer set.
12. [ ] Prove publish, identity change, unpublish, delete, retry-after-success, detect-only/exclusive reconciliation, artifact rollback, status refresh, and DLQ recovery against real services.
13. [x] Remove active v1 hooks, dirty writes, endpoint scheduler, cron credential, and product shadow-state configuration from code.
14. [ ] Before enabling plugin local-inventory writes, deregister Fine's transitional file-backed local-inventory source and verify Google no longer fetches `/api/local-inventory-feed.tsv`. The route returns `410 Gone` whenever `GOOGLE_MERCHANT_V2_ENABLED=true` as a fail-closed dual-writer guard; delete the route and helper after the rollback window.
15. [ ] Set the production request ceiling from `quotas.list`, prove the daily artifact/weekly reconciliation cadence does not overlap at production scale, then run feed/queue load tests and a full reconciliation; monitor aggregate root status, Merchant item issues, queue age, outbox age, limiter behavior, timeout fail-stop, skip telemetry, and DLQ.

Fine's should not declare the v2 deployment production-ready before all fifteen gates are evidenced.
