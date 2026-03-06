'use client'

import { useConfig, useDocumentInfo } from '@payloadcms/ui'
import React, { useCallback, useEffect, useState } from 'react'

type SyncState = 'error' | 'idle' | 'success' | 'syncing'

type SyncMeta = {
  lastAction?: string
  lastError?: string
  lastSyncedAt?: string
  state: SyncState
  syncSource?: string
}

type MCAnalytics = {
  merchantProductId?: string
  performance?: unknown[]
  status?: Record<string, unknown>
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) {return `${seconds}s ago`}
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {return `${minutes}m ago`}
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {return `${hours}h ago`}
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const styles = {
  badge: (state: SyncState): React.CSSProperties => ({
    backgroundColor:
      state === 'success' ? '#22c55e'
        : state === 'error' ? '#ef4444'
          : state === 'syncing' ? '#f59e0b'
            : '#94a3b8',
    borderRadius: '4px',
    color: '#fff',
    display: 'inline-block',
    fontSize: '12px',
    fontWeight: 600,
    padding: '2px 8px',
    textTransform: 'uppercase' as const,
  }),
  button: (variant: 'danger' | 'primary' | 'secondary'): React.CSSProperties => ({
    backgroundColor:
      variant === 'primary' ? '#2563eb'
        : variant === 'danger' ? '#dc2626'
          : '#6b7280',
    border: 'none',
    borderRadius: '4px',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
    padding: '6px 14px',
  }),
  buttonRow: {
    display: 'flex',
    gap: '8px',
  } as React.CSSProperties,
  container: {
    borderBottom: '1px solid var(--theme-elevation-200)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
    marginBottom: '24px',
    paddingBottom: '16px',
  } as React.CSSProperties,
  error: {
    backgroundColor: '#fef2f2',
    borderRadius: '4px',
    color: '#991b1b',
    fontSize: '13px',
    padding: '8px 12px',
  } as React.CSSProperties,
  header: {
    alignItems: 'center',
    display: 'flex',
    gap: '12px',
    justifyContent: 'space-between',
  } as React.CSSProperties,
  label: {
    color: 'var(--theme-elevation-500)',
    fontSize: '12px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
  } as React.CSSProperties,
  lastSync: {
    color: 'var(--theme-elevation-500)',
    fontSize: '12px',
  } as React.CSSProperties,
  section: {
    borderTop: '1px solid var(--theme-elevation-150)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    paddingTop: '10px',
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    margin: 0,
  } as React.CSSProperties,
  statusRow: {
    alignItems: 'center',
    display: 'flex',
    gap: '8px',
  } as React.CSSProperties,
  title: {
    fontSize: '16px',
    fontWeight: 600,
    margin: 0,
  } as React.CSSProperties,
  value: {
    fontSize: '13px',
  } as React.CSSProperties,
}

export const MerchantCenterSyncControls: React.FC = () => {
  const { id, collectionSlug, initialData } = useDocumentInfo()
  const { config } = useConfig()
  const [loading, setLoading] = useState<null | string>(null)
  const [lastResult, setLastResult] = useState<{ error?: string; success: boolean } | null>(null)
  const [analytics, setAnalytics] = useState<MCAnalytics | null>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsError, setAnalyticsError] = useState<null | string>(null)
  const [showSnapshot, setShowSnapshot] = useState(false)

  const routes = config.routes as { api?: string } | undefined
  const apiRoute = routes?.api ?? '/api'

  const initialMcData = (initialData as Record<string, unknown> | undefined)?.merchantCenter as
    | Record<string, unknown>
    | undefined
  const [mcData, setMcData] = useState<Record<string, unknown> | undefined>(initialMcData)
  const syncMeta = mcData?.syncMeta as SyncMeta | undefined
  const snapshot = mcData?.snapshot as Record<string, unknown> | undefined

  // Keep mcData in sync when initialData changes (e.g. navigation)
  useEffect(() => {
    setMcData(initialMcData)
  }, [initialData]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch analytics on mount
  useEffect(() => {
    if (!id) {return}
    let cancelled = false

    const fetchAnalytics = async () => {
      setAnalyticsLoading(true)
      setAnalyticsError(null)
      try {
        const response = await fetch(`${apiRoute}/gmc/product/analytics`, {
          body: JSON.stringify({ productId: id, rangeDays: 7 }),
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()
        if (!cancelled) {
          setAnalytics(data)
        }
      } catch (err) {
        if (!cancelled) {
          setAnalyticsError(err instanceof Error ? err.message : 'Failed to load analytics')
        }
      } finally {
        if (!cancelled) {
          setAnalyticsLoading(false)
        }
      }
    }

    void fetchAnalytics()
    return () => { cancelled = true }
  }, [id, apiRoute])

  const executeAction = useCallback(
    async (action: string) => {
      if (!id || loading) {return}
      setLoading(action)
      setLastResult(null)

      try {
        const response = await fetch(`${apiRoute}/gmc/product/${action}`, {
          body: JSON.stringify({ productId: id }),
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        })

        const data = await response.json()
        const success = data.success !== false && !data.error
        setLastResult({
          error: data.error ?? (data.success === false ? 'Operation failed' : undefined),
          success,
        })

        // Refresh MC data from the document after successful sync actions
        if (success && collectionSlug) {
          try {
            const docResponse = await fetch(
              `${apiRoute}/${collectionSlug}/${id}?depth=0`,
              { credentials: 'include' },
            )
            if (docResponse.ok) {
              const doc = await docResponse.json()
              setMcData(doc.merchantCenter ?? undefined)
            }
          } catch {
            // Best-effort refresh
          }
        }
      } catch (err) {
        setLastResult({
          error: err instanceof Error ? err.message : 'Request failed',
          success: false,
        })
      } finally {
        setLoading(null)
      }
    },
    [id, apiRoute, collectionSlug, loading],
  )

  if (!id) {
    return (
      <div style={styles.container}>
        <p style={{ color: 'var(--theme-elevation-500)', fontSize: '13px' }}>
          Save the document first to enable Merchant Center sync controls.
        </p>
      </div>
    )
  }

  // Parse status entries from analytics
  const statusEntries: Array<{ context: string; status: string }> = []
  if (analytics?.status) {
    for (const [context, value] of Object.entries(analytics.status)) {
      statusEntries.push({
        context,
        status: typeof value === 'string' ? value : JSON.stringify(value),
      })
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h4 style={styles.title}>Merchant Center Sync</h4>
        {lastResult && (
          <span style={styles.badge(lastResult.success ? 'success' : 'error')}>
            {lastResult.success ? 'Success' : 'Error'}
          </span>
        )}
      </div>

      <div style={styles.buttonRow}>
        <button
          disabled={!!loading}
          onClick={() => executeAction('push')}
          style={styles.button('primary')}
          type="button"
        >
          {loading === 'push' ? 'Pushing...' : 'Push to MC'}
        </button>
        <button
          disabled={!!loading}
          onClick={() => executeAction('pull')}
          style={styles.button('secondary')}
          type="button"
        >
          {loading === 'pull' ? 'Pulling...' : 'Pull from MC'}
        </button>
        <button
          disabled={!!loading}
          onClick={() => executeAction('refresh')}
          style={styles.button('secondary')}
          type="button"
        >
          {loading === 'refresh' ? 'Refreshing...' : 'Refresh Snapshot'}
        </button>
        <button
          disabled={!!loading}
          onClick={() => executeAction('delete')}
          style={styles.button('danger')}
          type="button"
        >
          {loading === 'delete' ? 'Deleting...' : 'Delete from MC'}
        </button>
      </div>

      {lastResult?.error && <div style={styles.error}>{lastResult.error}</div>}

      {/* Product Sync Status */}
      {syncMeta && (
        <div style={styles.section}>
          <h5 style={styles.sectionTitle}>Sync Status</h5>
          <div style={styles.statusRow}>
            <span style={styles.badge(syncMeta.state)}>
              {syncMeta.state}
            </span>
            {syncMeta.lastSyncedAt && (
              <span style={styles.lastSync}>
                Last synced: {relativeTime(syncMeta.lastSyncedAt)}
              </span>
            )}
          </div>
          {syncMeta.lastAction && (
            <div style={styles.statusRow}>
              <span style={styles.label}>Last action:</span>
              <span style={styles.value}>{syncMeta.lastAction}</span>
            </div>
          )}
          {syncMeta.syncSource && (
            <div style={styles.statusRow}>
              <span style={styles.label}>Source:</span>
              <span style={styles.value}>{syncMeta.syncSource}</span>
            </div>
          )}
          {syncMeta.lastError && (
            <div style={styles.error}>{syncMeta.lastError}</div>
          )}
        </div>
      )}

      {/* Merchant Center Status */}
      <div style={styles.section}>
        <h5 style={styles.sectionTitle}>Merchant Center Status</h5>
        {analyticsLoading && (
          <span style={styles.lastSync}>Loading MC status...</span>
        )}
        {analyticsError && (
          <span style={{ color: 'var(--theme-elevation-500)', fontSize: '12px' }}>
            Unable to load MC status
          </span>
        )}
        {analytics && (
          <>
            {analytics.merchantProductId && (
              <div style={styles.statusRow}>
                <span style={styles.label}>MC Product ID:</span>
                <span style={{ ...styles.value, fontFamily: 'monospace', fontSize: '12px' }}>
                  {analytics.merchantProductId}
                </span>
              </div>
            )}
            {statusEntries.length > 0 ? (
              statusEntries.map(({ context, status }) => {
                const lower = status.toLowerCase()
                const badgeState: SyncState =
                  lower === 'approved' ? 'success'
                    : lower === 'disapproved' ? 'error'
                      : lower === 'pending' ? 'syncing'
                        : 'idle'
                return (
                  <div key={context} style={styles.statusRow}>
                    <span style={styles.label}>{context}:</span>
                    <span style={styles.badge(badgeState)}>{status}</span>
                  </div>
                )
              })
            ) : (
              !analyticsLoading && !analyticsError && analytics.merchantProductId && (
                <span style={styles.lastSync}>No approval status available</span>
              )
            )}
          </>
        )}
        {!analytics && !analyticsLoading && !analyticsError && (
          <span style={styles.lastSync}>No MC data available</span>
        )}
      </div>

      {/* Snapshot Preview */}
      {snapshot && Object.keys(snapshot).length > 0 && (
        <div style={styles.section}>
          <div style={styles.statusRow}>
            <h5 style={styles.sectionTitle}>Last Snapshot</h5>
            <button
              onClick={() => setShowSnapshot((prev) => !prev)}
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
      )}
    </div>
  )
}
