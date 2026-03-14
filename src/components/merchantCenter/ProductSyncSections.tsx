'use client'

import React from 'react'

import type { PerformanceRow, ProductAnalytics, ProductSyncMeta, ProductSyncState } from './types.js'

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

const performanceTableStyles = {
  cell: {
    borderBottom: '1px solid var(--theme-elevation-100)',
    fontSize: '12px',
    padding: '4px 10px',
    textAlign: 'right' as const,
  },
  dateCell: {
    borderBottom: '1px solid var(--theme-elevation-100)',
    fontSize: '12px',
    padding: '4px 10px',
    textAlign: 'left' as const,
  },
  header: {
    borderBottom: '2px solid var(--theme-elevation-200)',
    fontSize: '11px',
    fontWeight: 600,
    padding: '4px 10px',
    textAlign: 'right' as const,
    textTransform: 'uppercase' as const,
  },
  headerDate: {
    borderBottom: '2px solid var(--theme-elevation-200)',
    fontSize: '11px',
    fontWeight: 600,
    padding: '4px 10px',
    textAlign: 'left' as const,
    textTransform: 'uppercase' as const,
  },
  table: {
    borderCollapse: 'collapse' as const,
    fontSize: '12px',
    width: '100%',
  },
  totalsCell: {
    borderTop: '2px solid var(--theme-elevation-200)',
    fontSize: '12px',
    fontWeight: 600,
    padding: '4px 10px',
    textAlign: 'right' as const,
  },
  totalsDateCell: {
    borderTop: '2px solid var(--theme-elevation-200)',
    fontSize: '12px',
    fontWeight: 600,
    padding: '4px 10px',
    textAlign: 'left' as const,
  },
}

const formatCtr = (rate: number): string => `${(rate * 100).toFixed(1)}%`

const PerformanceTable = (props: {
  rows: PerformanceRow[]
}): React.JSX.Element => {
  const { rows } = props
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date))

  const totals = sorted.reduce(
    (acc, row) => ({
      clicks: acc.clicks + row.clicks,
      conversions: acc.conversions + row.conversions,
      impressions: acc.impressions + row.impressions,
    }),
    { clicks: 0, conversions: 0, impressions: 0 },
  )
  const totalCtr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0

  return (
    <table style={performanceTableStyles.table}>
      <thead>
        <tr>
          <th style={performanceTableStyles.headerDate}>Date</th>
          <th style={performanceTableStyles.header}>Impressions</th>
          <th style={performanceTableStyles.header}>Clicks</th>
          <th style={performanceTableStyles.header}>CTR</th>
          <th style={performanceTableStyles.header}>Conversions</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={row.date}>
            <td style={performanceTableStyles.dateCell}>{row.date}</td>
            <td style={performanceTableStyles.cell}>{row.impressions.toLocaleString()}</td>
            <td style={performanceTableStyles.cell}>{row.clicks.toLocaleString()}</td>
            <td style={performanceTableStyles.cell}>{formatCtr(row.clickThroughRate)}</td>
            <td style={performanceTableStyles.cell}>{row.conversions.toLocaleString()}</td>
          </tr>
        ))}
        {sorted.length > 1 && (
          <tr>
            <td style={performanceTableStyles.totalsDateCell}>Total</td>
            <td style={performanceTableStyles.totalsCell}>{totals.impressions.toLocaleString()}</td>
            <td style={performanceTableStyles.totalsCell}>{totals.clicks.toLocaleString()}</td>
            <td style={performanceTableStyles.totalsCell}>{formatCtr(totalCtr)}</td>
            <td style={performanceTableStyles.totalsCell}>{totals.conversions.toLocaleString()}</td>
          </tr>
        )}
      </tbody>
    </table>
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
      <span style={productSyncStyles.lastSync}>
        Status data comes from Google&apos;s reporting view and may update before the full processed
        product snapshot below.
      </span>
      {analyticsLoading && (
        <span style={productSyncStyles.lastSync}>Loading MC status...</span>
      )}
      {analyticsError && (
        <div style={productSyncStyles.error}>
          Unable to load MC status: {analyticsError}
        </div>
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
          <div style={{ marginTop: '8px' }}>
            <h5 style={productSyncStyles.sectionTitle}>Performance (last 7 days)</h5>
            {analytics.performance && analytics.performance.length > 0 ? (
              <PerformanceTable rows={analytics.performance} />
            ) : (
              <span style={productSyncStyles.lastSync}>
                No performance data yet — metrics appear once the product receives impressions in Google
                Shopping.
              </span>
            )}
          </div>
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
        <h5 style={productSyncStyles.sectionTitle}>Processed Product Snapshot</h5>
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
      <span style={productSyncStyles.lastSync}>
        This snapshot comes from Google&apos;s Products API and can lag a successful push by a few
        minutes while Merchant Center reprocesses the product.
      </span>
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
