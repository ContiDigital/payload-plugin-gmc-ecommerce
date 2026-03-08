'use client'

import React from 'react'

import type { DashboardHealthData, SyncLog } from '../types.js'

import { headingStyle, sectionStyle, statusBadgeStyle } from '../styles.js'

export const MerchantCenterConnectionStatus = (props: {
  health: DashboardHealthData | null
  latestScheduledSyncLog?: null | SyncLog
}): React.JSX.Element => {
  const { health, latestScheduledSyncLog } = props
  const merchant = health?.merchant

  return (
    <div style={sectionStyle}>
      <h2 style={headingStyle}>Connection Status</h2>
      {health ? (
        <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr 1fr 1fr' }}>
          <div>
            <strong>Status:</strong>{' '}
            <span style={statusBadgeStyle(health.status)}>{health.status}</span>
          </div>
          <div>
            <strong>Account:</strong> {merchant?.accountId ?? 'Restricted'}
          </div>
          <div>
            <strong>Data Source:</strong> {merchant?.dataSourceId ?? 'Restricted'}
          </div>
          <div>
            <strong>Sync Mode:</strong> {health.sync.mode}
          </div>
          <div>
            <strong>Admin Mode:</strong> {health.admin.mode}
          </div>
          <div>
            <strong>Rate Limiting:</strong> {health.rateLimit.enabled ? 'Enabled' : 'Disabled'}
            {health.rateLimit.distributed ? ' (distributed)' : ''}
          </div>
          {health.jobs && (
            <>
              <div>
                <strong>Queue Strategy:</strong> {health.jobs.strategy}
              </div>
              <div>
                <strong>Queue:</strong> {health.jobs.queueName}
              </div>
              <div>
                <strong>Worker Endpoints:</strong>{' '}
                {health.jobs.workerEndpointsEnabled ? health.jobs.workerBasePath : 'disabled'}
              </div>
            </>
          )}
        </div>
      ) : (
        <p>Loading health data...</p>
      )}
      {latestScheduledSyncLog && (
        <div style={{
          backgroundColor: 'var(--theme-elevation-100)',
          borderRadius: '8px',
          marginTop: '16px',
          padding: '12px 16px',
        }}>
          <div style={{ alignItems: 'center', display: 'flex', gap: '12px', marginBottom: '8px' }}>
            <strong>Last Scheduled Dirty Sync</strong>
            <span style={statusBadgeStyle(latestScheduledSyncLog.status)}>
              {latestScheduledSyncLog.status}
            </span>
          </div>
          <div style={{ color: 'var(--theme-elevation-600)', display: 'flex', flexWrap: 'wrap', gap: '16px' }}>
            <span>
              Started: {latestScheduledSyncLog.startedAt
                ? new Date(latestScheduledSyncLog.startedAt).toLocaleString()
                : '-'}
            </span>
            <span>
              Completed: {latestScheduledSyncLog.completedAt
                ? new Date(latestScheduledSyncLog.completedAt).toLocaleString()
                : 'still running'}
            </span>
            <span>{latestScheduledSyncLog.succeeded}/{latestScheduledSyncLog.total} OK</span>
            {latestScheduledSyncLog.failed > 0 && (
              <span style={{ color: '#ef4444' }}>{latestScheduledSyncLog.failed} failed</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
