'use client'

import { useConfig } from '@payloadcms/ui'
import React from 'react'

import { resolveMerchantCenterApiConfig } from './merchantCenter/apiConfig.js'
import {
  MerchantCenterBulkOperations,
  MerchantCenterConnectionStatus,
  MerchantCenterFieldMappingsSection,
  MerchantCenterSyncHistory,
} from './merchantCenter/DashboardSections.js'
import { useMerchantCenterDashboard } from './merchantCenter/useMerchantCenterDashboard.js'

export const MerchantCenterDashboardClient: React.FC = () => {
  const { config } = useConfig()
  const { apiRoute, gmcEndpointBase } = resolveMerchantCenterApiConfig(config)
  const {
    activeJob,
    activeJobLog,
    expandedRows,
    health,
    loadMore,
    logLimit,
    logs,
    mappings,
    message,
    runBulkAction,
    setMappings,
    toggleRow,
  } = useMerchantCenterDashboard({
    apiRoute,
    gmcEndpointBase,
  })

  return (
    <div style={{ margin: '0 auto', maxWidth: '1200px', padding: '24px' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '24px' }}>
        Merchant Center
      </h1>

      <MerchantCenterConnectionStatus health={health} />
      <MerchantCenterBulkOperations
        activeJob={activeJob}
        activeJobLog={activeJobLog}
        message={message}
        onRunBulkAction={(action, body) => { void runBulkAction(action, body) }}
      />
      <MerchantCenterFieldMappingsSection
        apiBasePath={gmcEndpointBase}
        mappings={mappings}
        onUpdate={setMappings}
      />
      <MerchantCenterSyncHistory
        expandedRows={expandedRows}
        logLimit={logLimit}
        logs={logs}
        onLoadMore={loadMore}
        onToggleRow={toggleRow}
      />
    </div>
  )
}
