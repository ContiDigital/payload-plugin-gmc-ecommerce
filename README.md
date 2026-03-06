# payload-plugin-gmc-ecommerce

A production-grade [Payload CMS](https://payloadcms.com) plugin for bi-directional product synchronization with [Google Merchant Center](https://merchants.google.com/) via the Merchant API (v1). Push products from Payload to Google Shopping, pull MC data back into Payload, manage field mappings, track sync state per-product, and monitor performance analytics — all from the Payload admin panel.

Built for Payload 3.x. Uses the Merchant Center REST API directly (no SDK dependency) with service account authentication, automatic retry with exponential backoff, rate limiting, and structured logging.

## Features

- **Bi-directional sync** — Push product data to MC and pull MC state back into Payload
- **Three sync modes** — Manual, onChange (auto-push on save), and scheduled (cron)
- **Field mappings** — Declarative source-to-target mappings with transform presets (`toMicros`, `extractAbsoluteUrl`, `toArray`, etc.)
- **Per-product controls** — Enable/disable sync, override identity fields, per-product data source overrides
- **Admin dashboard** — Dedicated Merchant Center dashboard with sync controls, sync log viewer, and field mapping editor
- **Auto-injected tab** — Merchant Center tab injected into your products collection with identity, attributes, sync state, and MC snapshot
- **Initial sync** — Bulk-push all products to MC on first setup (supports dry run)
- **Pull all** — Import all products from MC back into Payload with conflict resolution
- **Batch operations** — Push dirty products, push by filter, push by product IDs
- **Conflict resolution** — Three strategies: `mc-wins`, `payload-wins`, `newest-wins`
- **Product analytics** — Per-product impressions, clicks, CTR, and conversions from MC Reports API
- **Rate limiting** — Token bucket with configurable concurrency, queue size, and requests/minute
- **Retry with backoff** — Exponential backoff with jitter for 429/5xx responses
- **Scheduled sync** — Two strategies: Payload Jobs (`autoRun` cron) or external scheduler (API key-authenticated endpoint)
- **Structured logging** — `[GMC]` prefixed logs with operation context via Payload's pino logger
- **Health checks** — Shallow and deep health endpoints (deep validates API connectivity)
- **Sync log collection** — Automatic tracking of all sync operations with TTL cleanup
- **Dirty tracking** — Products marked dirty on save, cleared after successful sync
- **Graceful shutdown** — Active services drain queues and reset token caches on SIGTERM/SIGINT

## Installation

```bash
pnpm add payload-plugin-gmc-ecommerce
# or
npm install payload-plugin-gmc-ecommerce
# or
yarn add payload-plugin-gmc-ecommerce
```

### Requirements

| Dependency | Version |
|---|---|
| Payload CMS | `^3.37.0` |
| Node.js | `^18.20.2` or `>=20.9.0` |

## Quick Start

```ts
// payload.config.ts
import { buildConfig } from 'payload'
import { payloadGmcEcommerce } from 'payload-plugin-gmc-ecommerce'

export default buildConfig({
  // ...your config
  plugins: [
    payloadGmcEcommerce({
      merchantId: process.env.GMC_MERCHANT_ID!,
      dataSourceId: process.env.GMC_DATA_SOURCE_ID!,
      getCredentials: async () => ({
        type: 'json',
        credentials: {
          client_email: process.env.GMC_CLIENT_EMAIL!,
          private_key: process.env.GMC_PRIVATE_KEY!,
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

This minimal configuration will:

1. Inject a **Merchant Center** tab into your `products` collection
2. Register API endpoints under `/api/gmc/*`
3. Add a **Merchant Center** route in the admin nav
4. Create `gmc-field-mappings` and `gmc-sync-log` utility collections
5. Set sync mode to `manual` (default)

## Production Configuration

```ts
payloadGmcEcommerce({
  merchantId: process.env.GMC_MERCHANT_ID!,
  dataSourceId: process.env.GMC_DATA_SOURCE_ID!,
  siteUrl: process.env.SITE_URL!, // e.g. 'https://example.com'
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
      fieldMappings: [
        { source: 'title', target: 'productAttributes.title', syncMode: 'permanent' },
        { source: 'description', target: 'productAttributes.description', syncMode: 'permanent' },
        { source: 'price', target: 'productAttributes.price.amountMicros', syncMode: 'permanent', transformPreset: 'toMicros' },
        { source: 'featuredImage', target: 'productAttributes.imageLink', syncMode: 'permanent', transformPreset: 'extractAbsoluteUrl' },
        { source: 'slug', target: 'productAttributes.link', syncMode: 'initialOnly' },
      ],
    },
  },
  defaults: {
    contentLanguage: 'en',
    feedLabel: 'US',
    currency: 'USD',
    condition: 'NEW',
  },
  sync: {
    mode: 'onChange',
    permanentSync: true,
    conflictStrategy: 'mc-wins',
    initialSync: {
      enabled: true,
      dryRun: false,
      batchSize: 50,
      onlyIfRemoteMissing: true,
    },
  },
  rateLimit: {
    enabled: true,
    maxConcurrency: 4,
    maxRequestsPerMinute: 120,
    maxRetries: 4,
  },
  admin: {
    mode: 'both',
  },
  access: async ({ req }) => {
    return req.user?.role === 'admin'
  },
})
```

## Google Merchant Center Setup

### 1. Create a Service Account

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Select or create a project
3. Navigate to **IAM & Admin > Service Accounts**
4. Click **Create Service Account**
5. Grant it no project-level roles (MC access is managed separately)
6. Under the service account, go to **Keys > Add Key > Create new key > JSON**
7. Download the JSON key file — you need `client_email` and `private_key`

### 2. Enable the Merchant API

1. In the Cloud Console, go to **APIs & Services > Library**
2. Search for **Merchant API** and enable it
3. Also enable **Google Shopping Content API** if you plan to use Reports

### 3. Grant Merchant Center Access

1. Go to [Google Merchant Center](https://merchants.google.com/)
2. Navigate to **Settings > Account access**
3. Add the service account email (`client_email` from step 1) as a user
4. Grant it **Standard** or **Admin** access

### 4. Find Your Merchant ID and Data Source ID

- **Merchant ID**: Visible in the top-right of Merchant Center, or in the URL (`merchants.google.com/mc/overview?a=MERCHANT_ID`)
- **Data Source ID**: Go to **Products > Feeds**, click on your primary feed — the ID is in the URL or feed details

### 5. Environment Variables

```env
GMC_MERCHANT_ID=123456789
GMC_DATA_SOURCE_ID=987654321
GMC_CLIENT_EMAIL=my-service-account@my-project.iam.gserviceaccount.com
GMC_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
SITE_URL=https://example.com
```

### Credential Resolution

The `getCredentials` function supports two resolution types:

```ts
// Inline JSON credentials (recommended for most deployments)
getCredentials: async () => ({
  type: 'json',
  credentials: {
    client_email: process.env.GMC_CLIENT_EMAIL!,
    private_key: process.env.GMC_PRIVATE_KEY!,
  },
})

// File path (for environments with mounted secrets)
getCredentials: async () => ({
  type: 'keyFilename',
  path: '/run/secrets/gmc-service-account.json',
})
```

## Admin Integration

### Admin Modes

| Mode | Description |
|---|---|
| `route` | Dedicated route at `/admin/merchant-center` (default) |
| `dashboard` | Widget embedded in the Payload dashboard |
| `both` | Both route and dashboard widget |
| `headless` | API endpoints only, no admin UI |

### Merchant Center Dashboard

The admin dashboard provides:

- **Connection status** with deep health check (validates API connectivity)
- **Quick actions**: Push all, push dirty, pull all, initial sync
- **Sync log viewer** with real-time progress tracking
- **Field mapping editor** — create, edit, and delete mappings from the UI

### Per-Product Tab

When `autoInjectTab` is `true` (default), a **Merchant Center** tab is added to your products collection with:

- **Enable toggle** — Opt products in/out of sync
- **Identity fields** — offerId (auto-populated from `identityField`), contentLanguage, feedLabel, dataSourceOverride
- **Product attributes** — All MC product attributes (title, description, price, availability, images, shipping, etc.)
- **Custom attributes** — Key-value pairs for MC custom attributes
- **Sync metadata** — State, last action, last error, last synced timestamp, dirty flag
- **MC snapshot** — Raw JSON response from the last MC API call

## Sync Modes

### Manual (`mode: 'manual'`)

Default mode. Products are only synced when explicitly triggered via API endpoints or admin UI actions.

### On Change (`mode: 'onChange'`)

Products are automatically pushed to MC after every save (update operation). The push is fire-and-forget — it does not block the save operation. The push is deferred via `setImmediate` to ensure the document is fully persisted before the push begins.

```ts
sync: {
  mode: 'onChange',
  permanentSync: true, // Re-apply field mappings on every save
}
```

### Scheduled (`mode: 'scheduled'`)

Products marked as dirty are pushed on a cron schedule. Two strategies are available:

#### Payload Jobs Strategy

Uses Payload's built-in Jobs/Queue system with `autoRun`. Best for long-running server environments (VPS, containers, dedicated servers).

> **Warning**: Do not use `payload-jobs` strategy on serverless platforms (Vercel, AWS Lambda). The `autoRun` scheduler requires a persistent process.

```ts
sync: {
  mode: 'scheduled',
  permanentSync: true,
  schedule: {
    strategy: 'payload-jobs',
    cron: '0 4 * * *', // 4am daily
  },
}
```

#### External Strategy

Exposes an API key-authenticated endpoint for external schedulers (AWS EventBridge, GitHub Actions, cron jobs, etc.). Works on any platform including serverless.

```ts
sync: {
  mode: 'scheduled',
  permanentSync: true,
  schedule: {
    strategy: 'external',
    apiKey: process.env.GMC_CRON_API_KEY!,
    cron: '0 4 * * *', // Used as documentation; actual schedule configured externally
  },
}
```

Trigger from an external scheduler:

```bash
# Via query parameter
curl -X POST "https://example.com/api/gmc/cron/sync?key=YOUR_API_KEY"

# Via header
curl -X POST https://example.com/api/gmc/cron/sync \
  -H "x-gmc-api-key: YOUR_API_KEY"
```

**GitHub Actions example:**

```yaml
name: GMC Scheduled Sync
on:
  schedule:
    - cron: '0 4 * * *'
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -X POST "${{ secrets.SITE_URL }}/api/gmc/cron/sync" \
            -H "x-gmc-api-key: ${{ secrets.GMC_CRON_API_KEY }}"
```

## Field Mappings

Field mappings declaratively map Payload document fields to MC product attributes. They support dot-notation paths, array indexing, and transform presets.

### Configuration

```ts
collections: {
  products: {
    slug: 'products',
    identityField: 'sku',
    fieldMappings: [
      {
        source: 'title',                              // Payload field path
        target: 'productAttributes.title',             // MC attribute path
        syncMode: 'permanent',                         // Applied on every save
        transformPreset: 'none',                       // Optional transform
        order: 0,                                      // Execution order
      },
      {
        source: 'price',
        target: 'productAttributes.price.amountMicros',
        syncMode: 'permanent',
        transformPreset: 'toMicros',                   // Converts dollars to micros
      },
      {
        source: 'featuredImage',
        target: 'productAttributes.imageLink',
        syncMode: 'permanent',
        transformPreset: 'extractAbsoluteUrl',         // Extracts .url and prepends siteUrl
      },
      {
        source: 'slug',
        target: 'productAttributes.link',
        syncMode: 'initialOnly',                       // Only applied on first sync
      },
    ],
  },
},
```

### Sync Modes

| Mode | Behavior |
|---|---|
| `permanent` | Applied on every save when `permanentSync` is `true`. Re-maps source fields to MC attributes before each push. |
| `initialOnly` | Applied only during initial sync. Useful for fields like `link` that shouldn't change after first push. |

### Transform Presets

| Preset | Description |
|---|---|
| `none` | Pass-through (default) |
| `toMicros` | Multiplies a number by 1,000,000 (e.g., `19.99` -> `19990000`). Used for MC price fields. |
| `toMicrosString` | Like `toMicros` but also handles string input (parses to number first) |
| `extractUrl` | Extracts `.url`, `.src`, or `.href` from an object. Useful for Payload media/upload fields. |
| `extractAbsoluteUrl` | Like `extractUrl`, but prepends `siteUrl` to relative paths (e.g., `/media/image.jpg` -> `https://example.com/media/image.jpg`). Requires `siteUrl` to be configured. |
| `toArray` | Wraps a single value in an array, or returns as-is if already an array |
| `toString` | Converts value to string |
| `toBoolean` | Converts value to boolean |

### Dot-Notation and Array Indexing

Source paths support dot-notation and array indexing:

```ts
{ source: 'variants[0].price', target: 'productAttributes.price.amountMicros', ... }
{ source: 'meta.seo.title', target: 'productAttributes.title', ... }
{ source: 'categories[0].name', target: 'productAttributes.googleProductCategory', ... }
```

### Runtime Field Mapping Editor

Field mappings can also be managed from the admin dashboard UI at runtime. Mappings saved via the UI are stored in the `gmc-field-mappings` collection and merged with config-defined mappings.

## Conflict Resolution

When pulling data from MC into Payload, conflict resolution determines whether to overwrite local data.

| Strategy | Behavior |
|---|---|
| `mc-wins` | Always overwrite local data with MC data (default) |
| `payload-wins` | Skip pull if the local document has been modified since last sync (`dirty=true`) |
| `newest-wins` | Compare MC's `updateTime` with local `lastSyncedAt`; only overwrite if MC is newer |

```ts
sync: {
  conflictStrategy: 'payload-wins',
}
```

## Dirty Tracking

Products are marked as `dirty` when:

1. The `beforeChange` hook runs with `permanentSync: true` and permanent field mappings exist
2. Any product attribute is modified in the admin

The dirty flag is cleared when:

1. A push operation completes successfully
2. A pull operation overwrites local data

Dirty tracking enables efficient scheduled sync — only modified products are pushed instead of the entire catalog.

## API Endpoints

All endpoints are registered under the configured `basePath` (default: `/gmc`). Endpoints require authentication via Payload session (except the cron endpoint which uses API key auth).

### Product Operations

| Method | Path | Description |
|---|---|---|
| `POST` | `/gmc/product/push` | Push a single product to MC |
| `POST` | `/gmc/product/pull` | Pull a single product from MC |
| `POST` | `/gmc/product/delete` | Delete a product from MC |
| `POST` | `/gmc/product/refresh` | Refresh MC snapshot without pushing |
| `POST` | `/gmc/product/analytics` | Get product performance analytics |

**Request body** (push/pull/delete/refresh):
```json
{ "productId": "64a1b2c3d4e5f6a7b8c9d0e1" }
```

**Request body** (analytics):
```json
{ "productId": "64a1b2c3d4e5f6a7b8c9d0e1", "rangeDays": 30 }
```

### Batch Operations

| Method | Path | Description |
|---|---|---|
| `POST` | `/gmc/batch/push` | Batch push products (by IDs or filter) |
| `POST` | `/gmc/batch/push-dirty` | Push all dirty products |
| `POST` | `/gmc/batch/pull-all` | Pull all products from MC |
| `POST` | `/gmc/batch/initial-sync` | Run initial sync |

**Batch push request body:**
```json
{
  "productIds": ["id1", "id2"],
  "filter": { "category": { "equals": "electronics" } }
}
```

**Initial sync request body:**
```json
{
  "dryRun": true,
  "batchSize": 50,
  "limit": 100,
  "onlyIfRemoteMissing": true
}
```

All batch operations return immediately with a `jobId` and run asynchronously. Progress is tracked in the `gmc-sync-log` collection.

### Field Mappings

| Method | Path | Description |
|---|---|---|
| `GET` | `/gmc/mappings` | List all field mappings |
| `POST` | `/gmc/mappings` | Save field mappings (replaces all) |

### Health and Scheduling

| Method | Path | Description |
|---|---|---|
| `GET` | `/gmc/health` | Health check (add `?deep=true` for API validation) |
| `POST` | `/gmc/cron/sync` | External cron trigger (API key auth) |

**Health response:**
```json
{
  "status": "ok",
  "timestamp": "2025-01-15T04:00:00.000Z",
  "merchant": { "accountId": "123456789", "dataSourceId": "987654321" },
  "sync": { "mode": "onChange" },
  "admin": { "mode": "both" },
  "rateLimit": { "enabled": true }
}
```

**Deep health** adds `apiConnection: "ok" | "error"` and optional `apiError` string.

## Rate Limiting and Retry

The plugin includes a multi-layer rate limiting and retry system designed for the MC API's quotas.

### Rate Limiter

Controls concurrent API calls and queue depth:

```ts
rateLimit: {
  enabled: true,             // Enable/disable rate limiting (default: true)
  maxConcurrency: 4,         // Max concurrent API requests (default: 4)
  maxQueueSize: 200,         // Max queued requests before rejection (default: 200)
  maxRequestsPerMinute: 120, // Requests per minute cap (default: 120)
}
```

### Retry with Exponential Backoff

Automatically retries on 429 (Too Many Requests) and 5xx server errors:

```ts
rateLimit: {
  maxRetries: 4,             // Max retry attempts (default: 4)
  baseRetryDelayMs: 300,     // Initial retry delay (default: 300ms)
  maxRetryDelayMs: 4000,     // Maximum retry delay (default: 4000ms)
  jitterFactor: 0.2,         // Random jitter factor 0-1 (default: 0.2)
  requestTimeoutMs: 15000,   // Per-request timeout (default: 15000ms)
}
```

Retryable status codes: `429`, `500`, `502`, `503`, `504`.

## Access Control

The `access` function gates all API endpoints and admin UI actions:

```ts
access: async ({ req, user }) => {
  // Only admins can interact with MC
  return user?.role === 'admin'
},
```

When not provided, all authenticated users have access.

## Initial Sync

Initial sync bulk-pushes all Payload products to MC. It's designed for first-time setup or catalog migration.

```ts
sync: {
  initialSync: {
    enabled: true,               // Enable initial sync endpoint (default: true)
    dryRun: true,                // Simulate without pushing (default: true)
    batchSize: 100,              // Products per batch (default: 100)
    onlyIfRemoteMissing: true,   // Skip products that already exist in MC (default: true)
  },
},
```

When `dryRun` is `true`, the sync runs through all products and applies field mappings but does not call the MC API. This is useful for validating mappings before a real sync.

The `onlyIfRemoteMissing` flag checks MC for each product before pushing — if a product with the same `offerId` already exists, it is skipped.

## Product Identity

Each product's MC identity is resolved from:

1. **offerId** — From `merchantCenter.identity.offerId` on the product, or auto-populated from the configured `identityField` (e.g., `sku`)
2. **contentLanguage** — From `merchantCenter.identity.contentLanguage` or `defaults.contentLanguage` (default: `en`)
3. **feedLabel** — From `merchantCenter.identity.feedLabel` or `defaults.feedLabel` (default: `US`)

These combine into the MC product identifier: `{contentLanguage}~{feedLabel}~{offerId}`

The full MC resource names are derived as:
- **Product**: `accounts/{merchantId}/products/{contentLanguage}~{feedLabel}~{offerId}`
- **ProductInput**: `accounts/{merchantId}/productInputs/{contentLanguage}~{feedLabel}~{offerId}`

### Per-Product Data Source Override

Individual products can target a different data source:

```
merchantCenter.identity.dataSourceOverride = "ALTERNATE_DATA_SOURCE_ID"
```

This is useful for multi-feed setups (e.g., separate feeds for different countries).

## Utility Collections

The plugin creates two internal collections:

### `gmc-sync-log`

Tracks all sync operations (push, pull, batch, initial sync, cron). Each log entry includes:

- `jobId`, `type`, `status`, `triggeredBy`
- `total`, `processed`, `succeeded`, `failed`
- `errors` (last 50)
- `startedAt`, `completedAt`
- `metadata` (additional context like `dryRun`, `matched`, `orphaned`)

Logs are automatically cleaned up: entries older than 30 days are deleted, and total count is capped at 500.

### `gmc-field-mappings`

Stores runtime-managed field mappings (created via the admin UI). Fields: `source`, `target`, `syncMode`, `transformPreset`, `order`.

## Exports

The plugin exports utilities for advanced use cases:

```ts
// Plugin function
import { payloadGmcEcommerce } from 'payload-plugin-gmc-ecommerce'

// Service factory (for custom server-side logic)
import { createMerchantService } from 'payload-plugin-gmc-ecommerce'
import type { MerchantService } from 'payload-plugin-gmc-ecommerce'

// Sync utilities
import { toMicros, fromMicros } from 'payload-plugin-gmc-ecommerce'
import { resolveIdentity } from 'payload-plugin-gmc-ecommerce'
import { applyFieldMappings, deepMerge } from 'payload-plugin-gmc-ecommerce'
import { buildUpdateMask } from 'payload-plugin-gmc-ecommerce'

// UI components (client entry point)
import { MerchantCenterUIPlaceholder } from 'payload-plugin-gmc-ecommerce'

// Types
import type {
  PayloadGMCEcommercePluginOptions,
  FieldMapping,
  MCProductAttributes,
  MCProductInput,
  MCProductState,
  SyncResult,
  BatchSyncReport,
  ConflictStrategy,
  ScheduleConfig,
  // ... and more
} from 'payload-plugin-gmc-ecommerce'
```

## Full Configuration Reference

```ts
type PayloadGMCEcommercePluginOptions = {
  /** Google Merchant Center account ID */
  merchantId: string

  /** Primary data source (feed) ID */
  dataSourceId: string

  /**
   * Base URL of your site (e.g. 'https://example.com').
   * Used by extractAbsoluteUrl transform to resolve relative media URLs.
   */
  siteUrl?: string

  /**
   * Credential resolver function. Called on each API request.
   * Return inline JSON credentials or a path to a key file.
   */
  getCredentials: (args: {
    payload: Payload | null
    req?: PayloadRequest
  }) => Promise<
    | { type: 'json'; credentials: { client_email: string; private_key: string; project_id?: string } }
    | { type: 'keyFilename'; path: string }
  >

  /** Disable the plugin without removing it from config */
  disabled?: boolean

  collections: {
    products: {
      /** Payload collection slug */
      slug: CollectionSlug

      /** Field used as the MC offerId (e.g. 'sku', 'slug', 'id') */
      identityField: string

      /** Auto-inject the Merchant Center tab into the collection (default: true) */
      autoInjectTab?: boolean

      /** Tab insertion position: 'append', 'before-last', or a numeric index (default: 'append') */
      tabPosition?: 'append' | 'before-last' | number

      /** Declarative field mappings from Payload fields to MC attributes */
      fieldMappings?: FieldMapping[]
    }

    /** Optional category collection for Google Product Category mapping */
    categories?: {
      slug: CollectionSlug
      nameField: string
      parentField?: string
      googleCategoryIdField?: string
    }
  }

  /** Default values for product identity and attributes */
  defaults?: {
    contentLanguage?: string  // default: 'en'
    feedLabel?: string        // default: 'US'
    currency?: string         // default: 'USD'
    condition?: string        // default: 'NEW'
  }

  /** Sync configuration */
  sync?: {
    /** Sync mode: 'manual' | 'onChange' | 'scheduled' (default: 'manual') */
    mode?: SyncMode

    /** Re-apply permanent field mappings on every save (default: false) */
    permanentSync?: boolean

    /** Conflict resolution strategy for pull operations (default: 'mc-wins') */
    conflictStrategy?: ConflictStrategy

    /** Initial sync configuration */
    initialSync?: {
      enabled?: boolean              // default: true
      dryRun?: boolean               // default: true
      batchSize?: number             // default: 100
      onlyIfRemoteMissing?: boolean  // default: true
    }

    /** Scheduled sync configuration (only used when mode is 'scheduled') */
    schedule?: {
      /** 'payload-jobs' for Payload autoRun, 'external' for API endpoint (default: 'external') */
      strategy?: 'payload-jobs' | 'external'

      /** Cron expression (default: '0 4 * * *' = 4am daily) */
      cron?: string

      /** API key for external scheduler authentication (required for 'external' strategy) */
      apiKey?: string
    }
  }

  /** Rate limiting and retry configuration */
  rateLimit?: {
    enabled?: boolean              // default: true
    maxConcurrency?: number        // default: 4
    maxQueueSize?: number          // default: 200
    maxRequestsPerMinute?: number  // default: 120
    maxRetries?: number            // default: 4
    baseRetryDelayMs?: number      // default: 300
    maxRetryDelayMs?: number       // default: 4000
    jitterFactor?: number          // default: 0.2
    requestTimeoutMs?: number      // default: 15000
  }

  /** Admin panel configuration */
  admin?: {
    /** Admin UI mode (default: 'route') */
    mode?: 'route' | 'dashboard' | 'both' | 'headless'

    /** Navigation label (default: 'Merchant Center') */
    navLabel?: string

    /** Admin route path (default: '/merchant-center') */
    route?: `/${string}`
  }

  /** API configuration */
  api?: {
    /** Base path for all endpoints (default: '/gmc') */
    basePath?: `/${string}`
  }

  /** Access control function — gates all endpoints and admin actions */
  access?: (args: {
    payload: Payload
    req: PayloadRequest
    user: PayloadRequest['user']
  }) => boolean | Promise<boolean>
}
```

### FieldMapping Type

```ts
type FieldMapping = {
  /** Dot-notation path to the source field on the Payload document */
  source: string

  /** Dot-notation path to the target field on the MC product input */
  target: string

  /** When this mapping is applied: 'permanent' (every save) or 'initialOnly' (first sync) */
  syncMode: 'permanent' | 'initialOnly'

  /** Transform preset to apply to the source value (default: 'none') */
  transformPreset?: 'none' | 'toMicros' | 'toMicrosString' | 'extractUrl'
    | 'extractAbsoluteUrl' | 'toArray' | 'toString' | 'toBoolean'

  /** Execution order (lower runs first, default: 0) */
  order?: number
}
```

## Architecture

```
src/
  index.ts                          # Plugin entry point, public exports
  constants.ts                      # All default values and constants
  types/index.ts                    # Full type definitions

  plugin/
    normalizeOptions.ts             # Options validation and defaults
    applyCollectionEnhancements.ts  # Injects MC tab into products collection
    applyEndpointEnhancements.ts    # Registers all API endpoints
    applyAdminEnhancements.ts       # Admin UI (route/dashboard)
    applyHooks.ts                   # beforeChange hook wiring
    applySyncCollections.ts         # Creates utility collections
    applyScheduledSync.ts           # Payload Jobs task + autoRun

  hooks/
    beforeChange.ts                 # Auto-populates offerId, applies field
                                    # mappings, triggers onChange sync

  server/
    services/
      merchantService.ts            # High-level service facade
      sub-services/
        googleApiClient.ts          # MC REST API client (JWT auth)
        rateLimiterService.ts       # Token bucket rate limiter
        retryService.ts             # Exponential backoff retry
    sync/
      pushSync.ts                   # Push/delete/refresh operations
      pullSync.ts                   # Pull single/pull all operations
      initialSync.ts                # Bulk initial sync
      fieldMapping.ts               # Field mapping engine with transforms
      identityResolver.ts           # MC identity resolution
      conflictResolver.ts           # Pull conflict strategies
      transformers.ts               # Price conversion, product transforms
      updateMask.ts                 # Update mask generation
    utilities/
      logger.ts                     # Structured logging wrapper
      access.ts                     # Access control enforcement
      http.ts                       # HTTP response helpers
      validation.ts                 # Request body validation
      inboundRateLimit.ts           # Per-endpoint rate limiting

  components/
    MerchantCenterDashboardClient.tsx  # Admin dashboard React component

  exports/
    client.ts                       # Client-side exports
    rsc.ts                          # React Server Component exports
```

## Local Development

```bash
# Clone and install
git clone <repo-url>
cd payload-plugin-gmc-ecommerce
pnpm install

# Set up dev environment
cp dev/.env.example dev/.env
# Edit dev/.env with your database URL and MC credentials

# Generate types
pnpm dev:generate-types

# Start dev server
pnpm dev

# Run tests
pnpm test:int

# Lint
pnpm lint
pnpm lint:fix

# Build
pnpm build
```

## Testing

The plugin includes unit tests covering core sync logic:

```bash
# Run all unit tests
pnpm test:int

# Run specific test files
npx vitest src/server/sync/__tests__/transformers.test.ts
npx vitest src/server/sync/__tests__/fieldMapping.test.ts
npx vitest src/server/sync/__tests__/identityResolver.test.ts
npx vitest src/server/sync/__tests__/updateMask.test.ts
```

Test suites cover:
- **Transformers** — `toMicros`, `fromMicros`, `buildProductInput`, `reverseTransformProduct`, `sanitizeCustomAttributes`
- **Field mapping** — `applyFieldMappings` with all transform presets, `deepMerge`
- **Identity resolver** — `resolveIdentity` with valid/invalid configurations
- **Update mask** — `buildUpdateMask` with camelCase to snake_case conversion

## License

MIT
