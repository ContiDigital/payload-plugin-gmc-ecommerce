/** Runtime constants used by the v2 Merchant API transport. */
export const GOOGLE_AUTH_SCOPES = ['https://www.googleapis.com/auth/content'] as const

export const MERCHANT_API_BASE_URL = 'https://merchantapi.googleapis.com'

export const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

/**
 * Stable Merchant API AIP-193 `details.metadata.REASON` values which can
 * succeed unchanged after backoff. HTTP status remains the broad fallback for
 * sub-APIs which have not yet rolled out ErrorInfo.
 */
export const RETRYABLE_MERCHANT_ERROR_REASONS = new Set([
  'CONFLICT_CONCURRENT_MODIFICATION',
  'INTERNAL_ERROR',
  'QUOTA_REQUEST_RATE_TOO_HIGH',
  'QUOTA_REQUEST_RATE_TOO_HIGH_FOR_FREQUENT_PRODUCT_UPDATES',
])

export const isRetryableMerchantApiError = (args: {
  reason?: string
  statusCode: number
}): boolean => {
  if (args.reason && RETRYABLE_MERCHANT_ERROR_REASONS.has(args.reason)) {
    return true
  }
  // Daily/account limits do not recover on exponential backoff. Preserve the
  // durable failure for operator action instead of amplifying it through every
  // local and queue retry merely because Google reports HTTP 429.
  if (args.reason === 'QUOTA_TOO_MANY_REQUESTS' || args.reason?.startsWith('QUOTA_EXCEEDED_')) {
    return false
  }
  return RETRYABLE_STATUS_CODES.has(args.statusCode)
}
