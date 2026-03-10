# Setup Guide

This guide walks through integrating `payload-plugin-gmc-ecommerce` into a Payload CMS project.

**Choose your path:**

- [Path A: New Application](#path-a-new-application) — No existing Merchant Center products. You're starting fresh.
- [Path B: Existing Application](#path-b-existing-application) — You already have products in Merchant Center from another system (custom hooks, feed files, Shopify, manual uploads, etc.) and need to migrate to this plugin without disrupting your live catalog.

Both paths share the same prerequisites and core configuration.

---

## Prerequisites

### 1. Gather Your Credentials

| What | Where to Find It |
|---|---|
| **Merchant Center account ID** | [Merchant Center](https://merchants.google.com/) > Settings > Account Information |
| **Data source ID** | Merchant Center > Products > Feeds > click into your feed/data source |
| **Service account JSON** | [Google Cloud Console](https://console.cloud.google.com/) > IAM & Admin > Service Accounts |

If migrating from an existing setup, also note:
| What | Where to Find It |
|---|---|
| **Your existing feed label** | Merchant Center > Products > click any product > look at the identity |
| **Your existing content language** | Same as above |
| **Your existing offerId format** | Same — is it uppercase? lowercase? a SKU? a model ID? |

### 2. Service Account Setup

1. Go to Google Cloud Console > IAM & Admin > Service Accounts.
2. Create a service account (or use an existing one).
3. Enable the **Merchant API** on your Google Cloud project.
4. Create a JSON key and download it.
5. In **Merchant Center**, go to Settings > Account Access and add the service account email with **Admin** permissions.

> Step 5 is the step that actually grants API access — the Google Cloud project role alone does not determine Merchant API permissions.

You need `client_email` and `private_key` from the JSON key file.

---

## Path A: New Application

No existing Merchant Center products. You're setting up sync for the first time.

### A1. Install

```bash
pnpm add payload-plugin-gmc-ecommerce
```

### A2. Add the Plugin

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
          slug: 'products',
          identityField: 'sku',  // field used as MC offerId
        },
      },
    }),
  ],
})
```

Add environment variables to your `.env`:

```env
GMC_MERCHANT_ID=your-merchant-id
GMC_DATA_SOURCE_ID=your-data-source-id
GMC_CLIENT_EMAIL=service-account@project.iam.gserviceaccount.com
GMC_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

### A3. Start Dev Server and Verify

Start your dev server. Verify:
- The products collection has a **Merchant Center** tab.
- The admin sidebar has a **Merchant Center** nav link.
- `GET /api/gmc/health` returns `{ status: 'ok' }`.
- `GET /api/gmc/health?deep=true` (with auth) returns `{ apiConnection: 'ok' }`.

If the deep health check fails, your service account credentials or permissions are wrong. Fix that before continuing.

### A4. Configure Field Mappings

Field mappings tell the plugin how to populate MC attributes from your Payload fields:

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

For the product `link` (full URL), use `beforePush`:

```ts
siteUrl: process.env.SITE_URL,  // required for extractAbsoluteUrl

beforePush: async ({ doc, productInput }) => {
  const slug = (doc as any).slug
  if (slug) {
    productInput.productAttributes ??= {}
    productInput.productAttributes.link = `${process.env.SITE_URL}/products/${slug}`
  }
  return productInput
},
```

> **Required MC fields**: Every product must have `title`, `link`, `imageLink`, and `availability`. The plugin validates these before sending to the API.

For transform presets and advanced mappings, see the [README](../README.md#field-mappings).

### A5. Test with One Product

With sync mode set to `manual` (the default):

1. Open a product in the admin panel.
2. Go to the **Merchant Center** tab.
3. Enable the **Enable Merchant Center sync** checkbox.
4. Verify the offerId looks correct.
5. Save the product.
6. Click **Push to Merchant Center**.

Check the result:
- Sync status should show **Success**.
- The snapshot section should populate with processed product data from MC.
- In Merchant Center, the product should appear under Products.

| Error | Cause | Fix |
|---|---|---|
| Missing required fields | title, link, imageLink, or availability not populated | Add field mappings or set values manually |
| 401/403 | Service account doesn't have access | Check MC account access settings |
| Unknown field in product input | Null/empty values sent for fields MC doesn't expect | This shouldn't happen — the plugin strips empty values. Report if you see this. |

### A6. Enable Products for Sync

You have two options:

**Option 1: Manual** — Enable products one-by-one in the admin UI (Merchant Center tab > Enable checkbox).

**Option 2: Migration script** — Enable products in bulk via a Payload Local API script or migration:

```ts
// enable-mc-products.ts — run with tsx or as a Payload migration
import { getPayload } from 'payload'
import config from './payload.config'

const payload = await getPayload({ config })

// Enable all products (or add a where clause to filter)
const products = await payload.find({
  collection: 'products',
  limit: 0,  // all products
  depth: 0,
  select: {},
})

for (const product of products.docs) {
  await payload.update({
    collection: 'products',
    id: product.id,
    data: {
      mc: { enabled: true },
    } as any,
    depth: 0,
  })
}

console.log(`Enabled MC sync for ${products.totalDocs} products`)
```

### A7. Run Initial Sync

Initial sync pushes all enabled products to Merchant Center.

**Dry run first** (validates without pushing):

```bash
# Via admin UI: Merchant Center dashboard > Initial Sync > Dry Run

# Or via API (worker endpoint):
curl -X POST https://your-site.com/api/gmc/worker/batch/initial-sync \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

Review the dry run results. If no errors, run the real sync:

```bash
curl -X POST https://your-site.com/api/gmc/worker/batch/initial-sync \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false}'
```

The operation runs asynchronously and returns a `jobId`. Track progress in the admin dashboard under Sync History, or query the sync log:

```bash
curl https://your-site.com/api/gmc-sync-log?limit=1&sort=-createdAt \
  -H "Authorization: users API-Key $PAYLOAD_API_KEY"
```

### A8. Configure Ongoing Sync

Once initial sync succeeds, choose a sync mode:

**onChange** — Products auto-push on every save:
```ts
sync: { mode: 'onChange' },
```

**scheduled** — Products are marked dirty on save, pushed in batch on a schedule:
```ts
sync: {
  mode: 'scheduled',
  schedule: {
    strategy: 'external',
    apiKey: process.env.GMC_WORKER_API_KEY!,
    cron: '0 4 * * *',
  },
},
```

Then set up your cron system to call:
```bash
curl -X POST https://your-site.com/api/gmc/cron/sync \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY"
```

See the [README](../README.md#scheduling-strategies) for details on the `payload-jobs` strategy and worker endpoints.

### A9. Production Checklist

- [ ] Deep health check passes (`/api/gmc/health?deep=true`)
- [ ] Field mappings produce correct values for title, link, imageLink, availability
- [ ] `siteUrl` is set if using `extractAbsoluteUrl`
- [ ] `access` function is configured for your role model
- [ ] Sync mode is appropriate for your workflow
- [ ] If using `scheduled`, scheduling is configured and tested
- [ ] If using `payload-jobs`, a worker is running for the `gmc-sync` queue
- [ ] If using `external` strategy, `apiKey` is set
- [ ] Initial sync completed without errors (or errors are understood and addressed)

---

## Path B: Existing Application

You already have products in Merchant Center and are replacing an existing sync system with this plugin. This requires careful identity alignment, testing against a test data source, and a controlled cutover.

### B1. Install

```bash
pnpm add payload-plugin-gmc-ecommerce
```

### B2. Create a Test Data Source

**Do not point the plugin at your production data source yet.**

In Merchant Center:
1. Go to Products > Feeds.
2. Create a new data source (Content API feed).
3. Note the data source ID — this is your test data source.

Products pushed to this test data source will not interfere with your production feed.

### B3. Add the Plugin (Pointing to Test Data Source)

```ts
payloadGmcEcommerce({
  merchantId: process.env.GMC_MERCHANT_ID!,
  dataSourceId: process.env.GMC_TEST_DATA_SOURCE_ID!,  // TEST data source
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
      identityField: 'modelId',  // must produce the SAME offerId as your existing catalog
    },
  },
  defaults: {
    contentLanguage: 'en',     // must match your existing catalog
    feedLabel: 'PRODUCTS',      // must match your existing catalog
    currency: 'USD',
  },
})
```

> **Identity is critical.** Check any existing product in Merchant Center. Its identity format is `contentLanguage~feedLabel~offerId`. Your `defaults.contentLanguage`, `defaults.feedLabel`, and the value produced by `identityField` on each product **must match exactly** what your existing catalog uses. If your existing products have offerId `MF-123` (uppercase), your `identityField` must produce `MF-123` — not `mf-123`.

### B4. Configure Field Mappings and `beforePush`

Map your Payload fields to MC attributes. For anything field mappings can't express, use `beforePush`.

Here's a real-world example from a production ecommerce site with ~5400 products, showing how complex field derivations (materials from categories, sale prices, promo labels, free shipping, custom labels) are handled entirely in `beforePush`:

```ts
payloadGmcEcommerce({
  // ...required options...

  collections: {
    products: {
      slug: 'products',
      identityField: 'modelId',
      fetchDepth: 2,  // need category relationships hydrated
      fieldMappings: [
        // Simple 1:1 mappings go here
        { source: 'title', target: 'productAttributes.title', syncMode: 'permanent' },
        { source: 'description', target: 'productAttributes.description', syncMode: 'permanent' },
      ],
    },
  },

  siteUrl: process.env.NEXT_PUBLIC_SERVER_URL,

  beforePush: async ({ doc, payload, productInput }) => {
    const attrs = productInput.productAttributes ?? {}
    const product = doc as any

    // --- Product link ---
    attrs.link = `${process.env.NEXT_PUBLIC_SERVER_URL}/products/${product.slug}`

    // --- Images ---
    // Primary: first ad image, fallback to main image
    const primaryImage = product.adImages?.[0]
    attrs.imageLink = primaryImage?.url || product.mainImage?.url || ''
    if (attrs.imageLink?.startsWith('/')) {
      attrs.imageLink = `${process.env.NEXT_PUBLIC_SERVER_URL}${attrs.imageLink}`
    }

    // Additional images
    const additionalImages = product.adImages?.slice(1)
      ?.map((img: any) => img?.url)
      ?.filter(Boolean) ?? []
    if (additionalImages.length > 0) {
      attrs.additionalImageLinks = additionalImages.map((url: string) =>
        url.startsWith('/') ? `${process.env.NEXT_PUBLIC_SERVER_URL}${url}` : url,
      )
    }

    // --- Pricing ---
    const toMicros = (value: number) => String(Math.round(value * 1_000_000))
    const price = product.suggestedPrice || product.price || 0
    attrs.price = { amountMicros: toMicros(price), currencyCode: 'USD' }

    // Sale price (only if lower than regular price)
    if (product.effectivePrice && product.effectivePrice < price) {
      attrs.salePrice = { amountMicros: toMicros(product.effectivePrice), currencyCode: 'USD' }
    }

    // --- Category-derived fields ---
    // Fetch the category if needed (or use the hydrated relationship)
    const category = product.category  // hydrated at fetchDepth: 2

    if (category && typeof category === 'object') {
      // Google product category from category's taxonomy ID
      if (category.googleCategoryId) {
        attrs.googleProductCategory = String(category.googleCategoryId)
      }

      // Material derived from category hierarchy
      attrs.material = getMaterial(category)  // your existing utility

      // Product types from category breadcrumb
      if (category.fullTitle) {
        attrs.productTypes = [category.fullTitle]
      }

      // Custom label: marble vs non-marble
      const isMarble = category.displayName?.toLowerCase().includes('marble')
      attrs.customLabel0 = isMarble ? 'marbleShopping' : 'nonMarbleShopping'
    }

    // --- Static fields ---
    attrs.brand = "Your Brand"
    attrs.condition = 'NEW'
    attrs.identifierExists = false
    attrs.availability = product.stockStatus === 'out-of-stock' ? 'OUT_OF_STOCK' : 'IN_STOCK'

    // --- Dimensions ---
    if (product.height) attrs.productHeight = { value: product.height, unit: 'in' }
    if (product.width) attrs.productWidth = { value: product.width, unit: 'in' }
    if (product.length) attrs.productLength = { value: product.length, unit: 'in' }

    // --- Promo-derived fields ---
    const promoLabels = getActivePromoCustomLabels(product.promos)  // your utility
    if (promoLabels.length > 0) {
      attrs.customLabel1 = promoLabels.join(' | ')
    }

    // Free shipping from active promotions
    if (hasEligibleFreeShippingPromo(product.promos)) {
      attrs.shipping = [{
        country: 'US',
        service: 'Standard',
        price: { amountMicros: '0', currencyCode: 'USD' },
      }]
    }

    productInput.productAttributes = attrs
    return productInput
  },
})
```

### B5. Test Against the Test Data Source

Start your dev server (or a staging environment) pointing to the test data source.

1. **Verify health**: `GET /api/gmc/health?deep=true` should return `{ apiConnection: 'ok' }`.

2. **Push one product manually**:
   - Open a product in admin > Merchant Center tab > Enable > Save > Push.
   - Verify the push succeeds.
   - Check Merchant Center — the product should appear under the test data source.
   - Verify the identity matches what your production catalog uses.

3. **Push a small batch** (5-10 products):
   - Enable MC sync on a handful of products.
   - Use the admin dashboard's "Push All Enabled" or run:
     ```bash
     curl -X POST https://your-site.com/api/gmc/batch/push \
       -H "Authorization: users API-Key $PAYLOAD_API_KEY" \
       -H "Content-Type: application/json" \
       -d '{"productIds": ["id1", "id2", "id3"]}'
     ```
   - Review the sync log for errors.
   - Spot-check products in Merchant Center — verify titles, prices, images, availability are correct.

4. **Run a dry-run initial sync** to validate all products:
   ```bash
   curl -X POST https://your-site.com/api/gmc/worker/batch/initial-sync \
     -H "Authorization: Bearer $GMC_WORKER_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"dryRun": true}'
   ```
   This validates every enabled product without pushing. Review errors.

### B6. Disable Your Old Sync System

**Do not run two sync systems simultaneously.** Before cutting over:

1. Disable all existing MC sync hooks (`beforeChange`, `afterChange` hooks that call your old sync function).
2. Disable any existing cron jobs, Lambda functions, or scheduled tasks that sync products to MC.
3. Disable or remove the old MC sync endpoint if you have one.
4. Comment out or remove the old sync code. Don't delete it yet — you may need to reference it.

Example (disabling an old hook-based sync):
```ts
// In your products collection hooks:
// BEFORE:
// beforeChange: [updateGoogleListing]
// AFTER:
beforeChange: []  // Old MC sync disabled — now handled by GMC plugin
```

### B7. Cut Over to Production Data Source

Update your environment variable to point to the production data source:

```env
# BEFORE:
GMC_DATA_SOURCE_ID=test-datasource-id

# AFTER:
GMC_DATA_SOURCE_ID=production-datasource-id
```

### B8. Enable Products and Sync

Now you need to enable MC sync on all the products you want to manage through the plugin, and decide how to handle the initial data flow.

**Step 1: Enable products via migration**

```ts
// enable-mc-products.ts
import { getPayload } from 'payload'
import config from './payload.config'

const payload = await getPayload({ config })

// Enable MC sync for products that were previously synced
// Adjust the where clause to match your product selection criteria
const products = await payload.find({
  collection: 'products',
  limit: 0,
  depth: 0,
  select: {},
  where: {
    googleFeed: { equals: true },  // or whatever flag your old system used
  },
})

for (const product of products.docs) {
  await payload.update({
    collection: 'products',
    id: product.id,
    data: {
      mc: { enabled: true },
    } as any,
    depth: 0,
  })
}

console.log(`Enabled MC sync for ${products.totalDocs} products`)
```

**Step 2: Choose your sync strategy based on your situation:**

#### Scenario 1: Production MC data source has NO existing products (clean data source)

This is the case when you created a new data source for the plugin, or your old system used a different data source.

Run **initial sync** (or push all enabled):

```bash
# Initial sync — inserts all enabled products
curl -X POST https://your-site.com/api/gmc/worker/batch/initial-sync \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false}'
```

Or push all enabled products:

```bash
curl -X POST https://your-site.com/api/gmc/worker/batch/push-dirty \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY"
```

Both work because the MC v1 `insertProductInput` is an **upsert** — it creates or replaces.

#### Scenario 2: Production MC data source HAS existing products

This is the case when you're taking over the same data source your old system used.

Run **pull-all first** to populate snapshots and MC state on your Payload documents:

```bash
curl -X POST https://your-site.com/api/gmc/worker/batch/pull-all \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY"
```

This:
- Iterates through every product in your MC account
- Matches each MC product to a Payload document by identity (offerId → identityField)
- Populates the MC snapshot, attributes, and sync metadata on each matched document
- Products in MC with no matching Payload document are counted as "orphaned"

After pull completes, run **initial sync** to push any products that exist in Payload but not in MC:

```bash
curl -X POST https://your-site.com/api/gmc/worker/batch/initial-sync \
  -H "Authorization: Bearer $GMC_WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false, "onlyIfRemoteMissing": true}'
```

`onlyIfRemoteMissing: true` (the default) means it only pushes products that don't already exist in MC — it won't overwrite the data you just pulled.

### B9. Verify and Configure Ongoing Sync

1. Check the sync log for errors: admin dashboard > Sync History.
2. Spot-check products in MC — verify data is correct.
3. Push a single product manually to confirm the full round-trip works.
4. Configure your ongoing sync mode (`onChange`, `scheduled`, or stay on `manual`).

### B10. Production Checklist

- [ ] Old sync system fully disabled (hooks, crons, lambdas, endpoints)
- [ ] Deep health check passes on production
- [ ] `dataSourceId` points to production data source
- [ ] Identity (feedLabel, contentLanguage, offerId format) matches existing catalog exactly
- [ ] Initial sync or pull-all completed without critical errors
- [ ] Products in MC match Payload data (spot-check 5-10 products)
- [ ] Ongoing sync mode configured and tested
- [ ] `access` function configured for your role model
- [ ] If using `scheduled` mode with `external` strategy, cron/EventBridge is configured
- [ ] If using `payload-jobs`, worker is running for the `gmc-sync` queue

---

## Advanced Configuration

### Categories

If your products have categories and you want `googleProductCategory` and `productTypes` resolved automatically:

```ts
collections: {
  categories: {
    slug: 'categories',
    nameField: 'title',
    googleCategoryIdField: 'googleCategoryId',
    parentField: 'parent',
    productCategoryField: 'category',
    productTypeField: 'fullTitle',
  },
},
```

During push, the plugin walks the category chain, builds `productTypes` breadcrumbs, and resolves `googleProductCategory` from the most specific category that has a Google taxonomy ID.

### Access Control

Default: `user.isAdmin === true || user.roles includes 'admin'`

For custom roles:

```ts
access: async ({ req }) => {
  return req.user?.role === 'admin' || req.user?.role === 'seo'
},
```

### Permanent Sync

When `sync.permanentSync` is `true`, field mappings with `syncMode: 'permanent'` are also applied in the `beforeChange` hook on every document save. This pre-populates the MC attribute fields on the document before the push, so the MC tab always shows current values.

### Scheduling

See the [README](../README.md#scheduling-strategies) for details on the `external` and `payload-jobs` strategies.

### Rate Limiting

Default settings handle most single-instance deployments (4 concurrent, 120 requests/min). For multi-instance deployments, provide a `rateLimit.store`. See [README](../README.md#distributed-rate-limiting).

---

## Monitoring

### Health Endpoint

```bash
# Basic (public)
curl https://your-site.com/api/gmc/health

# Deep (requires auth — tests API connectivity)
curl https://your-site.com/api/gmc/health?deep=true \
  -H "Authorization: users API-Key $PAYLOAD_API_KEY"
```

### Sync Logs

All batch operations create entries in `gmc-sync-log`. View them in the admin dashboard or query directly:

```bash
curl https://your-site.com/api/gmc-sync-log?limit=10&sort=-createdAt \
  -H "Authorization: users API-Key $PAYLOAD_API_KEY"
```

Each entry contains: `jobId`, `type`, `status` (running/completed/failed), progress counters (`total`, `processed`, `succeeded`, `failed`), and an `errors` array.

### Per-Product State

Each product's Merchant Center tab shows:
- Current sync state (idle, syncing, success, error)
- Last sync timestamp and error
- Dirty flag (needs syncing)
- Read-only snapshot of the processed MC product

### Analytics

The per-product sync controls include performance analytics (impressions, clicks, CTR, conversions) from the MC Reports API.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Deep health check fails | Service account credentials or permissions wrong | Verify credentials in env, check MC account access |
| Push returns "Missing required fields" | title, link, imageLink, or availability not set | Add field mappings or set in `beforePush` |
| Products duplicated in MC | Identity mismatch — feedLabel, contentLanguage, or offerId doesn't match | Check existing MC product identity, align `defaults` and `identityField` |
| Push succeeds but snapshot is stale | MC product propagation delay (30-90 seconds) | Use "Refresh Snapshot" after a few minutes |
| Batch job stuck on "running" | Should not happen — if it does, check sync logs for errors | Review `gmc-sync-log` entries; check server logs |
| `RateLimitQueueOverflowError` | Too many concurrent pushes (e.g., bulk save triggered 1000+ onChange pushes) | Expected behavior — overflow products stay dirty and sync on next scheduled run |
| 429 from Google API | MC API quota exceeded | Reduce `maxRequestsPerMinute` or add a `rateLimit.store` for distributed limiting |
