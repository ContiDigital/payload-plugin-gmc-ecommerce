import type { MCProductIdentity } from '../types/index.js'
import type { NormalizedGmcV2Options } from './types.js'

export const resolveGmcDataSourceName = (
  identity: MCProductIdentity,
  options: Pick<NormalizedGmcV2Options, 'dataSourceName' | 'dataSourceNames' | 'merchantId'>,
): string => {
  const override = identity.dataSourceOverride?.trim()
  if (!override) {
    return options.dataSourceName
  }
  const resolved = override.startsWith('accounts/')
    ? override
    : `accounts/${options.merchantId}/dataSources/${override}`
  if (!options.dataSourceNames.includes(resolved)) {
    throw new TypeError('dataSourceOverride must name an explicitly configured API data source')
  }
  return resolved
}

export const normalizeGmcIdentityRoute = (
  identity: MCProductIdentity,
  options: Pick<NormalizedGmcV2Options, 'dataSourceName' | 'dataSourceNames' | 'merchantId'>,
): MCProductIdentity => {
  const dataSourceName = resolveGmcDataSourceName(identity, options)
  return {
    contentLanguage: identity.contentLanguage,
    dataSourceOverride: dataSourceName === options.dataSourceName ? undefined : dataSourceName,
    feedLabel: identity.feedLabel,
    offerId: identity.offerId,
  }
}

export const getMerchantProductId = (identity: MCProductIdentity): string => {
  return `${identity.contentLanguage}~${identity.feedLabel}~${identity.offerId}`
}

export const getProductInputName = (identity: MCProductIdentity, merchantId: string): string => {
  const encoded = Buffer.from(getMerchantProductId(identity), 'utf8').toString('base64url')
  return `accounts/${merchantId}/productInputs/${encoded}`
}

export const getProcessedProductName = (
  identity: MCProductIdentity,
  merchantId: string,
): string => {
  const encoded = Buffer.from(getMerchantProductId(identity), 'utf8').toString('base64url')
  return `accounts/${merchantId}/products/${encoded}`
}
