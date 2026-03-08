'use client'

import React from 'react'

import type { DashboardHealthData } from '../types.js'

import { headingStyle, sectionStyle, statusBadgeStyle } from '../styles.js'

export const MerchantCenterConnectionStatus = (props: {
  health: DashboardHealthData | null
}): React.JSX.Element => {
  const { health } = props

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
    </div>
  )
}
