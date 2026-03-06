import type { PayloadRequest } from 'payload'

import type { NormalizedPluginOptions } from '../../types/index.js'

const WINDOW_MS = 60_000
const MAX_BUCKETS = 10_000

type Bucket = {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
let pruneCounter = 0

export class InboundRateLimitExceededError extends Error {
  public readonly statusCode = 429

  constructor(limit: number) {
    super(`Rate limit exceeded: ${limit} requests per minute`)
    this.name = 'InboundRateLimitExceededError'
  }
}

const resolveClientId = (req: PayloadRequest): string => {
  const headers = req.headers
  if (headers instanceof Headers) {
    const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) {return forwarded}
    const realIp = headers.get('x-real-ip')
    if (realIp) {return realIp}
  }
  return 'unknown'
}

const pruneExpired = (now: number): void => {
  for (const [k, b] of buckets) {
    if (now >= b.resetAt) {
      buckets.delete(k)
    }
  }
}

export const assertInboundRateLimit = (
  req: PayloadRequest,
  options: NormalizedPluginOptions,
  routeKey: string,
): void => {
  if (!options.rateLimit.enabled) {
    return
  }

  const clientId = resolveClientId(req)
  const key = `${routeKey}:${clientId}`
  const now = Date.now()

  let bucket = buckets.get(key)

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS }
    buckets.set(key, bucket)
  }

  bucket.count++

  if (bucket.count > options.rateLimit.maxRequestsPerMinute) {
    throw new InboundRateLimitExceededError(options.rateLimit.maxRequestsPerMinute)
  }

  // Lazy pruning with hard cap on Map size to prevent memory exhaustion
  // from spoofed client identifiers
  pruneCounter++
  if (pruneCounter >= 100 || buckets.size > MAX_BUCKETS) {
    pruneCounter = 0
    pruneExpired(now)

    // If still over cap after pruning expired entries, evict oldest
    if (buckets.size > MAX_BUCKETS) {
      const excess = buckets.size - MAX_BUCKETS
      const iter = buckets.keys()
      for (let i = 0; i < excess; i++) {
        const next = iter.next()
        if (next.done) {break}
        buckets.delete(next.value)
      }
    }
  }
}
