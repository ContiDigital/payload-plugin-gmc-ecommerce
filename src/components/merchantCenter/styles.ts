import type React from 'react'

import type { ProductSyncState } from './types.js'

export const sectionStyle: React.CSSProperties = {
  backgroundColor: 'var(--theme-elevation-50)',
  border: '1px solid var(--theme-elevation-150)',
  borderRadius: '8px',
  marginBottom: '20px',
  padding: '20px',
}

export const headingStyle: React.CSSProperties = {
  fontSize: '18px',
  fontWeight: 600,
  marginBottom: '16px',
  marginTop: 0,
}

export const tableStyle: React.CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: '13px',
  width: '100%',
}

export const thStyle: React.CSSProperties = {
  borderBottom: '2px solid var(--theme-elevation-200)',
  fontWeight: 600,
  padding: '8px 12px',
  textAlign: 'left',
}

export const tdStyle: React.CSSProperties = {
  borderBottom: '1px solid var(--theme-elevation-100)',
  padding: '8px 12px',
}

export const buttonStyle = (
  variant: 'danger' | 'primary' | 'secondary',
): React.CSSProperties => ({
  backgroundColor:
    variant === 'primary' ? '#2563eb'
      : variant === 'danger' ? '#dc2626'
        : '#6b7280',
  border: 'none',
  borderRadius: '4px',
  color: '#fff',
  cursor: 'pointer',
  fontSize: '13px',
  padding: '8px 16px',
})

export const syncControlButtonStyle = (
  variant: 'danger' | 'primary' | 'secondary',
): React.CSSProperties => ({
  ...buttonStyle(variant),
  padding: '6px 14px',
})

export const statusBadgeStyle = (status: string): React.CSSProperties => ({
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
  textTransform: 'uppercase',
})

export const productSyncBadgeStyle = (state: ProductSyncState): React.CSSProperties => ({
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
  textTransform: 'uppercase',
})

export const progressBarStyle = (pct: number): React.CSSProperties => ({
  backgroundColor: '#2563eb',
  borderRadius: '4px',
  height: '100%',
  transition: 'width 0.3s ease',
  width: `${pct}%`,
})

export const metadataTagStyle: React.CSSProperties = {
  backgroundColor: 'var(--theme-elevation-150)',
  borderRadius: '3px',
  display: 'inline-block',
  fontSize: '11px',
  marginLeft: '4px',
  padding: '1px 5px',
}

export const productSyncStyles = {
  buttonRow: {
    display: 'flex',
    gap: '8px',
  } satisfies React.CSSProperties,
  container: {
    borderBottom: '1px solid var(--theme-elevation-200)',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    marginBottom: '24px',
    paddingBottom: '16px',
  } satisfies React.CSSProperties,
  error: {
    backgroundColor: '#fef2f2',
    borderRadius: '4px',
    color: '#991b1b',
    fontSize: '13px',
    padding: '8px 12px',
  } satisfies React.CSSProperties,
  header: {
    alignItems: 'center',
    display: 'flex',
    gap: '12px',
    justifyContent: 'space-between',
  } satisfies React.CSSProperties,
  label: {
    color: 'var(--theme-elevation-500)',
    fontSize: '12px',
    fontWeight: 600,
    textTransform: 'uppercase',
  } satisfies React.CSSProperties,
  lastSync: {
    color: 'var(--theme-elevation-500)',
    fontSize: '12px',
  } satisfies React.CSSProperties,
  section: {
    borderTop: '1px solid var(--theme-elevation-150)',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    paddingTop: '10px',
  } satisfies React.CSSProperties,
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    margin: 0,
  } satisfies React.CSSProperties,
  statusRow: {
    alignItems: 'center',
    display: 'flex',
    gap: '8px',
  } satisfies React.CSSProperties,
  title: {
    fontSize: '16px',
    fontWeight: 600,
    margin: 0,
  } satisfies React.CSSProperties,
  value: {
    fontSize: '13px',
  } satisfies React.CSSProperties,
}
