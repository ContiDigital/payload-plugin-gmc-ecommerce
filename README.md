# payload-plugin-gmc-ecommerce

Durable, one-way Google Merchant Center publication and canonical product feeds for Payload CMS 3.

Version 2 treats Payload commerce data as the sole content authority. A host-supplied projector derives complete Merchant API `ProductInput` records from published product documents; the plugin validates and canonicalizes that projection, generates feeds from the same input, and converges Google through bounded durable commands.

There is no Google-to-Payload content sync, no editable Merchant shadow attached to Products, no process-local background work, and no optional “fire and forget” mode.

## Status

`2.0.0-rc.35` is a breaking release candidate. Release-candidate tarballs are immutable. The final `2.0.0` package may be published only by the repository owner after the plugin release gates pass: deterministic executor/adapter/feed/state suites, exact-artifact install smoke, and the isolated packaged-transport lifecycle against a designated Merchant test source. The live transport smoke deliberately does not claim to prove a consumer's durable adapter, migration, or deployment. Publishing the reusable package does not authorize or perform any consumer deployment: each host must then install the registry release, regenerate its lockfile, run its own migration and integration gates, and obtain separate deployment approval. RC31 and later use durable command schema 2; drain or quarantine every RC30 command before upgrading because `localInventory.apply` now requires its canonical `productId`. RC32 makes an explicitly configured empty local-inventory store set schema-stable and inactive. RC33 tracks the current Merchant API v1 product-availability vocabulary, emits Google's exact documented TSV destination spellings, and fails closed when an API destination has no documented text-feed representation. RC34 makes the registry-release/consumer-deployment boundary explicit and prohibits committed vendored or local-file package dependencies. RC35 makes the live stable-release gate build and import the public package boundary and documents exactly which external lifecycle it proves. The v2 API is the package root and is also available from `payload-plugin-gmc-ecommerce/v2`. The historical 1.x engine is not exported or shipped in the v2 package. Existing v1 deployments must stay pinned to a 1.x release during their rollback window.

## Requirements

- Payload `>=3.37.0 <4.0.0`
- Node.js `^22.12.0 || >=24.0.0` (supported LTS lines only; Node 18 and 20 are EOL)
- an API-backed primary Merchant Center product data source and service-account credentials
- a host-provided durable async adapter with atomic deduplication, transactional enqueue/outbox behavior, FIFO execution per subject, retries, durable operation lookup, aggregate workflow status, and atomic exclusion of overlapping full reconciliations for the same complete raw catalog subject. Exact-key reconciliation replay must return the original operation; a different key must fail with `GmcAsyncWorkflowConflictError` while any member of the earlier workflow is nonterminal
- database transactions enabled for every collection/Global write carrying an automatic v2 hook; the plugin awaits the actual transaction handle and fails with `GMC_TRANSACTION_REQUIRED` before mutation when it is absent (including a disabled adapter's `Promise<null>`). Payload's SQLite adapter requires an explicit `transactionOptions` object, MongoDB requires a transaction-capable replica set, and PostgreSQL must not set `transactionOptions: false`
- one of Payload's official SQLite, PostgreSQL, or MongoDB adapters for the built-in product and local-inventory publication-state stores, or custom atomic stores for both configured state domains

After the owner publishes the stable package, install it from the registry and
commit the resulting package-manager lockfile:

```bash
pnpm add --save-exact payload-plugin-gmc-ecommerce@2.0.0
```

An immutable candidate tarball may be installed from outside a consumer
repository for pre-release compatibility testing. Do not copy it into the
consumer repository, commit a `file:` dependency, publish it, or deploy it.

## The v2 data flow

```text
published Payload product
          |
          v
host projector -> validated canonical ProductInput
                         |                 |
                         v                 v
             canonical export only   durable command ledger
               (TSV/XML/etc.)                |
                                             v
                                    FIFO worker by subject
                                            |
                                            v
                               verified API-primary source
                                            |
                                            v
                                    Merchant API v1
                                            |
                                            v
                              read-only status/diagnostics
```

The projector is pure desired-state policy. Returning `products: []` means that none of the document's previous Google offers should remain. A document may produce one offer or multiple variant offers.

## Minimal configuration

```ts
import { buildConfig } from 'payload'
import { payloadGmcEcommerceV2, type GmcAsyncAdapter } from 'payload-plugin-gmc-ecommerce'

const asyncAdapter: GmcAsyncAdapter = {
  name: 'host-async-operations',
  capabilities: {
    delivery: 'at-least-once',
    durable: true,
    exclusiveCatalogReconciliation: true,
    globalSourceVersion: true,
    orderedBySubject: true,
    scheduledDelivery: true,
    transactionAware: true,
    workflowStatus: true,
  },

  // These three methods must bridge to your durable ledger/queue. See the
  // adapter contract; do not replace this with an in-memory Promise or timer.
  dispatch: async (args) => hostAsyncOperations.enqueueUnique(args),
  getOperation: async (args) => hostAsyncOperations.getAggregate(args),
  health: async (args) => hostAsyncOperations.health(args),
}

export default buildConfig({
  collections: [Products],
  plugins: [
    payloadGmcEcommerceV2({
      merchantId: process.env.GMC_MERCHANT_ID!,
      dataSourceId: process.env.GMC_DATA_SOURCE_ID!,
      instanceId: 'primary-store',
      productIngestion: { mode: 'api-primary' },

      getCredentials: async () => ({
        type: 'json',
        credentials: await secrets.getGoogleMerchantServiceAccount(),
      }),

      async: asyncAdapter,
      access: ({ user }) => {
        const role = user && typeof user === 'object' && 'role' in user ? user.role : undefined
        return role === 'admin' || role === 'owner'
      },
      workerAccess: ({ req }) => verifyInternalWorkerRequest(req),

      // Collections which can change ProductInput without changing a Product.
      // The plugin owns their catalog fan-out; select only projection inputs.
      catalogDependencies: [
        {
          collection: 'promotions',
          select: ({ doc }) => ({
            status: doc._status,
            starts: doc.starts,
            ends: doc.ends,
            price: doc.price,
          }),
          // Requires async.capabilities.scheduledDelivery === true.
          scheduleAt: ({ doc }) =>
            [doc.starts, doc.ends].filter((value): value is string => typeof value === 'string'),
        },
      ],

      // Payload Globals can also affect every ProductInput. The same durable,
      // bounded catalog workflow is plugin-owned; no host Merchant hook is needed.
      catalogGlobalDependencies: [
        {
          global: 'catalogRules',
          select: ({ doc }) => ({ enabled: doc.enabled, featuredProduct: doc.product }),
        },
      ],

      // Fail-closed default: reconciliation reports remote orphan candidates
      // but does not delete them. Opt in only for dedicated plugin-owned
      // primary sources after a verified ownership inventory.
      reconciliation: { orphanDeletion: 'disabled' },

      products: {
        collection: 'products',
        batchSize: 25,
        fetchDepth: 1,
        // Hard ceiling for every local catalog scan. Size this from the
        // maximum expected product count and batchSize, including one
        // terminal probe page. Exceeding it fails closed before continuation.
        maxCatalogPages: 2_000,
        where: { isSellable: { equals: true } },

        resolveIdentities: ({ doc }) => [
          {
            contentLanguage: 'en',
            feedLabel: 'US',
            offerId: String(doc.sku),
          },
        ],

        project: ({ doc }) => ({
          sourceVersion: String(doc.canonicalRevision),
          products: [
            {
              contentLanguage: 'en',
              feedLabel: 'US',
              offerId: String(doc.sku),
              productAttributes: {
                availability: doc.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
                brand: String(doc.brand),
                description: String(doc.description),
                imageLink: String(doc.imageUrl),
                link: `https://example.com/products/${String(doc.slug)}`,
                price: {
                  amountMicros: String(doc.priceMicros),
                  currencyCode: 'USD',
                },
                title: String(doc.title),
              },
            },
          ],
        }),
      },

      feeds: [
        {
          id: 'google-us',
          path: '/feeds/google-us.tsv',
          access: 'public',
          delivery: 'dynamic',
          format: 'tsv',
          selector: { contentLanguage: 'en', feedLabel: 'US' },
        },
      ],
    }),
  ],
})
```

`sourceVersion` is a monotonic non-negative int64 string. It is sent as Google's `versionNumber`, so it must increase whenever the canonical offer can change. Do not derive it from a non-monotonic hash or reset it during a database migration.

Enabled configurations require `productIngestion.mode: 'api-primary'` and canonical positive int64 `merchantId`, `dataSourceId`, and `additionalDataSourceIds` values matching Merchant API resource IDs. Do not pass display names or whole resource names. Before the first remote action in a worker process—and again after a bounded cache expires—the executor reads the relevant Data Sources v1 control plane and requires `input: API`, `primaryProductDataSource`, the exact configured resource name/ID, and compatible language/label targeting. When multiple sources are configured, every source must have both immutable `contentLanguage` and `feedLabel` restrictions and every pair must be unique; an unrestricted or overlapping topology fails before any product-plane call. A file-backed, supplemental, mismatched, or malformed source fails with `GMC_API_PRIMARY_DATA_SOURCE_REQUIRED`. Disabled configurations alone may use inert placeholders so local tooling can start without production secrets.

Google's processed-product identity is `contentLanguage` + `feedLabel` + `offerId`; a data source owns that identity but is not part of it. Immediately before every ProductInput insert and local-inventory mutation, v2 reads the processed product. If another source owns it, the operation fails permanently with `GMC_PRODUCT_DATA_SOURCE_CONFLICT` and performs no mutation. This is deliberate: [Google's insert contract](https://developers.google.com/merchant/api/reference/rest/products_v1/accounts.productInputs/insert) otherwise moves the product silently, while local inventory addresses the processed identity without a source-qualified path. V2.0 has no implicit transfer flag; source migrations require a stopped old writer and an explicit, audited migration procedure. An active local-inventory insert retries with `GMC_PROCESSED_PRODUCT_NOT_READY` while an accepted ProductInput is still being processed; deletion is already converged when no processed product exists. Capacity plans must budget one processed-product GET for every physical ProductInput insert and local-inventory mutation attempt in addition to control-plane validation and retries.

`resolveIdentities` must work on the deleted document and on the previous version supplied to hooks. It is how the plugin removes old offers after deletion, unpublishing, source-filter changes, or an identity change.

`catalogDependencies` declares canonical collections such as promotions, taxonomy, colors, media, or shared pricing rules whose changes can alter projections without touching Product rows. `catalogGlobalDependencies` does the same for Payload Globals such as account-wide merchandising rules or a featured-product selector. The plugin appends transaction-aware hooks, compares selected projection inputs, and dispatches one bounded `catalog.publish` root when they differ; collection dependencies also receive delete hooks. An optional `resolveProductIds` returns the complete affected Product set, `[]` for no work, or `null` for a full sweep. Targeted sets are canonicalized and capped at 1,000 IDs; oversized sets fail safely to one full root, and the worker—not the Payload write transaction—pages durable children. Immediate event keys include the complete before/after event envelope and target scope so a later cyclic transition cannot be mistaken for an old operation. Declare every relation and Global whose projection-relevant value can change independently; otherwise only a later sweep can discover drift. `scheduleAt` works on either dependency kind and adds exact future boundaries for time-derived rules; schedules deliberately do not capture target IDs because that set can be stale by activation. The adapter must advertise `scheduledDelivery: true`, retain `scheduledFor` durably, and never execute early. Replaced/deleted schedules may still fire, but they re-read current canonical state and are therefore harmless convergence sweeps rather than stale payloads.

Payload transactions are part of the automatic-hook contract, not an optional performance setting. Keep the database adapter's transactions enabled and never pass `disableTransaction: true` to a Product, dependency-collection, or dependency-Global write. V2 awaits `req.transactionID` and validates the resolved handle; a truthy Promise which resolves to `null` is not a transaction. Without one ambient transaction there is no atomic boundary spanning the canonical commit and durable operation insert, so v2 throws `GmcTransactionalHookRequiredError` (`code: GMC_TRANSACTION_REQUIRED`) before mutation instead of silently accepting a crash-loss window. On-demand and scheduled roots are not coupled to a canonical write and continue to dispatch through their own durable adapter transaction.

## Durable async contract

Every hook, API request, batch, continuation, reconciliation pass, feed build, and local-inventory operation enters the host ledger. Merchant calls occur only inside `offer.publish`, `offer.delete`, `status.refresh`, or local-inventory worker commands.

An adapter must guarantee all of the following:

- persist before acknowledging dispatch;
- atomically reuse the original operation for the same `idempotencyKey`, including after terminal completion; compare `getGmcCommandIdempotencyDigest(command)` on conflicts so diagnostic `requestedAt` changes do not break a legitimate replay;
- never supersede or concurrently replace that operation;
- join the caller transaction and leave queue publication behind its commit whenever an automatic hook supplies `req`; v2 rejects such a hook when the ambient transaction is absent;
- deliver at least once and serialize all commands with the same `subject`;
- retain `parentOperationId` and `rootOperationId` for every descendant;
- return aggregate root status: a coordinator is not `succeeded` while a descendant is queued, running, failed, or dead-lettered;
- return the requested ledger row's own `requestedState` separately from aggregate `state`, and a fixed-size `reconciliation` summary across completed remote pages so orphan/remote metrics are observable without materializing descendants; treat summary counts as partial until aggregate success;
- expose queue/ledger health and durable operation lookup;
- pass the authoritative command, operation ID, root operation ID, Payload instance, and restore-safe global int64 `sourceVersion` to a singleton command executor in the worker;
- derive each immediate root's execution `sourceVersion` from a committed global ledger sequence (or an equally strong dedicated sequence), and pass that exact value to every descendant regardless of later child-row allocation;
- when `scheduledDelivery` is declared, persist `scheduledFor` with the immutable registration, make it visible only after the host transaction commits, never execute early, and atomically allocate and retain one new globally ordered activation version before any child or Merchant write; every scheduled descendant inherits that activation version.

Adapter health details and retained errors are control-plane output. Keep them bounded and free of credentials, bearer tokens, signed requests, private keys, or private product content even when the operations endpoint itself is authenticated.

The worker integration is intentionally small:

```ts
const executeGmc = createGmcCommandExecutor(normalizeGmcV2Options(gmcOptions))

// Called only after the host ledger atomically claims one queued operation.
await executeGmc({
  command: ledgerRow.input.command,
  operationId: String(ledgerRow.id),
  rootOperationId: ledgerRow.rootOperationId ?? String(ledgerRow.id),
  payload,
  sourceVersion: String(ledgerRow.rootCausalSourceVersion),
})
```

`sourceVersion` on the execution context is mandatory. It identifies the root causal workflow, not the current delivery row: an immediate root receives a globally ordered version when retained, all of its continuations and children reuse it exactly, and a future registration receives a fresh version only when its time boundary becomes active. Activation allocation must be persisted before work so retries reuse it. Never derive descendant freshness from later child IDs; an old batch could otherwise outrank a newer Product event. The sequence must remain monotonic across every worker and restore and never reuse one version for divergent canonical intent. The projector still returns a source version for direct canonical/feed evaluation, but worker correctness never falls back to a product timestamp. The plugin pins one `projectionTime` for each catalog/feed collection pass so host time-derived rules do not drift from row to row. Hosts must still make relation reads fail closed and deterministic enough for a retry; silently omitting a relation after a database error corrupts the claimed canonical result.

Create the executor once per worker process. Recreating it for every message also recreates its token cache and in-process rate limiter. Multi-process workers should configure a distributed `rateLimit.store` or enforce an equivalent account-wide limit in the queue infrastructure.

See [the complete async adapter contract](./docs/v2-async-adapter.md) and [the Fine's ECS deployment mapping](./docs/v2-fines-ecs.md).

## Feeds

Every feed pins a content language, feed label, and optional configured data source. Feed/API drift is structurally avoided because both originate from the same canonical projection.

V2.0 has exactly one Merchant ingestion authority: the configured API-backed primary source. Plugin feeds are canonical exports/read models for auditing, downstream providers, golden comparisons, or archival delivery. **Do not register one as another Merchant Center primary product source for the same identities.** Google treats API and file uploads as different data sources; a second primary source can move ownership or conflict with the API-owned offer. A future file-primary mode would have to disable ProductInput mutations and define fetch lifecycle explicitly—it is not silently approximated by this release.

The built-in TSV serializer is deterministic, stable-order, UTF-8, correctly escapes repeated structured values, formats price micros without floating-point loss, and fails closed if a Merchant API field has no TSV mapping. API-native fields newly added by Google are preserved by canonical hashing/publication; a custom format adapter or plugin update must add their specification-correct feed representation. Recursive Merchant API `customAttributes.groupValues` are preserved and validated for API publication but intentionally reject built-in TSV generation because flattening them would lose structure. A custom format adapter can produce provider-specific TSV, XML, JSONL, or another canonical endpoint without adding channel fields to Products.

Dynamic feeds build during the GET request and are appropriate only when catalog size and request budgets make that safe. Production catalogs should normally use artifact delivery:

```ts
{
  id: 'google-us',
  path: '/feeds/google-us.tsv',
  access: 'public',
  delivery: 'artifact',
  format: 'tsv',
  selector: { contentLanguage: 'en', feedLabel: 'US' },
  limits: { maxProducts: 50_000, maxSerializedBytes: 128 * 1024 * 1024 },
  artifactStore,
}
```

Artifact publication is write → exact immutable read-back → byte length/checksum/metadata verification → atomic pointer promotion. Every store action receives `instanceId`, and generated descriptor keys include `instanceId/feedId`; shared stores must namespace both immutable objects and current pointers accordingly. On every artifact-backed feed read, the plugin independently verifies that the returned descriptor key matches the requested instance, feed, source version, checksum, and safe extension before serving bytes. A failed, corrupted, or cross-namespace artifact cannot replace or impersonate the last-known-good feed. Public feeds send short cache headers plus an ETag; protected feeds are `private, no-store`.

The store's `readCurrentDescriptor` method must read only the atomically promoted pointer descriptor. Before rebuilding, the executor uses that small read to make at-least-once replay safe: a newer pointer skips obsolete work without downloading a body, while an equal-version pointer is accepted only after the executor reads and verifies the exact immutable artifact. This closes the crash window after promotion but before durable command completion.

The built-in catalog reader uses bounded keyset pages, not a database-wide snapshot transaction. A build is therefore a deterministic projection-time view over rows observed during that scan, while concurrent commits converge through hooks and the next build. `products.maxCatalogPages` (default `10_000`) is a hard local-scan ceiling shared by feed collection, catalog publication/reconciliation, and local-inventory reconciliation; exceeding it aborts rather than returning a truncated authoritative result. Size it from the maximum expected eligible document count divided by `batchSize`, plus a terminal-probe margin, and alert on any breach. If the business requires a strict point-in-time feed, the host projector must read from a versioned snapshot/read model under the same canonical contract.

`maxSerializedBytes` is also enforced while canonical ProductInput JSON is accumulated, before the formatter can receive an unbounded collection. It is not a process-memory ceiling: object overhead and the simultaneous canonical and serialized representations mean hosts must leave substantial memory headroom. Artifact stores must retain every object referenced by a current pointer; an age-only deletion rule is unsafe unless a pointer-aware collector first proves the object is unreachable.

Local inventory is a separate, complete store/offer projection published through Merchant Inventories v1. V2 supports the current API-native local fields, including loyalty member benefits, local shipping labels, and recursive custom attributes. It validates the current Business Profile/store and protobuf wire constraints before a command reaches Google; see the [v2 setup contract](./docs/v2-setup.md#9-configure-local-inventory-only-when-authoritative).

## API

The default base path is `/gmc/v2`. Mutation endpoints require an authenticated user accepted by `access` and a caller-supplied `Idempotency-Key` header. Product endpoints accept only `{ productId }`; mutation routes whose intent is fully represented by their path accept no request body and reject one rather than silently ignoring fields.

| Method | Path                                | Purpose                                                          |
| ------ | ----------------------------------- | ---------------------------------------------------------------- |
| `POST` | `/gmc/v2/data-sources/validate`     | Durably preflight API-primary source type and configured scopes  |
| `POST` | `/gmc/v2/products/publish`          | Re-read and converge one published product                       |
| `POST` | `/gmc/v2/products/status/refresh`   | Refresh read-only processed status                               |
| `POST` | `/gmc/v2/catalog/publish`           | Publish the eligible catalog through bounded children            |
| `POST` | `/gmc/v2/catalog/reconcile`         | Repair missing offers and detect/optionally delete owned orphans |
| `POST` | `/gmc/v2/feeds/:feedId/build`       | Build an artifact-backed feed                                    |
| `POST` | `/gmc/v2/local-inventory/reconcile` | Reconcile configured stores                                      |
| `GET`  | `/gmc/v2/operations/:operationId`   | Read aggregate durable workflow status                           |
| `GET`  | `/gmc/v2/health`                    | Read adapter capability and measured health                      |

Feed GET paths are configured per feed. The optional `/gmc/v2/worker/execute` endpoint is disabled by default; invoke the executor directly only inside the host's already-claimed durable worker. Never execute it as request-local background work. If an HTTP worker bridge is unavoidable, protect it with independent machine authentication through `workerAccess`.

## Publication state and reconciliation

The built-in hidden `gmc-publications-v2` and `gmc-local-inventory-publications-v2` collections are non-versioned and contain only operational state. Nothing is injected into Products. Updates use an actual adapter-level revision compare-and-set on SQLite, PostgreSQL, and MongoDB; Payload's hook-oriented bulk update is deliberately not used because its `where` predicate is not atomic with the final per-ID write. Successful and pending product deletions retain a monotonic `deleteVersion` fence, so an older or equal delayed publish cannot resurrect an identity after cross-subject execution races.

Google LocalInventory is a whole-resource replacement with no `versionNumber` or conditional write. The second collection therefore retains the greatest desired global source version and digest per processed identity/store. Every local command carries the canonical `productId`, claims that fence before Google I/O, and rechecks both base-product and per-store state immediately before mutation. An equal-version content divergence fails terminally; an older child from an independently dispatched catalog/local workflow skips even if it reached the FIFO after newer work.

Reconciliation has a desired-state barrier. It first marks every currently projected identity, verifies every configured source is an API-backed primary source, then scans only products owned by those sources. The default `reconciliation.orphanDeletion: 'disabled'` detects and reports orphan candidates but performs no destructive remote action. `exclusive-data-sources` may be selected only when every configured source is dedicated to this plugin instance. In that mode, an orphan is deleted only if no desired claim at or after the reconciliation start exists, and the delete command repeats that comparison before transport. The mandatory durable root `startedVersion` makes this causal rather than clock-based. Higher canonical source versions therefore win both publish/delete orderings; equal-version divergent content fails closed.

Status refresh is also durably bounded: a multi-offer request fans into one ordered child per offer, and each child performs at most one processed-product read before bounded retries.

## Security and operating rules

- `access` and `workerAccess` are required; there is no anonymous mutation default.
- Feed access is explicit: use `'public'` or an authorization callback.
- Credentials are resolved only in the worker and are never serialized into commands.
- Product reads use `overrideAccess: true` because the plugin is system work; command dispatch remains authenticated.
- Published reads use `draft: false` and additionally reject an explicit non-published `_status`; draft-only rows are absence, and a pending draft over a live row never becomes Merchant content.
- Worker command bodies are schema-versioned and validated before execution. RC31 and later emit schema 2; do not roll them over a ledger containing RC30 schema-1 rows without a deliberate drain or quarantine.
- Request bodies are limited to 1 MiB and user idempotency keys to 200 characters.
- Projection errors fail the durable operation; invalid products are never partially submitted.
- Deleting from an explicitly configured primary source treats Google 404 as idempotent success.

`disabled: true` removes plugin hooks and endpoints from the generated config; it does not cancel or pause durable rows already committed to the host ledger. A real pause is host-owned: stop schedules/ingress, stop or scale down workers, and preserve or explicitly quarantine queued rows.

## Migration from 1.x

Do not enable v1 and v2 writers against the same data source. Build and compare the v2 projection first, deploy the async adapter and worker, canary a dedicated data source or offer subset, then cut hooks and schedulers over atomically. The plugin never silently removes historical `mc`, sync-log, mapping, version, or job schema from a host database.

Follow [the v2 migration runbook](./docs/v2-migration.md). Keep the previous application artifact and its pinned 1.x package available for rollback until legacy schema cleanup is complete.

## Documentation

- [Architecture and invariants](./docs/v2-architecture.md)
- [Setup and projection guide](./docs/v2-setup.md)
- [Durable async adapter contract](./docs/v2-async-adapter.md)
- [Fine's ECS AsyncOperations mapping](./docs/v2-fines-ecs.md)
- [Operations and incident runbook](./docs/v2-operations.md)
- [1.x to 2.0 migration](./docs/v2-migration.md)

## License

MIT
