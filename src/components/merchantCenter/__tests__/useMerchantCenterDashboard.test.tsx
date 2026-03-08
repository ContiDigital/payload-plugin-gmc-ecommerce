// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { useMerchantCenterDashboard } from '../useMerchantCenterDashboard.js'

const jsonResponse = (data: unknown, status = 200): Response => new Response(
  JSON.stringify(data),
  {
    headers: { 'Content-Type': 'application/json' },
    status,
  },
)

const getRequestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') {
    return input
  }

  if (input instanceof URL) {
    return input.toString()
  }

  return input.url
}

describe('useMerchantCenterDashboard', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()

  beforeEach(() => {
    vi.useRealTimers()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('loads health, mappings, and sync logs on mount', async () => {
    fetchMock.mockImplementation((input) => {
      const url = getRequestUrl(input)

      if (url.endsWith('/gmc/health')) {
        return Promise.resolve(jsonResponse({
          admin: { mode: 'route' },
          merchant: { accountId: '123', dataSourceId: 'ds-123' },
          rateLimit: { enabled: true },
          status: 'ok',
          sync: { mode: 'scheduled' },
          timestamp: '2026-03-07T12:00:00Z',
        }))
      }

      if (url.endsWith('/gmc/mappings')) {
        return Promise.resolve(jsonResponse({
          mappings: [
            {
              id: 'map-1',
              order: 0,
              source: 'title',
              syncMode: 'permanent',
              target: 'productAttributes.title',
              transformPreset: 'none',
            },
          ],
        }))
      }

      if (url.includes('/gmc-sync-log')) {
        return Promise.resolve(jsonResponse({
          docs: [
            {
              id: 'log-1',
              type: 'push',
              failed: 0,
              jobId: 'job-1',
              processed: 1,
              startedAt: '2026-03-07T12:00:00Z',
              status: 'completed',
              succeeded: 1,
              total: 1,
            },
          ],
        }))
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`))
    })

    const { result } = renderHook(() => useMerchantCenterDashboard({
      apiRoute: '/api',
      gmcEndpointBase: '/api/gmc',
    }))

    await waitFor(() => {
      expect(result.current.health?.status).toBe('ok')
      expect(result.current.logs).toHaveLength(1)
      expect(result.current.mappings).toHaveLength(1)
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/gmc/health', { credentials: 'include' })
    expect(fetchMock).toHaveBeenCalledWith('/api/gmc/mappings', { credentials: 'include' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/gmc-sync-log?limit=10&sort=-createdAt&depth=1',
      { credentials: 'include' },
    )
  })

  test('polls queued jobs until completion and reports the result', async () => {
    let logFetchCount = 0

    fetchMock.mockImplementation((input) => {
      const url = getRequestUrl(input)

      if (url.endsWith('/gmc/health')) {
        return Promise.resolve(jsonResponse({
          admin: { mode: 'route' },
          merchant: { accountId: '123', dataSourceId: 'ds-123' },
          rateLimit: { enabled: true },
          status: 'ok',
          sync: { mode: 'scheduled' },
          timestamp: '2026-03-07T12:00:00Z',
        }))
      }

      if (url.endsWith('/gmc/mappings')) {
        return Promise.resolve(jsonResponse({ mappings: [] }))
      }

      if (url.includes('/gmc-sync-log')) {
        logFetchCount++

        if (logFetchCount < 3) {
          return Promise.resolve(jsonResponse({ docs: [] }))
        }

        if (logFetchCount === 3) {
          return Promise.resolve(jsonResponse({
            docs: [{
              id: 'log-2',
              type: 'push',
              failed: 0,
              jobId: 'job-2',
              processed: 1,
              startedAt: '2026-03-07T12:00:00Z',
              status: 'running',
              succeeded: 1,
              total: 2,
            }],
          }))
        }

        return Promise.resolve(jsonResponse({
          docs: [{
            id: 'log-2',
            type: 'push',
            failed: 1,
            jobId: 'job-2',
            processed: 2,
            startedAt: '2026-03-07T12:00:00Z',
            status: 'completed',
            succeeded: 1,
            total: 2,
          }],
        }))
      }

      if (url.endsWith('/gmc/batch/push')) {
        return Promise.resolve(jsonResponse({ jobId: 'job-2' }))
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`))
    })

    const { result } = renderHook(() => useMerchantCenterDashboard({
      apiRoute: '/api',
      gmcEndpointBase: '/api/gmc',
    }))

    await waitFor(() => {
      expect(result.current.health?.status).toBe('ok')
    })

    const intervalCallbacks: Array<() => Promise<void> | void> = []
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      intervalCallbacks.push(callback as () => Promise<void> | void)
      return 1 as unknown as ReturnType<typeof setInterval>
    })

    await act(async () => {
      await result.current.runBulkAction('push')
    })

    expect(result.current.activeJob).toBe('job-2')
    expect(intervalCallbacks).toHaveLength(1)

    await act(async () => {
      await intervalCallbacks[0]?.()
      await Promise.resolve()
    })

    expect(result.current.activeJobLog?.status).toBe('running')

    await act(async () => {
      await intervalCallbacks[0]?.()
      await Promise.resolve()
    })

    expect(result.current.activeJob).toBeNull()
    expect(result.current.message).toEqual({
      type: 'success',
      text: 'push: 1 succeeded, 1 failed out of 2',
    })
    expect(clearIntervalSpy).toHaveBeenCalledWith(1)
  })
})
