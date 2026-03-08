import {
  FIELD_SYNC_MODES,
  type FieldSyncMode,
  type MCProductIdentity,
  TRANSFORM_PRESETS,
  type TransformPreset,
} from '../../types/index.js'

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

export const requireIdentifierString = (
  value: unknown,
  fieldName: string,
): string => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }

  return requireString(value, fieldName)
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

export const requireNonNegativeInteger = (
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
  if (!Number.isFinite(num) || num < 0) {
    throw new ValidationError(`${fieldName} must be a non-negative integer`)
  }

  return Math.floor(num)
}

export const parseSyncProductInput = (body: Record<string, unknown>): { productId: string } => {
  return { productId: requireIdentifierString(body.productId, 'productId') }
}

export const parseDeleteProductInput = (
  body: Record<string, unknown>,
): {
  identity?: Partial<MCProductIdentity> & Pick<MCProductIdentity, 'offerId'>
  productId: string
} => {
  const { productId } = parseSyncProductInput(body)
  const rawIdentity = body.identity

  if (rawIdentity === undefined) {
    return { productId }
  }

  if (typeof rawIdentity !== 'object' || rawIdentity === null || Array.isArray(rawIdentity)) {
    throw new ValidationError('identity must be a plain object')
  }

  const identityRecord = rawIdentity as Record<string, unknown>
  const identity: Partial<MCProductIdentity> & Pick<MCProductIdentity, 'offerId'> = {
    offerId: requireString(identityRecord.offerId, 'identity.offerId'),
    ...(typeof identityRecord.contentLanguage === 'string'
      ? { contentLanguage: identityRecord.contentLanguage.trim() }
      : {}),
    ...(typeof identityRecord.dataSourceOverride === 'string'
      ? { dataSourceOverride: identityRecord.dataSourceOverride.trim() }
      : {}),
    ...(typeof identityRecord.feedLabel === 'string'
      ? { feedLabel: identityRecord.feedLabel.trim() }
      : {}),
  }

  return { identity, productId }
}

export const parseBatchInput = (body: Record<string, unknown>): {
  filter?: Record<string, unknown>
  productIds?: string[]
} => {
  const rawProductIds = body.productIds
  const filter = body.filter as Record<string, unknown> | undefined

  let productIds: string[] | undefined

  if (rawProductIds !== undefined) {
    if (!Array.isArray(rawProductIds)) {
      throw new ValidationError('productIds must be an array of strings')
    }

    productIds = rawProductIds.map((productId, index) =>
      requireIdentifierString(productId, `productIds[${index}]`),
    )
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
    productId: requireIdentifierString(body.productId, 'productId'),
    rangeDays: requirePositiveInteger(body.rangeDays, 'rangeDays', 30),
  }
}

export const parseMappingsInput = (body: Record<string, unknown>): {
  mappings: Array<{
    order: number
    source: string
    syncMode: (typeof FIELD_SYNC_MODES)[number]
    target: string
    transformPreset: (typeof TRANSFORM_PRESETS)[number]
  }>
} => {
  const rawMappings = body.mappings

  if (!Array.isArray(rawMappings)) {
    throw new ValidationError('mappings must be an array')
  }

  const mappings = rawMappings.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ValidationError(`mappings[${index}] must be a plain object`)
    }

    const source = requireString((raw as Record<string, unknown>).source, `mappings[${index}].source`)
    const target = requireString((raw as Record<string, unknown>).target, `mappings[${index}].target`)

    const syncMode = (raw as Record<string, unknown>).syncMode
    if (typeof syncMode !== 'string' || !FIELD_SYNC_MODES.includes(syncMode as never)) {
      throw new ValidationError(
        `mappings[${index}].syncMode must be one of: ${FIELD_SYNC_MODES.join(', ')}`,
      )
    }

    const rawPreset = (raw as Record<string, unknown>).transformPreset
    const transformPreset =
      typeof rawPreset === 'string' && rawPreset.length > 0 ? rawPreset : 'none'
    if (!TRANSFORM_PRESETS.includes(transformPreset as never)) {
      throw new ValidationError(
        `mappings[${index}].transformPreset must be one of: ${TRANSFORM_PRESETS.join(', ')}`,
      )
    }

    return {
      order: raw.order !== undefined
        ? requireNonNegativeInteger(raw.order, `mappings[${index}].order`)
        : index,
      source,
      syncMode: syncMode as FieldSyncMode,
      target,
      transformPreset: transformPreset as TransformPreset,
    }
  })

  return { mappings }
}
