# payload-plugin-gmc-ecommerce

Google Merchant Center sync for [Payload CMS](https://payloadcms.com) v3.

Push products to Google Merchant Center, pull processed data back, manage field mappings, run batch operations, and monitor sync state, all from inside Payload's admin panel.

Uses the **Merchant API v1** (stable). Raw `fetch` to `merchantapi.googleapis.com`, no `@googleapis/content` dependency.

**Demo: plugin running in production on [Fine's Gallery](https://finesgallery.com)**

https://github.com/user-attachments/assets/21adb3d0-6f6b-4031-8aa2-33e622db4f1b

This plugin powers the [Fine's Gallery](https://finesgallery.com) Google Shopping integration, which is their primary revenue channel.

<img width="1209" height="607" alt="Fine's Gallery dominates Google Shopping for high-ticket marble sculptures" src="https://github.com/user-attachments/assets/cadf256d-ba85-4e3f-956e-57c1eba1baa8" />

<img width="1193" height="561" alt="Fine's Gallery Shopping listings across marble fountain searches" src="https://github.com/user-attachments/assets/020fb736-a4e9-444d-81f1-c42148578917" />

<img width="1193" height="667" alt="Fine's Gallery product listings powered by Merchant Center sync" src="https://github.com/user-attachments/assets/fa0435c0-83f9-4559-90db-3dc49894847a" />

The plugin manages Fine's entire Merchant Center catalog — syncing thousands of products, segmenting them into paid Shopping campaigns via `customLabel` fields, and providing a simple way for non-technical users to manage everything from the admin panel.

Read more for how Fine's Gallery uses Google Shopping to generate $200+k in monthly revenue: [Google Shopping for High-Ticket Ecommerce: The Fine's Gallery Playbook](https://www.petertconti.com/blog/google-shopping-for-high-ticket-ecommerce-the-fines-gallery-playbook)

## Requirements

- Payload CMS `^3.37.0`
- Node.js `^18.20.2 || >=20.9.0`
- **A long-running server process** (EC2, ECS, EKS, a VPS, etc.). See [Serverless Compatibility](#serverless-compatibility).

```bash
pnpm add payload-plugin-gmc-ecommerce
```

## Serverless Compatibility

**This plugin is not compatible with serverless environments like AWS Lambda or Vercel Functions.**

The plugin relies on background work that continues after the HTTP response is returned:

- **onChange sync** uses `setImmediate` to push products to MC after the save response is sent. On Lambda, the function freezes or terminates once the response is returned, killing the push mid-flight.
- **Batch operations** (initial sync, push-dirty, pull-all) use `void (async () => {...})()` to run asynchronously after the endpoint returns `{ jobId, status: 'running' }`. On Lambda, this background work is killed when the function invocation ends.
- **Large catalogs** (1000+ products) will exceed Lambda's 15-minute maximum timeout during batch operations, even if the function stayed alive. A 5000-product initial sync at 4 concurrent with rate limiting can take 20+ minutes.
- **In-memory state** (rate limiter buckets, service singleton) is lost between cold starts, which can cause duplicate pushes or quota overruns.

**Supported environments**: EC2, ECS, EKS, Docker on any long-running host, or any platform where your Node.js process runs continuously.

If your Payload deployment runs on Lambda (e.g., Vercel, SST), a common pattern is to run your main Payload instance on ECS/EC2 for admin and sync workloads while keeping your frontend on Lambda/Vercel.

## Minimal Setup

```ts
import { buildConfig } from 'payload'
import { payloadGmcEcommerce } from 'payload-plugin-gmc-ecommerce'

export default buildConfig({
  plugins: [
    payloadGmcEcommerce({
      merchantId: process.env.GMC_MERCHANT_ID!,
      dataSourceId: process.env.GMC_DATA_SOURCE_ID!,
      // Local dev: keyFilename reads the JSON file for you
      // Production: use type: 'json' with your secret manager (see setup guide)
      getCredentials: async () => ({
        type: 'keyFilename',
        path: process.env.GMC_SERVICE_ACCOUNT_PATH!,
      }),
      collections: {
        products: {
          slug: 'products',
          identityField: 'sku',
        },
      },
    }),
  ],
})
```

This mounts API endpoints under `/api/gmc/*`, injects a Merchant Center tab into your products collection, registers hidden utility collections, and adds an admin dashboard route at `/admin/merchant-center`.

Sync mode defaults to `manual`. Nothing syncs until you trigger it.

For the complete integration walkthrough, see [docs/setup-guide.md](./docs/setup-guide.md).

## What the Plugin Does

When enabled, the plugin:

1. Injects a `mc` field group into your products collection with identity fields, all Merchant Center product attributes, a read-only API snapshot, and sync metadata.
2. Adds a **Merchant Center** tab to each product's edit view with push/pull/delete/refresh controls, MC approval status per destination, performance analytics (impressions, clicks, CTR, conversions), and a read-only snapshot viewer.
3. Mounts REST endpoints for single-product and batch operations, health checks, field mapping management, and worker/cron scheduling.
4. Creates two hidden collections: `gmc-field-mappings` (runtime field mapping rules) and `gmc-sync-log` (operation history with progress tracking).
5. Adds an admin dashboard (or dashboard widget, or both) showing connection health, bulk operations, field mappings, and sync history.
6. Optionally registers Payload job task definitions when using the `payload-jobs` scheduling strategy.

## Configuration Reference

### Required Options

| Option                               | Type             | Description                                    |
| ------------------------------------ | ---------------- | ---------------------------------------------- |
| `merchantId`                         | `string`         | Your Google Merchant Center account ID         |
| `dataSourceId`                       | `string`         | The data source ID products will sync through  |
| `getCredentials`                     | `function`       | Returns Google service account credentials     |
| `collections.products.slug`          | `CollectionSlug` | Your products collection slug                  |
| `collections.products.identityField` | `string`         | Field used to derive `offerId` (e.g., `'sku'`) |

### All Options

```ts
payloadGmcEcommerce({
  // --- Required ---
  merchantId: string,
  dataSourceId: string,
  getCredentials: async ({ payload }) => CredentialResolution,
  collections: {
    products: {
      slug: CollectionSlug,
      identityField: string,
      autoInjectTab?: boolean,       // default: true
      tabPosition?: 'append' | 'before-last' | number,  // default: 'append'
      fetchDepth?: number,           // default: 1, depth for fetching product docs during push
      fieldMappings?: FieldMapping[], // default: []
    },
    categories?: {
      slug: CollectionSlug,
      nameField: string,
      googleCategoryIdField?: string,
      parentField?: string,
      productCategoryField?: string,  // relationship field on products
      productTypeField?: string,      // field used for MC productTypes
    },
  },

  // --- Credentials ---
  // getCredentials returns one of:
  //   { type: 'json', credentials: { client_email, private_key } }
  //   { type: 'keyFilename', path: '/path/to/service-account.json' }

  // --- Defaults ---
  defaults?: {
    contentLanguage?: string,  // default: 'en'
    feedLabel?: string,        // default: 'PRODUCTS'
    currency?: string,         // default: 'USD'
    condition?: string,        // default: 'NEW'
  },

  // --- Admin UI ---
  admin?: {
    mode?: 'route' | 'dashboard' | 'both' | 'headless',  // default: 'route'
    route?: string,       // default: '/merchant-center'
    navLabel?: string,    // default: 'Merchant Center'
  },

  // --- API ---
  api?: {
    basePath?: string,    // default: '/gmc'
  },

  // --- Site URL ---
  siteUrl?: string,
    // Base URL for resolving relative paths (e.g., 'https://example.com')
    // Required if using the 'extractAbsoluteUrl' transform preset

  // --- Sync ---
  sync?: {
    mode?: 'manual' | 'onChange' | 'scheduled',  // default: 'manual'
    permanentSync?: boolean,        // default: false
    conflictStrategy?: 'mc-wins' | 'payload-wins' | 'newest-wins',  // default: 'newest-wins'
    initialSync?: {
      enabled?: boolean,            // default: true
      dryRun?: boolean,             // default: true
      batchSize?: number,           // default: 100
      onlyIfRemoteMissing?: boolean, // default: true
    },
    schedule?: {
      strategy?: 'external' | 'payload-jobs',  // default: 'external'
      apiKey?: string,              // required for external strategy
      cron?: string,                // default: '0 4 * * *'
    },
    scheduleCron?: string,            // shorthand for schedule.cron (same default)
  },

  // --- Rate Limiting ---
  rateLimit?: {
    enabled?: boolean,              // default: true
    maxConcurrency?: number,        // default: 4
    maxQueueSize?: number,          // default: 200
    maxRequestsPerMinute?: number,  // default: 120
    maxRetries?: number,            // default: 4
    baseRetryDelayMs?: number,      // default: 300
    maxRetryDelayMs?: number,       // default: 4000
    jitterFactor?: number,          // default: 0.2
    requestTimeoutMs?: number,      // default: 15000
    store?: DistributedRateLimitStore,  // for multi-instance deployments
  },

  // --- Access Control ---
  access?: async ({ req, payload, user }) => boolean,
    // Default: user.isAdmin === true || user.roles includes 'admin'

  // --- Lifecycle Hook ---
  beforePush?: async ({ doc, operation, payload, productInput }) => MCProductInput,
    // The key integration point. See "The beforePush Hook" below.

  // --- Local Inventory (for Local Ads / Free Local Listings) ---
  localInventory?: {
    enabled?: boolean,              // default: false
    storeCode: string,              // Google Business Profile store code
    pickup?: {
      sla: LocalInventoryPickupSla,
        // 'SAME_DAY' | 'NEXT_DAY' | 'TWO_DAY' | ... | 'SEVEN_DAY' | 'MULTI_WEEK'
        // Omit pickup entirely for "On Display in Store" only (ships to customer)
    },
    availabilityResolver?: (doc) => 'in_stock' | null,
      // Optional custom resolver. Return 'in_stock' for products that should
      // appear as locally available; return null to remove the local entry.
      // Default: checks if MC availability is 'IN_STOCK' after beforePush.
  },

  // --- Disable ---
  disabled?: boolean,  // default: false
})
```

## Local Inventory (Local Ads & Free Local Listings)

The plugin supports Google's [Inventories sub-API](https://developers.google.com/merchant/api/guides/inventories) for **Local Inventory Ads** and **Free Local Listings**. This lets your in-stock products appear in Google's local shopping results, tied to your physical store location.

### How It Works

When `localInventory.enabled` is `true`:

1. **On every product push**: after the product is successfully synced to Merchant Center, the plugin checks if the product is in-stock (via `availabilityResolver` or the resolved MC `availability` attribute).
   - **In-stock** → inserts a local inventory entry for your store (`insertLocalInventory`)
   - **Not in-stock** → deletes the local inventory entry (`deleteLocalInventory`)
2. Local inventory sync is **non-critical** — failures are logged but do not fail the product push.
3. A **reconciliation endpoint** is available for batch operations and nightly cron jobs.

### Prerequisites

Before enabling local inventory in the plugin, complete these steps in Google Merchant Center:

1. **Link your Google Business Profile** to your Merchant Center account (your physical store must be listed)
2. **Enable the Free Local Listings and/or Local Inventory Ads add-on** (Settings → Add-ons)
3. **Configure your in-store product experience** (e.g., "On Display in Store" for showroom products shipped to customers)
4. **Note your store code** from Google Business Profile — this is the `storeCode` you'll pass to the plugin

### Configuration

```ts
payloadGmcEcommerce({
  // ... other options
  localInventory: {
    enabled: true,
    storeCode: 'your-gbp-store-code',

    // Optional: pickup configuration for "Pickup Later"
    // Omit this for "On Display in Store" only (items ship to customer)
    pickup: {
      sla: 'MULTI_WEEK',  // or 'SAME_DAY', 'NEXT_DAY', 'TWO_DAY' ... 'SEVEN_DAY'
    },

    // Optional: custom logic for which products are locally available
    availabilityResolver: (doc) => {
      return doc.stockStatus === 'in-stock' ? 'in_stock' : null
    },
  },
})
```

### Pickup Configuration

The `pickup` option controls whether in-stock products are also available for in-store pickup. This is separate from "On Display in Store" (which shows products viewable in the showroom but shipped to customers).

| `pickup.sla` | Google Annotation | Use Case |
|---|---|---|
| `'SAME_DAY'` | "Pickup today" | Item is ready for same-day pickup |
| `'NEXT_DAY'` | "Pickup tomorrow" | Ready next business day |
| `'TWO_DAY'` to `'SEVEN_DAY'` | "Pickup in X days" | Needs packaging/preparation time |
| `'MULTI_WEEK'` | "Store pick-up" | Generic annotation, no specific date shown |
| *(omit pickup entirely)* | No pickup annotation | "On Display in Store" only — item ships to customer |

> **Note:** As of September 2024, Google only requires `pickupSla`. The `pickupMethod` attribute is deprecated and is NOT submitted by this plugin.

**Example: Showroom with 7-day pickup prep time**
```ts
localInventory: {
  enabled: true,
  storeCode: 'bonita-springs-01',
  pickup: { sla: 'SEVEN_DAY' },  // Google rounds to next open day based on GBP hours
}
```

### Reconciliation Endpoint

For nightly cron jobs or manual reconciliation, use:

```
POST /api/gmc/local-inventory/reconcile        (authenticated user)
POST /api/gmc/worker/local-inventory/reconcile  (API key via X-GMC-API-Key header)
```

This iterates all MC-enabled products and ensures local inventory entries match their current stock status.

### Programmatic Access

```ts
const service = getMerchantServiceInstance()
const report = await service.reconcileLocalInventory({ payload })
// { inserted: 42, deleted: 5, errors: 0, processed: 47, total: 47 }
```

## Merchant Center Product Identity

Product identity in Google Merchant Center is derived from three values:

```
contentLanguage~feedLabel~offerId
```

For example: `en~PRODUCTS~SKU-123`

These three values together form a unique product in Merchant Center. Changing any of them creates a **new** Merchant Center product rather than updating the existing one.

The plugin resolves identity as follows:

1. `contentLanguage` from per-product override (`mc.identity.contentLanguage`) or `defaults.contentLanguage`
2. `feedLabel` from per-product override (`mc.identity.feedLabel`) or `defaults.feedLabel`
3. `offerId` from per-product override (`mc.identity.offerId`) or the value of your `identityField`

If you are connecting to an existing live Merchant Center data source, your identity values **must match your current production identity exactly**. If your live catalog uses `PRODUCTS` as the feed label and you configure the plugin with `US`, you will create duplicate products.

## Sync Modes

| Mode        | Behavior                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manual`    | Nothing syncs automatically. Use the admin UI or API endpoints to trigger operations.                                                                                                      |
| `onChange`  | Products auto-sync to Merchant Center on every successful save. The push runs asynchronously via `setImmediate` and never blocks the save response. Failures are logged to `gmc-sync-log`. |
| `scheduled` | Products are marked dirty on save. A scheduled job pushes all dirty products in batch.                                                                                                     |

Start with `manual`. Move to `onChange` or `scheduled` only after you have verified identity alignment and pushed a few products successfully.

### How onChange Works

When a product is saved and `mode` is `onChange`:

1. The `afterChange` hook fires and queues a push via `setImmediate` (or enqueues a Payload job if using `payload-jobs` strategy).
2. The HTTP response returns immediately. The user never waits for the MC API call.
3. The push runs in the background: resolve identity, apply field mappings, apply `beforePush`, insert product input, fetch snapshot, update sync metadata.
4. If the push fails, the error is written to `mc.syncMeta.lastError` and `mc.syncMeta.state` is set to `'error'`.

### Rate Limiter Behavior Under Load

If many products save simultaneously (e.g., a bulk update triggers 1000 onChange pushes):

- **4 products** process concurrently (default `maxConcurrency`)
- **200 products** queue behind them (default `maxQueueSize`)
- **Remaining products** receive a `RateLimitQueueOverflowError` and are marked dirty with `syncMeta.state: 'error'`
- Dirty products are picked up on the next scheduled sync or can be pushed via "Push Dirty" in the admin UI

This is by design. The rate limiter protects your MC API quota and prevents runaway API calls.

## Field Mappings

Field mappings copy values from your Payload document fields into Merchant Center product attributes. There are two sources of field mappings, and they are merged at push time:

### Config-Time Mappings

Defined in your plugin config. These are static and version-controlled:

```ts
collections: {
  products: {
    slug: 'products',
    identityField: 'sku',
    fieldMappings: [
      { source: 'title', target: 'productAttributes.title', syncMode: 'permanent' },
      { source: 'description', target: 'productAttributes.description', syncMode: 'permanent' },
      { source: 'price', target: 'productAttributes.price.amountMicros', syncMode: 'permanent', transformPreset: 'toMicrosString' },
      { source: 'featuredImage', target: 'productAttributes.imageLink', syncMode: 'permanent', transformPreset: 'extractAbsoluteUrl' },
    ],
  },
},
```

Field mappings are good for simple 1:1 field-to-attribute copies with optional transforms. For anything more complex (conditional logic, cross-collection lookups, computed values), use `beforePush`.

### Runtime Mappings (Admin UI)

Defined in the Merchant Center admin dashboard. These are stored in the `gmc-field-mappings` collection. Useful for non-developer users who need to adjust mappings without code changes.

Runtime mappings are additive. They are appended to config-time mappings, not replacing them.

### Sync Modes for Mappings

| Mode          | Behavior                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `permanent`   | Applied on every push. If `sync.permanentSync` is `true`, also applied in the `beforeChange` hook on every document save (pre-populating MC attribute fields before the push). |
| `initialOnly` | Applied only when a product has no existing snapshot (first sync).                                                                                                             |

### Transform Presets

| Preset               | What It Does                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `none`               | Pass value through unchanged                                                                                                 |
| `toMicros`           | Convert a number to micros string (15.99 becomes `"15990000"`). Non-numbers pass through unchanged.                          |
| `toMicrosString`     | Same as `toMicros` but also accepts numeric string input (`"15.99"` becomes `"15990000"`)                                    |
| `extractUrl`         | Extract `.url`, `.src`, or `.href` from an object (e.g., Payload media/upload field)                                         |
| `extractAbsoluteUrl` | Same as `extractUrl`, but prepends `siteUrl` for paths starting with `/`. Bare strings (e.g., slugs) pass through unchanged. |
| `toArray`            | Wrap a scalar value in an array. Arrays pass through unchanged.                                                              |
| `toString`           | Convert value to string                                                                                                      |
| `toBoolean`          | Convert value to boolean                                                                                                     |

> **Important**: `amountMicros` is a **string** in the Merchant API v1, not a number. Always use `toMicrosString` for price fields.

## Category Resolution

If you configure a `categories` collection, the plugin resolves `googleProductCategory` and `productTypes` from your product's category relationships during push.

```ts
collections: {
  categories: {
    slug: 'categories',
    nameField: 'title',
    googleCategoryIdField: 'googleCategoryId',  // Google taxonomy ID field
    parentField: 'parent',                       // self-referencing relationship
    productCategoryField: 'category',            // relationship field on products
    productTypeField: 'fullTitle',               // field for MC productTypes breadcrumb
  },
},
```

- `googleProductCategory`: Set to the Google taxonomy ID from the most specific category that has one.
- `productTypes`: Built from the category chain using `productTypeField` (falls back to `nameField`).
- Both are only set if not already manually populated on the product.

The category resolver handles single values, arrays, populated objects, and polymorphic relationships.

## The `beforePush` Hook

`beforePush` is the primary integration point of this plugin. While field mappings handle simple 1:1 copies, real-world ecommerce products almost always require conditional logic, cross-collection lookups, computed values, and business rules that field mappings cannot express. `beforePush` is where you put all of that.

It runs **after** field mappings and category resolution, right before the API call. It receives the prepared `MCProductInput` (already populated by field mappings) and the source Payload document, and must return the (potentially modified) input.

| Argument       | Description                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------- |
| `doc`          | The Payload document, hydrated to `fetchDepth` (relationships resolved as objects, not IDs) |
| `operation`    | `'insert'` or `'update'`                                                                    |
| `payload`      | Payload instance for querying other collections, running local API calls, etc.              |
| `productInput` | The prepared MC product input. Modify this and return it.                                   |

### Simple Example

```ts
beforePush: async ({ doc, productInput }) => {
  productInput.productAttributes ??= {}
  productInput.productAttributes.availability =
    (doc as any).inventory > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK'
  productInput.productAttributes.link =
    `${process.env.SITE_URL}/products/${(doc as any).slug}`
  return productInput
},
```

### Production Example

This is the actual `beforePush` implementation running in production for a ~5400-product ecommerce catalog. It demonstrates the full power of the hook: price fallback logic, sale price validation, category-derived material resolution, dimension unit overrides based on product type, cross-collection promo lookups, and image prioritization.

```ts
beforePush: async ({ doc, productInput, payload }) => {
  const product = doc as unknown as Product
  productInput.productAttributes ??= {}
  const attrs = productInput.productAttributes

  // --- Title / description fallback ---
  if (!attrs.title && product.title) attrs.title = product.title
  if (!attrs.description && product.description) attrs.description = product.description

  // --- Static fields ---
  attrs.brand = "Fine's Gallery"
  attrs.identifierExists = false
  attrs.condition = 'NEW'
  attrs.availability = product.stockStatus === 'out-of-stock' ? 'OUT_OF_STOCK' : 'IN_STOCK'

  // --- Link ---
  if (product.slug) {
    attrs.link = `${process.env.NEXT_PUBLIC_SERVER_URL}/products/${product.slug}`
  }

  // --- Pricing with fallback + sale price validation ---
  const toMicros = (value: number) => String(Math.round(value * 1_000_000))
  if (!product.suggestedPrice && product.price) {
    attrs.price = { amountMicros: toMicros(product.price), currencyCode: 'USD' }
  }
  const primaryPrice = product.suggestedPrice || product.price || 0
  if (!product.effectivePrice || product.effectivePrice >= primaryPrice) {
    delete attrs.salePrice  // remove invalid sale price
  }

  // --- Dimension units: rugs use feet, everything else uses inches ---
  const isRug = product.inheritedCategories?.some(
    (cat) => (typeof cat === 'object' ? cat?.title === 'Rugs' : false),
  )
  const unit = isRug ? 'ft' : 'in'
  if (attrs.productHeight?.value) attrs.productHeight.unit = unit
  if (attrs.productWidth?.value) attrs.productWidth.unit = unit
  if (attrs.productLength?.value) attrs.productLength.unit = unit

  // --- Category-derived fields ---
  const categoryRef = product.productCategories?.[0] ?? product.inheritedCategories?.[0]
  let category = typeof categoryRef === 'object' ? categoryRef : null

  if (!category && categoryRef && payload) {
    try {
      category = await payload.findByID({ collection: 'categories', id: categoryRef as number })
    } catch { /* skip */ }
  }

  if (category) {
    attrs.material = getMaterial(category)  // marble, bronze, limestone, etc.
    if (category.googleCategoryId) {
      attrs.googleProductCategory = String(category.googleCategoryId)
    }
    if (category.fullTitle) {
      attrs.productTypes = [category.fullTitle]
    }
    // Custom label: marble vs non-marble for Shopping campaign segmentation
    // Only set on products opted into the Google Shopping feed
    const shoppingEnabled = (product as any).googleFeed === true
    if (shoppingEnabled) {
      const isMarble = category.displayName?.toLowerCase().includes('marble')
      attrs.customLabel0 = isMarble ? 'marbleShopping' : 'nonMarbleShopping'
    }
  }

  // --- Promo fields (cross-collection lookup) ---
  try {
    const promos = await payload.find({
      collection: 'promos',
      where: { 'promoProducts.product': { equals: product.id } },
      limit: 200,
      depth: 1,
    })
    const promoLabels = getActivePromoCustomLabels(promos)
    if (promoLabels.length > 0) {
      attrs.customLabel1 = promoLabels.join(' | ')
    }
    if (hasEligibleFreeShippingPromo(promos)) {
      attrs.shipping = [{
        country: 'US', service: 'Standard',
        price: { amountMicros: '0', currencyCode: 'USD' },
      }]
    }
  } catch (err) {
    console.error('[GMC] Failed to hydrate promos:', err)
  }

  // --- Image handling: ad images first, then main image fallback ---
  const adImages = product.adImages as Array<{ url?: string }> | undefined
  const mainImage = product.mainImage as { url?: string } | undefined
  if (adImages?.length) {
    attrs.imageLink = adImages[0]?.url || ''
    const additional = adImages.slice(1).map((img) => img?.url).filter(Boolean)
    if (additional.length > 0) attrs.additionalImageLinks = additional as string[]
  } else if (mainImage?.url) {
    attrs.imageLink = mainImage.url
  }

  return productInput
},
```

### What `beforePush` Can Do

Because `beforePush` receives the full Payload instance, you can do anything:

- **Query other collections**: Look up promos, inventory records, warehouse data, related products, or any other collection to derive MC attributes.
- **Conditional logic**: Set different values based on product type, category, status, or any field on the document. Rugs get feet for dimensions, everything else gets inches. Products with no GTIN set `identifierExists: false`.
- **Price computation**: Validate sale prices against regular prices, apply currency conversions, handle tax-inclusive pricing.
- **Image prioritization**: Choose between multiple image sources (ad images, main image, gallery) and set primary vs. additional image links.
- **Custom labels for campaigns**: Derive custom labels from category hierarchies, active promotions, or any business logic for Google Shopping campaign segmentation.
- **Override or delete fields**: Remove invalid sale prices, override values set by field mappings, or conditionally suppress fields.

The pattern is straightforward: use `fieldMappings` for simple copies, use `beforePush` for everything else. In practice, most production integrations do the bulk of their work in `beforePush`.

## Conflict Strategy

Controls how pull operations handle conflicts between local and remote data. Default: **`newest-wins`**.

| Strategy       | Pull Behavior                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mc-wins`      | MC values always overwrite local. Pull always proceeds.                                                                                                                                                                          |
| `payload-wins` | Pull is skipped if the local document has been modified since last sync (`dirty === true`). Otherwise, pull proceeds.                                                                                                            |
| `newest-wins`  | Pull is skipped if the local document is dirty. If not dirty, the plugin compares the MC product's `updateTime` against the local `lastSyncedAt`. Pull proceeds only if the remote is newer, or if timestamps can't be compared. |

### Pull Merge Behavior

When a single-product pull proceeds, the remote MC attributes are **deep-merged** into the local MC attributes (`deepMerge(local, remote)`). Remote values overwrite local values for the same keys, but local-only keys are preserved.

When a pull-all operation proceeds, the remote MC attributes **replace** the local MC attributes entirely (no merge).

Both operations always update the snapshot and sync metadata.

## Admin UI Modes

| Mode        | What You Get                                                   |
| ----------- | -------------------------------------------------------------- |
| `route`     | Dedicated admin page at `/admin/merchant-center` with nav link |
| `dashboard` | Widget on the Payload dashboard linking to a full-page view    |
| `both`      | Both the dedicated route and the dashboard widget              |
| `headless`  | No admin UI. Endpoints and sync logic only.                    |

All modes include the per-product Merchant Center tab with sync controls (unless `autoInjectTab` is `false`).

## Scheduling Strategies

### External Strategy (default)

Use when you already have a cron or scheduling system (i.e. AWS eventbridge / lambda). Set up your external system to POST to the cron endpoint:

```bash
curl -X POST https://your-site.com/api/gmc/cron/sync \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Configure:

```ts
sync: {
  mode: 'scheduled',
  schedule: {
    strategy: 'external',
    apiKey: process.env.GMC_WORKER_API_KEY,
    cron: '0 * * * *',  // informational, your cron system uses this
  },
},
```

The `cron` value is informational. The plugin does not run a scheduler itself. Your external system is responsible for calling the endpoint on the desired schedule.

The plugin also exposes worker endpoints for more granular external job orchestration:

- `POST /api/gmc/worker/product/push` - Push single product
- `POST /api/gmc/worker/product/delete` - Delete single product
- `POST /api/gmc/worker/batch/push-dirty` - Push all dirty products
- `POST /api/gmc/worker/batch/initial-sync` - Run initial sync
- `POST /api/gmc/worker/batch/pull-all` - Pull all from MC

Worker endpoints authenticate via `Authorization: Bearer {apiKey}` or `x-gmc-api-key` header.

### Payload Jobs Strategy

Use when you want Payload to own job queueing:

```ts
sync: {
  mode: 'scheduled',
  schedule: {
    strategy: 'payload-jobs',
  },
},
```

This registers six task definitions on the `gmc-sync` queue:

| Task               | Description                                                |
| ------------------ | ---------------------------------------------------------- |
| `gmcPushProduct`   | Push a single product (used by onChange)                   |
| `gmcDeleteProduct` | Delete a single product from MC (used by afterDelete hook) |
| `gmcSyncDirty`     | Push all dirty products (used by scheduled sync)           |
| `gmcBatchPush`     | Push a batch of products by IDs or filter                  |
| `gmcInitialSync`   | Run initial sync across all products                       |
| `gmcPullAll`       | Pull all products from MC back into Payload                |

**You must run a Payload jobs worker** for the `gmc-sync` queue. The plugin does not process jobs inside the web process.

## API Endpoints

Default base path: `/api/gmc`

There are two auth boundaries:

- **User endpoints** (product actions, batch actions, mappings) require a Payload-authenticated user (`req.user`). Authenticate via session cookie, or [Payload API key](https://payloadcms.com/docs/authentication/api-keys) (`Authorization: {slug} API-Key {key}`). Access is controlled by the plugin `access` function.
- **Worker endpoints** (`/cron/*`, `/worker/*`) use the plugin's own API key (set via `sync.schedule.apiKey`). Pass it via `Authorization: Bearer {key}` or `x-gmc-api-key` header. Designed for server-to-server calls, scripts, and cron.

### Product Actions (user auth)

| Method | Path                 | Body                        | Description                                                                            |
| ------ | -------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `POST` | `/product/push`      | `{ productId }`             | Push product to MC                                                                     |
| `POST` | `/product/pull`      | `{ productId }`             | Pull product data from MC                                                              |
| `POST` | `/product/delete`    | `{ productId }`             | Delete product from MC                                                                 |
| `POST` | `/product/refresh`   | `{ productId }`             | Refresh snapshot from MC                                                               |
| `POST` | `/product/analytics` | `{ productId, rangeDays? }` | Get MC approval status and performance metrics (impressions, clicks, CTR, conversions) |

### Batch Actions (user auth)

| Method | Path                  | Body                                                    | Description               |
| ------ | --------------------- | ------------------------------------------------------- | ------------------------- |
| `POST` | `/batch/push`         | `{ productIds?, filter? }`                              | Push multiple products    |
| `POST` | `/batch/push-dirty`   | -                                                       | Push all dirty products   |
| `POST` | `/batch/initial-sync` | `{ dryRun?, batchSize?, limit?, onlyIfRemoteMissing? }` | Run initial sync          |
| `POST` | `/batch/pull-all`     | -                                                       | Pull all products from MC |

Batch operations return a `jobId` and run asynchronously. Progress is tracked in the `gmc-sync-log` collection and visible in the admin dashboard. The operation starts immediately and the endpoint returns `{ jobId, status: 'running' }`. Poll the sync log for progress.

### Health & Mappings

| Method | Path        | Description                                                                             |
| ------ | ----------- | --------------------------------------------------------------------------------------- |
| `GET`  | `/health`   | Basic health check (public; `?deep=true` requires user auth and tests API connectivity) |
| `GET`  | `/mappings` | List current field mappings (user auth)                                                 |
| `POST` | `/mappings` | Replace all runtime field mappings (user auth)                                          |

### Scheduling & Workers (API key auth)

| Method | Path                         | Body                                                    | Description                             |
| ------ | ---------------------------- | ------------------------------------------------------- | --------------------------------------- |
| `POST` | `/cron/sync`                 | -                                                       | Trigger scheduled sync (push all dirty) |
| `POST` | `/worker/product/push`       | `{ productId }`                                         | Push single product                     |
| `POST` | `/worker/product/delete`     | `{ productId, identity }`                               | Delete product from MC                  |
| `POST` | `/worker/batch/push-dirty`   | -                                                       | Push all dirty products                 |
| `POST` | `/worker/batch/initial-sync` | `{ dryRun?, batchSize?, limit?, onlyIfRemoteMissing? }` | Run initial sync                        |
| `POST` | `/worker/batch/pull-all`     | -                                                       | Pull all products from MC               |

## Batch Operation Architecture

All batch operations (push-dirty, initial-sync, pull-all, batch-push) follow the same pattern:

1. A sync log document is created in `gmc-sync-log` with `status: 'running'`.
2. The operation runs asynchronously. The endpoint returns `{ jobId, status: 'running' }` immediately.
3. Progress callbacks update the sync log document periodically (counters: `processed`, `succeeded`, `failed`, `total`).
4. When the operation completes, the sync log is updated with `status: 'completed'` (or `'failed'`) and `completedAt`.

Products within a batch are processed through the rate limiter (default: 4 concurrent, 200 queued). The rate limiter coordinates per-minute API budget and prevents exceeding Google's quota.

## Access Control

If you do not provide `access`, the plugin checks:

- `user.isAdmin === true`, or
- `user.roles` contains `'admin'`

For production apps with a different role model, provide `access` explicitly:

```ts
access: async ({ req }) => {
  return req.user?.role === 'admin' || req.user?.role === 'seo'
},
```

## Manual UI Placement

By default, the plugin auto-injects the Merchant Center tab into your products collection. To control placement manually:

1. Set `autoInjectTab: false`
2. Use the exported helpers:

```ts
import { getMerchantCenterTab, MerchantCenterUIPlaceholder } from 'payload-plugin-gmc-ecommerce'
```

- `getMerchantCenterTab(options)` returns a complete tab config to place in your collection's tabs
- `getMerchantCenterField(options)` returns the field group without the tab wrapper
- `MerchantCenterUIPlaceholder` is a placeholder field; if placed inside an existing tab, the plugin replaces it with the full Merchant Center tab during initialization

## Distributed Rate Limiting

For multi-instance deployments, provide a `rateLimit.store` to coordinate API budget across processes:

```ts
rateLimit: {
  maxRequestsPerMinute: 120,
  store: {
    async claimSlot({ key, limit, scope, windowMs }) {
      // Implement with Redis, DynamoDB, etc.
      return { allowed: true, count: 1, resetAt: Date.now() + windowMs }
    },
  },
},
```

The store coordinates per-minute budget windows. It does not replace a queue.

## Compatibility

### Payload Ecommerce Template

This plugin works with the [official Payload ecommerce template](https://github.com/payloadcms/payload/tree/main/templates/ecommerce). Set `identityField` to whatever field holds your product SKU or unique identifier. The plugin injects its own tab alongside existing ones.

### payload-ai Plugin

Compatible with [payload-ai](https://github.com/ashbuilds/payload-ai). The two plugins do not conflict. payload-ai adds AI content generation to your collection fields, while this plugin syncs product data to Merchant Center. The typical workflow: payload-ai generates or refines content in your product fields, then field mappings push that content to MC attributes.

## Exports

### Main Entry Point (`payload-plugin-gmc-ecommerce`)

```ts
// Plugin
export { payloadGmcEcommerce }

// Manual UI placement
export { getMerchantCenterField, getMerchantCenterTab, MerchantCenterUIPlaceholder }

// Service (for programmatic use outside endpoints)
export { createMerchantService }
export type { MerchantService }

// Utilities
export { applyFieldMappings, buildUpdateMask, deepMerge, fromMicros, resolveIdentity, toMicros }

// All types
export type {
  AccessFn,
  AdminMode,
  BatchSyncReport,
  BeforePushHook,
  BeforePushHookArgs,
  ConflictStrategy,
  CredentialResolution,
  FieldMapping,
  FieldSyncMode,
  GetCredentialsFn,
  GoogleServiceAccount,
  HealthResult,
  InitialSyncReport,
  MCAvailability,
  MCCondition,
  MCCustomAttribute,
  MCPerformanceRow,
  MCPrice,
  MCProductAnalytics,
  MCProductAttributes,
  MCProductIdentity,
  MCProductInput,
  MCProductState,
  MCSyncMeta,
  NormalizedPluginOptions,
  PayloadGMCEcommercePluginOptions,
  PullAllReport,
  PullResult,
  ResolvedMCIdentity,
  ScheduleConfig,
  SyncAction,
  SyncMode,
  SyncResult,
  SyncSource,
  SyncState,
  TransformPreset,
}
```

### Client Entry Point (`payload-plugin-gmc-ecommerce/client`)

```ts
export { MerchantCenterDashboardClient }
export { MerchantCenterNavLink }
export { MerchantCenterSyncControls }
```

### RSC Entry Point (`payload-plugin-gmc-ecommerce/rsc`)

```ts
export { MerchantCenterAdminView }
export { MerchantCenterDashboardWidget }
```

## Production Configuration Example

```ts
import { buildConfig } from 'payload'
import { payloadGmcEcommerce } from 'payload-plugin-gmc-ecommerce'

export default buildConfig({
  plugins: [
    payloadGmcEcommerce({
      merchantId: process.env.GMC_MERCHANT_ID!,
      dataSourceId: process.env.GMC_DATA_SOURCE_ID!,
      siteUrl: process.env.SITE_URL!,

      getCredentials: async () => ({
        type: 'keyFilename',
        path: process.env.GMC_SERVICE_ACCOUNT_PATH!,
      }),

      access: async ({ req }) => {
        return req.user?.role === 'admin' || req.user?.role === 'seo'
      },

      admin: {
        mode: 'both',
      },

      collections: {
        products: {
          slug: 'products',
          identityField: 'sku',
          fieldMappings: [
            { source: 'title', target: 'productAttributes.title', syncMode: 'permanent' },
            {
              source: 'description',
              target: 'productAttributes.description',
              syncMode: 'permanent',
            },
            {
              source: 'price',
              target: 'productAttributes.price.amountMicros',
              syncMode: 'permanent',
              transformPreset: 'toMicrosString',
            },
            {
              source: 'featuredImage',
              target: 'productAttributes.imageLink',
              syncMode: 'permanent',
              transformPreset: 'extractAbsoluteUrl',
            },
          ],
        },
        categories: {
          slug: 'categories',
          nameField: 'title',
          googleCategoryIdField: 'googleCategoryId',
          parentField: 'parent',
          productCategoryField: 'category',
          productTypeField: 'breadcrumbLabel',
        },
      },

      defaults: {
        contentLanguage: 'en',
        feedLabel: 'PRODUCTS',
        currency: 'USD',
      },

      beforePush: async ({ doc, productInput }) => {
        const slug = (doc as any).slug
        if (slug) {
          productInput.productAttributes ??= {}
          productInput.productAttributes.link = `${process.env.SITE_URL}/products/${slug}`
        }
        return productInput
      },

      sync: {
        mode: 'onChange',
        permanentSync: true,
        // conflictStrategy defaults to 'newest-wins'
        schedule: {
          strategy: 'external',
          apiKey: process.env.GMC_WORKER_API_KEY!,
          cron: '0 4 * * *', // daily 4am push-dirty as safety net
        },
      },

      rateLimit: {
        maxConcurrency: 4,
        maxRequestsPerMinute: 120,
      },
    }),
  ],
})
```

## Documentation

- [Setup Guide](./docs/setup-guide.md) - Step-by-step integration walkthrough for new and existing Merchant Center setups

## License

MIT
