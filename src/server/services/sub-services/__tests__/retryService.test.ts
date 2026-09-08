import { describe, expect, test, vi } from 'vitest'

import { GoogleTransportError } from '../googleApiClient.js'
import { createRetryService } from '../retryService.js'

describe('createRetryService', () => {
  test('retries retryable status-code errors and logs the retry', async () => {
    vi.useFakeTimers()

    const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() }
    const service = createRetryService(
      {
        baseRetryDelayMs: 100,
        jitterFactor: 0,
        maxRetries: 1,
        maxRetryDelayMs: 1000,
      },
      logger,
    )

    const fn = vi.fn().mockRejectedValueOnce({ statusCode: 503 }).mockResolvedValueOnce('ok')

    const resultPromise = service.execute(fn, { operation: 'pushProduct', productId: 'prod-1' })
    await vi.advanceTimersByTimeAsync(100)

    await expect(resultPromise).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(
      '[GMC Retry] pushProduct attempt 1/1 failed, retrying in 100ms',
      { merchantProductId: undefined, productId: 'prod-1' },
    )

    vi.useRealTimers()
  })

  test('retries wrapped Google transport failures without retrying arbitrary TypeErrors', async () => {
    vi.useFakeTimers()
    const service = createRetryService({
      baseRetryDelayMs: 100,
      jitterFactor: 0,
      maxRetries: 1,
      maxRetryDelayMs: 1000,
    })
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new GoogleTransportError('Merchant API transport failed', new TypeError('fetch failed')),
      )
      .mockResolvedValueOnce('ok')

    const result = service.execute(fn, { operation: 'insertProductInput' })
    await vi.advanceTimersByTimeAsync(100)
    await expect(result).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  test('does not retry non-retryable errors', async () => {
    const service = createRetryService({
      baseRetryDelayMs: 100,
      jitterFactor: 0,
      maxRetries: 2,
      maxRetryDelayMs: 1000,
    })

    const fn = vi.fn().mockRejectedValue(new Error('validation failed'))

    await expect(service.execute(fn, { operation: 'pushProduct' })).rejects.toThrow(
      'validation failed',
    )
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('never infers retryability from unstable human-readable error text', async () => {
    const service = createRetryService({
      baseRetryDelayMs: 100,
      jitterFactor: 0,
      maxRetries: 2,
      maxRetryDelayMs: 1000,
    })
    const fn = vi.fn().mockRejectedValue(new Error('validation failed with status 503'))

    await expect(service.execute(fn, { operation: 'insertProductInput' })).rejects.toThrow(
      'validation failed with status 503',
    )
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('retries stable transient Merchant ErrorInfo reasons even on a non-retryable status', async () => {
    vi.useFakeTimers()
    const service = createRetryService({
      baseRetryDelayMs: 100,
      jitterFactor: 0,
      maxRetries: 1,
      maxRetryDelayMs: 1000,
    })
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ reason: 'INTERNAL_ERROR', statusCode: 400 })
      .mockResolvedValueOnce('ok')

    const result = service.execute(fn, { operation: 'insertProductInput' })
    await vi.advanceTimersByTimeAsync(100)
    await expect(result).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  test('does not amplify an explicit daily Merchant quota exhaustion through retries', async () => {
    const service = createRetryService({
      baseRetryDelayMs: 100,
      jitterFactor: 0,
      maxRetries: 2,
      maxRetryDelayMs: 1000,
    })
    const fn = vi.fn().mockRejectedValue({ reason: 'QUOTA_TOO_MANY_REQUESTS', statusCode: 429 })

    await expect(service.execute(fn, { operation: 'insertProductInput' })).rejects.toMatchObject({
      reason: 'QUOTA_TOO_MANY_REQUESTS',
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('honors Retry-After without exceeding the configured hard delay cap', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() }
    const service = createRetryService(
      {
        baseRetryDelayMs: 900,
        jitterFactor: 1,
        maxRetries: 1,
        maxRetryDelayMs: 1_000,
      },
      logger,
    )
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ retryAfterMs: 5_000, statusCode: 429 })
      .mockResolvedValueOnce('ok')

    const result = service.execute(fn, { operation: 'insertProductInput' })
    await vi.advanceTimersByTimeAsync(999)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toBe('ok')
    expect(logger.warn.mock.calls[0]?.[0]).toContain('1000ms')

    vi.restoreAllMocks()
    vi.useRealTimers()
  })
})
