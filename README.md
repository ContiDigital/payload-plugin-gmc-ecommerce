# payload-plugin-gmc-ecommerce

Publish Payload CMS products to Google Merchant Center.

You write one function that turns a published product into a Merchant API
`ProductInput`. The plugin does the rest: it detects changes, queues durable
publish and delete commands, runs them in a worker with retries and rate
limiting, keeps Google converged with your catalog, and can serve the same data
as a TSV feed.

- **One source of truth.** Product content comes only from your Payload data
  through your projector. The plugin never adds editable Merchant fields to
  your products and never writes Google data back into them.
- **Durable by design.** Every Merchant Center call is a command in a queue.
  Hooks enqueue; a worker executes. Nothing runs inside a web request.
- **Batteries included.** A built-in adapter on Payload Jobs works out of the
  box. Hosts with their own queue can plug it in through a small interface.

## Requirements

- Payload `>=3.37.0 <4.0.0` with the official SQLite, PostgreSQL, or MongoDB
  adapter.
- Node.js `^22.12.0 || >=24.0.0`.
- A Merchant Center account, an **API** data source (not a file feed), and a
  service account with Merchant API access.

```bash
pnpm add payload-plugin-gmc-ecommerce
```

Upgrading from 1.x? Read [docs/v2-migration.md](docs/v2-migration.md) first.
2.0 is a different model, not an in-place upgrade.

## Quick start

```ts
import { buildConfig } from 'payload'
import { payloadGmcEcommerce, payloadJobsAsyncAdapter } from 'payload-plugin-gmc-ecommerce'

import type { Product } from './payload-types'

export default buildConfig({
  collections: [Products],
  jobs: {
    // Runs queued Merchant commands every minute. Not for serverless hosts;
    // there, call payload.jobs.run({ queue: 'gmc', sequential: true }) from a
    // cron endpoint.
    autoRun: [{ cron: '* * * * *', queue: 'gmc', limit: 25 }],
  },
  plugins: [
    payloadGmcEcommerce({
      merchantId: process.env.GMC_MERCHANT_ID!,
      dataSourceId: process.env.GMC_DATA_SOURCE_ID!,
      getCredentials: async () => ({
        type: 'json',
        credentials: JSON.parse(process.env.GMC_SERVICE_ACCOUNT_JSON!),
      }),

      async: payloadJobsAsyncAdapter({ queue: 'gmc' }),

      products: {
        collection: 'products',
        where: { _status: { equals: 'published' } },

        // Every Google offer a document owns. Must work on a deleted document too.
        resolveIdentities: ({ doc }) => [
          { contentLanguage: 'en', feedLabel: 'US', offerId: String(doc.sku) },
        ],

        // The complete ProductInput. Return products: [] to remove the offer.
        project: ({ doc }) => {
          const product = doc as Product
          return {
            products: [
              {
                contentLanguage: 'en',
                feedLabel: 'US',
                offerId: product.sku,
                productAttributes: {
                  title: product.title,
                  description: product.description,
                  link: `https://example.com/products/${product.slug}`,
                  imageLink: product.image?.url,
                  availability: product.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
                  condition: 'NEW',
                  brand: 'Example',
                  price: {
                    amountMicros: String(Math.round(product.price * 1_000_000)),
                    currencyCode: 'USD',
                  },
                },
              },
            ],
          }
        },
      },
    }),
  ],
})
```

That is a working installation. Saving a published product enqueues a publish;
unpublishing or deleting it enqueues a delete; the worker converges Google.

## How it works

```text
Payload save/delete ──hook──▶ durable command ──worker──▶ Merchant API v1
                                    │
                                    └──▶ hidden publication state (digest, status, timestamps)
```

1. A hook on your products collection (and on any collections or globals you
   declare as dependencies) enqueues a `product.publish` command through the
   async adapter. With the built-in adapter and database transactions enabled,
   the command commits with the product.
2. The worker re-reads the **published** document, runs your `project`
   function, validates the result, and computes a content digest.
3. If the digest already published, nothing is sent. Otherwise the worker
   inserts the `ProductInput` (Google's insert is an upsert) and records the
   result in the hidden `gmc-publications-v2` collection.
4. Deletes, identity changes, and `products: []` remove old offers.
5. `catalog.publish` sweeps the whole catalog in pages; `catalog.reconcile`
   also scans Google for products it owns but your catalog does not, and
   reports them (optionally deletes them).

### Projection rules

- `project` receives `{ doc, payload, projectionTime }` and returns
  `{ products, sourceVersion?, warnings? }`. Derive everything from `doc` and
  your own data. Do not read the plugin's state collection.
- One document may map to several offers (variants). Each needs a unique
  `contentLanguage` + `feedLabel` + `offerId`.
- `resolveIdentities` must return the same identities for the previous version
  of a document and for a deleted document; it is how old offers get removed.
- `sourceVersion` is optional. If you keep a monotonic revision on your
  products, return it and the plugin sends it as Google's `versionNumber`.
- Unknown `productAttributes` fields pass through to the API unchanged, so
  new Merchant API fields work without a plugin update.

### Dependencies that change products

Prices, promotions, categories, media, and site-wide rules often live outside
the product document. Declare them and the plugin re-publishes affected
products when they change:

```ts
import type { Promotion } from './payload-types'

catalogDependencies: [
  {
    collection: 'promotions',
    // Only these fields matter; equal selections are ignored.
    select: ({ doc }) => ({ status: doc._status, starts: doc.starts, ends: doc.ends, price: doc.price }),
    // Optional: the exact products affected. Return null for a full sweep.
    resolveProductIds: ({ doc }) => (doc as Promotion).products?.map((p) => p.id) ?? null,
    // Optional: future instants when the same data projects differently.
    scheduleAt: ({ doc }) =>
      [doc.starts, doc.ends].filter((value): value is string => typeof value === 'string'),
  },
],
catalogGlobalDependencies: [
  { global: 'storeSettings', select: ({ doc }) => ({ freeShippingOver: doc.freeShippingOver }) },
],
```

`scheduleAt` needs an adapter that supports delayed delivery. The built-in
adapter does.

## Running the worker

With `payloadJobsAsyncAdapter`, commands are Payload Jobs on the `gmc` queue.
Run them with `jobs.autoRun` (shown above) or from your own scheduler:

```ts
await payload.jobs.run({ queue: 'gmc', limit: 25, sequential: true })
```

Payload runs a queue's jobs concurrently by default, and two concurrent write
transactions deadlock on SQLite — a SQLite host must pass `sequential: true`
and let only one runner drain the queue. Elsewhere, run one worker process or
accept that commands for the same offer may interleave; the plugin converges
either way, and the next reconcile repairs anything that raced.

To use your own queue (SQS, BullMQ, a database ledger), implement the adapter
interface described in [docs/v2-async-adapter.md](docs/v2-async-adapter.md):

```ts
type GmcAsyncAdapter = {
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
  /** Optional: add collections or tasks to the Payload config. */
  install?: (args: { config: Config; options: NormalizedGmcV2Options }) => Config
  capabilities?: { orderedBySubject?: boolean; scheduledDelivery?: boolean }
}
```

Your worker then calls the executor for each command it claims:

```ts
const execute = createGmcCommandExecutor(normalizeGmcV2Options(pluginOptions))
await execute({ command, operationId, rootOperationId, payload })
```

## Transactions

By default the plugin dispatches even when the save is not inside a database
transaction; a crash between the commit and the dispatch is repaired by the
next `catalog.reconcile`. Set `requireTransaction: true` to fail the save
instead (SQLite needs `transactionOptions: {}` on its adapter for that).

## Endpoints

All routes live under `api.basePath` (default `/gmc/v2`) and require a user
that passes `access` (default: admins). Mutations require an
`Idempotency-Key` header and return `202` with an operation id.

| Method | Path                             | What it does                                   |
| ------ | -------------------------------- | ---------------------------------------------- |
| POST   | `/products/publish`              | Re-publish one product (`{ productId }`)        |
| POST   | `/products/status/refresh`       | Fetch Google's processed status for a product  |
| POST   | `/catalog/publish`               | Publish every eligible product, in pages       |
| POST   | `/catalog/reconcile`             | Publish sweep plus remote orphan scan          |
| POST   | `/feeds/:feedId/build`           | Build an artifact-backed feed                  |
| POST   | `/local-inventory/reconcile`     | Reconcile configured stores                    |
| POST   | `/data-sources/validate`         | Check the data source is an API primary source |
| GET    | `/operations/:operationId`       | Aggregate status of a command and its children |
| GET    | `/health`                        | Adapter health                                 |

## Reconciliation

`catalog.reconcile` first re-publishes the catalog, then lists the products
Google holds in your data source. A product Google has that your catalog does
not is reported as an orphan. Deletion is off by default; set
`reconciliation: { orphanDeletion: 'exclusive-data-sources' }` only when this
plugin is the only writer to the data source. Before deleting, the worker
re-reads the product so a live product whose publish has not run yet is never
removed.

Schedule `catalog.publish` hourly and `catalog.reconcile` daily or weekly by
posting to the endpoints from a cron, or enqueue the commands directly with
`createCatalogPublishCommand()` and your adapter.

## Feeds (optional)

A feed serves the same canonical products as TSV. Useful for audits, other
channels, or archival. Do not register it as a second Merchant Center primary
source for the same offers; the API data source is the authority.

```ts
feeds: [
  {
    id: 'google-us',
    path: '/feeds/google-us.tsv',
    access: 'public',
    delivery: 'dynamic',              // or 'artifact' with an artifactStore for large catalogs
    selector: { contentLanguage: 'en', feedLabel: 'US' },
  },
],
```

Attributes without a documented TSV column are omitted and reported in the
build result's `warnings`. A custom `format` adapter can produce XML or any
other representation from the same canonical products.

A dynamic feed rebuilds on every uncached request, and each rebuild is a full
catalog scan, so a public dynamic feed is for small catalogs or for a path that
sits behind a CDN. A production catalog uses `delivery: 'artifact'`, which
serves the last promoted build instead of scanning. (Concurrent requests share
one in-flight build and the result is held in memory for 60 seconds, which
bounds a burst but not sustained traffic.)

## Local inventory (optional)

For Google local listings, declare store codes and a projector for per-store
stock. Each store row is published through Merchant Inventories v1 after the
product itself is live.

```ts
localInventory: {
  storeCodes: ['MAIN'],
  project: ({ doc, storeCode }) => [
    {
      identity: { contentLanguage: 'en', feedLabel: 'US', offerId: String(doc.sku) },
      storeCode,
      inventory: Number(doc.stock) > 0
        ? { storeCode, localInventoryAttributes: { availability: 'IN_STOCK', quantity: String(doc.stock) } }
        : null, // null removes the store row
    },
  ],
},
```

## Configuration reference

| Option                      | Required | Notes                                                     |
| --------------------------- | -------- | --------------------------------------------------------- |
| `merchantId`                | yes      | Numeric Merchant Center account id                        |
| `dataSourceId`              | yes      | Numeric id of an API-backed primary product data source   |
| `getCredentials`            | yes      | Returns service-account JSON credentials                  |
| `async`                     | yes      | `payloadJobsAsyncAdapter()` or your adapter               |
| `products`                  | yes      | `collection`, `project`, `resolveIdentities`, `where?`, `batchSize?`, `fetchDepth?`, `maxCatalogPages?`, `maxRemoteReconcilePages?`, `remotePageSize?` (reconcile list page size, default 250; `maxRemoteReconcilePages × remotePageSize` is the max remote offers one reconcile pass scans) |
| `access`                    | no       | Endpoint and state-collection access; default admin-only  |
| `catalogDependencies`       | no       | Collections whose changes re-publish products             |
| `catalogGlobalDependencies` | no       | Globals whose changes re-publish products                 |
| `feeds`                     | no       | TSV or custom-format exports                              |
| `localInventory`            | no       | Store codes and per-store projector                       |
| `reconciliation`            | no       | `orphanDeletion: 'disabled' \| 'exclusive-data-sources'`  |
| `rateLimit`                 | no       | Requests per minute, concurrency, retries, distributed store |
| `requireTransaction`        | no       | Fail hooks that run without a transaction (default false) |
| `instanceId`                | no       | Namespace for queues and state; needed for two installs   |
| `api.basePath`              | no       | Default `/gmc/v2`                                         |
| `api.exposeWorkerEndpoint`  | no       | Adds `POST /gmc/v2/worker/execute`, which runs one command inline. Off by default |
| `workerAccess`              | no       | Required when `api.exposeWorkerEndpoint` is on; authorizes that route |
| `additionalDataSourceIds`   | no       | Extra API sources selectable per offer                    |
| `disabled`                  | no       | No hooks and no endpoints. Schema is unchanged: the state collection, and the adapter's own `install` (the built-in one's ledger collection and Jobs task), are still declared |

## Documentation

- [Setup and projection guide](docs/v2-setup.md)
- [Architecture](docs/v2-architecture.md)
- [Async adapter contract](docs/v2-async-adapter.md)
- [Operations](docs/v2-operations.md)
- [Migrating from 1.x](docs/v2-migration.md)

## License

MIT
