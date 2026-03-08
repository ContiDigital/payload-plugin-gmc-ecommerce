'use client'

import { useConfig, useDocumentInfo } from '@payloadcms/ui'
import React, { useState } from 'react'

import type { ProductSyncMeta } from './merchantCenter/types.js'

import { resolveMerchantCenterApiConfig } from './merchantCenter/apiConfig.js'
import {
  ProductActionButtons,
  ProductMerchantStatusSection,
  ProductSnapshotSection,
  ProductSyncStatusSection,
} from './merchantCenter/ProductSyncSections.js'
import { asClientRecord } from './merchantCenter/recordUtils.js'
import { productSyncBadgeStyle, productSyncStyles } from './merchantCenter/styles.js'
import { useMerchantCenterProductSync } from './merchantCenter/useMerchantCenterProductSync.js'

export const MerchantCenterSyncControls: React.FC = () => {
  const { id, collectionSlug, initialData } = useDocumentInfo()
  const { config } = useConfig()
  const { apiRoute, gmcBasePath } = resolveMerchantCenterApiConfig(config)
  const [showSnapshot, setShowSnapshot] = useState(false)

  const {
    analytics,
    analyticsError,
    analyticsLoading,
    executeAction,
    lastResult,
    loading,
    mcData,
    statusEntries,
  } = useMerchantCenterProductSync({
    apiRoute,
    collectionSlug,
    gmcBasePath,
    initialData: asClientRecord(initialData),
    productId: id,
  })

  const syncMeta = asClientRecord(mcData?.syncMeta) as ProductSyncMeta | undefined
  const snapshot = asClientRecord(mcData?.snapshot)

  if (!id) {
    return (
      <div style={productSyncStyles.container}>
        <p style={{ color: 'var(--theme-elevation-500)', fontSize: '13px' }}>
          Save the document first to enable Merchant Center sync controls.
        </p>
      </div>
    )
  }

  return (
    <div style={productSyncStyles.container}>
      <div style={productSyncStyles.header}>
        <h4 style={productSyncStyles.title}>Merchant Center Sync</h4>
        {lastResult && (
          <span style={productSyncBadgeStyle(lastResult.success ? 'success' : 'error')}>
            {lastResult.success ? 'Success' : 'Error'}
          </span>
        )}
      </div>

      <ProductActionButtons loading={loading} onAction={(action) => { void executeAction(action) }} />

      {lastResult?.error && <div style={productSyncStyles.error}>{lastResult.error}</div>}
      {lastResult?.warning && <div style={productSyncStyles.warning}>{lastResult.warning}</div>}
      <div style={productSyncStyles.note}>
        Push writes the Merchant Center product input immediately. Refresh Snapshot and Pull from MC
        read Google&apos;s processed product, which can lag a fresh push by a few minutes. The
        status panel can update sooner because it comes from Google&apos;s reporting view.
      </div>

      <ProductSyncStatusSection syncMeta={syncMeta} />
      <ProductMerchantStatusSection
        analytics={analytics}
        analyticsError={analyticsError}
        analyticsLoading={analyticsLoading}
        statusEntries={statusEntries}
      />
      <ProductSnapshotSection
        onToggle={() => setShowSnapshot((prev) => !prev)}
        showSnapshot={showSnapshot}
        snapshot={snapshot}
      />
    </div>
  )
}
