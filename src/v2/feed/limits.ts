export const GMC_V2_DEFAULT_FEED_LIMITS = {
  maxProducts: 10_000,
  maxSerializedBytes: 64 * 1024 * 1024,
} as const

export class GmcFeedLimitError extends RangeError {
  readonly code = 'GMC_FEED_LIMIT_EXCEEDED'

  constructor(message: string) {
    super(message)
    this.name = 'GmcFeedLimitError'
  }
}
