# Setup

From an empty Merchant Center account to a product live in Google, then the
optional pieces. Every code block here exists as a compiling file under
`dev/docs-samples/`.

## 1. Merchant Center prerequisites

1. **A Merchant Center account id** — the numeric id, not the display name.
2. **A primary product data source whose input is `API`**, created under
   *Data sources → Add product source → Use the Content API*. A file feed, a
   supplemental source, or a source whose content language and feed label do
   not match the offers you send is rejected by `dataSources.validate`.
3. **A service account with Merchant API access** — created in Google Cloud
   with the Merchant API enabled, then added as a user on the Merchant Center
   account with at least the *Standard* role. Keep its JSON key out of your
   repository.

The plugin composes `accounts/<merchantId>/dataSources/<dataSourceId>` from the
account id and the numeric data source id.

## 2. Install and configure

```bash
pnpm add payload-plugin-gmc-ecommerce
```

The minimum working configuration is the account, the data source, the
credentials, an async adapter, and the two functions that describe your
products.

```ts
import { buildConfig } from 'payload'
import { payloadGmcEcommerce, payloadJobsAsyncAdapter } from 'payload-plugin-gmc-ecommerce'

import type { Product } from './payload-types'

export default buildConfig({
  collections: [Products],
  jobs: {
    autoRun: [{ cron: '* * * * *', limit: 25, queue: 'gmc' }],
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
        // Which documents may reach Google at all.
        where: { _status: { equals: 'published' } },
        // Every Google offer this document owns. Must also work for the
        // previous version of a document and for a deleted one.
        resolveIdentities: ({ doc }) => [
          { contentLanguage: 'en', feedLabel: 'US', offerId: String(doc.sku) },
        ],
        // The complete ProductInput for each offer.
        project: ({ doc }) => {
          const product = doc as Product
          return {
            products: [
              {
                contentLanguage: 'en',
                feedLabel: 'US',
                offerId: product.sku,
                productAttributes: {
                  availability: product.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
                  brand: 'Example',
                  condition: 'NEW',
                  description: product.description,
                  imageLink: product.image?.url,
                  link: `https://example.com/products/${product.slug}`,
                  price: {
                    amountMicros: String(Math.round(product.price * 1_000_000)),
                    currencyCode: 'USD',
                  },
                  title: product.title,
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

`project` receives `{ doc, payload, projectionTime }`. `projectionTime` is one
pinned instant — use it for anything time-derived, so a retry produces the same
content and therefore the same digest. Returning `products: []` is an
authoritative "this document must not exist in Merchant Center" and removes the
offers the document used to own. One document may return several offers
(variants, locales, feed labels), each with a distinct `contentLanguage` +
`feedLabel` + `offerId`. `project` may also return `sourceVersion` (a
non-negative int64 string, forwarded to Google as `ProductInput.versionNumber`)
and `warnings`. Do not read the plugin's state collection from it.

`resolveIdentities` is how old offers get cleaned up: it is called on the
*previous* version of a document during an update and on the document being
deleted, so it must not depend on data that is already gone.

Other `products` options: `fetchDepth` (relationship depth for the worker's
re-read, default 1), `batchSize` (products per coordinator page, default 100),
`maxCatalogPages` and `maxRemoteReconcilePages` (safety ceilings).

## 3. Run the queue and publish

`payloadJobsAsyncAdapter` installs a `gmc-operations` ledger collection and a
`gmc-command` Payload Jobs task. Something has to run that queue:

```ts
// A long-lived host: jobs.autoRun, as in the config above. Anywhere else,
// including serverless, call this from your own scheduler. On SQLite, pass
// sequential: true — see below.
await payload.jobs.run({ limit: 25, queue: 'gmc', sequential: true })
```

Payload runs a queue's jobs concurrently by default. **On SQLite that
deadlocks**: two concurrent write transactions cannot both proceed. A SQLite
host must run the queue with `sequential: true` and size its `jobs.autoRun`
entries so only one runner drains the `gmc` queue at a time. PostgreSQL and
MongoDB hosts may run jobs concurrently; ordering per offer is then
best-effort, and reconciliation converges anything that raced.

Start Payload and save a published product: the hook enqueues
`product.publish` and the next queue run executes it. The endpoints let you
drive the rest by hand. They need an `Idempotency-Key` and a user that passes
`access`.

```bash
curl -X POST .../api/gmc/v2/data-sources/validate -H 'Idempotency-Key: validate-1'
curl -X POST .../api/gmc/v2/catalog/publish -H 'Idempotency-Key: initial-publish-1'
curl .../api/gmc/v2/operations/<operationId>
```

A `published` row in `gmc-publications-v2` means Google accepted the
`ProductInput`. Whether Google *approved* the offer is a separate question:
post to `/gmc/v2/products/status/refresh` and read `remoteStatus` on the row.

## 4. Dependencies that change products

Prices, promotions, taxonomy and site-wide rules often live outside the product
document. Declare them and the plugin re-publishes affected products when they
change.

```ts
catalogDependencies: [
  {
    collection: 'promotions',
    // Only these fields affect projection; an equal selection dispatches nothing.
    select: ({ doc }) => ({
      ends: doc.ends,
      price: doc.price,
      starts: doc.starts,
      status: doc._status,
    }),
    // The products actually affected. Return null for a full catalog sweep.
    resolveProductIds: ({ doc }) =>
      (doc as Promotion).products?.map((product) => product.id) ?? null,
    // Future instants at which the same data projects differently.
    scheduleAt: ({ doc }) =>
      [doc.starts, doc.ends].filter((value): value is string => typeof value === 'string'),
  },
],
catalogGlobalDependencies: [
  {
    global: 'storeSettings',
    select: ({ doc }) => ({ freeShippingOver: doc.freeShippingOver }),
  },
],
```

`resolveProductIds` returning more than 1,000 ids falls back to a full sweep and
logs why. `scheduleAt` may return at most 20 ISO instants and needs an adapter
that supports delayed delivery — the built-in one does. Past instants are
ignored, and an instant already scheduled by the previous version of the
document is not scheduled twice.

## 5. Feeds (optional)

A feed serves the same canonical products as a TSV file. It is for audits,
archives, and other channels — not for Merchant Center, which already has the
API data source.

```ts
feeds: [
  {
    id: 'google-us',
    access: 'public',
    delivery: 'dynamic',
    path: '/feeds/google-us.tsv',
    selector: { contentLanguage: 'en', feedLabel: 'US' },
  },
],
```

`delivery: 'dynamic'` builds the file on each request. For a catalog too large
for that, use `delivery: 'artifact'` with an `artifactStore` you implement and
build it with `POST /gmc/v2/feeds/:feedId/build`; the path then serves the last
promoted artifact. `access` is `'public'` or a function of the request;
`limits` caps products and serialized bytes; `format` accepts a custom adapter
for XML or anything else. Attributes with no documented TSV column are omitted
and reported in the build's `warnings` rather than failing it.

## 6. Local inventory (optional)

For local listings, declare your store codes and a per-store projector. Store
rows are written only after the offer itself is `published`, because Google
attaches inventory to the processed product.

```ts
localInventory: {
  storeCodes: ['MAIN'],
  // Codes you have stopped managing. Keep them here until one full
  // reconciliation has removed their inventory; the plugin emits deletes for
  // them without calling project().
  retiredStoreCodes: [],
  project: ({ doc, storeCode }) => [
    {
      identity: { contentLanguage: 'en', feedLabel: 'US', offerId: String(doc.sku) },
      storeCode,
      // null removes this store's row.
      inventory:
        Number(doc.stock) > 0
          ? {
              storeCode,
              localInventoryAttributes: {
                availability: 'IN_STOCK',
                quantity: String(doc.stock),
              },
            }
          : null,
    },
  ],
},
```

Both lists may be empty. That keeps the schema and types stable while the
capability is inactive: no local-inventory work is dispatched.

## 7. Multiple data sources

`additionalDataSourceIds` registers extra API sources. A projected offer selects
one by setting `dataSourceOverride` to the full resource name.

```ts
additionalDataSourceIds: [process.env.GMC_EU_DATA_SOURCE_ID!],
```

With more than one source configured, every publish first reads the processed
product to check which source owns it — `productInputs.insert` moves an
existing offer to whichever source writes it, and that is not something to do
by accident. A single-source install skips that read for hook and API
publishes. It is still made for reconciliation children, which carry
`verifyRemote` and always read the processed product to prove the offer is
really there before trusting the local digest shortcut.

## 8. Two installations in one process

`instanceId` namespaces the durable queue subjects, the operation ledger, and
the artifact keys. It defaults to `merchantId`, which is right for one
installation. Give each installation its own id, state collection, and adapter
collection if you run two.

```ts
instanceId: 'gmc-us',
publicationState: { collectionSlug: 'gmc-publications-us' },
async: payloadJobsAsyncAdapter({ collectionSlug: 'gmc-operations-us', queue: 'gmc-us' }),
```

## 9. Transactions

By default the hooks dispatch even when the surrounding save is not inside a
database transaction, and log a warning the first time, once per process. A
crash in that window is repaired by the next `catalog.reconcile`.

Set `requireTransaction: true` to fail the save instead. Payload's SQLite
adapter needs `transactionOptions: {}` for transactions to exist at all; on
PostgreSQL and MongoDB they are on by default. A save made with
`disableTransaction` then fails with `GMC_TRANSACTION_REQUIRED` — which is the
point of the setting.

## 10. The worker endpoint (optional)

`api.exposeWorkerEndpoint: true` adds `POST /gmc/v2/worker/execute`, which runs
one command inline and returns its result. It exists for hosts whose queue
delivers work over HTTP rather than in-process. It is off by default, and
`workerAccess` — a function of `{ payload, req }` — is required when it is on;
the route authorizes before it reads the request body, so an unauthorized
caller costs nothing. Everything else in this plugin keeps Google calls out of
web requests, so leave this off unless your transport needs it.

## 11. Before production

- `POST /gmc/v2/data-sources/validate` and read the operation.
- Publish one product, `POST /gmc/v2/products/status/refresh` for it, and read
  `remoteStatus` on its publication row.
- Run `POST /gmc/v2/catalog/reconcile` with `orphanDeletion` at `disabled` and
  read `orphanCount`. A non-zero count before you have ever published means
  Google holds offers this install did not write; find out what they are before
  enabling deletion.
- `GET /gmc/v2/health` should report `ok`.
