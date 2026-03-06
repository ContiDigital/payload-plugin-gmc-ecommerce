import { RETRYABLE_STATUS_CODES } from '../../../constants.js'

type RetryConfig = {
  baseRetryDelayMs: number
  jitterFactor: number
  maxRetries: number
  maxRetryDelayMs: number
}

type RetryContext = {
  merchantProductId?: string
  operation: string
  productId?: string
}

type Logger = {
  debug: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

const isRetryableError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const statusMatch = error.message.match(/status[:\s]+(\d{3})/i)
    if (statusMatch) {
      return RETRYABLE_STATUS_CODES.has(Number(statusMatch[1]))
    }
  }

  if (typeof error === 'object' && error !== null) {
    const statusCode = (error as Record<string, unknown>).statusCode
      ?? (error as Record<string, unknown>).status
    if (typeof statusCode === 'number') {
      return RETRYABLE_STATUS_CODES.has(statusCode)
    }
  }

  return false
}

const computeDelay = (attempt: number, config: RetryConfig): number => {
  const exponentialDelay = Math.min(
    config.maxRetryDelayMs,
    config.baseRetryDelayMs * Math.pow(2, attempt),
  )
  const jitter = exponentialDelay * config.jitterFactor * Math.random()
  return exponentialDelay + jitter
}

export const createRetryService = (config: RetryConfig, logger?: Logger) => {
  const execute = async <T>(
    fn: () => Promise<T>,
    context: RetryContext,
  ): Promise<T> => {
    let lastError: unknown

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error

        if (attempt >= config.maxRetries || !isRetryableError(error)) {
          throw error
        }

        const delayMs = computeDelay(attempt, config)
        logger?.warn(
          `[GMC Retry] ${context.operation} attempt ${attempt + 1}/${config.maxRetries} failed, retrying in ${Math.round(delayMs)}ms`,
          {
            merchantProductId: context.merchantProductId,
            productId: context.productId,
          },
        )

        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }

    throw lastError
  }

  return { execute }
}

export type RetryService = ReturnType<typeof createRetryService>
