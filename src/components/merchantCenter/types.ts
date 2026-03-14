export type DashboardHealthData = {
  admin: { mode: string }
  jobs?: {
    queueName: string
    runnerRequired: boolean
    strategy: 'external' | 'payload-jobs'
    workerBasePath: string
    workerEndpointsEnabled: boolean
  }
  merchant?: { accountId: string; dataSourceId: string }
  rateLimit: { distributed?: boolean; enabled: boolean }
  status: string
  sync: { mode: string }
  timestamp: string
}

export type DashboardMessage = {
  text: string
  type: 'error' | 'success'
}

export type MappingEntry = {
  id: string
  order: number
  source: string
  syncMode: string
  target: string
  transformPreset: string
}

export type ProductSyncState = 'error' | 'idle' | 'success' | 'syncing'

export type ProductSyncMeta = {
  lastAction?: string
  lastError?: null | string
  lastSyncedAt?: string
  state: ProductSyncState
  syncSource?: string
}

export type PerformanceRow = {
  clicks: number
  clickThroughRate: number
  conversions: number
  date: string
  impressions: number
}

export type ProductAnalytics = {
  merchantProductId?: string
  performance?: PerformanceRow[]
  status?: Record<string, unknown>
}

export type SyncLog = {
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
    trigger?: string
  }
  processed: number
  startedAt: string
  status: string
  succeeded: number
  total: number
  triggeredBy?: string
  type: string
}
