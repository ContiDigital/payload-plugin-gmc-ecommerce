import { describe, expect, test, vi } from 'vitest'

import { createRetryService } from '../retryService.js'

describe('createRetryService', () => {
  test('retries retryable status-code errors and logs the retry', async () => {
    vi.useFakeTimers()

    const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() }
    const service = createRetryService({
      baseRetryDelayMs: 100,
      jitterFactor: 0,
      maxRetries: 1,
      maxRetryDelayMs: 1000,
    }, logger)

    const fn = vi.fn()
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValueOnce('ok')

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

  test('does not retry non-retryable errors', async () => {
    const service = createRetryService({
      baseRetryDelayMs: 100,
      jitterFactor: 0,
      maxRetries: 2,
      maxRetryDelayMs: 1000,
    })

    const fn = vi.fn().mockRejectedValue(new Error('validation failed'))

    await expect(service.execute(fn, { operation: 'pushProduct' })).rejects.toThrow('validation failed')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
