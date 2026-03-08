import { describe, expect, test, vi } from 'vitest'

import { createRateLimiterService } from '../rateLimiterService.js'

describe('createRateLimiterService', () => {
  test('bypasses queueing when disabled', async () => {
    const limiter = createRateLimiterService({
      enabled: false,
      maxConcurrency: 1,
      maxQueueSize: 1,
      maxRequestsPerMinute: 1,
    })

    await expect(limiter.execute(() => Promise.resolve('ok'))).resolves.toBe('ok')
    expect(limiter.getStats()).toMatchObject({
      activeCount: 0,
      queueSize: 0,
      requestsInWindow: 0,
    })
  })

  test('caps started work per minute when enabled', async () => {
    vi.useFakeTimers()

    const limiter = createRateLimiterService({
      enabled: true,
      maxConcurrency: 2,
      maxQueueSize: 10,
      maxRequestsPerMinute: 1,
    })

    const starts: number[] = []
    const first = limiter.execute(() => Promise.resolve().then(() => {
      starts.push(Date.now())
      return 'first'
    }))
    const second = limiter.execute(() => Promise.resolve().then(() => {
      starts.push(Date.now())
      return 'second'
    }))

    await expect(first).resolves.toBe('first')
    expect(starts).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(second).resolves.toBe('second')
    expect(starts).toHaveLength(2)
    const [firstStart, secondStart] = starts
    expect(secondStart - firstStart).toBeGreaterThanOrEqual(60_000)

    vi.useRealTimers()
  })

  test('rejects new work when the queue is full', async () => {
    vi.useFakeTimers()

    const limiter = createRateLimiterService({
      enabled: true,
      maxConcurrency: 1,
      maxQueueSize: 1,
      maxRequestsPerMinute: 10,
    })

    const blocker = limiter.execute(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('done'), 1_000)
        }),
    )
    const queued = limiter.execute(() => Promise.resolve('queued'))

    await expect(limiter.execute(() => Promise.resolve('overflow'))).rejects.toThrow(
      'Rate limit queue overflow',
    )

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(blocker).resolves.toBe('done')
    await expect(queued).resolves.toBe('queued')

    vi.useRealTimers()
  })

  test('uses the distributed store to coordinate outbound start slots', async () => {
    vi.useFakeTimers()

    const claimSlot = vi.fn()
      .mockResolvedValueOnce({
        allowed: true,
        count: 1,
        resetAt: Date.now() + 60_000,
      })
      .mockResolvedValueOnce({
        allowed: false,
        count: 1,
        resetAt: Date.now() + 60_000,
      })
      .mockResolvedValueOnce({
        allowed: true,
        count: 1,
        resetAt: Date.now() + 120_000,
      })

    const limiter = createRateLimiterService({
      enabled: true,
      maxConcurrency: 2,
      maxQueueSize: 10,
      maxRequestsPerMinute: 1,
      scopeKey: 'merchant:123',
      store: { claimSlot },
    })

    const starts: number[] = []
    const first = limiter.execute(() => Promise.resolve().then(() => {
      starts.push(Date.now())
      return 'first'
    }))
    const second = limiter.execute(() => Promise.resolve().then(() => {
      starts.push(Date.now())
      return 'second'
    }))

    await expect(first).resolves.toBe('first')
    expect(starts).toHaveLength(1)
    expect(claimSlot).toHaveBeenCalledWith({
      key: 'merchant:123',
      limit: 1,
      scope: 'outbound',
      windowMs: 60_000,
    })

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(second).resolves.toBe('second')
    expect(starts).toHaveLength(2)

    vi.useRealTimers()
  })
})
