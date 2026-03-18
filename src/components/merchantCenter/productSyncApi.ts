import type { ProductAnalytics } from './types.js'

export type ProductStatusEntry = {
  context: string
  status: string
}

export type ProductSyncActionResult = {
  error?: string
  success: boolean
  warning?: string
}

type FetchLike = typeof fetch

export const buildProductStatusEntries = (
  status: ProductAnalytics['status'] | undefined,
): ProductStatusEntry[] => {
  if (!status) {
    return []
  }

  // MC product_view returns statusPerReportingContext as an array of
  // { reportingContext, approvedCountries?, disapprovedCountries? }
  const perContext = status.statusPerReportingContext
  if (Array.isArray(perContext)) {
    return perContext.map((entry: Record<string, unknown>) => {
      const rawContext = entry.reportingContext
      const context = typeof rawContext === 'string' ? rawContext : 'UNKNOWN'
      const approved = Array.isArray(entry.approvedCountries) ? entry.approvedCountries : []
      const disapproved = Array.isArray(entry.disapprovedCountries) ? entry.disapprovedCountries : []
      let entryStatus: string
      if (disapproved.length > 0) {
        entryStatus = `DISAPPROVED (${disapproved.join(', ')})`
      } else if (approved.length > 0) {
        entryStatus = `APPROVED (${approved.join(', ')})`
      } else {
        entryStatus = 'PENDING'
      }
      return { context, status: entryStatus }
    })
  }

  // Fallback: if aggregatedReportingContextStatus is present, show it as a single entry
  if (typeof status.aggregatedReportingContextStatus === 'string') {
    return [{ context: 'Overall', status: status.aggregatedReportingContextStatus }]
  }

  // Legacy fallback: treat as flat key-value pairs
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
    const errorText = await response.text()
    try {
      const parsed = JSON.parse(errorText) as { error?: string }
      throw new Error(parsed.error || `HTTP ${response.status}`)
    } catch {
      throw new Error(errorText || `HTTP ${response.status}`)
    }
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
    const errorText = await response.text()
    try {
      const parsed = JSON.parse(errorText) as { error?: string }
      return { error: parsed.error || `HTTP ${response.status}`, success: false }
    } catch {
      return { error: errorText || `HTTP ${response.status}`, success: false }
    }
  }

  const data = await response.json()
  const success = data.success !== false && !data.error

  return {
    error: data.error ?? (data.success === false ? 'Operation failed' : undefined),
    success,
    warning: typeof data.warning === 'string' ? data.warning : undefined,
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

  return response.json()
}
