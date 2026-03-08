'use client'

import React from 'react'

import type { SyncLog } from '../types.js'

import {
  buttonStyle,
  headingStyle,
  metadataTagStyle,
  sectionStyle,
  statusBadgeStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from '../styles.js'

const renderLogMetadata = (log: SyncLog): null | React.JSX.Element => {
  if (log.type === 'pullAll' && log.metadata) {
    return (
      <>
        {log.metadata.matched != null && (
          <span style={metadataTagStyle}>matched: {log.metadata.matched}</span>
        )}
        {log.metadata.orphaned != null && (
          <span style={metadataTagStyle}>orphaned: {log.metadata.orphaned}</span>
        )}
      </>
    )
  }

  if (log.type === 'initialSync' && log.metadata) {
    return (
      <>
        {log.metadata.dryRun != null && (
          <span
            style={{
              ...metadataTagStyle,
              backgroundColor: log.metadata.dryRun ? '#fef3c7' : '#d1fae5',
            }}
          >
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
    )
  }

  return null
}

export const MerchantCenterSyncHistory = (props: {
  expandedRows: Set<string>
  logLimit: number
  logs: SyncLog[]
  onLoadMore: () => void
  onToggleRow: (logId: string) => void
}): React.JSX.Element => {
  const { expandedRows, logLimit, logs, onLoadMore, onToggleRow } = props

  return (
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
                const hasErrors = log.failed > 0 && Boolean(log.errors?.length)
                const isExpanded = expandedRows.has(log.id)

                return (
                  <React.Fragment key={log.id}>
                    <tr
                      onClick={hasErrors ? () => onToggleRow(log.id) : undefined}
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
                        {renderLogMetadata(log)}
                      </td>
                      <td style={tdStyle}>
                        <span style={statusBadgeStyle(log.status)}>{log.status}</span>
                      </td>
                      <td style={tdStyle}>
                        {log.succeeded}/{log.total} OK
                        {log.failed > 0 && `, ${log.failed} failed`}
                      </td>
                      <td style={tdStyle}>
                        {log.startedAt ? new Date(log.startedAt).toLocaleString() : '-'}
                      </td>
                    </tr>
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
                                {log.errors?.map((error, index) => (
                                  <tr key={`${log.id}-${index.toString()}`}>
                                    <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: '12px', padding: '4px 8px' }}>
                                      {error.productId}
                                    </td>
                                    <td style={{ ...tdStyle, color: '#991b1b', fontSize: '12px', padding: '4px 8px' }}>
                                      {error.message}
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
                onClick={onLoadMore}
                style={buttonStyle('secondary')}
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
  )
}
