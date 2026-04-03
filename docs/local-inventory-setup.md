# Local Inventory Setup Guide

This guide covers how to set up **Local Inventory Ads** and **Free Local Listings** with the `payload-plugin-gmc-ecommerce` plugin.

Local inventory lets your in-stock products appear in Google's local shopping results, tied to your physical store location. Customers see that items are available at your store and click through to YOUR product pages on YOUR website.

## Prerequisites

Before enabling local inventory in the plugin, complete these steps in Google's systems:

### 1. Google Business Profile (GBP)

Your physical store must be listed and verified in [Google Business Profile](https://business.google.com/).

- Ensure your store address, phone number, and business hours are accurate and up-to-date
- Note your **store code** — find it in GBP under your location's settings, or in Merchant Center under Settings > Linked accounts > Business Profiles

### 2. Link GBP to Merchant Center

In Google Merchant Center:
1. Go to **Settings** (gear icon) > **Linked accounts**
2. Link your Google Business Profile
3. Verify your store appears and is matched

### 3. Enable the Add-on

In Google Merchant Center:
1. Go to **Settings** > **Add-ons** > **Your add-ons**
2. Enable **Free Local Listings** and/or **Local Inventory Ads**
3. Click **Add country** and select your target country (e.g., United States)
4. Click **Continue setup**

### 4. Configure Your Product Page Experience

During setup, Google asks how your website handles in-store availability. Choose the option that matches your site:

#### "Product pages with in-store availability" (RECOMMENDED)

**Choose this option.** Google sends customers directly to YOUR product pages on YOUR domain.

Your product pages must meet these requirements:
- **Show in-store availability** — a section, badge, or indicator showing whether the product is available at your physical location. This can appear after the customer clicks a link like "Check store availability" or enters a postcode. For single-store merchants, a static "Available at [Store Name] Showroom" badge on in-stock products is sufficient.
- **Show the omnichannel price** — the price on your landing page must match what you submit in your primary data source
- **Be crawlable by Google Storebot** — standard server-rendered pages work; no special configuration needed if you're already indexed

You'll provide a sample product URL showing in-store availability for Google to verify.

> **Do NOT select "Product pages without in-store availability"** — that option makes Google host a generic page for your products instead of sending customers to your site.

#### "Store-specific product pages with availability and price"

Choose this only if your website can load store-specific pricing and availability based on a `{store_code}` parameter in the URL (e.g., `yoursite.com/products/item?store=STORE123`). Requires a `link_template` attribute with a `{store_code}` ValueTrack parameter. Most single-location merchants do NOT need this.

### 5. Configure Your Pickup/Display Experience

After selecting your product page experience, Google asks about fulfillment options:

#### "On Display in Store"

Enable this if products can be **experienced and viewed in your store** but are **shipped directly to the customer** (not carried out). This is ideal for showrooms, galleries, and stores with large or heavy items.

You'll need to provide your shipping policy URL.

#### "Pickup Later" (optional, in addition to On Display)

Enable this if customers can **buy online and pick up at your store** after a preparation period. You must:
- Show pickup availability on your product pages or during checkout
- Send a confirmation when the order is ready for pickup
- Display pickup fees if applicable

#### Both

You can enable BOTH "On Display in Store" AND "Pickup Later". Products appear as viewable in-store and available for pickup.

### 6. Link Google Ads (for paid Local Inventory Ads only)

If you want to run paid local inventory ads (not just free listings):
1. Link your Google Ads account to Merchant Center
2. Enable local products in your campaigns (Performance Max automatically includes them)

## Plugin Configuration

### Basic: On Display in Store Only

```ts
localInventory: {
  enabled: true,
  storeCode: 'your-gbp-store-code',
},
```

Products with MC availability `IN_STOCK` get a local inventory entry. Products that are not in-stock automatically have their entry removed.

### With Pickup Later

```ts
localInventory: {
  enabled: true,
  storeCode: 'your-gbp-store-code',
  pickup: {
    sla: 'MULTI_WEEK', // See table below
  },
},
```

### Pickup SLA Values

| Value | Google Shows | Best For |
|-------|-------------|----------|
| `'SAME_DAY'` | "Pickup today" | Items ready immediately |
| `'NEXT_DAY'` | "Pickup tomorrow" | Next business day |
| `'TWO_DAY'` through `'SEVEN_DAY'` | "Pickup in X days" | Packing/prep time needed |
| `'MULTI_WEEK'` | "Store pick-up" | Generic annotation, no specific date |

Google adjusts the displayed pickup date based on your store hours from Google Business Profile. If a pickup date lands on a closed day, Google shows the next open day.

> As of September 2024, Google only requires `pickupSla`. The `pickupMethod` attribute is deprecated and is NOT submitted by this plugin.

### Custom Availability Logic

By default, the plugin checks if the product's MC availability is `'IN_STOCK'` (as set by your `beforePush` hook). Override with a custom resolver:

```ts
localInventory: {
  enabled: true,
  storeCode: 'bonita-springs-01',
  pickup: { sla: 'MULTI_WEEK' },
  availabilityResolver: (doc) => {
    // Only products genuinely in stock at the physical location
    // Exclude pending-sale, finished-production, out-of-stock
    return doc.stockStatus === 'in-stock' ? 'in_stock' : null
  },
},
```

Return `'in_stock'` to insert a local inventory entry, or `null` to remove it.

## How It Works

### Automatic Sync

When a product is saved and pushed to Merchant Center (in `onChange` mode):

1. Product data syncs to MC (primary feed) as usual
2. After successful push, the plugin checks local availability
3. In-stock products get a local inventory entry inserted for your store
4. Not-in-stock products get their local inventory entry deleted
5. Local inventory sync is non-critical — failures are logged but never block the product push

### Nightly Reconciliation

Run a reconciliation job to catch any products that fell through:

```bash
# External cron (API key auth)
curl -X POST https://your-site.com/api/gmc/worker/local-inventory/reconcile \
  -H "X-GMC-API-Key: your-api-key"

# Authenticated user
curl -X POST https://your-site.com/api/gmc/local-inventory/reconcile \
  -H "Authorization: Bearer your-jwt"
```

### Programmatic Access

```ts
import { getMerchantServiceInstance } from 'payload-plugin-gmc-ecommerce'

const service = getMerchantServiceInstance()
const report = await service.reconcileLocalInventory({ payload })
// { inserted: 42, deleted: 5, errors: 0, processed: 47, total: 47 }
```

## API Details

Uses Google's **Inventories sub-API** (Merchant API v1). Same service account credentials as product sync — no additional scopes needed.

### Request Format (v1)

```json
{
  "storeCode": "your-store-code",
  "localInventoryAttributes": {
    "availability": "IN_STOCK",
    "price": {
      "amountMicros": "15990000",
      "currencyCode": "USD"
    },
    "pickupSla": "MULTI_WEEK"
  }
}
```

In Merchant API v1, inventory attributes are nested under `localInventoryAttributes`. The `storeCode` is top-level.

## Troubleshooting

| Issue | Check |
|-------|-------|
| Products not in local results | Verify GBP is linked, add-on is enabled, store code matches |
| Wrong store showing | Ensure `storeCode` exactly matches your GBP store code |
| Local inventory not updating | Allow up to 30 minutes for changes to propagate |
| Pickup annotation not showing | Verify "Pickup Later" is enabled in MC setup AND `pickup.sla` is configured |
| Inventory verification required | Complete the verification process in MC (provide contact, Google may call) |
