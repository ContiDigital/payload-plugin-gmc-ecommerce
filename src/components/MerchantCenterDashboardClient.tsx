'use client'

import { useConfig } from '@payloadcms/ui'
import React, { useCallback, useEffect, useRef, useState } from 'react'

type HealthData = {
  admin: { mode: string }
  merchant: { accountId: string; dataSourceId: string }
  rateLimit: { enabled: boolean }
  status: string
  sync: { mode: string }
  timestamp: string
}

type SyncLog = {
  completedAt?: string
  errors?: Array<{ message: string; productId: string }>
  failed: number
  id: string
  jobId: string
  metadata?: {
    dryRun?: boolean
    existingRemote?: number
    matched?: number
    orphaned?: number
    skipped?: number
  }
  processed: number
  startedAt: string
  status: string
  succeeded: number
  total: number
  type: string
}

type MappingEntry = {
  id: string
  order: number
  source: string
  syncMode: string
  target: string
  transformPreset: string
}

const sectionStyle: React.CSSProperties = {
  backgroundColor: 'var(--theme-elevation-50)',
  border: '1px solid var(--theme-elevation-150)',
  borderRadius: '8px',
  marginBottom: '20px',
  padding: '20px',
}

const headingStyle: React.CSSProperties = {
  fontSize: '18px',
  fontWeight: 600,
  marginBottom: '16px',
  marginTop: 0,
}

const tableStyle: React.CSSProperties = {
  borderCollapse: 'collapse' as const,
  fontSize: '13px',
  width: '100%',
}

const thStyle: React.CSSProperties = {
  borderBottom: '2px solid var(--theme-elevation-200)',
  fontWeight: 600,
  padding: '8px 12px',
  textAlign: 'left' as const,
}

const tdStyle: React.CSSProperties = {
  borderBottom: '1px solid var(--theme-elevation-100)',
  padding: '8px 12px',
}

const btnStyle = (variant: 'danger' | 'primary' | 'secondary'): React.CSSProperties => ({
  backgroundColor:
    variant === 'primary' ? '#2563eb'
      : variant === 'danger' ? '#dc2626'
        : '#6b7280',
  border: 'none',
  borderRadius: '4px',
  color: '#fff',
  cursor: 'pointer',
  fontSize: '13px',
  marginRight: '8px',
  padding: '8px 16px',
})

const statusBadge = (status: string): React.CSSProperties => ({
  backgroundColor:
    status === 'completed' ? '#22c55e'
      : status === 'failed' ? '#ef4444'
        : status === 'running' ? '#f59e0b'
          : '#94a3b8',
  borderRadius: '4px',
  color: '#fff',
  display: 'inline-block',
  fontSize: '11px',
  fontWeight: 600,
  padding: '2px 6px',
  textTransform: 'uppercase' as const,
})

const progressBarStyle = (pct: number): React.CSSProperties => ({
  backgroundColor: '#2563eb',
  borderRadius: '4px',
  height: '100%',
  transition: 'width 0.3s ease',
  width: `${pct}%`,
})

// ---------------------------------------------------------------------------
// Field Mappings Editor
// ---------------------------------------------------------------------------

const SYNC_MODE_OPTIONS = ['permanent', 'initialOnly'] as const
const TRANSFORM_OPTIONS = ['none', 'toMicros', 'toMicrosString', 'extractUrl', 'extractAbsoluteUrl', 'toArray', 'toString', 'toBoolean'] as const

type EditableMappingEntry = {
  id?: string
  order: number
  source: string
  syncMode: string
  target: string
  transformPreset: string
}

const emptyMapping = (): EditableMappingEntry => ({
  order: 0,
  source: '',
  syncMode: 'permanent',
  target: '',
  transformPreset: 'none',
})

const inputStyle: React.CSSProperties = {
  background: 'var(--theme-elevation-0)',
  border: '1px solid var(--theme-elevation-250)',
  borderRadius: '4px',
  fontSize: '13px',
  padding: '4px 8px',
  width: '100%',
}

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  width: 'auto',
}

const FieldMappingsSection: React.FC<{
  apiRoute: string
  mappings: MappingEntry[]
  onUpdate: (mappings: MappingEntry[]) => void
}> = ({ apiRoute, mappings, onUpdate }) => {
  const [editing, setEditing] = useState(false)
  const [editRows, setEditRows] = useState<EditableMappingEntry[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const startEdit = useCallback(() => {
    setEditRows(
      mappings.length > 0
        ? mappings.map((m) => ({ ...m }))
        : [emptyMapping()],
    )
    setEditing(true)
    setError(null)
  }, [mappings])

  const cancelEdit = useCallback(() => {
    setEditing(false)
    setEditRows([])
    setError(null)
  }, [])

  const addRow = useCallback(() => {
    setEditRows((prev) => [...prev, emptyMapping()])
  }, [])

  const removeRow = useCallback((index: number) => {
    setEditRows((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const updateRow = useCallback((index: number, field: keyof EditableMappingEntry, value: number | string) => {
    setEditRows((prev) =>
      prev.map((row, i) =>
        i === index ? { ...row, [field]: value } : row,
      ),
    )
  }, [])

  const saveAll = useCallback(async () => {
    // Validate
    const valid = editRows.filter((r) => r.source.trim() && r.target.trim())
    if (valid.length === 0 && editRows.length > 0) {
      setError('At least one mapping must have both source and target fields.')
      return
    }

    setSaving(true)
    setError(null)

    try {
      const response = await fetch(`${apiRoute}/gmc/mappings`, {
        body: JSON.stringify({
          mappings: valid.map((r, i) => ({
            order: i,
            source: r.source.trim(),
            syncMode: r.syncMode,
            target: r.target.trim(),
            transformPreset: r.transformPreset,
          })),
        }),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      // Re-fetch to get IDs
      const mappingsRes = await fetch(`${apiRoute}/gmc/mappings`, { credentials: 'include' })
      if (mappingsRes.ok) {
        const data = await mappingsRes.json()
        onUpdate(data.mappings ?? [])
      }

      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save mappings')
    } finally {
      setSaving(false)
    }
  }, [apiRoute, editRows, onUpdate])

  return (
    <div style={sectionStyle}>
      <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2 style={{ ...headingStyle, marginBottom: 0 }}>Field Mappings</h2>
        {!editing ? (
          <button onClick={startEdit} style={btnStyle('secondary')} type="button">
            Edit Mappings
          </button>
        ) : (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button disabled={saving} onClick={addRow} style={btnStyle('secondary')} type="button">
              + Add Row
            </button>
            <button disabled={saving} onClick={saveAll} style={btnStyle('primary')} type="button">
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button disabled={saving} onClick={cancelEdit} style={btnStyle('secondary')} type="button">
              Cancel
            </button>
          </div>
        )}
      </div>

      {error && (
        <div style={{
          backgroundColor: '#fef2f2',
          borderRadius: '4px',
          color: '#991b1b',
          fontSize: '13px',
          marginBottom: '12px',
          padding: '8px 12px',
        }}>
          {error}
        </div>
      )}

      {editing ? (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Source Field</th>
              <th style={thStyle}>Target Field</th>
              <th style={thStyle}>Mode</th>
              <th style={thStyle}>Transform</th>
              <th aria-label="Actions" style={{ ...thStyle, width: '40px' }}></th>
            </tr>
          </thead>
          <tbody>
            {editRows.map((row, idx) => (
              <tr key={idx}>
                <td style={tdStyle}>
                  <input
                    aria-label="Source field path"
                    onChange={(e) => updateRow(idx, 'source', e.target.value)}
                    placeholder="e.g. title"
                    style={inputStyle}
                    type="text"
                    value={row.source}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    aria-label="Target field path"
                    onChange={(e) => updateRow(idx, 'target', e.target.value)}
                    placeholder="e.g. productAttributes.title"
                    style={inputStyle}
                    type="text"
                    value={row.target}
                  />
                </td>
                <td style={tdStyle}>
                  <select
                    aria-label="Sync mode"
                    onChange={(e) => updateRow(idx, 'syncMode', e.target.value)}
                    style={selectStyle}
                    value={row.syncMode}
                  >
                    {SYNC_MODE_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </td>
                <td style={tdStyle}>
                  <select
                    aria-label="Transform preset"
                    onChange={(e) => updateRow(idx, 'transformPreset', e.target.value)}
                    style={selectStyle}
                    value={row.transformPreset}
                  >
                    {TRANSFORM_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </td>
                <td style={tdStyle}>
                  <button
                    onClick={() => removeRow(idx)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#dc2626',
                      cursor: 'pointer',
                      fontSize: '16px',
                      padding: '2px 6px',
                    }}
                    title="Remove"
                    type="button"
                  >
                    x
                  </button>
                </td>
              </tr>
            ))}
            {editRows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ ...tdStyle, color: 'var(--theme-elevation-500)', textAlign: 'center' }}>
                  No mappings. Click &quot;+ Add Row&quot; to add one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      ) : mappings.length > 0 ? (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Source Field</th>
              <th style={thStyle}>Target Field</th>
              <th style={thStyle}>Mode</th>
              <th style={thStyle}>Transform</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((m) => (
              <tr key={m.id}>
                <td style={tdStyle}><code>{m.source}</code></td>
                <td style={tdStyle}><code>{m.target}</code></td>
                <td style={tdStyle}><span style={statusBadge(m.syncMode)}>{m.syncMode}</span></td>
                <td style={tdStyle}>{m.transformPreset || 'none'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style={{ color: 'var(--theme-elevation-500)', fontSize: '13px' }}>
          No field mappings configured. Click &quot;Edit Mappings&quot; to add them.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------

export const MerchantCenterDashboardClient: React.FC = () => {
  const { config } = useConfig()
  const routes = config.routes as { api?: string } | undefined
  const apiRoute = routes?.api ?? '/api'

  const [health, setHealth] = useState<HealthData | null>(null)
  const [logs, setLogs] = useState<SyncLog[]>([])
  const [mappings, setMappings] = useState<MappingEntry[]>([])
  const [activeJob, setActiveJob] = useState<null | string>(null)
  const [message, setMessage] = useState<{ text: string; type: 'error' | 'success' } | null>(null)
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set())
  const [logLimit, setLogLimit] = useState(10)
  const pollRef = useRef<null | ReturnType<typeof setInterval>>(null)

  const fetchLogs = useCallback(async () => {
    try {
      const logsRes = await fetch(`${apiRoute}/gmc-sync-log?limit=${logLimit}&sort=-createdAt&depth=1`, {
        credentials: 'include',
      })
      if (logsRes.ok) {
        const data = await logsRes.json()
        const docs = (data.docs ?? []) as SyncLog[]
        setLogs(docs)
        return docs
      }
    } catch {
      // Silently handle fetch errors
    }
    return []
  }, [apiRoute, logLimit])

  const fetchData = useCallback(async () => {
    try {
      const [healthRes, mappingsRes] = await Promise.all([
        fetch(`${apiRoute}/gmc/health`, { credentials: 'include' }),
        fetch(`${apiRoute}/gmc/mappings`, { credentials: 'include' }),
      ])

      if (healthRes.ok) {
        setHealth(await healthRes.json())
      }

      if (mappingsRes.ok) {
        const data = await mappingsRes.json()
        setMappings(data.mappings ?? [])
      }

      await fetchLogs()
    } catch {
      // Silently handle fetch errors
    }
  }, [apiRoute, fetchLogs])

  // Start polling when there's an active job
  const startPolling = useCallback((jobId: string) => {
    setActiveJob(jobId)
    if (pollRef.current) {clearInterval(pollRef.current)}

    pollRef.current = setInterval(async () => {
      const currentLogs = await fetchLogs()
      const job = currentLogs.find((l) => l.jobId === jobId)
      if (job && job.status !== 'running') {
        // Job completed
        if (pollRef.current) {clearInterval(pollRef.current)}
        pollRef.current = null
        setActiveJob(null)
        setMessage({
          type: job.failed > 0 && job.succeeded === 0 ? 'error' : 'success',
          text: `${job.type}: ${job.succeeded} succeeded, ${job.failed} failed out of ${job.total}`,
        })
      }
    }, 2000)
  }, [fetchLogs])

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) {clearInterval(pollRef.current)}
    }
  }, [])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const runBulkAction = useCallback(
    async (action: string, body?: Record<string, unknown>) => {
      setActiveJob(action)
      setMessage(null)

      try {
        const response = await fetch(`${apiRoute}/gmc/batch/${action}`, {
          body: body ? JSON.stringify(body) : '{}',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        })

        const data = await response.json()

        if (data.error) {
          setMessage({ type: 'error', text: data.error })
          setActiveJob(null)
        } else if (data.jobId) {
          // Job started — poll for progress
          startPolling(data.jobId)
        } else {
          setMessage({
            type: 'success',
            text: `${action}: ${data.succeeded ?? 0} succeeded, ${data.failed ?? 0} failed out of ${data.total ?? 0}`,
          })
          setActiveJob(null)
          void fetchData()
        }
      } catch (err) {
        setMessage({
          type: 'error',
          text: err instanceof Error ? err.message : 'Request failed',
        })
        setActiveJob(null)
      }
    },
    [apiRoute, fetchData, startPolling],
  )

  const toggleRow = useCallback((logId: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(logId)) {
        next.delete(logId)
      } else {
        next.add(logId)
      }
      return next
    })
  }, [])

  const loadMore = useCallback(() => {
    setLogLimit((prev) => {
      if (prev < 25) {return 25}
      if (prev < 50) {return 50}
      return 100
    })
  }, [])

  // Re-fetch when logLimit changes
  useEffect(() => {
    void fetchLogs()
  }, [logLimit, fetchLogs])

  // Find the currently running job from logs
  const runningJob = logs.find((l) => l.status === 'running')
  const activeJobLog = activeJob ? logs.find((l) => l.jobId === activeJob) ?? runningJob : runningJob

  const metadataTagStyle: React.CSSProperties = {
    backgroundColor: 'var(--theme-elevation-150)',
    borderRadius: '3px',
    display: 'inline-block',
    fontSize: '11px',
    marginLeft: '4px',
    padding: '1px 5px',
  }

  return (
    <div style={{ margin: '0 auto', maxWidth: '1200px', padding: '24px' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '24px' }}>
        Merchant Center
      </h1>

      {/* Connection Status */}
      <div style={sectionStyle}>
        <h2 style={headingStyle}>Connection Status</h2>
        {health ? (
          <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr 1fr 1fr' }}>
            <div>
              <strong>Status:</strong>{' '}
              <span style={statusBadge(health.status)}>{health.status}</span>
            </div>
            <div>
              <strong>Account:</strong> {health.merchant.accountId}
            </div>
            <div>
              <strong>Data Source:</strong> {health.merchant.dataSourceId}
            </div>
            <div>
              <strong>Sync Mode:</strong> {health.sync.mode}
            </div>
            <div>
              <strong>Admin Mode:</strong> {health.admin.mode}
            </div>
            <div>
              <strong>Rate Limiting:</strong> {health.rateLimit.enabled ? 'Enabled' : 'Disabled'}
            </div>
          </div>
        ) : (
          <p>Loading health data...</p>
        )}
      </div>

      {/* Bulk Operations */}
      <div style={sectionStyle}>
        <h2 style={headingStyle}>Bulk Operations</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
          <button
            disabled={!!activeJob}
            onClick={() => runBulkAction('initial-sync', { dryRun: true })}
            style={btnStyle('secondary')}
            type="button"
          >
            Initial Sync (Dry Run)
          </button>
          <button
            disabled={!!activeJob}
            onClick={() => runBulkAction('initial-sync', { dryRun: false })}
            style={btnStyle('primary')}
            type="button"
          >
            Initial Sync (Write)
          </button>
          <button
            disabled={!!activeJob}
            onClick={() => runBulkAction('push')}
            style={btnStyle('primary')}
            type="button"
          >
            Push All Enabled
          </button>
          <button
            disabled={!!activeJob}
            onClick={() => runBulkAction('push-dirty')}
            style={btnStyle('primary')}
            type="button"
          >
            Push Dirty Only
          </button>
          <button
            disabled={!!activeJob}
            onClick={() => runBulkAction('pull-all')}
            style={btnStyle('secondary')}
            type="button"
          >
            Pull All from MC
          </button>
        </div>

        {/* Live progress bar */}
        {activeJobLog && activeJobLog.status === 'running' && (
          <div style={{
            backgroundColor: 'var(--theme-elevation-100)',
            borderRadius: '8px',
            fontSize: '13px',
            marginBottom: '12px',
            padding: '12px 16px',
          }}>
            <div style={{ alignItems: 'center', display: 'flex', gap: '12px', marginBottom: '8px' }}>
              <span style={statusBadge('running')}>running</span>
              <strong>{activeJobLog.type}</strong>
              <span style={{ color: 'var(--theme-elevation-500)' }}>
                {activeJobLog.jobId}
              </span>
            </div>
            <div style={{
              backgroundColor: 'var(--theme-elevation-200)',
              borderRadius: '4px',
              height: '8px',
              marginBottom: '8px',
              overflow: 'hidden',
            }}>
              <div style={progressBarStyle(
                activeJobLog.total > 0
                  ? Math.round((activeJobLog.processed / activeJobLog.total) * 100)
                  : 0,
              )} />
            </div>
            <div style={{ color: 'var(--theme-elevation-600)', display: 'flex', gap: '16px' }}>
              <span>{activeJobLog.processed} / {activeJobLog.total} processed</span>
              <span style={{ color: '#22c55e' }}>{activeJobLog.succeeded} OK</span>
              {activeJobLog.failed > 0 && (
                <span style={{ color: '#ef4444' }}>{activeJobLog.failed} failed</span>
              )}
            </div>
          </div>
        )}

        {message && !activeJobLog?.status?.match(/running/) && (
          <div
            style={{
              backgroundColor: message.type === 'success' ? '#f0fdf4' : '#fef2f2',
              borderRadius: '4px',
              color: message.type === 'success' ? '#166534' : '#991b1b',
              fontSize: '13px',
              padding: '8px 12px',
            }}
          >
            {message.text}
          </div>
        )}
      </div>

      {/* Field Mappings */}
      <FieldMappingsSection
        apiRoute={apiRoute}
        mappings={mappings}
        onUpdate={(updated) => setMappings(updated)}
      />

      {/* Sync History */}
      <div style={sectionStyle}>
        <h2 style={headingStyle}>Sync History</h2>
        {logs.length > 0 ? (
          <>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th aria-label="Expand" style={{ ...thStyle, width: '32px' }}></th>
                  <th style={thStyle}>Job ID</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Progress</th>
                  <th style={thStyle}>Started</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const hasErrors = log.failed > 0 && log.errors && log.errors.length > 0
                  const isExpanded = expandedRows.has(log.id)
                  return (
                    <React.Fragment key={log.id}>
                      <tr
                        onClick={hasErrors ? () => toggleRow(log.id) : undefined}
                        style={{ cursor: hasErrors ? 'pointer' : 'default' }}
                      >
                        <td style={tdStyle}>
                          {hasErrors ? (
                            <span style={{ display: 'inline-block', fontFamily: 'monospace', fontSize: '12px', userSelect: 'none', width: '16px' }}>
                              {isExpanded ? '[-]' : '[+]'}
                            </span>
                          ) : null}
                        </td>
                        <td style={tdStyle}><code>{log.jobId}</code></td>
                        <td style={tdStyle}>
                          {log.type}
                          {log.type === 'pullAll' && log.metadata && (
                            <>
                              {log.metadata.matched != null && (
                                <span style={metadataTagStyle}>matched: {log.metadata.matched}</span>
                              )}
                              {log.metadata.orphaned != null && (
                                <span style={metadataTagStyle}>orphaned: {log.metadata.orphaned}</span>
                              )}
                            </>
                          )}
                          {log.type === 'initialSync' && log.metadata && (
                            <>
                              {log.metadata.dryRun != null && (
                                <span style={{ ...metadataTagStyle, backgroundColor: log.metadata.dryRun ? '#fef3c7' : '#d1fae5' }}>
                                  {log.metadata.dryRun ? 'dry run' : 'write'}
                                </span>
                              )}
                              {log.metadata.existingRemote != null && (
                                <span style={metadataTagStyle}>remote: {log.metadata.existingRemote}</span>
                              )}
                              {log.metadata.skipped != null && (
                                <span style={metadataTagStyle}>skipped: {log.metadata.skipped}</span>
                              )}
                            </>
                          )}
                        </td>
                        <td style={tdStyle}><span style={statusBadge(log.status)}>{log.status}</span></td>
                        <td style={tdStyle}>
                          {log.succeeded}/{log.total} OK
                          {log.failed > 0 && `, ${log.failed} failed`}
                        </td>
                        <td style={tdStyle}>
                          {log.startedAt ? new Date(log.startedAt).toLocaleString() : '-'}
                        </td>
                      </tr>
                      {/* Expanded error details row — no interactive controls, a11y warning is a false positive */}
                      {/* eslint-disable jsx-a11y/control-has-associated-label */}
                      {hasErrors && isExpanded && (
                        <tr>
                          <td colSpan={6} style={{ padding: 0 }}>
                            <div style={{
                              backgroundColor: 'var(--theme-elevation-100)',
                              borderBottom: '1px solid var(--theme-elevation-150)',
                              maxHeight: '200px',
                              overflowY: 'auto',
                              padding: '12px 16px',
                            }}>
                              <table style={{ ...tableStyle, fontSize: '12px' }}>
                                <thead>
                                  <tr>
                                    <th style={{ ...thStyle, fontSize: '11px', padding: '4px 8px' }}>Product ID</th>
                                    <th style={{ ...thStyle, fontSize: '11px', padding: '4px 8px' }}>Error Message</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {log.errors!.map((err, idx) => (
                                    <tr key={idx}>
                                      <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: '12px', padding: '4px 8px' }}>
                                        {err.productId}
                                      </td>
                                      <td style={{ ...tdStyle, color: '#991b1b', fontSize: '12px', padding: '4px 8px' }}>
                                        {err.message}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                      {/* eslint-enable jsx-a11y/control-has-associated-label */}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
            {logs.length >= logLimit && logLimit < 100 && (
              <div style={{ marginTop: '12px', textAlign: 'center' }}>
                <button
                  onClick={loadMore}
                  style={{
                    ...btnStyle('secondary'),
                    marginRight: 0,
                  }}
                  type="button"
                >
                  Load More (showing {logLimit})
                </button>
              </div>
            )}
          </>
        ) : (
          <p style={{ color: 'var(--theme-elevation-500)', fontSize: '13px' }}>
            No sync history yet.
          </p>
        )}
      </div>
    </div>
  )
}
