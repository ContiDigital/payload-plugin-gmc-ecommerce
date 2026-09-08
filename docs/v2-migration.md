# Migration

Two different migrations share this page. Pick the one you are doing.

- [From 1.x](#from-1x) — a different product, not an upgrade.
- [From a 2.0 release candidate](#from-a-20-release-candidate) — schema and
  contract changes since the last rc.

## From 1.x

1.x was a two-way sync engine: it added a `mc` field group to your products,
kept field mappings and sync logs in Payload, pushed and pulled, and resolved
conflicts. 2.0 is a one-way publisher with a projector you write. There is no
in-place upgrade, and no code path that reads 1.x state.

1.x continues on the `release/1.x` branch, with 1.3.0 as its last release. Keep
your existing install pinned to it until you have finished this migration.

### What is gone

| 1.x | 2.0 |
| --- | --- |
| The `mc` field group injected into products | Nothing is injected. Content comes from `products.project`. |
| Field mappings (`gmc-field-mappings`), transform presets | Your projector, in TypeScript. |
| Sync log collection, admin dashboard, `./client` and `./rsc` exports | The `gmc-publications-v2` state collection and the operations ledger; no UI. |
| Pull sync, conflict resolution (`mc-wins`, `newest-wins`), dirty tracking | Payload is the only authority; nothing is read back onto products. |
| Sync modes (`manual`, `onChange`, `scheduled`), batch push endpoints | Durable commands, run by a worker; see [Operations](v2-operations.md). |
| Per-product analytics from the Reports API | `status.refresh`, which records Google's processed status on the state row. |
| `MCProductAttributes.taxes`, `MCTax` | Removed; Merchant API v1 has no such field. |

The package root now exports 2.0 directly, so `import ... from
'payload-plugin-gmc-ecommerce'` gets the new plugin. Legacy symbols such as
`createMerchantService` no longer exist.

### The projector you have to write

This is the whole migration. In 1.x, field mappings turned product fields into
Merchant attributes at push time. In 2.0 you write one function that returns
the complete `ProductInput`, and it is the only source of product content.

Read your existing mappings and translate each one. A mapping with a
`toMicros` transform becomes an explicit `Price`; `extractAbsoluteUrl` becomes
whatever your media layer returns; `toArray` becomes an array literal. A
resolved Google product category becomes a lookup in `project`.

```ts
import type { GmcProductProjection, GmcProjectionArgs } from 'payload-plugin-gmc-ecommerce'

export const project = ({ doc }: GmcProjectionArgs): GmcProductProjection => {
  const product = doc as {
    category?: { googleCategoryId?: string }
    description?: string
    image?: { url?: string }
    inStock?: boolean
    price: number
    sku: string
    slug: string
    title: string
  }
  return {
    products: [
      {
        contentLanguage: 'en',
        feedLabel: 'US',
        offerId: product.sku,
        productAttributes: {
          availability: product.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
          condition: 'NEW',
          description: product.description,
          googleProductCategory: product.category?.googleCategoryId,
          imageLink: product.image?.url,
          link: `https://example.com/p/${product.slug}`,
          price: {
            amountMicros: String(Math.round(product.price * 1_000_000)),
            currencyCode: 'USD',
          },
          title: product.title,
        },
      },
    ],
  }
}
```

Three things that catch people out:

- `resolveIdentities` must return the same identities for the *previous*
  version of a document and for a deleted one. In 1.x the identity lived on the
  document in `mc.identity`; if you keep that field, read it there and fall back
  to your own rule.
- The projection must be complete. `productInputs.insert` is a full replace, so
  an attribute you stop returning is an attribute Google stops having.
- Everything a 1.x mapping stored in `mc.attrs` was a snapshot of what had been
  sent. Nothing reads it now. Derive from your real data instead.

### The sequence

1. Add 2.0 alongside nothing — a new install pointing at a **test** data source,
   with `reconciliation.orphanDeletion` left at `disabled`.
2. Write `project` and `resolveIdentities`. Run
   `POST /gmc/v2/catalog/publish` and compare what lands in the test source
   against your 1.x production feed, offer by offer.
3. Point 2.0 at the production data source, with the 1.x install still running
   but with its sync mode set to `manual` so it stops writing.
4. Publish the catalog with 2.0. Because the API insert is an upsert on the
   same identities, this converges onto the offers 1.x already created.
5. Run `POST /gmc/v2/catalog/reconcile` and read `orphanCount`. It should be
   the count of offers 1.x wrote that your 2.0 projection does not produce.
   Resolve each one before considering enabling deletion.
6. Remove the 1.x plugin. Its collections (`gmc-field-mappings`, the sync log)
   and the `mc` field group are yours to drop with a migration once nothing
   reads them. Drop the field group last: it is the only record of what 1.x
   sent.

## From a 2.0 release candidate

The changes below apply to older candidates such as rc.35. rc.37 already uses
the stable 2.0 contract: upgrading rc.37 to 2.0.0 requires no additional plugin
schema migration. Hosts coming from older candidates must review the schema,
queued commands, publication rows, and feed artifacts as described below.

### State collection

`gmc-publications-v2` loses `deleteVersion`, `desiredVersion` and
`publishedVersion`, and gains `storeCode`. Generate a migration for the new
shape. The remaining columns keep their meaning; `desiredAt` and
`desiredDigest` were already the ordering and skipping keys.

The separate `gmc-local-inventory-publications-v2` collection is gone. Local
inventory rows now live in the main collection, keyed by the same identity plus
a `|store:<code>` key segment and carrying `storeCode`. Drop the old table; do
not attempt to copy rows into the new one. The next
`localInventory.reconcile` re-establishes every store row from your projector,
which is cheaper and more trustworthy than a data migration.

**One ledger fact worth knowing before you run a reconcile.** Under the release
candidates, a deleted offer's row was left with `desiredAt: null` — deletion
ordering was carried by `deleteVersion`, which no longer exists. Those rows
therefore have no anti-resurrection stamp: a publish command queued before the
delete would not be refused by the `desiredAt` comparison. 2.0 stamps the
deletion instant into `desiredAt` on every delete it performs, so a row gets
its stamp the first time it is re-published or re-deleted under 2.0. Until
then, drain the queue (below) so no pre-upgrade publish command is left to
race, and treat one `catalog.reconcile` as part of the upgrade.

### Queued commands

Command wire schema is still `2`. The fields the release candidates wrote are
accepted and ignored for this release, so a queued row drains rather than
becoming a poison message:

| Command | Accepted and ignored |
| --- | --- |
| `catalog.reconcile` | `startedVersion` |
| `localInventory.apply` | `desiredVersion`, `sourceVersion` |
| `offer.delete` | `deleteIfDesiredBefore`, `deleteIfDesiredVersionBefore`, `deleteVersion`, `desiredVersion`, `sourceVersion` |
| `offer.publish` | `desiredVersion`, `sourceVersion` |

They will be rejected in a later release: drain the queue during the upgrade
and do not rely on the grace period.

### Feed artifacts

`GmcArtifactDescriptor.sourceVersion` is replaced by `generatedAt`, an ISO
instant. Promotion compares `generatedAt`: a newer artifact wins, an older one
returns `stale`, and an equal instant returns `stale` only when the descriptor
is identical. An existing pointer with no `generatedAt` is logged once and
rebuilt over on the next `feed.build`; nothing needs to be migrated by hand.
An `artifactStore` implementation of your own needs `readCurrentDescriptor`,
and its `promote` must implement the comparison above.

### Adapter contract

The contract shrank. An adapter is `{ name, dispatch, getOperation, health }`
plus optional `install` and `capabilities`.

- `GmcAsyncDispatchArgs.sourceVersion` is gone. Stop persisting or forwarding
  it.
- The executor is called with `{ command, operationId, rootOperationId?,
  payload }`. `sourceVersion` on the execution context is deprecated and
  ignored; it is still accepted so an rc worker compiles.
- The capability flags `globalSourceVersion`, `exclusiveCatalogReconciliation`,
  `workflowStatus`, `transactionAware`, `durable` and `delivery` are gone. Only
  `scheduledDelivery` and `orderedBySubject` are read, and only the first
  changes behaviour. Extra keys are accepted and ignored, so you may leave them
  in place while you clean up.
- Whatever machinery you built for global monotonic source versions — a version
  allocator, per-subject ordering records, an exclusivity lock around
  reconciliation — is dead weight. Ordering is `desiredAt`; skipping is the
  content digest; reconciliation needs no lock.

### Options

- `publicationState.store` and `localInventory.publicationState` are gone.
  Custom publication-state stores are no longer supported.
- `productIngestion` is ignored.
- `feeds` is optional; an install with no feeds is normal.
- `workerAccess` is required only with `api.exposeWorkerEndpoint: true`.
- `requireTransaction` is new and defaults to `false`. The release candidates
  effectively behaved as if it were `true`.
