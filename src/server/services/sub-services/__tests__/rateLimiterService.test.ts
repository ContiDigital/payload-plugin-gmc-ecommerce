import { describe, expect, test, vi } from 'vitest'

import {
  createRateLimiterService,
  RateLimitQueueOverflowError,
  RateLimitStoreError,
} from '../rateLimiterService.js'
import { createRetryService } from '../retryService.js'

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
    const first = limiter.execute(() =>
      Promise.resolve().then(() => {
        starts.push(Date.now())
        return 'first'
      }),
    )
    const second = limiter.execute(() =>
      Promise.resolve().then(() => {
        starts.push(Date.now())
        return 'second'
      }),
    )

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

  test('queue overflow is a terminal backpressure signal a durable retry service must not retry', async () => {
    const limiter = createRateLimiterService({
      enabled: true,
      maxConcurrency: 0,
      maxQueueSize: 0,
      maxRequestsPerMinute: 10,
    })
    const retryService = createRetryService({
      baseRetryDelayMs: 1,
      jitterFactor: 0,
      maxRetries: 2,
      maxRetryDelayMs: 10,
    })
    const task = vi.fn(() => limiter.execute(() => Promise.resolve('unreachable')))

    await expect(retryService.execute(task, { operation: 'insertProductInput' })).rejects.toThrow(
      RateLimitQueueOverflowError,
    )
    expect(task).toHaveBeenCalledTimes(1)
  })

  test('uses the distributed store to coordinate outbound start slots', async () => {
    vi.useFakeTimers()

    const clockStart = Date.now()
    let claimCount = 0
    let observeDenial: () => void = () => undefined
    const denialObserved = new Promise<void>((resolve) => {
      observeDenial = resolve
    })
    const claimSlot = vi.fn(() => {
      claimCount++
      if (claimCount === 2) {
        observeDenial()
        return Promise.resolve({
          allowed: false,
          count: 1,
          resetAt: clockStart + 60_000,
        })
      }
      return Promise.resolve({
        allowed: true,
        count: 1,
        resetAt: clockStart + (claimCount === 1 ? 60_000 : 120_000),
      })
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
    let releaseFirst: () => void = () => undefined
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = limiter.execute(async () => {
      starts.push(Date.now())
      await firstCanFinish
      return 'first'
    })
    const second = limiter.execute(() =>
      Promise.resolve().then(() => {
        starts.push(Date.now())
        return 'second'
      }),
    )

    await denialObserved
    expect(starts).toHaveLength(1)
    expect(claimSlot).toHaveBeenCalledTimes(2)
    expect(claimSlot).toHaveBeenCalledWith({
      key: 'merchant:123',
      limit: 1,
      scope: 'outbound',
      windowMs: 60_000,
    })

    releaseFirst()
    await expect(first).resolves.toBe('first')
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(second).resolves.toBe('second')
    expect(starts).toHaveLength(2)
    expect(claimSlot).toHaveBeenCalledTimes(3)

    vi.useRealTimers()
  })

  test('rejects queued work cleanly when the distributed limiter is unavailable', async () => {
    const limiterError = new Error('distributed limiter unavailable')
    const task = vi.fn(() => Promise.resolve('must not run'))
    const limiter = createRateLimiterService({
      enabled: true,
      maxConcurrency: 1,
      maxQueueSize: 10,
      maxRequestsPerMinute: 1,
      store: { claimSlot: vi.fn(() => Promise.reject(limiterError)) },
    })

    await expect(limiter.execute(task)).rejects.toMatchObject({
      name: 'RateLimitStoreError',
      cause: limiterError,
      code: 'GMC_RATE_LIMIT_STORE',
      retryable: true,
    })
    expect(task).not.toHaveBeenCalled()
    expect(limiter.getStats()).toMatchObject({ activeCount: 0, queueSize: 0 })
  })

  test('fails closed on a malformed distributed reservation', async () => {
    const limiter = createRateLimiterService({
      enabled: true,
      maxConcurrency: 1,
      maxQueueSize: 10,
      maxRequestsPerMinute: 1,
      store: {
        claimSlot: vi.fn(() =>
          Promise.resolve({
            allowed: true,
            count: Number.NaN,
            resetAt: Number.NaN,
          }),
        ),
      },
    })

    await expect(limiter.execute(() => Promise.resolve('unsafe'))).rejects.toThrow(
      RateLimitStoreError,
    )
    await expect(limiter.execute(() => Promise.resolve('unsafe'))).rejects.toThrow(
      /invalid reservation/i,
    )
  })

  test('fails closed instead of scheduling an implausibly distant reset', async () => {
    vi.useFakeTimers()
    const task = vi.fn(() => Promise.resolve('unsafe'))
    const limiter = createRateLimiterService({
      enabled: true,
      maxConcurrency: 1,
      maxQueueSize: 10,
      maxRequestsPerMinute: 1,
      store: {
        claimSlot: vi.fn(() =>
          Promise.resolve({
            allowed: false,
            count: 1,
            resetAt: Date.now() + 2_147_483_648,
          }),
        ),
      },
    })

    await expect(limiter.execute(task)).rejects.toThrow(/implausible reset time/i)
    expect(task).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  test('rejects a distributed reset beyond one limiter window plus clock skew', async () => {
    vi.useFakeTimers()
    const task = vi.fn(() => Promise.resolve('unsafe'))
    const limiter = createRateLimiterService({
      enabled: true,
      maxConcurrency: 1,
      maxQueueSize: 10,
      maxRequestsPerMinute: 1,
      store: {
        claimSlot: vi.fn(() =>
          Promise.resolve({ allowed: false, count: 1, resetAt: Date.now() + 65_001 }),
        ),
      },
    })

    await expect(limiter.execute(task)).rejects.toThrow(/implausible reset time/i)
    expect(task).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  test('backs off a denied reservation whose reset is slightly behind the worker clock', async () => {
    vi.useFakeTimers()
    const claimSlot = vi
      .fn()
      .mockResolvedValueOnce({ allowed: false, count: 1, resetAt: Date.now() - 1_000 })
      .mockResolvedValueOnce({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })
    const limiter = createRateLimiterService({
      enabled: true,
      maxConcurrency: 1,
      maxQueueSize: 10,
      maxRequestsPerMinute: 1,
      store: { claimSlot },
    })
    const work = limiter.execute(() => Promise.resolve('safe'))

    await vi.advanceTimersByTimeAsync(99)
    expect(claimSlot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(work).resolves.toBe('safe')
    expect(claimSlot).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
