type RateLimiterConfig = {
  maxConcurrency: number
  maxQueueSize: number
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

  const processNext = (): void => {
    if (activeCount >= config.maxConcurrency || queue.length === 0) {
      return
    }

    const item = queue.shift()!
    activeCount++

    item
      .task()
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        activeCount--
        processNext()
      })
  }

  const execute = <T>(task: () => Promise<T>): Promise<T> => {
    if (queue.length >= config.maxQueueSize) {
      return Promise.reject(new RateLimitQueueOverflowError(queue.length))
    }

    return new Promise<T>((resolve, reject) => {
      queue.push({ reject, resolve, task } as QueueItem<unknown>)
      processNext()
    })
  }

  const getStats = () => ({
    activeCount,
    queueSize: queue.length,
  })

  const drain = (): void => {
    while (queue.length > 0) {
      const item = queue.shift()!
      item.reject(new Error('Rate limiter drained'))
    }
  }

  return { drain, execute, getStats }
}

export type RateLimiterService = ReturnType<typeof createRateLimiterService>
