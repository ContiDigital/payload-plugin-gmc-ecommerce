import type { ProductAnalytics } from './types.js'

import { MC_FIELD_GROUP_NAME } from '../../constants.js'

export type ProductStatusEntry = {
  context: string
  status: string
}

export type ProductSyncActionResult = {
  error?: string
  success: boolean
}

type FetchLike = typeof fetch

export const buildProductStatusEntries = (
  status: ProductAnalytics['status'] | undefined,
): ProductStatusEntry[] => {
  if (!status) {
    return []
  }

  return Object.entries(status).map(([context, value]) => ({
    context,
    status: typeof value === 'string' ? value : JSON.stringify(value),
  }))
}

export const fetchProductAnalytics = async (args: {
  apiRoute: string
  fetchImpl?: FetchLike
  gmcBasePath: string
  productId: number | string
  rangeDays?: number
}): Promise<ProductAnalytics> => {
  const {
    apiRoute,
    fetchImpl = fetch,
    gmcBasePath,
    productId,
    rangeDays = 7,
  } = args

  const response = await fetchImpl(`${apiRoute}${gmcBasePath}/product/analytics`, {
    body: JSON.stringify({ productId, rangeDays }),
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return response.json()
}

export const executeProductSyncAction = async (args: {
  action: string
  apiRoute: string
  fetchImpl?: FetchLike
  gmcBasePath: string
  productId: number | string
}): Promise<ProductSyncActionResult> => {
  const {
    action,
    apiRoute,
    fetchImpl = fetch,
    gmcBasePath,
    productId,
  } = args

  const response = await fetchImpl(`${apiRoute}${gmcBasePath}/product/${action}`, {
    body: JSON.stringify({ productId }),
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    return { error: `HTTP ${response.status}`, success: false }
  }

  const data = await response.json()
  const success = data.success !== false && !data.error

  return {
    error: data.error ?? (data.success === false ? 'Operation failed' : undefined),
    success,
  }
}

export const fetchMerchantCenterState = async (args: {
  apiRoute: string
  collectionSlug: string
  fetchImpl?: FetchLike
  productId: number | string
}): Promise<Record<string, unknown> | undefined> => {
  const {
    apiRoute,
    collectionSlug,
    fetchImpl = fetch,
    productId,
  } = args

  const response = await fetchImpl(
    `${apiRoute}/${collectionSlug}/${productId}?depth=0`,
    { credentials: 'include' },
  )

  if (!response.ok) {
    return undefined
  }

  const doc = await response.json()
  return doc[MC_FIELD_GROUP_NAME] ?? undefined
}
