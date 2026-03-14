'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  DashboardHealthData,
  DashboardMessage,
  MappingEntry,
  SyncLog,
} from './types.js'

type UseMerchantCenterDashboardArgs = {
  apiRoute: string
  gmcEndpointBase: string
}

export const useMerchantCenterDashboard = (
  args: UseMerchantCenterDashboardArgs,
) => {
  const { apiRoute, gmcEndpointBase } = args
  const [health, setHealth] = useState<DashboardHealthData | null>(null)
  const [logs, setLogs] = useState<SyncLog[]>([])
  const [mappings, setMappings] = useState<MappingEntry[]>([])
  const [activeJob, setActiveJob] = useState<null | string>(null)
  const [message, setMessage] = useState<DashboardMessage | null>(null)
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set())
  const [logLimit, setLogLimit] = useState(10)
  const pollRef = useRef<null | ReturnType<typeof setInterval>>(null)

  const fetchLogs = useCallback(async (): Promise<SyncLog[]> => {
    try {
      const response = await fetch(
        `${apiRoute}/gmc-sync-log?limit=${logLimit}&sort=-createdAt&depth=1`,
        { credentials: 'include' },
      )

      if (!response.ok) {
        return []
      }

      const data = await response.json()
      const docs = (data.docs ?? []) as SyncLog[]
      setLogs(docs)
      return docs
    } catch {
      return []
    }
  }, [apiRoute, logLimit])

  const fetchDashboardData = useCallback(async () => {
    try {
      const [healthResponse, mappingsResponse] = await Promise.all([
        fetch(`${gmcEndpointBase}/health`, { credentials: 'include' }),
        fetch(`${gmcEndpointBase}/mappings`, { credentials: 'include' }),
      ])

      if (healthResponse.ok) {
        setHealth(await healthResponse.json())
      }

      if (mappingsResponse.ok) {
        const data = await mappingsResponse.json()
        setMappings(data.mappings ?? [])
      }

      await fetchLogs()
    } catch {
      // Best-effort dashboard refresh
    }
  }, [fetchLogs, gmcEndpointBase])

  const startPolling = useCallback((jobId: string) => {
    setActiveJob(jobId)

    if (pollRef.current) {
      clearInterval(pollRef.current)
    }

    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const currentLogs = await fetchLogs()
          const job = currentLogs.find((entry) => entry.jobId === jobId)

          if (!job || job.status === 'running') {
            return
          }

          if (pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
          }

          setActiveJob(null)
          setMessage({
            type: job.failed > 0 && job.succeeded === 0 ? 'error' : 'success',
            text: `${job.type}: ${job.succeeded} succeeded, ${job.failed} failed out of ${job.total}`,
          })
        } catch {
          // Polling fetch failed; next interval will retry
        }
      })()
    }, 2_000)
  }, [fetchLogs])

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
      }
    }
  }, [])

  useEffect(() => {
    void fetchDashboardData()
  }, [fetchDashboardData])

  useEffect(() => {
    void fetchLogs()
  }, [fetchLogs, logLimit])

  const runBulkAction = useCallback(async (
    action: string,
    body?: Record<string, unknown>,
  ) => {
    setActiveJob(action)
    setMessage(null)

    try {
      const response = await fetch(`${gmcEndpointBase}/batch/${action}`, {
        body: JSON.stringify(body ?? {}),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      if (!response.ok) {
        setActiveJob(null)
        setMessage({ type: 'error', text: `HTTP ${response.status}` })
        return
      }

      const data = await response.json()

      if (data.error) {
        setActiveJob(null)
        setMessage({ type: 'error', text: data.error })
        return
      }

      if (data.jobId) {
        startPolling(data.jobId)
        return
      }

      setActiveJob(null)
      setMessage({
        type: 'success',
        text: `${action}: ${data.succeeded ?? 0} succeeded, ${data.failed ?? 0} failed out of ${data.total ?? 0}`,
      })
      void fetchDashboardData()
    } catch (error) {
      setActiveJob(null)
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Request failed',
      })
    }
  }, [fetchDashboardData, gmcEndpointBase, startPolling])

  const toggleRow = useCallback((logId: string) => {
    setExpandedRows((previous) => {
      const next = new Set(previous)
      if (next.has(logId)) {
        next.delete(logId)
      } else {
        next.add(logId)
      }
      return next
    })
  }, [])

  const loadMore = useCallback(() => {
    setLogLimit((previous) => {
      if (previous < 25) {
        return 25
      }

      if (previous < 50) {
        return 50
      }

      return 100
    })
  }, [])

  const runningJob = logs.find((entry) => entry.status === 'running')
  const activeJobLog = activeJob
    ? logs.find((entry) => entry.jobId === activeJob) ?? runningJob
    : runningJob
  const latestScheduledSyncLog = logs.find(
    (entry) => entry.type === 'batch' && entry.triggeredBy === 'cron',
  ) ?? null

  return {
    activeJob,
    activeJobLog,
    expandedRows,
    health,
    latestScheduledSyncLog,
    loadMore,
    logLimit,
    logs,
    mappings,
    message,
    runBulkAction,
    setMappings,
    toggleRow,
  }
}
