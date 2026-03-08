'use client'

import React from 'react'

import type { DashboardMessage, SyncLog } from '../types.js'

import {
  buttonStyle,
  headingStyle,
  progressBarStyle,
  sectionStyle,
  statusBadgeStyle,
} from '../styles.js'

export const MerchantCenterBulkOperations = (props: {
  activeJob: null | string
  activeJobLog?: SyncLog
  message: DashboardMessage | null
  onRunBulkAction: (action: string, body?: Record<string, unknown>) => void
}): React.JSX.Element => {
  const { activeJob, activeJobLog, message, onRunBulkAction } = props

  return (
    <div style={sectionStyle}>
      <h2 style={headingStyle}>Bulk Operations</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        <button
          disabled={Boolean(activeJob)}
          onClick={() => onRunBulkAction('initial-sync', { dryRun: true })}
          style={buttonStyle('secondary')}
          type="button"
        >
          Initial Sync (Dry Run)
        </button>
        <button
          disabled={Boolean(activeJob)}
          onClick={() => onRunBulkAction('initial-sync', { dryRun: false })}
          style={buttonStyle('primary')}
          type="button"
        >
          Initial Sync (Write)
        </button>
        <button
          disabled={Boolean(activeJob)}
          onClick={() => onRunBulkAction('push')}
          style={buttonStyle('primary')}
          type="button"
        >
          Push All Enabled
        </button>
        <button
          disabled={Boolean(activeJob)}
          onClick={() => onRunBulkAction('push-dirty')}
          style={buttonStyle('primary')}
          type="button"
        >
          Push Dirty Only
        </button>
        <button
          disabled={Boolean(activeJob)}
          onClick={() => onRunBulkAction('pull-all')}
          style={buttonStyle('secondary')}
          type="button"
        >
          Pull All from MC
        </button>
      </div>

      {activeJobLog?.status === 'running' && (
        <div style={{
          backgroundColor: 'var(--theme-elevation-100)',
          borderRadius: '8px',
          fontSize: '13px',
          marginBottom: '12px',
          padding: '12px 16px',
        }}>
          <div style={{ alignItems: 'center', display: 'flex', gap: '12px', marginBottom: '8px' }}>
            <span style={statusBadgeStyle('running')}>running</span>
            <strong>{activeJobLog.type}</strong>
            <span style={{ color: 'var(--theme-elevation-500)' }}>{activeJobLog.jobId}</span>
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

      {message && activeJobLog?.status !== 'running' && (
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
  )
}
