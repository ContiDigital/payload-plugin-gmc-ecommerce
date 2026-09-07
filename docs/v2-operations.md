# Operations

What has to run, what to schedule, what the numbers mean, and what to do when
something is wrong.

## Running the worker

Nothing publishes until something drains the queue. With the built-in adapter
that is Payload Jobs on the `gmc` queue:

```ts
// Long-lived host: declare it in the Payload config.
jobs: {
  tasks: [], // The plugin appends its task; required by Payload 3.37.
  autoRun: [{ cron: '* * * * *', limit: 25, queue: 'gmc' }],
}

// Anywhere else — serverless included — call this from your own scheduler.
await payload.jobs.run({ limit: 25, queue: 'gmc', sequential: true })
```

Payload runs a queue's jobs concurrently by default. **A SQLite host must pass
`sequential: true`**: two concurrent write transactions deadlock on SQLite.
Size `jobs.autoRun` so only one runner drains the `gmc` queue at a time.
PostgreSQL and MongoDB hosts may run concurrently; ordering per offer is then
best-effort and the next reconcile converges anything that raced.

`limit` is the number of jobs per run — raise it if the queue grows faster than
it drains, keeping the Merchant rate limit below in mind.

With a custom adapter, your queue's consumer calls
`createGmcCommandExecutor(...)` — see
[the adapter contract](v2-async-adapter.md#running-commands).

## What to schedule

None of these run on their own. Post to the endpoint from cron, or enqueue the
command directly through your adapter. All mutating routes need an
`Idempotency-Key` header and a user that passes `access`; they answer `202` with
an operation id.

| Cadence | Command | Why |
| --- | --- | --- |
| Hourly | `POST /gmc/v2/catalog/publish` | Picks up anything a lost dispatch missed. Unchanged products cost one digest comparison and no Merchant write. |
| Daily or weekly | `POST /gmc/v2/catalog/reconcile` | The same sweep plus a scan of what Google actually holds. This is what finds orphans and repairs races. |
| Per feed, as often as the feed matters | `POST /gmc/v2/feeds/:feedId/build` | Only for `delivery: 'artifact'` feeds. Dynamic feeds build on request. |
| Daily, if you use local inventory | `POST /gmc/v2/local-inventory/reconcile` | Re-applies every store row for every eligible product. |
| After each deploy | `POST /gmc/v2/data-sources/validate` | Cheap preflight: every configured source is still API-primary and still accepts the identities you send. |

Do not overlap two `catalog.reconcile` runs. Nothing breaks, but they duplicate
every read. Space them further apart than one run takes.

## Reading status

```bash
curl https://example.com/api/gmc/v2/operations/<operationId>
```

```jsonc
{
  "operationId": "1042",
  "state": "queued",            // aggregate state of the whole workflow
  "requestedState": "succeeded", // this row's own state
  "childCounts": { "queued": 12, "succeeded": 300 },
  "commandType": "catalog.publish",
  "attempts": 1,
  "submittedAt": "...", "startedAt": "...", "finishedAt": "..."
}
```

A coordinator whose own row succeeded is still reported as `queued` or
`running` while its children are outstanding — that is the point of the
aggregate. `dead-lettered` and `failed` in `childCounts` are the two numbers to
alert on.

`GET /gmc/v2/health` returns the adapter's health plus the identity of the
installation, and answers 503 when the adapter cannot answer at all. With the
built-in adapter, `details` carries `queued`, `running`, `staleQueued`,
`staleRunning`, `deadLettered`, and a `reasons` array (`queue_backlog_stale`,
`running_rows_stale`, `dead_letters_present`).

## Publication status

Rows live in `gmc-publications-v2` (or your `publicationState.collectionSlug`),
one per offer, keyed by identity. They are readable by whoever passes `access`
and are never written by anything but the plugin.

| Status | What it means | What to do |
| --- | --- | --- |
| `publish-pending` | New content is claimed; Google has not been told yet. | Nothing, unless it is old — then the queue is not draining. |
| `published` | Google accepted this `publishedDigest`. | Note this is acceptance, not approval. `status.refresh` reads approval. |
| `delete-pending` | Removal is desired; the delete has not landed. | Same as above: old means stuck. |
| `deleted` | The offer was removed. The row is kept on purpose. | Nothing. It is what stops a stale publish resurrecting the offer. |
| `failed` | The last attempt against Google failed; `error` says why. | Read `error.code` and `error.retryable`. |

`remoteStatus`, `remoteVersion`, `remoteMissing` and `observedAt` are filled by
`status.refresh` and by reconciliation. `remoteMissing: true` on a `published`
row means Google does not have an offer you believe you sent.

## Incidents

### The queue is not draining

Symptoms: `staleQueued` climbing, `publish-pending` rows getting older,
`queue_backlog_stale` in health.

Check that something is actually running the queue (`autoRun` declared, or your
scheduler still calling `payload.jobs.run`), then that the worker process is
alive, then whether commands are failing rather than waiting — a large
`attempts` count with `queued` state is a retry loop, not a backlog. A retry
loop usually means Google is throttling or the ledger database is slow.

### A command stays `queued` although its job is gone

If the worker died before it could record an attempt — for example the ledger
database was unreachable at the moment the job started — often enough for
Payload to exhaust the job's retries, the `gmc-operations` row is left `queued`
pointing at a job that is either gone or retained with an error. The same
happens when a row committed but its queue publication was lost, leaving
`jobId` null. Health reports both as `queue_backlog_stale`.

Remediation: re-dispatch against *that row*, which means reusing its
idempotency key — POST `/gmc/v2/products/publish` with the same
`Idempotency-Key` the stranded request used, or call
`createProductPublishCommand` and hand your adapter the original key. The
adapter then sees that the referenced job no longer exists, or is retained in a
terminal error state, and publishes a fresh one against the existing row.

Re-saving the product does *not* re-drive the stranded row: the automatic hook
derives its key from a hash of the document's canonical content, so a save
produces a **new** operation. That still converges the offer — the new command
publishes the same desired state — but the old row stays where it is and keeps
showing in `staleQueued` until you clear it.

### A row is stuck `running` and its job is gone

Symptoms: a `gmc-operations` row sits in `running` with no job behind it, and
health reports `running_rows_stale` with a non-zero `staleRunning` — a row
whose `startedAt` (or, if it was claimed before recording one, its `updatedAt`)
is more than 30 minutes old.

Cause: the command succeeded at Google, and then every attempt to write the
terminal state back to the ledger failed. The adapter writes the row *after*
the Merchant call returns, so this window is exactly the one where the ledger
is unwritable — a database outage, a connection pool exhausted for longer than
the job's retry budget, or a transaction that could never commit. Google has
the change; only the row is wrong.

Remediation: nothing needs to be re-applied at Google. Either update the row's
`state` to `succeeded` by hand, or re-dispatch the same command with a **new**
`Idempotency-Key` — the executor's desired-state digest makes the repeat a
no-op against Google and writes a correct terminal row. A later
`catalog.reconcile` converges the publication state either way, so leaving the
row alone is safe as long as the alert is understood; it is the alert, not the
offer, that is stale.

### Dead letters

`dead_letters_present` means a retryable command exhausted its budget. Read the
row's `error` in `gmc-operations`. Nothing retries it automatically: fix the
cause, then re-dispatch by re-saving the product or posting
`/gmc/v2/products/publish` with a new `Idempotency-Key`. A `catalog.publish`
sweep also picks it up.

`failed` (as opposed to `dead-lettered`) means the error was never retryable —
usually a projection that does not validate, or an identity owned by another
product. Fix the data, not the queue.

### Reconciliation reports orphans

`orphanCount` on the operation is the number of offers Google holds that your
catalog does not want. Before doing anything about it, establish who wrote
them: another feed, an older install, or manual entry in the Merchant Center
UI all look identical from here.

If this plugin is the only writer to every configured data source, set
`reconciliation: { orphanDeletion: 'exclusive-data-sources' }` and the next
reconcile deletes them; `orphanDeleteCount` reports how many. If it is not the
only writer, leave deletion disabled — this is not a setting to try out.

### `GMC_IDENTITY_OWNERSHIP_CONFLICT`

Two products claim one `contentLanguage`/`feedLabel`/`offerId`. The plugin
refuses rather than letting them overwrite each other. Find the offending
documents (query the state collection for the identity's `key` to see which
`productId` owns it), fix `resolveIdentities`/`project` so the ids are unique,
and re-publish. The error is terminal; no amount of retrying resolves it.

### A data source is rejected

`dataSources.validate` and every publish check that the target is a primary
data source whose input is `API` and whose content language and feed label
accept the offer. A failure means the source was changed in Merchant Center, or
that an offer's identity does not match the source it routes to. Recreate the
source as an API primary source, or fix the identity.

### Rate limits

Defaults: 60 Merchant requests per minute, 4 concurrent, 5 retries with
exponential backoff and jitter, a 1,000-entry local queue, 30-second request
timeout. Tune with `rateLimit`, and use `rateLimit.store` to share the budget
across processes.

- Google 429/5xx and `QUOTA_REQUEST_RATE_TOO_HIGH` are retried.
- `QUOTA_TOO_MANY_REQUESTS` and `QUOTA_EXCEEDED_*` are treated as terminal:
  a daily or account limit does not recover on backoff, and amplifying it
  through every retry only makes it worse. Reduce the publish rate.
- A local queue overflow (`RateLimitQueueOverflowError`) is terminal — the
  worker is asking for more than the limiter can hold, so lower the job `limit`
  or raise `rateLimit.maxQueueSize`.
- A distributed rate-limit store failure is retryable and the command comes
  back.

### Feed build or serving failures

A build that finds a newer promoted artifact than its own `requestedAt` stands
down and reports `skipped` — that is correct, not an error. A pre-2.0 artifact
pointer with no `generatedAt` is logged once and rebuilt over. Unmapped
attributes are warnings on the result, not failures. A hard failure is a feed
limit (`maxProducts`, `maxSerializedBytes`) or an artifact store that cannot
write.

## Logs

Everything goes through Payload's logger. The messages worth alerting on:

- `dispatching Merchant command outside a database transaction` — once per
  process, the first time a hook dispatches without one. Either enable
  transactions or set `requireTransaction: true`.
- `GMC targeted dependency invalidation resolved N products; falling back to a
  full catalog root` — a `resolveProductIds` returned more than 1,000 ids.
- `feed <id> has a pre-2.0 artifact pointer with no generatedAt` — once per
  feed per process, during a migration.
- Feed warnings, logged one line per unmapped attribute per build, with the
  attribute `code` and `path`.
- `GMC gmc-command job <id> has no gmc-operations row; acknowledging` — a job
  whose ledger row was deleted. Should never happen; if it does, someone is
  writing to the ledger collection.

## Deploys and rollback

Command rows outlive a deploy. A worker running the new code may pick up a
command a hook wrote under the old one, which is why the command schema accepts
the fields the 2.0 release candidates wrote and ignores them. Drain the queue
before rolling *back*, though: an older worker does not understand a newer
command.

Nothing in the plugin needs a maintenance window. To pause publishing entirely,
stop running the queue — commands accumulate and execute when you resume.
`disabled: true` goes further: no hooks and no endpoints. Schema is deliberately
unaffected — the plugin still declares the publication state collection, and it
still calls the async adapter's `install`, so the built-in adapter's ledger
collection and its Payload Jobs task are declared exactly as when enabled. A
config toggled between enabled and disabled needs no migration.
