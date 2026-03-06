import type { MCProductIdentity, NormalizedPluginOptions, ResolvedMCIdentity } from '../../types/index.js'

import { getByPath } from '../utilities/pathUtils.js'

type IdentityResult =
  | { errors: string[]; ok: false }
  | { ok: true; value: ResolvedMCIdentity }

export const resolveIdentity = (
  product: Record<string, unknown>,
  options: NormalizedPluginOptions,
): IdentityResult => {
  const mcState = product.merchantCenter as Record<string, unknown> | undefined
  const identity = mcState?.identity as Partial<MCProductIdentity> | undefined

  const offerId = (identity?.offerId as string)
    ?? String(getByPath(product, options.collections.products.identityField) as string ?? '')

  const contentLanguage = (identity?.contentLanguage as string)
    ?? options.defaults.contentLanguage

  const feedLabel = (identity?.feedLabel as string)
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
