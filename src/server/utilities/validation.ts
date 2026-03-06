export class ValidationError extends Error {
  public readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export const requireString = (
  value: unknown,
  fieldName: string,
): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} is required and must be a non-empty string`)
  }
  return value.trim()
}

export const requirePositiveInteger = (
  value: unknown,
  fieldName: string,
  defaultValue?: number,
): number => {
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) {
      return defaultValue
    }
    throw new ValidationError(`${fieldName} is required`)
  }

  const num = Number(value)
  if (!Number.isFinite(num) || num < 1) {
    throw new ValidationError(`${fieldName} must be a positive integer`)
  }

  return Math.floor(num)
}

export const parseSyncProductInput = (body: Record<string, unknown>): { productId: string } => {
  return { productId: requireString(body.productId, 'productId') }
}

export const parseBatchInput = (body: Record<string, unknown>): {
  filter?: Record<string, unknown>
  productIds?: string[]
} => {
  const productIds = body.productIds as string[] | undefined
  const filter = body.filter as Record<string, unknown> | undefined

  if (productIds !== undefined) {
    if (!Array.isArray(productIds)) {
      throw new ValidationError('productIds must be an array of strings')
    }
    for (let i = 0; i < productIds.length; i++) {
      if (typeof productIds[i] !== 'string' || productIds[i].trim().length === 0) {
        throw new ValidationError(`productIds[${i}] must be a non-empty string`)
      }
    }
  }

  if (filter !== undefined) {
    if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
      throw new ValidationError('filter must be a plain object')
    }
  }

  return { filter, productIds }
}

export const parseInitialSyncInput = (body: Record<string, unknown>): {
  batchSize?: number
  dryRun?: boolean
  limit?: number
  onlyIfRemoteMissing?: boolean
} => {
  return {
    batchSize: body.batchSize !== undefined
      ? requirePositiveInteger(body.batchSize, 'batchSize')
      : undefined,
    dryRun: typeof body.dryRun === 'boolean' ? body.dryRun : undefined,
    limit: body.limit !== undefined
      ? requirePositiveInteger(body.limit, 'limit')
      : undefined,
    onlyIfRemoteMissing: typeof body.onlyIfRemoteMissing === 'boolean'
      ? body.onlyIfRemoteMissing
      : undefined,
  }
}

export const parseAnalyticsInput = (body: Record<string, unknown>): {
  productId: string
  rangeDays: number
} => {
  return {
    productId: requireString(body.productId, 'productId'),
    rangeDays: requirePositiveInteger(body.rangeDays, 'rangeDays', 30),
  }
}
