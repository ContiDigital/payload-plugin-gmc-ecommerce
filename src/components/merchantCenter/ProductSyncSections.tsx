'use client'

import React from 'react'

import type { ProductAnalytics, ProductSyncMeta, ProductSyncState } from './types.js'

import {
  productSyncBadgeStyle,
  productSyncStyles,
  syncControlButtonStyle,
} from './styles.js'
import { relativeTime } from './utils.js'

export const ProductActionButtons = (props: {
  loading: null | string
  onAction: (action: string) => void
}): React.JSX.Element => {
  const { loading, onAction } = props

  return (
    <div style={productSyncStyles.buttonRow}>
      <button
        disabled={Boolean(loading)}
        onClick={() => onAction('push')}
        style={syncControlButtonStyle('primary')}
        type="button"
      >
        {loading === 'push' ? 'Pushing...' : 'Push to MC'}
      </button>
      <button
        disabled={Boolean(loading)}
        onClick={() => onAction('pull')}
        style={syncControlButtonStyle('secondary')}
        type="button"
      >
        {loading === 'pull' ? 'Pulling...' : 'Pull from MC'}
      </button>
      <button
        disabled={Boolean(loading)}
        onClick={() => onAction('refresh')}
        style={syncControlButtonStyle('secondary')}
        type="button"
      >
        {loading === 'refresh' ? 'Refreshing...' : 'Refresh Snapshot'}
      </button>
      <button
        disabled={Boolean(loading)}
        onClick={() => onAction('delete')}
        style={syncControlButtonStyle('danger')}
        type="button"
      >
        {loading === 'delete' ? 'Deleting...' : 'Delete from MC'}
      </button>
    </div>
  )
}

export const ProductSyncStatusSection = (props: {
  syncMeta?: ProductSyncMeta
}): null | React.JSX.Element => {
  const { syncMeta } = props

  if (!syncMeta) {
    return null
  }

  return (
    <div style={productSyncStyles.section}>
      <h5 style={productSyncStyles.sectionTitle}>Sync Status</h5>
      <div style={productSyncStyles.statusRow}>
        <span style={productSyncBadgeStyle(syncMeta.state)}>
          {syncMeta.state}
        </span>
        {syncMeta.lastSyncedAt && (
          <span style={productSyncStyles.lastSync}>
            Last synced: {relativeTime(syncMeta.lastSyncedAt)}
          </span>
        )}
      </div>
      {syncMeta.lastAction && (
        <div style={productSyncStyles.statusRow}>
          <span style={productSyncStyles.label}>Last action:</span>
          <span style={productSyncStyles.value}>{syncMeta.lastAction}</span>
        </div>
      )}
      {syncMeta.syncSource && (
        <div style={productSyncStyles.statusRow}>
          <span style={productSyncStyles.label}>Source:</span>
          <span style={productSyncStyles.value}>{syncMeta.syncSource}</span>
        </div>
      )}
      {syncMeta.lastError && (
        <div style={productSyncStyles.error}>{syncMeta.lastError}</div>
      )}
    </div>
  )
}

const toBadgeState = (status: string): ProductSyncState => {
  const lower = status.toLowerCase()

  if (lower === 'approved') {
    return 'success'
  }

  if (lower === 'disapproved') {
    return 'error'
  }

  if (lower === 'pending') {
    return 'syncing'
  }

  return 'idle'
}

export const ProductMerchantStatusSection = (props: {
  analytics: null | ProductAnalytics
  analyticsError: null | string
  analyticsLoading: boolean
  statusEntries: Array<{ context: string; status: string }>
}): React.JSX.Element => {
  const { analytics, analyticsError, analyticsLoading, statusEntries } = props

  return (
    <div style={productSyncStyles.section}>
      <h5 style={productSyncStyles.sectionTitle}>Merchant Center Status</h5>
      {analyticsLoading && (
        <span style={productSyncStyles.lastSync}>Loading MC status...</span>
      )}
      {analyticsError && (
        <span style={{ color: 'var(--theme-elevation-500)', fontSize: '12px' }}>
          Unable to load MC status
        </span>
      )}
      {analytics && (
        <>
          {analytics.merchantProductId && (
            <div style={productSyncStyles.statusRow}>
              <span style={productSyncStyles.label}>MC Product ID:</span>
              <span style={{ ...productSyncStyles.value, fontFamily: 'monospace', fontSize: '12px' }}>
                {analytics.merchantProductId}
              </span>
            </div>
          )}
          {statusEntries.length > 0 ? (
            statusEntries.map(({ context, status }) => (
              <div key={context} style={productSyncStyles.statusRow}>
                <span style={productSyncStyles.label}>{context}:</span>
                <span style={productSyncBadgeStyle(toBadgeState(status))}>{status}</span>
              </div>
            ))
          ) : (
            !analyticsLoading && !analyticsError && analytics.merchantProductId && (
              <span style={productSyncStyles.lastSync}>No approval status available</span>
            )
          )}
        </>
      )}
      {!analytics && !analyticsLoading && !analyticsError && (
        <span style={productSyncStyles.lastSync}>No MC data available</span>
      )}
    </div>
  )
}

export const ProductSnapshotSection = (props: {
  onToggle: () => void
  showSnapshot: boolean
  snapshot?: Record<string, unknown>
}): null | React.JSX.Element => {
  const { onToggle, showSnapshot, snapshot } = props

  if (!snapshot || Object.keys(snapshot).length === 0) {
    return null
  }

  return (
    <div style={productSyncStyles.section}>
      <div style={productSyncStyles.statusRow}>
        <h5 style={productSyncStyles.sectionTitle}>Last Snapshot</h5>
        <button
          onClick={onToggle}
          style={{
            background: 'none',
            border: '1px solid var(--theme-elevation-250)',
            borderRadius: '4px',
            color: 'var(--theme-elevation-600)',
            cursor: 'pointer',
            fontSize: '12px',
            padding: '2px 8px',
          }}
          type="button"
        >
          {showSnapshot ? 'Hide Snapshot' : 'Show Snapshot'}
        </button>
      </div>
      {showSnapshot && (
        <pre
          style={{
            background: 'var(--theme-elevation-50)',
            border: '1px solid var(--theme-elevation-150)',
            borderRadius: '4px',
            fontSize: '12px',
            maxHeight: '300px',
            overflow: 'auto',
            padding: '10px',
          }}
        >
          <code>{JSON.stringify(snapshot, null, 2)}</code>
        </pre>
      )}
    </div>
  )
}
