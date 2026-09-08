import { isRetryableMerchantApiError } from '../../../v2/runtimeConstants.js'
import { GoogleTransportError } from './googleApiClient.js'

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

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

const isRetryableError = (error: unknown): boolean => {
  if (error instanceof GoogleTransportError) {
    return true
  }
  if (error instanceof Error) {
    // Network-level errors (Node.js / undici)
    const code = (error as NodeJS.ErrnoException).code
    if (code && RETRYABLE_ERROR_CODES.has(code)) {
      return true
    }

    // AbortError from fetch timeout
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return true
    }
  }

  if (typeof error === 'object' && error !== null) {
    const statusCode =
      (error as Record<string, unknown>).statusCode ?? (error as Record<string, unknown>).status
    if (typeof statusCode === 'number') {
      const reason = (error as { reason?: unknown }).reason
      return isRetryableMerchantApiError({
        reason: typeof reason === 'string' ? reason : undefined,
        statusCode,
      })
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
  return Math.min(config.maxRetryDelayMs, exponentialDelay + jitter)
}

const retryAfterMsFrom = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') {
    return undefined
  }
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export const createRetryService = (config: RetryConfig, logger?: Logger) => {
  const execute = async <T>(fn: () => Promise<T>, context: RetryContext): Promise<T> => {
    let lastError: unknown

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error

        if (attempt >= config.maxRetries || !isRetryableError(error)) {
          throw error
        }

        const delayMs = Math.min(
          config.maxRetryDelayMs,
          Math.max(computeDelay(attempt, config), retryAfterMsFrom(error) ?? 0),
        )
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
