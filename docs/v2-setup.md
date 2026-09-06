# Payload GMC Ecommerce v2 setup and projection guide

This guide covers the host-owned configuration needed for a correct v2 deployment. Read the [architecture invariants](./v2-architecture.md) and [async adapter contract](./v2-async-adapter.md) first. The plugin is deliberately unusable without a conforming durable async adapter.

## 1. Establish the ownership model

Payload product, price, promotion, taxonomy, media, and inventory data remain canonical. The projector derives complete Google `ProductInput` objects from that data. Do not add editable Google title, description, price, availability, image, eligibility, or version fields solely for this plugin, and do not read the plugin publication-state collection while projecting content. Eligibility and revision signals should describe the canonical catalog (for example, `isSellable` and `canonicalRevision`), not recreate channel-specific `merchantEnabled` or `merchantVersion` shadows.

One Payload document can yield zero, one, or many Google offers:

- `products: []` is authoritative absence and removes previously owned offers;
- one result is a simple product;
- multiple results normally represent variants, each with a unique identity;
- every result is a complete replacement input, never a patch onto remote state.

## 2. Provision Merchant Center

Create or identify:

- the Merchant account ID;
- one primary API data source ID;
- any additional primary data source IDs the projector is allowed to route to;
- a service account with only the Merchant permissions this deployment needs;
- Business Profile stores and Merchant local-inventory configuration when local inventory is enabled.

Set `productIngestion: { mode: 'api-primary' }`. Every configured source must be `input: API` and contain `primaryProductDataSource`: file sources cannot accept ProductInput mutations, and supplemental sources cannot own product creation/deletion. A single source may be unrestricted. If `additionalDataSourceIds` is non-empty, every configured source must set both immutable `contentLanguage` and `feedLabel`, and those pairs must be unique. The worker validates the complete topology before product-plane work, so unrestricted or overlapping multi-source routing fails closed.

Record every writer to each identity, not merely each source. Google identifies a processed product by language, feed label, and offer ID; [ProductInput insert](https://developers.google.com/merchant/api/reference/rest/products_v1/accounts.productInputs/insert) moves that identity when another source currently owns it. V2 reads ownership immediately before ProductInput and local-inventory mutations and raises terminal `GMC_PRODUCT_DATA_SOURCE_CONFLICT` instead of transferring or modifying another source's identity. Stop and inventory an old writer before a source migration. Budget one processed-product GET per physical ProductInput insert and local-inventory mutation attempt in the account-wide rate limit. A shared source may be reconciled in detect-only mode, but it must never use automatic orphan deletion.

Do not register a plugin-generated TSV/XML export as a second Merchant primary product source for the same identities. In v2.0 the API source is the sole Merchant ingestion authority. Feeds are canonical export/read-model endpoints for downstream providers, audits, archives, and API/feed equivalence checks.

Configure account and data-source IDs as canonical positive decimal int64 strings (for example, `123456` and `104628`), not display names or full `accounts/.../dataSources/...` resource names. V2 rejects malformed enabled configuration before it can enqueue or call Google.

Store credentials in a secret manager. `getCredentials()` runs only in the worker path and should resolve the current secret on demand. Never place credentials, tokens, or private keys in commands, product fields, operation output, or logs.

## 3. Implement a monotonic projection version

`sourceVersion` must be a non-negative base-10 int64 string and must increase whenever any value in any projected offer can change. It is sent as Merchant API `versionNumber`; Google rejects a lower version and permits an equal version as a refresh.

A Product `updatedAt` is insufficient when related price, promotion, stock, category, image, variant, or Global rows can alter projection without updating the Product. Declare relation collections through `catalogDependencies` and Payload Globals through `catalogGlobalDependencies`; the plugin compares projection-relevant selections and dispatches a bounded root through the same transaction/outbox. Supply `resolveProductIds` when the host can prove a complete reverse mapping: return every affected current/previous Product ID, `[]` for no work, or `null` for a full sweep. The plugin caps targeted roots at 1,000 canonical IDs and automatically falls back to one full root above that bound. Do not perform direct child fan-out in the Payload hook.

Worker execution must source its sequence from the durable command ledger (or a dedicated global sequence). Pass the root workflow's globally monotonic int64 as `GmcCommandExecutionContext.sourceVersion`; every immediate descendant inherits it exactly even if its own row is allocated after an unrelated live event. A future schedule is only a registration: atomically allocate and persist one fresh sequence value when it becomes active, before any plugin/remote work, and inherit that value through the scheduled workflow. Preserve and advance the sequence and activation records across database restore. The executor replaces the projection version before claiming state or creating offer commands and rejects a missing value. The plugin supplies one `projectionTime` to every projector invocation in a catalog/feed pass; use it instead of calling `new Date()` repeatedly for temporal rules.

For a rule that changes solely because time passes, add `scheduleAt` to its catalog dependency and advertise durable scheduled delivery from the adapter. Return exact future boundaries such as promotion start/end. The scheduled root re-reads canonical state and fans out at execution time; targeted IDs are deliberately resolved only for immediate changes because a set captured when the schedule was registered can be stale at activation.

Do not use:

- a hash, because it is not ordered;
- wall-clock milliseconds without a monotonic conflict strategy;
- an application-local counter;
- a sequence that resets during restore, import, or migration.

## 4. Implement identity resolution

`resolveIdentities({ doc })` must work with both the previous document from an update and the last document returned after deletion. It should be deterministic, side-effect free, and independent of remote Google state.

```ts
resolveIdentities: ({ doc }) => {
  const variants = Array.isArray(doc.variants) ? doc.variants : []
  return variants.map((variant) => ({
    contentLanguage: 'en',
    feedLabel: 'US',
    offerId: String(variant.sku),
  }))
}
```

Google processed identity is the tuple of `contentLanguage`, `feedLabel`, and `offerId`; the data-source route selects its owner but does not create a second identity. Offer IDs must be stable and at most 50 characters. One projection cannot emit the same processed identity through different routes. A rename is a delete of the old identity plus publication of the new identity; it is not an in-place rename.

If identity resolution depends on a relation, ensure the deleted document retains the needed value or denormalize only the stable identity—not editable Merchant content—onto the product.

## 5. Implement the canonical projector

```ts
project: async ({ doc, payload }) => {
  const view = await loadCanonicalCommerceView({ doc, payload })
  if (!view.isSellable) {
    return { products: [], sourceVersion: String(view.canonicalRevision) }
  }

  return {
    sourceVersion: String(view.canonicalRevision),
    products: view.variants.map((variant) => ({
      contentLanguage: 'en',
      feedLabel: 'US',
      offerId: variant.sku,
      productAttributes: {
        availability: variant.available ? 'IN_STOCK' : 'OUT_OF_STOCK',
        brand: view.brand,
        description: view.description,
        gtins: variant.gtin ? [variant.gtin] : undefined,
        identifierExists: Boolean(variant.gtin || variant.mpn),
        imageLink: variant.imageUrl ?? view.imageUrl,
        itemGroupId: view.groupSku,
        link: `https://www.example.com/products/${view.slug}?variant=${variant.id}`,
        mpn: variant.mpn,
        price: {
          amountMicros: variant.priceMicros,
          currencyCode: view.currency,
        },
        salePrice: variant.salePriceMicros
          ? { amountMicros: variant.salePriceMicros, currencyCode: view.currency }
          : undefined,
        title: `${view.title} — ${variant.label}`,
      },
    })),
  }
}
```

Project only JSON-compatible data. The plugin normalizes object-key order and legacy Payload row wrappers, validates core Merchant requirements, and computes a SHA-256 digest over the API body. Warnings are retained in projection results for host observability but do not permit invalid output.

Google evolves `ProductAttributes` faster than package releases. V2 therefore permits additional API-native JSON fields on `productAttributes`; they are preserved in canonical hashing and API publication. ProductInput root fields remain an explicit writable allowlist because output-only fields and plugin-owned `versionNumber` must never leak from a projector. Recursive `customAttributes.groupValues` are preserved for API publication and bounded to 2,500 total nodes, 102,400 total characters, 10,240 characters per node, and 20 nested levels. Exactly one non-empty `value` or `groupValues` is required at every node. The built-in TSV serializer fails closed on an attribute without an explicit column mapping and on grouped custom attributes, whose tree cannot be losslessly represented as one generic text-feed column. Add a correct custom format adapter or upgrade the plugin before using such a field in a TSV-backed feed.

Keep the projector deterministic for a stable canonical database view. It may read relations through Payload, but it must not call Google, mutate documents, enqueue commands, consult the publication ledger, or use current time to change content. Canonical reads must fail closed: a failed category, color, promotion, media, price, or inventory query must reject the durable operation, not return an incomplete `ProductInput`. Cache or coalesce shared relation reads only when keyed by immutable `projectionTime`, bounded, and able to evict rejected promises.

## 6. Define eligibility

`products.where` limits automatic batch scans, reconciliation, dynamic feeds, and single-product worker reads. A product that no longer matches is treated as absent and its plugin-owned identities are deleted.

```ts
where: {
  and: [
    { isSellable: { equals: true } },
    { _status: { equals: 'published' } },
  ],
}
```

The plugin already uses `draft: false` and rejects an explicit `_status` other than `published`. Include only business eligibility in `where`; do not depend on access-control filters because plugin system reads use `overrideAccess: true`. A draft-only row is absent. A pending draft over a live row never becomes the projected document; unpublishing converges to deletion.

`fetchDepth` defaults to one. Choose the smallest depth that makes the projector complete. For large relation graphs, a host query optimized around a versioned commerce read model is preferable to deep per-product resolution.

## 7. Configure the durable adapter

The built-in `payloadJobsAsyncAdapter()` runs commands on Payload's own Jobs queue with a plugin-owned ledger collection. It is the fastest correct start, and [the adapter contract](./v2-async-adapter.md#payload-jobs) documents both what it guarantees and what it does not (no per-subject FIFO, no exclusive reconciliation). Something still has to run the queue: `jobs.autoRun` on a long-lived host, or an external scheduler calling the jobs run endpoint on serverless platforms.

```ts
import { payloadJobsAsyncAdapter } from 'payload-plugin-gmc-ecommerce/v2'

async: payloadJobsAsyncAdapter({ queue: 'gmc' })
```

To use another transport instead, implement all methods and capabilities from [the adapter contract](./v2-async-adapter.md). The most commonly missed rule is immutable key reuse: the same idempotency key returns the original operation forever, even after success or terminal failure. It never supersedes an in-flight live write.

Persist these values for every row:

- validated `command` and command schema version;
- `idempotencyKey` and a canonical command digest;
- raw ordered `subject`;
- `parentOperationId` and `rootOperationId`;
- lifecycle state, attempts, timestamps, safe error, and result;
- queue/outbox publication state.

Keep Payload database transactions enabled for the Product collection, every declared dependency collection, and every declared dependency Global. Do not use `disableTransaction: true` on those writes. The plugin awaits `req.transactionID` at the beginning of every automatic hook and throws `GMC_TRANSACTION_REQUIRED` when the resolved handle is absent, because a separate ledger transaction cannot close the crash gap after a canonical commit. This catches Payload's disabled-adapter shape where `req.transactionID` is a truthy Promise resolving to `null`. SQLite transactions are opt-in through a non-false `transactionOptions` object, MongoDB needs a replica set, and PostgreSQL must not use `transactionOptions: false`.

When a hook supplies `req`, join `req.transactionID` and write to an outbox in that same transaction. A queue message must never observe a product transaction that later rolls back. On-demand and scheduled operations have no simultaneous canonical mutation and may use the adapter's own transaction.

## 8. Configure feeds

Every feed selects exactly one language, feed label, and optional configured data source.

These are canonical exports, not a second Merchant ingestion path. A public endpoint may be fetched by a downstream provider, but it must not be registered in Merchant Center as a primary file source for offers already owned by v2's API source. Supporting file-primary Merchant ingestion would require a distinct mode that disables ProductInput writes and owns Google fetch scheduling; v2.0 intentionally fails to imply that behavior.

Dynamic delivery rebuilds the entire selected feed in a GET request. Use it only for a catalog with demonstrated worst-case latency and memory headroom. Artifact delivery is the production default:

```ts
const artifactStore: GmcFeedArtifactStore = {
  put: ({ body, descriptor, feedId, instanceId }) =>
    objectStore.putImmutable(instanceId, feedId, descriptor.key, body),
  read: ({ artifact, feedId, instanceId }) =>
    objectStore.readExact(instanceId, feedId, artifact.key),
  promote: ({ artifact, feedId, instanceId }) =>
    pointerStore.compareAndSetCurrent(instanceId, feedId, artifact),
  readCurrentDescriptor: ({ feedId, instanceId }) =>
    pointerStore.readCurrentDescriptor(instanceId, feedId),
  readCurrent: ({ feedId, instanceId }) => pointerStore.readCurrentObject(instanceId, feedId),
}
```

Every object and pointer namespace must include the supplied `instanceId` before `feedId`; feed IDs are unique only inside one plugin instance. The plugin also includes both segments in newly generated descriptor keys. `put` must not overwrite a different object at the same key. `read` must fetch that exact immutable object, not follow the current pointer. `promote` must atomically change a small pointer only after the plugin has read the object back and verified byte length, SHA-256 checksum, content type, creation time, and key. `readCurrentDescriptor` reads only that pointer descriptor; it must not download/follow a body. `readCurrent` returns one matched body/descriptor snapshot. Before serving, the plugin independently requires the descriptor key to match the requested `instanceId/feedId/sourceVersion-checksum.extension` namespace; a shared-store routing defect therefore fails closed instead of leaking another instance's feed.

The pointer descriptor is part of command idempotency. On replay, a pointer newer than the command skips the obsolete build. An equal source version must name the exact same descriptor; the executor reads that immutable object and verifies its checksum and metadata before treating the prior promotion as complete. Equal-version descriptor divergence is an invariant failure, never an arbitrary winner.

Set `limits.maxProducts` and `limits.maxSerializedBytes` well below the actual worker/container memory budget. The same byte limit independently bounds aggregate canonical ProductInput JSON before formatting and the final serialized body. The builder can retain canonical objects and serialized bytes at the same time, and JavaScript object overhead is not included, so process peak memory can exceed that number materially. Limits are hard failures, not recommendations.

Do not attach a blind age-expiration policy to immutable feed objects. The current pointer may legitimately reference an old last-known-good artifact after builds stop or fail. Retain current objects indefinitely, or run a pointer-aware mark-and-sweep collector with a rollback grace period, versioned-pointer protection, metrics, and a dry-run mode.

The built-in collection pass uses bounded keyset pages but does not hold one database transaction across the full feed. Concurrent writes can therefore be observed between pages. Hooks and the next build converge that view. Configure `products.maxCatalogPages` from the largest credible eligible catalog divided by `products.batchSize`, plus at least one terminal-probe page and growth headroom. The default is 10,000 pages. This same hard limit bounds feed collection, catalog publication/reconciliation, and local-inventory reconciliation; a breach fails the operation rather than silently truncating desired state. If a strict point-in-time file is required, project from a host-owned versioned snapshot whose version is also used for API publication.

Feed access is explicit:

- `'public'` produces public cache headers and is suitable for non-Merchant provider fetching;
- a callback produces `private, no-store` and must authenticate every request.

Do not put a secret token in a query string if it will leak through logs or referrers. Prefer provider-supported HTTP authentication or an unguessable path backed by edge controls.

## 9. Configure local inventory only when authoritative

Local inventory projection is also complete desired state. It may return an entry or `null` for each canonical offer/store. Missing projected entries are treated as deletes for every configured store during reconciliation.

```ts
localInventory: {
  storeCodes: ['nyc'],
  retiredStoreCodes: ['old-showroom'],
  project: ({ doc }) => doc.offers.flatMap((offer) => [{
    identity: { contentLanguage: 'en', feedLabel: 'US', offerId: offer.sku },
    storeCode: 'nyc',
    inventory: offer.nycQuantity > 0 ? {
      storeCode: 'nyc',
      localInventoryAttributes: {
        availability: 'IN_STOCK',
        price: { amountMicros: String(offer.nycPriceMicros), currencyCode: 'USD' },
        quantity: String(offer.nycQuantity),
        localShippingLabel: offer.sameDayEligible ? 'same-day' : undefined,
        loyaltyPrograms: offer.memberPriceMicros ? [{
          programLabel: 'gallery_club',
          tierLabel: 'member',
          price: { amountMicros: String(offer.memberPriceMicros), currencyCode: 'USD' },
        }] : undefined,
      },
    } : null,
  }]),
}
```

The identity must exist in the canonical product projection and an active store must be declared in `storeCodes`. All local-inventory children serialize on the offer-wide subject, after the ProductInput write they depend on; stores for one offer intentionally do not run concurrently. `availability` is required for every non-null entry. Store codes are case-sensitive, limited to 64 characters, and must exactly match a linked Business Profile location.

LocalInventory insert is a whole-resource replacement and Google exposes neither `versionNumber` nor a conditional mutation. The plugin therefore retains durable desired/applied state per processed identity/store. Every apply command carries its canonical `productId`, atomically claims the greatest global root source version and desired digest, then rechecks both base-product state and the per-store claim after remote ownership I/O and immediately before mutation. A delayed older child skips; different content at one source version raises terminal `GMC_LOCAL_INVENTORY_SOURCE_VERSION_CONFLICT`. Correctness still requires the adapter's complete offer subject to be FIFO and non-overlapping.

Never remove an active store code directly. Move it to `retiredStoreCodes`; reconciliation then emits deletion-only work for every canonical offer and never calls the active-store projector for that code. A queued pre-retirement insert also becomes a delete at execution time. Every mutation first proves the processed product is still owned by the routed source. Active insertion retries while a newly accepted ProductInput is not visible yet; deletion is already converged when the processed product is absent. Keep the code retired until one complete production reconciliation succeeds, all older operations on its offer subjects terminate, and aggregate status, DLQ, and Merchant verification prove cleanup. Only then remove the retired code. Active and retired lists must be disjoint and contain at most 1,000 codes in total. Both lists may be empty after retirement is proven complete; this keeps the local-inventory publication collection, generated Payload types, and migration schema stable while dispatching no store work. Remove the entire `localInventory` block only when the installation is permanently abandoning the capability and an owner-reviewed schema migration intentionally removes its state.

The accepted `localInventoryAttributes` shape tracks the writable [Merchant Inventories v1 LocalInventoryAttributes](https://developers.google.com/merchant/api/reference/rest/inventories_v1/accounts.products.localInventories): price, sale price and interval, loyalty programs, recursive custom attributes, availability, int64 quantity, pickup method/SLA, 20-byte in-store location, and 100-character local shipping label. [InventoryLoyaltyProgram](https://developers.google.com/merchant/api/reference/rest/inventories_v1/InventoryLoyaltyProgram) supports member price and interval, cashback, int64 points, member shipping label, and optional single-tier program/tier labels. Program/tier labels must match the account setup; their identity is case-insensitive. Multiple tiers/programs should supply both labels.

V2 rejects output-only/unknown fields, malformed or negative prices, mixed local currencies, sale/member prices above the supplied store price, invalid pickup pairs, duplicate loyalty identities, and payloads over 256 KiB before transport. Intervals use the protobuf `Interval` JSON shape (`startTime`/`endTime`) with RFC 3339 timestamps, offsets, up to nanosecond precision, open bounds, and inclusive-start/exclusive-end ordering. Recursive `customAttributes` can carry data-specification fields not yet exposed as first-class API fields, but only in Google's documented generic shape; the same structural and size limits described in section 6 apply.

Google account configuration is not inferable from the payload. Before enabling a benefit, verify Business Profile linkage, country/program eligibility, loyalty labels/tiers, local delivery services, pickup promises, and landing-page/checkout parity against the current [local inventory data specification](https://support.google.com/merchants/answer/14819809).

## 10. Choose reconciliation ownership explicitly

Reconciliation always performs the desired sweep, verifies remote existence, and counts remote orphan candidates. Its safe default is non-destructive:

```ts
reconciliation: {
  orphanDeletion: 'disabled'
}
```

Use `exclusive-data-sources` only after proving that every `dataSourceId` and `additionalDataSourceIds` value is a dedicated primary API source written by this plugin instance alone:

```ts
reconciliation: {
  orphanDeletion: 'exclusive-data-sources'
}
```

The operation response exposes aggregate `reconciliation.orphanCount`, `reconciliation.orphanDeleteCount`, `reconciliation.remoteCount`, and `reconciliation.pagesCompleted` across completed remote pages. The summary may be partial unless the workflow `state` is `succeeded`. Alert on both orphan counts; a nonzero orphan count in detect-only mode is evidence to investigate, not permission to delete.

## 11. Configure access and worker execution

`access` protects mutation, status, health, and publication-state reads and is evaluated only after authentication. Handle nullable/heterogeneous users defensively:

```ts
access: ({ user }) => {
  const role = user && typeof user === 'object' && 'role' in user ? user.role : undefined
  return role === 'admin' || role === 'owner'
}
```

Create one `createGmcCommandExecutor(normalizedOptions)` instance per worker process and invoke it only after the ledger has atomically claimed a row. “Direct” means inside that durable worker—not an unawaited web-process promise. The HTTP worker bridge is disabled by default; if infrastructure requires it, enable `api.exposeWorkerEndpoint` and implement independent machine authentication in `workerAccess`.

The executor has an in-process token cache and limiter. Multiple worker processes require an atomic distributed `rateLimit.store` or infrastructure limits that bound account-wide concurrency. Do not let process count multiply Merchant request rate unnoticed. Derive queue handler, claim-lock, and visibility budgets from request timeout, HTTP retries, maximum backoff, distributed-limiter wait, coordinator page size, and worst-case feed projection. A limiter reservation more than roughly one 60-second window ahead is rejected as corrupt. Load-test configured catalog/byte limits; they are safety bounds, not an execution-time proof.

## 12. Schema and startup

With default stores, the plugin adds a hidden, non-versioned product publication collection and, when `localInventory` is configured, a second hidden, non-versioned local-inventory publication collection. Generate and apply the Payload database migration before starting workers. The default stores support Payload's official SQLite, PostgreSQL, and MongoDB adapters. A custom database adapter must supply custom atomic `publicationState.store` and `localInventory.publicationState.store` implementations for the state domains it enables; partial method sets fail configuration.

RC31 advances the durable command schema from 1 to 2 because `localInventory.apply.productId` is now mandatory. Pause ingress and schedules, drain or quarantine every schema-1 RC30 row, deploy web and workers together, and only then accept schema-2 commands. Do not relabel old JSON as schema 2.

Never manually edit publication rows. They are operational convergence ledgers, not merchant content.

## 13. Pre-production proof

Before enabling production hooks, prove all of the following in the real host stack:

1. draft-only creation submits nothing;
2. publish produces every expected variant;
3. a draft over a published product re-sends only published content;
4. identity change deletes the old identity and publishes the new one;
5. eligibility removal, unpublish, and delete remove owned offers;
6. 100 concurrent duplicate dispatches produce one immutable operation;
7. a rolled-back Payload transaction produces no externally visible command;
8. worker crash after Google success converges safely on redelivery;
9. lower source versions never replace higher desired state;
10. reconciliation repairs missing offers and reports orphans without deleting in default mode;
11. explicitly owned-source reconciliation deletes only a seeded plugin-owned orphan;
12. corrupt artifact read-back cannot move the feed pointer;
13. root workflow status remains non-success until every descendant terminates;
14. queue, outbox, DLQ, and Merchant error alerts fire in a controlled exercise;
15. relation-read failure aborts instead of producing a degraded offer;
16. media URL/MIME, promotion boundaries, taxonomy, and color changes enter the durable workflow;
17. the canonical feed and API inputs match for the canary dataset.
18. `POST /gmc/v2/data-sources/validate` completes successfully through the production durable worker; each configured data source resolves as `input: API`, has `primaryProductDataSource`, accepts the configured canonical feed language/label, and no canonical export URL is registered as a competing Merchant primary source.
19. Multi-source configurations have complete, pairwise-disjoint language/label scopes; a seeded cross-source ownership conflict produces `GMC_PRODUCT_DATA_SOURCE_CONFLICT` and no insert.
20. Every retired local store completes deletion-only reconciliation before its code is removed from configuration.
21. Two independently dispatched local-inventory roots delivered in causal reverse order retain the newer per-store value, and equal-version divergent payloads fail without a Google mutation.
22. Artifact replay after pointer promotion but before ledger completion reuses the verified immutable object and does not rebuild or promote divergent bytes.

Continue with the [operations runbook](./v2-operations.md) and [migration runbook](./v2-migration.md).
