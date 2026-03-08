# Setup Guide

This guide walks through integrating `payload-plugin-gmc-ecommerce` into a Payload CMS project. It covers both first-time Merchant Center setups and connecting to an existing live catalog.

## Before You Start

Gather the following:

| What | Where to Find It |
|---|---|
| **Merchant Center account ID** | [Merchant Center](https://merchants.google.com/) > Settings > Account Information |
| **Data source ID** | Merchant Center > Products > Feeds > click into your feed/data source |
| **Service account JSON** | [Google Cloud Console](https://console.cloud.google.com/) > IAM & Admin > Service Accounts |
| **Your existing feed label** (if migrating) | Merchant Center > Products > look at any product's identity |
| **Your existing content language** (if migrating) | Same as above |

### Service Account Setup

1. Go to Google Cloud Console > IAM & Admin > Service Accounts.
2. Create a service account (or use an existing one).
3. Enable the **Merchant API** (Content API for Shopping) on your Google Cloud project.
4. Create a JSON key and download it.
5. In **Merchant Center**, go to Settings > Account Access and add the service account email with **Admin** permissions. This is the step that actually grants API access — the Google Cloud project role alone does not determine Merchant API access.

You need `client_email` and `private_key` from the JSON key file.

## Step 1: Install

```bash
pnpm add payload-plugin-gmc-ecommerce
```

## Step 2: Add the Plugin

```ts
// payload.config.ts
import { buildConfig } from 'payload'
import { payloadGmcEcommerce } from 'payload-plugin-gmc-ecommerce'

export default buildConfig({
  // ...your existing config
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
          slug: 'products',      // your products collection slug
          identityField: 'sku',  // field used for MC offerId
        },
      },
    }),
  ],
})
```

Add the environment variables to your `.env`:

```env
GMC_MERCHANT_ID=your-merchant-id
GMC_DATA_SOURCE_ID=your-data-source-id
GMC_CLIENT_EMAIL=service-account@project.iam.gserviceaccount.com
GMC_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Start your dev server and verify:
- The products collection now has a **Merchant Center** tab.
- The admin sidebar has a **Merchant Center** nav link.
- `GET /api/gmc/health` returns `{ status: 'ok' }`.

## Step 3: Understand Identity

Every product in Merchant Center has an identity composed of three parts:

```
contentLanguage~feedLabel~offerId
```

The plugin constructs this from:
1. `defaults.contentLanguage` (default: `en`)
2. `defaults.feedLabel` (default: `PRODUCTS`)
3. The value of your `identityField` on each product (e.g., `sku`)

**If you are connecting to an existing live catalog**, your `contentLanguage` and `feedLabel` must match what is already in Merchant Center. Check any existing product in your Merchant Center account to see the current identity format. If they don't match, the plugin will create new products instead of updating existing ones.

Per-product overrides are available in the Merchant Center tab on each product if specific products need different values.

## Step 4: Configure Field Mappings

Field mappings tell the plugin how to populate Merchant Center attributes from your Payload document fields.

```ts
collections: {
  products: {
    slug: 'products',
    identityField: 'sku',
    fieldMappings: [
      {
        source: 'title',
        target: 'productAttributes.title',
        syncMode: 'permanent',
      },
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
},
```

> **Product link URL**: The `link` attribute requires a full URL (e.g., `https://example.com/products/chair-1`). Since slugs are bare strings (not paths starting with `/`), `extractAbsoluteUrl` won't prepend `siteUrl`. Use `beforePush` to construct the URL:
>
> ```ts
> beforePush: async ({ doc, productInput }) => {
>   const slug = (doc as any).slug
>   if (slug) {
>     productInput.productAttributes ??= {}
>     productInput.productAttributes.link = `${process.env.SITE_URL}/products/${slug}`
>   }
>   return productInput
> },
> ```

### Source and Target Paths

- **source**: Dot-notation path in your Payload document. For example, `title`, `pricing.amount`, `mainImage`. Array indexing is supported: `adImages[0]`, `adImages.0`.
- **target**: Dot-notation path in the MC product. Almost always starts with `productAttributes.`. For example, `productAttributes.title`, `productAttributes.price.amountMicros`.

### Relationship and Upload Fields

The plugin fetches product documents at **depth 1** by default, which means one level of relationships is hydrated. An upload field like `featuredImage` becomes `{ url: '/media/image.jpg', filename: '...', ... }` instead of just an ID string.

This means `extractUrl` and `extractAbsoluteUrl` transforms work on upload fields out of the box — they extract `.url` from the hydrated media object.

For deeper nesting (e.g., a brand relationship with its own logo upload), use `beforePush` with `payload.findByID()` to fetch the data you need. You can also set `collections.products.fetchDepth` to a higher value, but this increases query cost for every push.

```ts
collections: {
  products: {
    slug: 'products',
    identityField: 'sku',
    fetchDepth: 2,  // default: 1 — increase if mappings need deeper relations
  },
},
```

### Sync Modes

- **`permanent`**: Applied every time a product is pushed. If `sync.permanentSync` is `true`, also applied in the `beforeChange` hook on every document save.
- **`initialOnly`**: Applied only when a product has no existing snapshot (its first sync).

### Transform Presets

| Preset | Input | Output | Notes |
|---|---|---|---|
| `none` | any | Unchanged | |
| `toMicrosString` | `15.99` (number or string) | `"15990000"` | Accepts `"15.99"` string input too |
| `toMicros` | `15.99` (number only) | `"15990000"` | Non-numbers pass through unchanged |
| `extractUrl` | `{ url: '/image.jpg' }` | `"/image.jpg"` | Checks `.url`, `.src`, `.href` in that order |
| `extractAbsoluteUrl` | `{ url: '/image.jpg' }` | `"https://example.com/image.jpg"` | Same as `extractUrl` but prepends `siteUrl` for relative paths |
| `toArray` | `"value"` | `["value"]` | Arrays pass through unchanged |
| `toString` | `42` | `"42"` | Objects become JSON strings |
| `toBoolean` | any | `true` or `false` | Uses JS truthiness — `"false"` becomes `true` |

If you use `extractAbsoluteUrl`, set `siteUrl` in your plugin config:

```ts
siteUrl: process.env.SITE_URL,  // e.g., 'https://example.com'
```

### Runtime Mappings

Additional field mappings can be created in the Merchant Center admin dashboard without code changes. These are stored in the `gmc-field-mappings` collection and merged with your config-time mappings at push time.

## Step 5: Required Merchant Center Fields

Every product pushed to Merchant Center must have these attributes populated (by field mappings, manual entry, or `beforePush`):

| Field | Attribute Path |
|---|---|
| Title | `productAttributes.title` |
| Link | `productAttributes.link` |
| Image Link | `productAttributes.imageLink` |
| Availability | `productAttributes.availability` |

The plugin validates these before sending to the API and will return an error listing any missing required fields.

Additional fields like `price`, `condition`, `brand`, and `description` are strongly recommended for product approval. See [Google's product data specification](https://support.google.com/merchants/answer/7052112) for the full list.

The plugin auto-applies `defaults.condition` (default: `NEW`) if no condition is set on the product.

## Step 6: Verify with a Manual Push

With sync mode set to `manual` (the default):

1. Open a product in the admin panel.
2. Go to the **Merchant Center** tab.
3. Enable the **Enable Merchant Center sync** checkbox.
4. Verify the offerId, content language, and feed label look correct.
5. Save the product.
6. Click **Push to Merchant Center**.

Check the result:
- The sync status should show **Success**.
- The snapshot section should populate with the processed product data from MC.
- In Merchant Center, the product should appear under Products.

If push fails, the error message will indicate what went wrong. Common issues:

| Error | Cause | Fix |
|---|---|---|
| Missing required fields | title, link, imageLink, or availability not populated | Add field mappings or set values in the MC tab |
| 401/403 | Service account doesn't have access | Check service account permissions in MC |
| Identity mismatch (duplicate products) | feedLabel or contentLanguage doesn't match existing catalog | Set `defaults.feedLabel` and `defaults.contentLanguage` to match |

> **Note:** A successful push means the data was accepted by the Merchant Center API. Product processing and approval may take additional time (minutes to hours). The snapshot may not reflect the final processed state immediately — use **Refresh Snapshot** to re-fetch it later.

## Step 7: Configure Access Control

The default access check allows any user with `isAdmin === true` or `roles` containing `'admin'`. For production, provide your own:

```ts
access: async ({ req }) => {
  return req.user?.role === 'admin' || req.user?.role === 'seo'
},
```

This controls access to all plugin endpoints and the admin UI sections.

## Step 8: Set Up Categories (Optional)

If your products have categories and you want them reflected in Merchant Center:

```ts
collections: {
  categories: {
    slug: 'categories',
    nameField: 'title',                  // field with category name
    googleCategoryIdField: 'googleCategoryId',  // Google taxonomy ID
    parentField: 'parent',              // self-referencing relationship for hierarchy
    productCategoryField: 'category',   // relationship field on products pointing to categories
    productTypeField: 'fullTitle',      // field for MC productTypes breadcrumb
  },
},
```

During push, the plugin:
1. Follows the product's category relationships.
2. Walks up the parent chain to build `productTypes` (breadcrumb array).
3. Takes the `googleCategoryIdField` value from the most specific category that has one.
4. Only sets these if they aren't already manually populated on the product.

## Step 9: Choose a Sync Mode

### Manual (default)

No automatic syncing. You push products through the admin UI or API.

### onChange

Products auto-push after every successful save:

```ts
sync: {
  mode: 'onChange',
},
```

The push happens asynchronously after the response is sent to the user. Failures are logged to the sync log collection and visible in the admin dashboard.

If using `payload-jobs` strategy, the push is queued as a job instead of running inline.

### Scheduled

Products are marked dirty on save. A scheduled job pushes all dirty products:

```ts
sync: {
  mode: 'scheduled',
  schedule: {
    strategy: 'external',
    apiKey: process.env.GMC_WORKER_API_KEY!,
    cron: '0 * * * *',
  },
},
```

See the [Scheduling](#step-10-set-up-scheduling-if-not-manual) section below.

## Step 10: Set Up Scheduling (if not Manual)

### External Strategy

Your external system (cron, CI/CD, Cloud Tasks, etc.) calls the sync endpoint on a schedule:

```bash
# Run every hour via cron
0 * * * * curl -s -X POST https://your-site.com/api/gmc/cron/sync -H "Authorization: Bearer $GMC_WORKER_API_KEY"
```

The `cron` config value is informational — the plugin does not run a scheduler itself. Your external system is responsible for calling the endpoint.

Worker endpoints are also available for granular orchestration:

```bash
# Push a specific product
curl -X POST https://your-site.com/api/gmc/worker/product/push \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"productId": "abc123"}'

# Push all dirty products
curl -X POST https://your-site.com/api/gmc/worker/batch/push-dirty \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY"

# Delete a product from MC (requires identity — the local doc may already be gone)
curl -X POST https://your-site.com/api/gmc/worker/product/delete \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "abc123",
    "identity": {
      "offerId": "SKU-123",
      "contentLanguage": "en",
      "feedLabel": "PRODUCTS"
    }
  }'
```

> **Delete orchestration**: When deleting products from Merchant Center via the worker endpoint, you must provide the product's MC identity (`offerId`, `contentLanguage`, `feedLabel`) in the request body. This is because the Payload document may already be deleted — the plugin cannot look it up to resolve identity. The `afterDelete` hook handles this automatically for local deletes, but if you're orchestrating deletes externally (e.g., from a queue or cleanup script), you need to supply the identity yourself.

### Payload Jobs Strategy

The plugin registers task definitions with Payload's job system:

```ts
sync: {
  mode: 'scheduled',
  schedule: {
    strategy: 'payload-jobs',
  },
},
```

**You must run a Payload jobs worker** for the `gmc-sync` queue. The web process does not process jobs on its own. Refer to the [Payload Jobs documentation](https://payloadcms.com/docs/jobs-queue/overview) for worker setup.

Six tasks are registered on the `gmc-sync` queue:

| Task Slug | Purpose |
|---|---|
| `gmcPushProduct` | Push a single product (used by onChange) |
| `gmcDeleteProduct` | Delete a product from MC (used by afterDelete hook) |
| `gmcSyncDirty` | Push all dirty products (used by scheduled sync) |
| `gmcBatchPush` | Push a batch of products by IDs or filter |
| `gmcInitialSync` | Run initial sync across all products |
| `gmcPullAll` | Pull all products from MC back into Payload |

## Step 11: Use `beforePush` for Custom Logic

For transformations that field mappings cannot express:

```ts
beforePush: async ({ doc, operation, payload, productInput }) => {
  const attrs = productInput.productAttributes ?? {}

  // Dynamic availability from inventory
  const inventory = (doc as any).inventory ?? 0
  attrs.availability = inventory > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK'

  // Set brand from a relationship
  if (doc.brand && typeof doc.brand === 'object') {
    attrs.brand = (doc.brand as any).name
  }

  productInput.productAttributes = attrs
  return productInput
},
```

`beforePush` runs after field mappings and category resolution, right before the API call. It receives:

| Argument | Description |
|---|---|
| `doc` | The Payload document (with merged field mapping values) |
| `operation` | `'insert'` or `'update'` |
| `payload` | Payload instance (for querying other collections) |
| `productInput` | The prepared MC product input to modify |

## Step 12: Run Initial Sync

If you have existing products that need to be pushed to Merchant Center for the first time:

1. Go to the Merchant Center admin dashboard.
2. Click **Initial Sync**.

Or via API. Batch endpoints under `/api/gmc/batch/*` require a Payload-authenticated user. Worker equivalents use the plugin's own API key (`sync.schedule.apiKey`):

```bash
# Via worker endpoint (plugin API key — use this for scripts/cron)
curl -X POST https://your-site.com/api/gmc/worker/batch/initial-sync \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'

# Or via user endpoint (Payload API key — requires useAPIKey on your auth collection)
curl -X POST https://your-site.com/api/gmc/batch/initial-sync \
  -H "Authorization: users API-Key $PAYLOAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false}'
```

> Payload supports [API keys](https://payloadcms.com/docs/authentication/api-keys) as an auth strategy. Enable `useAPIKey: true` on your users collection, then generate a key for the user. The header format is `Authorization: {collection-slug} API-Key {key}`.

Additional fields supported by the initial-sync endpoint: `limit` (max products to process), `batchSize`, `onlyIfRemoteMissing`.

Initial sync defaults:
- `dryRun: true` — validates products without pushing. Run this first.
- `onlyIfRemoteMissing: true` — skips products that already exist in MC.
- `batchSize: 100` — products processed per chunk.

The operation is tracked in the sync log with a `jobId` for progress monitoring.

## Connecting to an Existing Live Catalog

If your Merchant Center account already has products from another system (a feed file, Shopify, manual uploads, etc.), follow this additional guidance:

### 1. Match Your Identity

Check any existing product in Merchant Center to find its identity format. For example:

```
en~PRODUCTS~SKU-123
```

Configure the plugin to match:

```ts
defaults: {
  contentLanguage: 'en',   // must match
  feedLabel: 'PRODUCTS',    // must match
},
```

The `identityField` on your products must produce the same offerId values as your existing catalog. If your existing products use SKU `ABC-001`, your Payload product with that SKU must have `ABC-001` as the value in the field you configure as `identityField`.

### 2. Verify with One Product

Before running any bulk operation:

1. Pick one product you know exists in MC.
2. Enable MC sync for it in the admin panel.
3. Verify the identity (offerId, feedLabel, contentLanguage) matches exactly.
4. Push it.
5. Confirm in Merchant Center that the existing product was **updated** (not duplicated).

### 3. Run a Pull Before Pushing

If Merchant Center has data you want to preserve (manually entered attributes, approval status), pull before pushing:

```bash
# Pull all products from MC into Payload (worker endpoint — API key auth)
curl -X POST https://your-site.com/api/gmc/worker/batch/pull-all \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY"
```

This populates snapshot data and MC attributes on your Payload documents based on the `conflictStrategy`:

| Strategy | Behavior |
|---|---|
| `mc-wins` | MC values overwrite Payload values for conflicting fields |
| `payload-wins` | Payload values are preserved; only empty fields are populated from MC |
| `newest-wins` | The most recently updated value wins |

### 4. Disable Your Old Sync System

Do not run two sync systems simultaneously. Disable your existing feed, Shopify connector, or other integration before enabling automated sync from this plugin.

### 5. Initial Sync for Existing Catalogs

Run initial sync with `onlyIfRemoteMissing: true` (the default) — this only pushes products that don't already exist in MC:

```bash
curl -X POST https://your-site.com/api/gmc/worker/batch/initial-sync \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false, "onlyIfRemoteMissing": true}'
```

## Monitoring and Debugging

### Health Endpoint

```bash
# Basic check (public — returns status without merchant details)
curl https://your-site.com/api/gmc/health

# Deep check (requires Payload user auth — tests API connectivity)
curl https://your-site.com/api/gmc/health?deep=true \
  -H "Authorization: users API-Key $PAYLOAD_API_KEY"
```

### Sync Logs

All batch operations create entries in the `gmc-sync-log` collection. View them in the admin dashboard under **Sync History**, or query directly (requires Payload user auth):

```bash
curl https://your-site.com/api/gmc-sync-log?limit=10&sort=-createdAt \
  -H "Authorization: users API-Key $PAYLOAD_API_KEY"
```

Each log entry contains:
- `jobId` — Unique operation identifier
- `type` — Operation type (push, pull, initialSync, pullAll, batch)
- `status` — running, completed, failed, cancelled
- `total`, `processed`, `succeeded`, `failed` — Progress counters
- `errors` — Array of `{ productId, message }` for failed products

### Per-Product Sync State

Each product's Merchant Center tab shows:
- Current sync state (idle, syncing, success, error)
- Last sync timestamp
- Last error message
- The dirty flag (whether the product needs syncing)
- The snapshot (last known processed state from MC)

### Product Analytics

The per-product sync controls include a performance analytics section showing impressions, clicks, click-through rate, and conversions from the Merchant Center Reports API.

## Rate Limiting

The plugin rate-limits both inbound requests to plugin endpoints and outbound requests to the Google Merchant API.

Default settings handle most single-instance deployments:

| Setting | Default | Description |
|---|---|---|
| `maxConcurrency` | 4 | Concurrent outbound API requests |
| `maxQueueSize` | 200 | Maximum queued outbound requests |
| `maxRequestsPerMinute` | 120 | Per-minute API budget |
| `maxRetries` | 4 | Retry count for failed API requests |
| `baseRetryDelayMs` | 300 | Base delay for exponential backoff |
| `requestTimeoutMs` | 15000 | Per-request timeout |

For multi-instance deployments, provide a `rateLimit.store` to coordinate API budget across processes. See the [README](../README.md#distributed-rate-limiting) for the store interface.

## Production Checklist

Before going live:

- [ ] `feedLabel` and `contentLanguage` match your existing MC identity (or are intentionally new)
- [ ] At least one product pushed successfully with correct identity (no duplicates)
- [ ] Field mappings produce correct values for title, link, imageLink, availability
- [ ] `siteUrl` is set if using `extractAbsoluteUrl` transform
- [ ] `access` function is configured for your role model
- [ ] Old sync systems are disabled (if migrating)
- [ ] Deep health check passes (`/api/gmc/health?deep=true`)
- [ ] Sync mode is appropriate for your workflow
- [ ] If using `scheduled` mode, scheduling is configured and tested
- [ ] If using `payload-jobs`, a worker is running for the `gmc-sync` queue
- [ ] If using `external` strategy, `apiKey` is set and cron is configured
- [ ] Rate limit settings are appropriate for your catalog size
- [ ] Sync logs are reviewed for any errors after initial sync
