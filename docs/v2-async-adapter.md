# Async adapter contract

Every Merchant Center call this plugin makes starts life as a command handed to
an async adapter. The adapter owns durability: it records the command, hands it
to a worker later, and can answer questions about it afterwards. The plugin
owns correctness once the command runs.

Most installations should use the built-in `payloadJobsAsyncAdapter`. Write
your own when you already have a queue — SQS, BullMQ, a database outbox — and
want Merchant commands on it.

## The interface

```ts
import type { Config, Payload, PayloadRequest } from 'payload'
import type {
  GmcAsyncDispatchArgs,
  GmcAsyncHealth,
  GmcAsyncOperation,
  GmcDispatchReceipt,
  NormalizedGmcV2Options,
} from 'payload-plugin-gmc-ecommerce'

type Adapter = {
  name: string
  dispatch: (args: GmcAsyncDispatchArgs) => Promise<GmcDispatchReceipt>
  getOperation: (args: {
    instanceId: string
    operationId: string
    payload: Payload
    req?: PayloadRequest
  }) => Promise<GmcAsyncOperation | null>
  health: (args: {
    instanceId: string
    payload: Payload
    req?: PayloadRequest
  }) => Promise<GmcAsyncHealth>
  install?: (args: { config: Config; options: NormalizedGmcV2Options }) => Config
  capabilities?: { orderedBySubject?: boolean; scheduledDelivery?: boolean }
}
```

### `dispatch`

Called by hooks, by the HTTP endpoints, and by coordinator commands fanning out
children. Its argument carries:

| Field | Meaning |
| --- | --- |
| `command` | The JSON command to execute later. Store it verbatim. |
| `idempotencyKey` | Stable across every retry of the event that caused this dispatch. |
| `subject` | `gmc:<instanceId>:<offer\|product\|feed\|catalog>:...`. Commands with the same subject touch the same thing. |
| `payload` | Runtime Payload instance. Never serialize it. |
| `req` | Present only when dispatching from a Payload request. Use it to join the host transaction. |
| `parentOperationId` | The operation that dispatched this one, when it is a child. |
| `rootOperationId` | The root of the workflow, inherited by every descendant. |
| `scheduledFor` | Not-before instant for a root command. Only set when you advertise `scheduledDelivery`. |

Return `{ operationId, state: 'queued' | 'pending' }`.

The one hard rule is idempotency by key: **a duplicate `idempotencyKey` must
atomically return the original operation**, including after that operation has
finished, and must never supersede or run alongside it. Enforce it with a
unique index, not a read-then-insert — hooks retry, and two workers can dispatch
the same key at the same time. If the same key arrives with a *different*
command body, that is a bug in the caller; throw
`GmcAsyncIdempotencyConflictError`.

When `req` is present, write the ledger row and publish the queue message
inside that request's transaction. A rollback then leaves neither, which is
what makes the outbox honest.

### The ledger

An adapter needs its own durable record; a queue alone is not enough, because
most queues delete a message once it succeeds and you still have to answer
`getOperation` afterwards. Per operation keep at least: the idempotency key
(unique), the command, the subject, the instance id, `parentOperationId` and
`rootOperationId`, the state, the attempt count, the last error, the scheduled
instant, and start/finish timestamps.

States are `queued`, `running`, `succeeded`, `failed`, `dead-lettered`, and
`cancelled`. Use `failed` for a terminal non-retryable outcome and
`dead-lettered` for something that was retryable but exhausted its budget —
operators triage those differently.

### `getOperation`

Returns the aggregate state of the **workflow**, not just the row asked for. A
coordinator that returned is not `succeeded` while a child is still running.
Precedence: any `dead-lettered` → `dead-lettered`; else any `failed` → `failed`;
else any `running` → `running`; else any `queued` → `queued`; else `succeeded`;
else `cancelled`. Report the requested row's own state separately in
`requestedState`, and per-state descendant counts in `childCounts`.

Return `null` for an unknown operation, and also for one belonging to a
different `instanceId` — a status read must not cross installations. An
operation id that the database cannot even parse is "not found", not an error.

### `health`

Return `{ status: 'ok' | 'degraded' | 'error', checkedAt, details? }`. `error`
means you could not answer; the plugin's `/gmc/v2/health` route turns it into a
503. Put whatever an operator needs into `details`.

### `install` and `capabilities`

`install` is called once while the plugin builds the config, and may add
collections or Payload Jobs tasks. Return the modified config.

`capabilities.scheduledDelivery` must be `true` for
`catalogDependencies[].scheduleAt` to be honoured. `capabilities.orderedBySubject`
is documentation: the plugin does not gate on it, and it converges either way
(see [Architecture](v2-architecture.md#ordering-and-convergence)). Declare it
honestly anyway — it tells an operator how much reordering to expect.

### Running commands

Whatever claims a message calls the executor with the ledger's identifiers:

```ts
import { createGmcCommandExecutor, normalizeGmcV2Options } from 'payload-plugin-gmc-ecommerce'

const execute = createGmcCommandExecutor(normalizeGmcV2Options(pluginOptions))

const result = await execute({
  command,
  operationId,
  payload,
  rootOperationId,
})
```

Build the executor once per normalized options object and reuse it: it owns the
rate limiter and the data-source validation cache, so rebuilding it per message
multiplies your Merchant request budget.

On failure, classify before deciding what to do:

```ts
import { classifyGmcCommandError } from 'payload-plugin-gmc-ecommerce'

const { code, message, retryable } = classifyGmcCommandError(error)
```

`retryable: false` means retrying cannot help — invalid projection, an ownership
conflict, a permanent Google rejection, a daily quota. Fail the operation
instead of burning the budget. `retryable: true` covers transport errors,
throttling, and anything unrecognised.

## The built-in adapter

`payloadJobsAsyncAdapter({ collectionSlug?, queue?, retries?, taskSlug? })`
runs on Payload's own Jobs queue. Defaults: `gmc-operations`, queue `gmc`, 5
retries after the first attempt, task `gmc-command`.

What it does:

- `install()` adds the `gmc-operations` ledger collection (hidden, read-only to
  hosts, readable by whoever passes your `access`) and registers one task. The
  `payload-jobs` collection cannot be the ledger, because Payload deletes a job
  once it succeeds.
- `dispatch` looks the key up, inserts a row under a unique index, then queues
  the job. With a hook's `req` both writes commit with your product.
- `scheduledFor` becomes the job's `waitUntil`, so `scheduleAt` works.
- The task marks the row `running`, calls the executor, and records the result.
  A redelivered envelope for a `succeeded` row returns immediately.
- Failures are classified. Retryable ones go back to `queued` and are retried
  with exponential backoff from 30 seconds; the row goes `dead-lettered` when
  the retry budget is spent and `failed` when the error was never retryable.
  Either way the job is acknowledged, so a poison message does not loop.
- `health` counts `queued`, `running`, rows queued for over 15 minutes with no
  future not-before time (`queue_backlog_stale`), and rows dead-lettered in the
  last 24 hours (`dead_letters_present`). Either reason reports `degraded`.

What it does not do:

- **Ordering.** Payload Jobs is not FIFO per subject, so the adapter reports
  `orderedBySubject: false`. Commands for one offer can run out of order or
  concurrently, and the digest and `desiredAt` rules are what make that safe.
- **Exactly-once delivery.** The guarantee is at-least-once. Inside a hook's
  transaction the ledger row and the job commit together; without a transaction,
  a concurrent dispatch of the same idempotency key can publish a second job for
  the same row. A duplicate execution converges: the second run finds the digest
  already published and skips.
- **Exclusivity.** Nothing stops two `catalog.reconcile` runs overlapping. They
  converge, but they cost twice as much; schedule them apart.
- **Running itself.** See below.

### Re-publishing a stranded row

A dispatch that finds an existing row for its idempotency key normally just
returns it. It re-publishes a job for that row only when the row is `queued`
**and** one of two things is true: its `jobId` is still null and the row is at
least 60 seconds old (the queue publication was lost after the row committed),
or the `payload-jobs` document it points at is gone, or is retained with an
error and is not being processed — Payload has exhausted that job's retries. An
unreadable jobs collection is not treated as abandonment, so a transient
database error cannot cause a double publish.

The remediation for a stranded row is therefore to dispatch the same command
again with the same idempotency key: re-save the product, or POST the publish
endpoint with the same `Idempotency-Key`. The new job lands on the original
row, so the operation id and its lineage do not change.

### Running the queue

Use `jobs.autoRun`, or call `payload.jobs.run` from your own scheduler:

```ts
await payload.jobs.run({ limit: 25, queue: 'gmc', sequential: true })
```

Payload runs a queue's jobs concurrently by default. **A SQLite host must pass
`sequential: true`**, because two concurrent write transactions deadlock on
SQLite; size `jobs.autoRun` so only one runner drains the `gmc` queue at a
time. PostgreSQL and MongoDB hosts may run jobs concurrently. Ordering per
offer is then best-effort, and reconciliation heals anything that raced.

## Conformance checklist

Run these against your adapter before trusting it:

1. **Idempotent dispatch.** Dispatch the same key twice, sequentially and
   concurrently. Both return the same `operationId`, and exactly one ledger row
   exists. Repeat after the operation has finished.
2. **Conflicting reuse.** Dispatch the same key with a different command body.
   It throws rather than overwriting.
3. **Transactional dispatch.** Dispatch with a `req` inside a transaction that
   then rolls back. No ledger row and no queue message survive.
4. **Durability.** Dispatch, kill the worker before it starts, restart. The
   command still runs.
5. **Scheduling.** If you advertise `scheduledDelivery`, a command with
   `scheduledFor` in the future is not executable before that instant and is
   executed after it.
6. **Aggregate status.** With a coordinator succeeded and one child still
   queued, `getOperation` on the coordinator returns `queued` — and
   `requestedState: 'succeeded'`.
7. **Isolation.** `getOperation` with a different `instanceId` returns `null`.
   So does an unknown or unparseable id.
8. **Terminal classification.** A command that fails with
   `retryable: false` stops retrying and lands in `failed`; a retryable one
   exhausts its budget and lands in `dead-lettered`.
9. **Health.** With a backlog present, `health` reports `degraded`; with the
   ledger unreachable, `error`.
10. **At-least-once tolerance.** Deliver the same command twice. The second
    execution is a no-op — proof that the executor, not the queue, is what
    keeps Google correct.
