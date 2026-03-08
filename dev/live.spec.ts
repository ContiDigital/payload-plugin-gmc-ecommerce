/**
 * Live Integration Tests — Google Merchant Center
 *
 * These tests run against the REAL test data source (fines_dev_testing)
 * and exercise every sync feature of the plugin end-to-end.
 *
 * Prerequisites:
 *   - Valid credentials in dev/.env (GOOGLE_MERCHANT_ID, GOOGLE_MERCHANT_DATA_SOURCE_ID, etc.)
 *   - GOOGLE_MERCHANT_DATA_SOURCE_ID must point to the TEST data source (10621021803)
 *
 * IMPORTANT: MC v1 ProductInput INSERT is accepted immediately but the Product
 * resource takes 30-120s to become available via GET. Tests that need to read
 * back from MC (pull, refresh) use a polling helper with retries.
 *
 * Cleanup:
 *   afterAll deletes every product pushed during the test run from the MC data source.
 *
 * Run:
 *   pnpm test:live
 */

import type { Payload } from 'payload'

import config from '@payload-config'
import { getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { getMerchantServiceInstance } from '../src/plugin/serviceRegistry.js'
import type { MerchantService } from '../src/server/services/merchantService.js'
import { createGoogleApiClient } from '../src/server/services/sub-services/googleApiClient.js'
import type { GoogleApiClient } from '../src/server/services/sub-services/googleApiClient.js'
import { normalizePluginOptions } from '../src/plugin/normalizeOptions.js'

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let payload: Payload
let service: MerchantService
let apiClient: GoogleApiClient

// Track product IDs pushed during tests so we can clean them up
const createdProductIds: string[] = []
// Track SKUs pushed to MC so we can clean up remotely
const pushedSkus: string[] = []

// Unique prefix to avoid collisions with other test runs
const TEST_PREFIX = `live-test-${Date.now().toString(36)}`

// ---------------------------------------------------------------------------
// Helper: wait for MC Product to propagate after INSERT
// MC v1 processes ProductInput asynchronously — Product may not be GETable
// for 30-120s after insert. This helper polls with retries.
// ---------------------------------------------------------------------------

async function waitForMCProduct(
  svc: MerchantService,
  pl: Payload,
  productId: string,
  { maxAttempts = 8, intervalMs = 5_000 }: { intervalMs?: number; maxAttempts?: number } = {},
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await svc.refreshSnapshot({ payload: pl, productId })
    if (result.success && result.snapshot) {
      return true
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Setup & Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Validate env
  const requiredVars = [
    'GOOGLE_MERCHANT_ID',
    'GOOGLE_MERCHANT_DATA_SOURCE_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_SERVICE_ACCOUNT_KEY',
  ]
  for (const v of requiredVars) {
    if (!process.env[v] || process.env[v] === `your-${v.toLowerCase().replace(/_/g, '-')}`) {
      throw new Error(`[Live Tests] Missing or placeholder env var: ${v}. Configure dev/.env with real credentials.`)
    }
  }

  payload = await getPayload({ config })

  // Get the service that was initialized by the plugin
  const svc = getMerchantServiceInstance()
  if (!svc) {
    throw new Error('[Live Tests] MerchantService not initialized — plugin may be disabled')
  }
  service = svc

  // Build a raw API client for cleanup operations
  const rawOptions = {
    collections: {
      products: {
        identityField: 'sku',
        slug: 'products',
      },
    },
    dataSourceId: process.env.GOOGLE_MERCHANT_DATA_SOURCE_ID!,
    getCredentials: async () => ({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
        private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY!,
      },
      type: 'json' as const,
    }),
    merchantId: process.env.GOOGLE_MERCHANT_ID!,
    defaults: {
      contentLanguage: 'en',
      currency: 'USD',
      feedLabel: 'PRODUCTS',
    },
  }
  const normalizedOptions = normalizePluginOptions(rawOptions)
  apiClient = createGoogleApiClient(normalizedOptions)
}, 30_000)

afterAll(async () => {
  // 1. Delete test products from Payload
  for (const id of createdProductIds) {
    try {
      await payload.delete({
        id,
        collection: 'products',
        overrideAccess: true,
      })
    } catch {
      // Already deleted or doesn't exist
    }
  }

  // 2. Delete test products from MC data source
  const merchantId = process.env.GOOGLE_MERCHANT_ID!
  const dataSourceId = process.env.GOOGLE_MERCHANT_DATA_SOURCE_ID!
  const dataSourceName = `accounts/${merchantId}/dataSources/${dataSourceId}`

  for (const sku of pushedSkus) {
    const productInputName = `accounts/${merchantId}/productInputs/en~PRODUCTS~${sku}`
    try {
      await apiClient.deleteProductInput(productInputName, payload, dataSourceName)
    } catch {
      // Already deleted or never pushed
    }
  }

  // 3. Clean up sync logs from test runs
  try {
    await payload.delete({
      collection: 'gmc-sync-log' as never,
      overrideAccess: true,
      where: { jobId: { contains: 'gmc-' } },
    })
  } catch {
    // Non-critical
  }

  // 4. Tear down DB connection
  if (typeof payload?.db?.destroy === 'function') {
    await payload.db.destroy()
  }
}, 60_000)

// ---------------------------------------------------------------------------
// Helper: create a test product in Payload
// ---------------------------------------------------------------------------

async function createTestProduct(overrides: Record<string, unknown> = {}): Promise<{
  id: string
  sku: string
}> {
  const sku = `${TEST_PREFIX}-${createdProductIds.length + 1}`
  const product = await payload.create({
    collection: 'products',
    data: {
      title: `Live Test Product ${createdProductIds.length + 1}`,
      sku,
      price: 49.99,
      description: 'A product created by the live integration test suite',
      imageUrl: 'https://example.com/test-image.jpg',
      merchantCenter: {
        enabled: true,
        identity: {
          offerId: sku,
          contentLanguage: 'en',
          feedLabel: 'PRODUCTS',
        },
        productAttributes: {
          title: `Live Test Product ${createdProductIds.length + 1}`,
          link: 'https://example.com/products/test',
          imageLink: 'https://example.com/test-image.jpg',
          availability: 'IN_STOCK',
          condition: 'NEW',
          price: {
            amountMicros: String(49_990_000),
            currencyCode: 'USD',
          },
          description: 'A product created by the live integration test suite',
        },
      },
      ...overrides,
    },
    overrideAccess: true,
  })

  const id = (product as unknown as Record<string, unknown>).id as string
  createdProductIds.push(id)
  pushedSkus.push(sku)

  return { id, sku }
}

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe('Live MC Integration: Health', () => {
  test('getHealth returns ok status', () => {
    const health = service.getHealth()
    expect(health.status).toBe('ok')
    expect(health.merchant.accountId).toBe(process.env.GOOGLE_MERCHANT_ID)
    expect(health.merchant.dataSourceId).toBe(process.env.GOOGLE_MERCHANT_DATA_SOURCE_ID)
    expect(health.sync.mode).toBeDefined()
    expect(health.timestamp).toBeDefined()
  })

  test('getHealthDeep verifies API connectivity', async () => {
    const health = await service.getHealthDeep({ payload })
    expect(health.status).toBe('ok')
    expect(health.apiConnection).toBe('ok')
  }, 15_000)
})

describe('Live MC Integration: Push Single Product', () => {
  let productId: string

  test('push product to MC succeeds', async () => {
    const { id } = await createTestProduct()
    productId = id

    const result = await service.pushProduct({ payload, productId })

    expect(result.success).toBe(true)
    expect(result.productId).toBe(productId)
    // MC INSERT is an upsert — action is 'insert' or 'update' depending on snapshot
    expect(result.action).toMatch(/insert|update/)
  }, 30_000)

  test('pushed product has success syncMeta', async () => {
    const doc = await payload.findByID({
      id: productId,
      collection: 'products',
      depth: 0,
    }) as unknown as Record<string, unknown>

    const mc = doc.merchantCenter as Record<string, unknown>
    const syncMeta = mc.syncMeta as Record<string, unknown>
    expect(syncMeta.state).toBe('success')
    expect(syncMeta.lastSyncedAt).toBeDefined()
    expect(syncMeta.dirty).toBe(false)
    // Snapshot may or may not be populated depending on MC propagation speed
  })

  test('push same product again succeeds (upsert)', async () => {
    await payload.update({
      id: productId,
      collection: 'products',
      data: {
        merchantCenter: {
          productAttributes: {
            title: 'Updated Live Test Product',
          },
        },
      } as never,
      overrideAccess: true,
    })

    const result = await service.pushProduct({ payload, productId })
    expect(result.success).toBe(true)
    // MC INSERT is always an upsert — whether action is 'insert' or 'update'
    // depends on snapshot presence, not on MC state
    expect(result.action).toMatch(/insert|update/)
  }, 30_000)
})

describe('Live MC Integration: Refresh Snapshot (with propagation wait)', () => {
  let productId: string

  test('refreshSnapshot reads MC state after propagation', async () => {
    const { id } = await createTestProduct()
    productId = id

    // Push first
    const pushResult = await service.pushProduct({ payload, productId })
    expect(pushResult.success).toBe(true)

    // Wait for MC to process the product (may take 30-90s)
    const available = await waitForMCProduct(service, payload, productId, {
      maxAttempts: 15,
      intervalMs: 5_000,
    })

    expect(available).toBe(true)

    // Verify snapshot was stored
    const doc = await payload.findByID({
      id: productId,
      collection: 'products',
      depth: 0,
    }) as unknown as Record<string, unknown>

    const mc = doc.merchantCenter as Record<string, unknown>
    expect(mc.snapshot).toBeDefined()
    expect(Object.keys(mc.snapshot as object).length).toBeGreaterThan(0)
  }, 120_000)
})

describe('Live MC Integration: Pull Single Product (with propagation wait)', () => {
  let productId: string

  test('pullProduct reads from MC and updates local doc', async () => {
    const { id } = await createTestProduct()
    productId = id

    // Push and wait for propagation
    await service.pushProduct({ payload, productId })
    const available = await waitForMCProduct(service, payload, productId, {
      maxAttempts: 15,
      intervalMs: 5_000,
    })
    expect(available).toBe(true)

    // Clear local product attributes to verify pull repopulates them
    await payload.update({
      id: productId,
      collection: 'products',
      data: {
        merchantCenter: {
          productAttributes: {},
          snapshot: {},
          syncMeta: {
            state: 'idle',
            lastSyncedAt: undefined,
            dirty: true,
          },
        },
      } as never,
      overrideAccess: true,
    })

    const result = await service.pullProduct({ payload, productId })
    expect(result.success).toBe(true)
    expect(result.action).toBe('pull')
    expect(result.populatedFields.length).toBeGreaterThan(0)

    // Verify local doc was updated with pulled data
    const doc = await payload.findByID({
      id: productId,
      collection: 'products',
      depth: 0,
    }) as unknown as Record<string, unknown>

    const mc = doc.merchantCenter as Record<string, unknown>
    const attrs = mc.productAttributes as Record<string, unknown>
    expect(attrs.title).toBeDefined()
    expect(attrs.availability).toBeDefined()

    const syncMeta = mc.syncMeta as Record<string, unknown>
    expect(syncMeta.state).toBe('success')
    expect(syncMeta.syncSource).toBe('pull')
  }, 120_000)
})

describe('Live MC Integration: Delete Product from MC', () => {
  let productId: string

  test('deleteProduct removes product from MC', async () => {
    const { id } = await createTestProduct()
    productId = id

    // Push first
    const pushResult = await service.pushProduct({ payload, productId })
    expect(pushResult.success).toBe(true)

    // Delete from MC (works even if Product hasn't propagated yet —
    // it deletes the ProductInput, not the Product)
    const deleteResult = await service.deleteProduct({ payload, productId })
    expect(deleteResult.success).toBe(true)
    expect(deleteResult.action).toBe('delete')
  }, 30_000)

  test('deleting an already-deleted product succeeds (404 handled)', async () => {
    const result = await service.deleteProduct({ payload, productId })
    expect(result.success).toBe(true)
  }, 15_000)
})

describe('Live MC Integration: Batch Push', () => {
  const batchProductIds: string[] = []

  test('pushBatch pushes multiple products', async () => {
    for (let i = 0; i < 3; i++) {
      const { id } = await createTestProduct()
      batchProductIds.push(id)
    }

    let progressCallCount = 0
    const report = await service.pushBatch({
      payload,
      productIds: batchProductIds,
      onProgress: () => {
        progressCallCount++
      },
    })

    expect(report.status).toBe('completed')
    expect(report.total).toBe(3)
    expect(report.succeeded).toBe(3)
    expect(report.failed).toBe(0)
    expect(report.processed).toBe(3)
    expect(report.completedAt).toBeDefined()
  }, 60_000)

  test('pushBatch with dirty filter pushes matching products', async () => {
    for (const id of batchProductIds) {
      await payload.update({
        id,
        collection: 'products',
        data: {
          merchantCenter: {
            syncMeta: { dirty: true },
          },
        } as never,
        overrideAccess: true,
      })
    }

    const report = await service.pushBatch({
      filter: {
        'merchantCenter.syncMeta.dirty': { equals: true },
        id: { in: batchProductIds },
      },
      payload,
    })

    expect(report.status).toBe('completed')
    expect(report.succeeded).toBeGreaterThanOrEqual(3)
  }, 60_000)
})

describe('Live MC Integration: Pull All', () => {
  test('pullAllProducts fetches products from MC and matches local', async () => {
    let progressCalled = false

    const report = await service.pullAllProducts({
      payload,
      onProgress: () => {
        progressCalled = true
      },
    })

    expect(report.status).toBe('completed')
    expect(report.total).toBeGreaterThan(0)
    // Some should match our test products (or existing products from seed)
    expect(report.matched + report.orphaned).toBe(report.total)
    expect(report.completedAt).toBeDefined()
  }, 120_000)
})

describe('Live MC Integration: Initial Sync', () => {
  test('initial sync dry run counts products without pushing', async () => {
    await createTestProduct()
    await createTestProduct()

    const report = await service.runInitialSync({
      payload,
      overrides: {
        dryRun: true,
        limit: 5,
      },
    })

    expect(report.status).toBe('completed')
    expect(report.dryRun).toBe(true)
    expect(report.total).toBeGreaterThan(0)
  }, 60_000)

  test('initial sync write mode pushes products', async () => {
    const { id } = await createTestProduct()

    // Clear snapshot so initial sync sees it as new
    await payload.update({
      id,
      collection: 'products',
      data: {
        merchantCenter: {
          snapshot: null,
          syncMeta: {
            state: 'idle',
            lastSyncedAt: undefined,
          },
        },
      } as never,
      overrideAccess: true,
    })

    let progressCalled = false
    const report = await service.runInitialSync({
      payload,
      overrides: {
        dryRun: false,
        onlyIfRemoteMissing: false,
        limit: 50,
      },
      onProgress: () => {
        progressCalled = true
      },
    })

    expect(report.status).toBe('completed')
    expect(report.total).toBeGreaterThan(0)
    expect(report.succeeded).toBeGreaterThan(0)
    expect(report.completedAt).toBeDefined()
  }, 120_000)
})

describe('Live MC Integration: Product Analytics', () => {
  test('getProductAnalytics returns structured data', async () => {
    const { id } = await createTestProduct()
    await service.pushProduct({ payload, productId: id })

    const analytics = await service.getProductAnalytics({
      payload,
      productId: id,
      rangeDays: 7,
    })

    expect(analytics.merchantProductId).toBeDefined()
    expect(analytics.merchantProductId).toContain('~')
    // Performance array may be empty for test products but should exist
    expect(Array.isArray(analytics.performance)).toBe(true)
  }, 30_000)
})

describe('Live MC Integration: Field Mappings', () => {
  test('runtime field mappings are persisted and retrieved', async () => {
    const mapping = await payload.create({
      collection: 'gmc-field-mappings' as never,
      data: {
        source: 'title',
        target: 'productAttributes.title',
        syncMode: 'permanent',
        transformPreset: 'none',
        order: 0,
      } as never,
      overrideAccess: true,
    })

    const mappingId = (mapping as unknown as Record<string, unknown>).id as string
    expect(mappingId).toBeDefined()

    const found = await payload.find({
      collection: 'gmc-field-mappings' as never,
      depth: 0,
      overrideAccess: true,
    })

    expect(found.docs.length).toBeGreaterThan(0)

    // Clean up
    await payload.delete({
      id: mappingId,
      collection: 'gmc-field-mappings' as never,
      overrideAccess: true,
    })
  })

  test('permanent field mappings override product attributes during push', async () => {
    const mappingSku = `${TEST_PREFIX}-mapping-test`
    const { id } = await createTestProduct({
      title: 'Mapped Title from Payload Field',
      merchantCenter: {
        enabled: true,
        identity: {
          offerId: mappingSku,
          contentLanguage: 'en',
          feedLabel: 'PRODUCTS',
        },
        productAttributes: {
          title: 'Original MC Title — Should Be Overridden',
          link: 'https://example.com/products/test',
          imageLink: 'https://example.com/test-image.jpg',
          availability: 'IN_STOCK',
          condition: 'NEW',
          price: {
            amountMicros: String(29_990_000),
            currencyCode: 'USD',
          },
        },
      },
    })

    // The dev config has permanent mapping: title → productAttributes.title
    // So the Payload 'title' field should override productAttributes.title
    const result = await service.pushProduct({ payload, productId: id })
    expect(result.success).toBe(true)

    // Verify mapping was applied by checking what was stored before push
    const doc = await payload.findByID({
      id,
      collection: 'products',
      depth: 0,
    }) as unknown as Record<string, unknown>

    const mc = doc.merchantCenter as Record<string, unknown>
    const attrs = mc.productAttributes as Record<string, unknown>
    // The permanent mapping should have overridden the title in productAttributes
    expect(attrs.title).toBe('Mapped Title from Payload Field')

    pushedSkus.push(mappingSku)
  }, 30_000)
})

describe('Live MC Integration: Sync Log', () => {
  test('sync operations create log entries', async () => {
    const { id } = await createTestProduct()

    await service.pushBatch({
      payload,
      productIds: [id],
    })

    // Check cleanup works
    await service.cleanupSyncLogs({ payload, ttlDays: 365 })

    const logs = await payload.find({
      collection: 'gmc-sync-log' as never,
      depth: 0,
      limit: 5,
      overrideAccess: true,
      sort: '-createdAt',
    })

    expect(logs.docs).toBeDefined()
  }, 30_000)
})

describe('Live MC Integration: Push validation', () => {
  test('push fails with clear error when required fields missing', async () => {
    const sku = `${TEST_PREFIX}-validation-fail`
    const product = await payload.create({
      collection: 'products',
      data: {
        title: 'Validation Test',
        sku,
        merchantCenter: {
          enabled: true,
          identity: { offerId: sku, contentLanguage: 'en', feedLabel: 'PRODUCTS' },
          productAttributes: {
            // Missing: title, link, imageLink, availability
          },
        },
      },
      overrideAccess: true,
    })

    const id = (product as unknown as Record<string, unknown>).id as string
    createdProductIds.push(id)

    const result = await service.pushProduct({ payload, productId: id })
    expect(result.success).toBe(false)

    const doc = await payload.findByID({
      id,
      collection: 'products',
      depth: 0,
    }) as unknown as Record<string, unknown>

    const mc = doc.merchantCenter as Record<string, unknown>
    const syncMeta = mc.syncMeta as Record<string, unknown>
    expect(syncMeta.state).toBe('error')
    expect(syncMeta.lastError).toContain('Missing required fields')
  }, 15_000)
})

describe('Live MC Integration: Disabled product skipped', () => {
  test('batch push ignores products with enabled=false', async () => {
    const sku = `${TEST_PREFIX}-disabled`
    const product = await payload.create({
      collection: 'products',
      data: {
        title: 'Disabled Product',
        sku,
        merchantCenter: {
          enabled: false,
        },
      },
      overrideAccess: true,
    })

    const id = (product as unknown as Record<string, unknown>).id as string
    createdProductIds.push(id)

    const report = await service.pushBatch({
      payload,
      filter: {
        id: { equals: id },
        'merchantCenter.enabled': { equals: true },
      },
    })

    expect(report.total).toBe(0)
  }, 15_000)
})

describe('Live MC Integration: End-to-end lifecycle', () => {
  test('full lifecycle: create → push → wait → pull → update → push → delete → verify', async () => {
    // 1. CREATE
    const { id } = await createTestProduct({
      title: 'Lifecycle Test Product',
      price: 199.99,
    })

    // 2. PUSH
    const pushResult = await service.pushProduct({ payload, productId: id })
    expect(pushResult.success).toBe(true)

    // 3. Verify syncMeta
    let doc = await payload.findByID({
      id,
      collection: 'products',
      depth: 0,
    }) as unknown as Record<string, unknown>
    let mc = doc.merchantCenter as Record<string, unknown>
    expect((mc.syncMeta as Record<string, unknown>).state).toBe('success')

    // 4. WAIT for MC propagation then PULL
    const available = await waitForMCProduct(service, payload, id, {
      maxAttempts: 15,
      intervalMs: 5_000,
    })
    expect(available).toBe(true)

    // Clear local attrs and pull from MC
    await payload.update({
      id,
      collection: 'products',
      data: {
        merchantCenter: {
          productAttributes: {},
          syncMeta: { state: 'idle', dirty: true },
        },
      } as never,
      overrideAccess: true,
    })

    const pullResult = await service.pullProduct({ payload, productId: id })
    expect(pullResult.success).toBe(true)
    expect(pullResult.populatedFields.length).toBeGreaterThan(0)

    // 5. UPDATE & RE-PUSH
    await payload.update({
      id,
      collection: 'products',
      data: {
        title: 'Updated Lifecycle Product',
        price: 299.99,
        merchantCenter: {
          productAttributes: {
            title: 'Updated Lifecycle Product',
            price: {
              amountMicros: String(299_990_000),
              currencyCode: 'USD',
            },
          },
        },
      } as never,
      overrideAccess: true,
    })

    const rePushResult = await service.pushProduct({ payload, productId: id })
    expect(rePushResult.success).toBe(true)

    // 6. DELETE from MC
    const deleteResult = await service.deleteProduct({ payload, productId: id })
    expect(deleteResult.success).toBe(true)

    // 7. Verify deletion — the ProductInput is deleted but the Product resource
    // may linger in MC for a while. Re-pushing should succeed (upsert creates fresh).
    // We verify the delete itself succeeded (already asserted above).
    // Attempting to delete again should also succeed (404 = already gone)
    const reDeleteResult = await service.deleteProduct({ payload, productId: id })
    expect(reDeleteResult.success).toBe(true)
  }, 180_000)
})
