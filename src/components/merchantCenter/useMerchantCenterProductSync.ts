'use client'

import { useEffect, useMemo, useState } from 'react'

import type { ProductAnalytics } from './types.js'

import { MC_FIELD_GROUP_NAME } from '../../constants.js'
import {
  buildProductStatusEntries,
  executeProductSyncAction,
  fetchMerchantCenterState,
  fetchProductAnalytics,
  type ProductSyncActionResult,
} from './productSyncApi.js'
import { asClientRecord } from './recordUtils.js'

type UseMerchantCenterProductSyncArgs = {
  apiRoute: string
  collectionSlug?: string
  gmcBasePath: string
  initialData?: Record<string, unknown>
  productId?: number | string
}

export const useMerchantCenterProductSync = (
  args: UseMerchantCenterProductSyncArgs,
) => {
  const { apiRoute, collectionSlug, gmcBasePath, initialData, productId } = args
  const [loading, setLoading] = useState<null | string>(null)
  const [lastResult, setLastResult] = useState<null | ProductSyncActionResult>(null)
  const [analytics, setAnalytics] = useState<null | ProductAnalytics>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsError, setAnalyticsError] = useState<null | string>(null)
  const [mcData, setMcData] = useState<Record<string, unknown> | undefined>(
    asClientRecord(initialData?.[MC_FIELD_GROUP_NAME]),
  )

  useEffect(() => {
    setMcData(asClientRecord(initialData?.[MC_FIELD_GROUP_NAME]))
  }, [initialData])

  useEffect(() => {
    if (!productId) {
      return
    }

    let cancelled = false

    const fetchAnalytics = async () => {
      setAnalyticsLoading(true)
      setAnalyticsError(null)

      try {
        const data = await fetchProductAnalytics({
          apiRoute,
          gmcBasePath,
          productId,
        })
        if (!cancelled) {
          setAnalytics(data)
        }
      } catch (error) {
        if (!cancelled) {
          setAnalyticsError(error instanceof Error ? error.message : 'Failed to load analytics')
        }
      } finally {
        if (!cancelled) {
          setAnalyticsLoading(false)
        }
      }
    }

    void fetchAnalytics()

    return () => {
      cancelled = true
    }
  }, [apiRoute, gmcBasePath, productId])

  const statusEntries = useMemo(() => {
    return buildProductStatusEntries(analytics?.status)
  }, [analytics])

  const executeAction = async (action: string): Promise<void> => {
    if (!productId || loading) {
      return
    }

    setLoading(action)
    setLastResult(null)

    try {
      const actionResult = await executeProductSyncAction({
        action,
        apiRoute,
        gmcBasePath,
        productId,
      })
      setLastResult(actionResult)

      if (actionResult.success && collectionSlug) {
        try {
          setMcData(await fetchMerchantCenterState({
            apiRoute,
            collectionSlug,
            productId,
          }))
        } catch {
          // Best-effort refresh
        }
      }
    } catch (error) {
      setLastResult({
        error: error instanceof Error ? error.message : 'Request failed',
        success: false,
      })
    } finally {
      setLoading(null)
    }
  }

  return {
    analytics,
    analyticsError,
    analyticsLoading,
    executeAction,
    lastResult,
    loading,
    mcData,
    statusEntries,
  }
}
