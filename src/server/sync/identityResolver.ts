import type {
  MCProductIdentity,
  MCProductState,
  NormalizedPluginOptions,
  PayloadProductDoc,
  ResolvedMCIdentity,
} from '../../types/index.js'

import { MC_FIELD_GROUP_NAME } from '../../constants.js'
import { getByPath } from '../utilities/pathUtils.js'

/**
 * Coerce a value to string only if it is a primitive (string, number, boolean).
 * Returns empty string for objects/arrays to prevent "[object Object]" IDs.
 */
const coercePrimitiveToString = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return ''
}

type IdentityResult =
  | { errors: string[]; ok: false }
  | { ok: true; value: ResolvedMCIdentity }

export const resolveIdentity = (
  product: PayloadProductDoc | Record<string, unknown>,
  options: NormalizedPluginOptions,
): IdentityResult => {
  const mcState = product[MC_FIELD_GROUP_NAME] as MCProductState | undefined
  const identity: Partial<MCProductIdentity> | undefined = mcState?.identity

  const rawIdentityFieldValue = getByPath(product as Record<string, unknown>, options.collections.products.identityField)
  const offerId = identity?.offerId
    ?? coercePrimitiveToString(rawIdentityFieldValue)

  const contentLanguage = identity?.contentLanguage
    ?? options.defaults.contentLanguage

  const feedLabel = identity?.feedLabel
    ?? options.defaults.feedLabel

  const dataSourceOverride = identity?.dataSourceOverride

  const errors: string[] = []

  if (!offerId || offerId.trim().length === 0) {
    errors.push(
      `offerId is required: set it on the Merchant Center tab or ensure "${options.collections.products.identityField}" has a value`,
    )
  }

  if (!contentLanguage || contentLanguage.trim().length === 0) {
    errors.push('contentLanguage is required')
  }

  if (!feedLabel || feedLabel.trim().length === 0) {
    errors.push('feedLabel is required')
  }

  if (!options.merchantId) {
    errors.push('merchantId is not configured')
  }

  if (!options.dataSourceId && !dataSourceOverride) {
    errors.push('dataSourceId is not configured and no per-product override is set')
  }

  if (errors.length > 0) {
    return { errors, ok: false }
  }

  const trimmedOfferId = offerId.trim()
  const trimmedContentLanguage = contentLanguage.trim()
  const trimmedFeedLabel = feedLabel.trim()

  const merchantProductId = `${trimmedContentLanguage}~${trimmedFeedLabel}~${trimmedOfferId}`

  const effectiveDataSource = dataSourceOverride
    ? `accounts/${options.merchantId}/dataSources/${dataSourceOverride}`
    : options.dataSourceName

  return {
    ok: true,
    value: {
      contentLanguage: trimmedContentLanguage,
      dataSourceName: effectiveDataSource,
      dataSourceOverride,
      feedLabel: trimmedFeedLabel,
      merchantProductId,
      offerId: trimmedOfferId,
      productInputName: `accounts/${options.merchantId}/productInputs/${merchantProductId}`,
      productName: `accounts/${options.merchantId}/products/${merchantProductId}`,
    },
  }
}
