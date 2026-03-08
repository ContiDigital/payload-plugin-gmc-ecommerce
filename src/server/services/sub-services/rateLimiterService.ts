import type { DistributedRateLimitStore } from '../../../types/index.js'

type RateLimiterConfig = {
  enabled: boolean
  maxConcurrency: number
  maxQueueSize: number
  maxRequestsPerMinute: number
  scopeKey?: string
  store?: DistributedRateLimitStore
}

type QueueItem<T> = {
  reject: (reason: unknown) => void
  resolve: (value: T) => void
  task: () => Promise<T>
}

export class RateLimitQueueOverflowError extends Error {
  public readonly statusCode = 429

  constructor(queueSize: number) {
    super(`Rate limit queue overflow: ${queueSize} items in queue, refusing new work`)
    this.name = 'RateLimitQueueOverflowError'
  }
}

export const createRateLimiterService = (config: RateLimiterConfig) => {
  let activeCount = 0
  const queue: QueueItem<unknown>[] = []
  const startedAtTimestamps: number[] = []
  let processing = false
  let scheduledTimer: null | ReturnType<typeof setTimeout> = null

  const pruneStartedAt = (now: number): void => {
    const cutoff = now - 60_000
    while (startedAtTimestamps.length > 0 && startedAtTimestamps[0] <= cutoff) {
      startedAtTimestamps.shift()
    }
  }

  const getWaitTimeMs = (now: number): number => {
    if (!config.enabled || config.maxRequestsPerMinute < 1) {
      return 0
    }

    pruneStartedAt(now)
    if (startedAtTimestamps.length < config.maxRequestsPerMinute) {
      return 0
    }

    const oldestStart = startedAtTimestamps[0]
    if (!oldestStart) {
      return 0
    }

    return Math.max(1, oldestStart + 60_000 - now)
  }

  const scheduleNextAttempt = (delayMs: number): void => {
    if (scheduledTimer) {
      return
    }

    scheduledTimer = setTimeout(() => {
      scheduledTimer = null
      void processNext()
    }, delayMs)
  }

  const startItem = (item: QueueItem<unknown>): void => {
    activeCount++

    item
      .task()
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        activeCount--
        void processNext()
      })
  }

  const reserveDistributedSlot = async (now: number): Promise<{ allowed: boolean; waitTimeMs?: number }> => {
    if (!config.store || !config.enabled || config.maxRequestsPerMinute < 1) {
      return { allowed: true }
    }

    // Prune stale local timestamps to prevent unbounded growth
    pruneStartedAt(now)

    const reservation = await config.store.claimSlot({
      key: config.scopeKey ?? 'global',
      limit: config.maxRequestsPerMinute,
      scope: 'outbound',
      windowMs: 60_000,
    })

    if (!reservation.allowed) {
      return {
        allowed: false,
        waitTimeMs: Math.max(1, reservation.resetAt - now),
      }
    }

    startedAtTimestamps.push(now)
    return { allowed: true }
  }

  const reserveLocalSlot = (now: number): { allowed: boolean; waitTimeMs?: number } => {
    const waitTimeMs = getWaitTimeMs(now)
    if (waitTimeMs > 0) {
      return { allowed: false, waitTimeMs }
    }

    startedAtTimestamps.push(now)
    return { allowed: true }
  }

  const reserveStartSlot = async (now: number): Promise<{ allowed: boolean; waitTimeMs?: number }> => {
    if (!config.enabled) {
      return { allowed: true }
    }

    if (config.store) {
      return reserveDistributedSlot(now)
    }

    return reserveLocalSlot(now)
  }

  const processNext = async (): Promise<void> => {
    if (processing) {
      return
    }

    processing = true

    try {
      if (!config.enabled) {
        while (activeCount < config.maxConcurrency && queue.length > 0) {
          const item = queue.shift()
          if (!item) {
            return
          }
          startItem(item)
        }
        return
      }

      while (activeCount < config.maxConcurrency && queue.length > 0) {
        const reservation = await reserveStartSlot(Date.now())
        if (!reservation.allowed) {
          scheduleNextAttempt(reservation.waitTimeMs ?? 1)
          return
        }

        const item = queue.shift()
        if (!item) {
          return
        }

        startItem(item)
      }
    } finally {
      processing = false

      if (!scheduledTimer && queue.length > 0 && activeCount < config.maxConcurrency) {
        void processNext()
      }
    }
  }

  const execute = <T>(task: () => Promise<T>): Promise<T> => {
    if (!config.enabled) {
      return task()
    }

    if (
      !config.store &&
      !processing &&
      queue.length === 0 &&
      activeCount < config.maxConcurrency &&
      getWaitTimeMs(Date.now()) === 0
    ) {
      startedAtTimestamps.push(Date.now())
      activeCount++

      return task().finally(() => {
        activeCount--
        void processNext()
      })
    }

    if (queue.length >= config.maxQueueSize) {
      return Promise.reject(new RateLimitQueueOverflowError(queue.length))
    }

    return new Promise<T>((resolve, reject) => {
      queue.push({ reject, resolve, task } as QueueItem<unknown>)
      void processNext()
    })
  }

  const getStats = () => ({
    activeCount,
    queueSize: queue.length,
    requestsInWindow: startedAtTimestamps.length,
  })

  const drain = (): void => {
    if (scheduledTimer) {
      clearTimeout(scheduledTimer)
      scheduledTimer = null
    }
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) {
        return
      }
      item.reject(new Error('Rate limiter drained'))
    }
  }

  return { drain, execute, getStats }
}

export type RateLimiterService = ReturnType<typeof createRateLimiterService>
