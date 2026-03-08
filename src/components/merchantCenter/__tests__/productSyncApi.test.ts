import { describe, expect, test, vi } from 'vitest'

import {
  buildProductStatusEntries,
  executeProductSyncAction,
  fetchMerchantCenterState,
  fetchProductAnalytics,
} from '../productSyncApi.js'

const jsonResponse = (data: unknown, status = 200): Response => new Response(
  JSON.stringify(data),
  {
    headers: { 'Content-Type': 'application/json' },
    status,
  },
)

describe('productSyncApi', () => {
  test('buildProductStatusEntries stringifies non-string status values', () => {
    expect(buildProductStatusEntries({
      destination: 'approved',
      issueSummary: { count: 0 },
    })).toEqual([
      { context: 'destination', status: 'approved' },
      { context: 'issueSummary', status: '{"count":0}' },
    ])
  })

  test('fetchProductAnalytics posts to the analytics endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      merchantProductId: 'en~US~SKU-1',
      performance: [],
      status: {},
    }))

    const result = await fetchProductAnalytics({
      apiRoute: '/api',
      fetchImpl,
      gmcBasePath: '/gmc',
      productId: 'prod-1',
    })

    expect(fetchImpl).toHaveBeenCalledWith('/api/gmc/product/analytics', {
      body: JSON.stringify({ productId: 'prod-1', rangeDays: 7 }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    expect(result).toEqual({
      merchantProductId: 'en~US~SKU-1',
      performance: [],
      status: {},
    })
  })

  test('executeProductSyncAction normalizes failed responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: false }))

    await expect(executeProductSyncAction({
      action: 'push',
      apiRoute: '/api',
      fetchImpl,
      gmcBasePath: '/gmc',
      productId: 'prod-2',
    })).resolves.toEqual({
      error: 'Operation failed',
      success: false,
    })
  })

  test('fetchMerchantCenterState returns refreshed Merchant Center data when available', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      merchantCenter: {
        snapshot: { name: 'snapshot-1' },
        syncMeta: { state: 'success' },
      },
    }))

    await expect(fetchMerchantCenterState({
      apiRoute: '/api',
      collectionSlug: 'products',
      fetchImpl,
      productId: 'prod-3',
    })).resolves.toEqual({
      snapshot: { name: 'snapshot-1' },
      syncMeta: { state: 'success' },
    })
  })

  test('fetchMerchantCenterState returns undefined for non-OK document fetches', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'not found' }, 404))

    await expect(fetchMerchantCenterState({
      apiRoute: '/api',
      collectionSlug: 'products',
      fetchImpl,
      productId: 'prod-4',
    })).resolves.toBeUndefined()
  })
})
