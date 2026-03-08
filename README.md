# payload-plugin-gmc-ecommerce

Google Merchant Center sync for [Payload CMS](https://payloadcms.com) v3.

Push products to Google Merchant Center, pull processed data back, manage field mappings, run batch operations, and monitor sync state — all from inside Payload's admin panel.

## Requirements

- Payload CMS `^3.37.0`
- Node.js `^18.20.2 || >=20.9.0`

```bash
pnpm add payload-plugin-gmc-ecommerce
```

## Minimal Setup

```ts
import { buildConfig } from 'payload'
import { payloadGmcEcommerce } from 'payload-plugin-gmc-ecommerce'

export default buildConfig({
  plugins: [
    payloadGmcEcommerce({
      merchantId: process.env.GMC_MERCHANT_ID!,
      dataSourceId: process.env.GMC_DATA_SOURCE_ID!,
      getCredentials: async () => ({
        type: 'json',
        credentials: {
          client_email: process.env.GMC_CLIENT_EMAIL!,
          private_key: process.env.GMC_PRIVATE_KEY!.replace(/\\n/g, '\n'),
        },
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

Sync mode defaults to `manual` — nothing syncs until you trigger it.

For the complete integration walkthrough, see [docs/setup-guide.md](./docs/setup-guide.md).

## What the Plugin Does

When enabled, the plugin:

1. Injects a `merchantCenter` field group into your products collection with identity fields, all Merchant Center product attributes, a read-only API snapshot, and sync metadata.
2. Adds a **Merchant Center** tab to each product's edit view with push/pull/delete/refresh controls and analytics.
3. Mounts REST endpoints for single-product and batch operations, health checks, field mapping management, and worker/cron scheduling.
4. Creates two hidden collections: `gmc-field-mappings` (runtime field mapping rules) and `gmc-sync-log` (operation history).
5. Adds an admin dashboard (or dashboard widget, or both) showing connection health, bulk operations, field mappings, and sync history.
6. Optionally registers Payload job task definitions when using the `payload-jobs` scheduling strategy.

## Configuration Reference

### Required Options

| Option | Type | Description |
|---|---|---|
| `merchantId` | `string` | Your Google Merchant Center account ID |
| `dataSourceId` | `string` | The data source ID products will sync through |
| `getCredentials` | `function` | Returns Google service account credentials |
| `collections.products.slug` | `CollectionSlug` | Your products collection slug |
| `collections.products.identityField` | `string` | Field used to derive `offerId` (e.g., `'sku'`) |

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
      fetchDepth?: number,             // default: 1 — depth for fetching product docs during push
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
    conflictStrategy?: 'mc-wins' | 'payload-wins' | 'newest-wins',  // default: 'mc-wins'
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
    // Called before each product is sent to the MC API.
    // Return the modified productInput.

  // --- Disable ---
  disabled?: boolean,  // default: false
})
```

## Merchant Center Product Identity

Product identity in Google Merchant Center is derived from three values:

```
contentLanguage~feedLabel~offerId
```

For example: `en~PRODUCTS~SKU-123`

These three values together form a unique product in Merchant Center. Changing any of them creates a **new** Merchant Center product rather than updating the existing one.

If you are connecting to an existing live Merchant Center data source, your `defaults.contentLanguage`, `defaults.feedLabel`, and identity field values **must match your current production identity exactly**. If your live catalog uses `PRODUCTS` as the feed label and you configure the plugin with `US`, you will create duplicate products.

Per-product identity overrides are available in the Merchant Center tab if specific products need different values.

## Sync Modes

| Mode | Behavior |
|---|---|
| `manual` | Nothing syncs automatically. Use the admin UI or API endpoints to trigger operations. |
| `onChange` | Products auto-sync to Merchant Center on every successful save (create or update). |
| `scheduled` | Products are marked dirty on save. A scheduled job pushes all dirty products in batch. |

Start with `manual`. Move to `onChange` or `scheduled` only after you have verified identity alignment and pushed a few products successfully.

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

// Use beforePush to build product URLs from slugs:
beforePush: async ({ doc, productInput }) => {
  const slug = (doc as any).slug
  if (slug) {
    productInput.productAttributes ??= {}
    productInput.productAttributes.link = `${process.env.SITE_URL}/products/${slug}`
  }
  return productInput
},
```

### Runtime Mappings (Admin UI)

Defined in the Merchant Center admin dashboard. These are stored in the `gmc-field-mappings` collection. Useful for non-developer users who need to adjust mappings without code changes.

Runtime mappings are additive — they are appended to config-time mappings, not replacing them.

### Sync Modes for Mappings

| Mode | Behavior |
|---|---|
| `permanent` | Applied on every push. If `sync.permanentSync` is `true`, also applied in the `beforeChange` hook on every document save. |
| `initialOnly` | Applied only when a product has no existing snapshot (first sync). |

### Transform Presets

| Preset | What It Does |
|---|---|
| `none` | Pass value through unchanged |
| `toMicros` | Convert a number to micros string (15.99 becomes `"15990000"`) |
| `toMicrosString` | Same as `toMicros` (accepts both number and numeric string input) |
| `extractUrl` | Extract `.url`, `.src`, or `.href` from an object (e.g., Payload media field) |
| `extractAbsoluteUrl` | Same as `extractUrl`, but prepends `siteUrl` for paths starting with `/`. Bare strings (e.g., slugs) pass through unchanged. |
| `toArray` | Wrap a scalar value in an array |
| `toString` | Convert value to string |
| `toBoolean` | Convert value to boolean |

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
    productTypeField: 'fullTitle',               // field used for MC productTypes breadcrumb
  },
},
```

- `googleProductCategory`: Set to the Google taxonomy ID from the most specific category that has one.
- `productTypes`: Built from the category chain using `productTypeField` (falls back to `nameField`).
- Both are only set if not already manually populated on the product.

## The `beforePush` Hook

For custom logic that field mappings cannot handle, use `beforePush`. It receives the prepared `MCProductInput` and the source document, and must return the (potentially modified) input:

```ts
payloadGmcEcommerce({
  // ...
  beforePush: async ({ doc, operation, payload, productInput }) => {
    // Example: set availability based on inventory count
    const inventory = doc.inventory as number
    productInput.productAttributes ??= {}
    productInput.productAttributes.availability =
      inventory > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK'
    return productInput
  },
})
```

## Admin UI Modes

| Mode | What You Get |
|---|---|
| `route` | Dedicated admin page at `/admin/merchant-center` with nav link |
| `dashboard` | Widget on the Payload dashboard linking to a full-page view |
| `both` | Both the dedicated route and the dashboard widget |
| `headless` | No admin UI. Endpoints and sync logic only. |

All modes include the per-product Merchant Center tab with sync controls (unless `autoInjectTab` is `false`).

## Scheduling Strategies

### External Strategy (default)

Use when you already have cron, queues, or a CI/CD system. Set up your external system to POST to the cron endpoint:

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
    cron: '0 * * * *',  // informational — your cron system uses this
  },
},
```

The plugin also exposes worker endpoints for more granular external job orchestration:

- `POST /api/gmc/worker/product/push` — Push single product
- `POST /api/gmc/worker/product/delete` — Delete single product
- `POST /api/gmc/worker/batch/push-dirty` — Push all dirty products
- `POST /api/gmc/worker/batch/initial-sync` — Run initial sync
- `POST /api/gmc/worker/batch/pull-all` — Pull all from MC

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

| Task | Description |
|---|---|
| `gmcPushProduct` | Push a single product (used by onChange) |
| `gmcDeleteProduct` | Delete a single product from MC (used by afterDelete hook) |
| `gmcSyncDirty` | Push all dirty products (used by scheduled sync) |
| `gmcBatchPush` | Push a batch of products by IDs or filter |
| `gmcInitialSync` | Run initial sync across all products |
| `gmcPullAll` | Pull all products from MC back into Payload |

**You must run a Payload jobs worker** for the `gmc-sync` queue. The plugin does not process jobs inside the web process.

## API Endpoints

Default base path: `/api/gmc`

There are two auth boundaries:

- **User endpoints** (product actions, batch actions, mappings) — require a Payload-authenticated user (`req.user`). Authenticate via session cookie, or [Payload API key](https://payloadcms.com/docs/authentication/api-keys) (`Authorization: {slug} API-Key {key}`). Access is controlled by the plugin `access` function.
- **Worker endpoints** (`/cron/*`, `/worker/*`) — use the plugin's own API key (set via `sync.schedule.apiKey`). Pass it via `Authorization: Bearer {key}` or `x-gmc-api-key` header. Designed for server-to-server calls, scripts, and cron.

### Product Actions (user auth)

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/product/push` | `{ productId }` | Push product to MC |
| `POST` | `/product/pull` | `{ productId }` | Pull product data from MC |
| `POST` | `/product/delete` | `{ productId }` | Delete product from MC |
| `POST` | `/product/refresh` | `{ productId }` | Refresh snapshot from MC |
| `POST` | `/product/analytics` | `{ productId, rangeDays? }` | Get performance analytics |

### Batch Actions (user auth)

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/batch/push` | `{ productIds?, filter? }` | Push multiple products |
| `POST` | `/batch/push-dirty` | — | Push all dirty products |
| `POST` | `/batch/initial-sync` | `{ dryRun?, batchSize?, limit?, onlyIfRemoteMissing? }` | Run initial sync |
| `POST` | `/batch/pull-all` | — | Pull all products from MC |

Batch operations return a `jobId` and run asynchronously. Progress is tracked in the sync log.

### Health & Mappings

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Basic health check (public; `?deep=true` requires user auth) |
| `GET` | `/mappings` | List current field mappings (user auth) |
| `POST` | `/mappings` | Replace all field mappings (user auth) |

### Scheduling & Workers (API key auth)

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/cron/sync` | — | Trigger scheduled sync |
| `POST` | `/worker/product/push` | `{ productId }` | Push single product |
| `POST` | `/worker/product/delete` | `{ productId, identity }` | Delete product from MC (identity: `{ offerId, contentLanguage, feedLabel, ... }`) |
| `POST` | `/worker/batch/push-dirty` | — | Push all dirty products |
| `POST` | `/worker/batch/initial-sync` | `{ dryRun?, batchSize?, limit?, onlyIfRemoteMissing? }` | Run initial sync |
| `POST` | `/worker/batch/pull-all` | — | Pull all products from MC |

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

- `getMerchantCenterTab(options)` — Returns a complete tab config to place in your collection's tabs
- `getMerchantCenterField(options)` — Returns the field group without the tab wrapper
- `MerchantCenterUIPlaceholder` — A placeholder field; if placed inside an existing tab, the plugin replaces it with the full Merchant Center tab during initialization

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

Compatible with [payload-ai](https://github.com/ashbuilds/payload-ai). The two plugins do not conflict — they operate on different concerns. payload-ai adds AI content generation to your collection fields (titles, descriptions, rich text), while this plugin syncs product data to Merchant Center. The typical workflow: payload-ai generates or refines content in your product fields, then field mappings push that content to Merchant Center attributes. No special configuration is needed to make them work together — just enable both plugins on your products collection.

## Exports

### Main Entry Point (`payload-plugin-gmc-ecommerce`)

```ts
// Plugin
export { payloadGmcEcommerce }

// Manual UI placement
export { getMerchantCenterField, getMerchantCenterTab, MerchantCenterUIPlaceholder }

// Service (for programmatic use outside endpoints)
export { createMerchantService }

// Utilities
export { applyFieldMappings, buildUpdateMask, deepMerge, fromMicros, resolveIdentity, toMicros }

// All types
export type { ... }
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
        type: 'json',
        credentials: {
          client_email: process.env.GMC_CLIENT_EMAIL!,
          private_key: process.env.GMC_PRIVATE_KEY!.replace(/\\n/g, '\n'),
        },
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
            { source: 'description', target: 'productAttributes.description', syncMode: 'permanent' },
            { source: 'price', target: 'productAttributes.price.amountMicros', syncMode: 'permanent', transformPreset: 'toMicrosString' },
            { source: 'featuredImage', target: 'productAttributes.imageLink', syncMode: 'permanent', transformPreset: 'extractAbsoluteUrl' },
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

      // Build product link from slug (extractAbsoluteUrl only works on paths starting with /)
      beforePush: async ({ doc, productInput }) => {
        const slug = (doc as any).slug
        if (slug) {
          productInput.productAttributes ??= {}
          productInput.productAttributes.link = `${process.env.SITE_URL}/products/${slug}`
        }
        return productInput
      },

      sync: {
        mode: 'scheduled',
        permanentSync: true,
        conflictStrategy: 'mc-wins',
        schedule: {
          strategy: 'external',
          apiKey: process.env.GMC_WORKER_API_KEY!,
          cron: '0 * * * *',
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

- [Setup Guide](./docs/setup-guide.md) — Step-by-step integration walkthrough for new and existing Merchant Center setups

## License

MIT
