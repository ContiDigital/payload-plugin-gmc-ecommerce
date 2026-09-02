import type { Payload, PayloadRequest } from 'payload'

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const MC_AVAILABILITY = [
  'IN_STOCK',
  'LIMITED_AVAILABILITY',
  'OUT_OF_STOCK',
  'PREORDER',
  'BACKORDER',
] as const
export type MCAvailability = (typeof MC_AVAILABILITY)[number]

export const MC_CONDITION = ['NEW', 'USED', 'REFURBISHED'] as const
export type MCCondition = (typeof MC_CONDITION)[number]

// ---------------------------------------------------------------------------
// Google service account
// ---------------------------------------------------------------------------

export type GoogleServiceAccount = {
  client_email: string
  private_key: string
  project_id?: string
}

export type CredentialResolution =
  | { credentials: GoogleServiceAccount; type: 'json' }
  | { path: string; type: 'keyFilename' }

export type GetCredentialsFn = (args: {
  payload: null | Payload
  req?: PayloadRequest
}) => Promise<CredentialResolution>

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

export type AccessFn = (args: {
  payload: Payload
  req: PayloadRequest
  user: PayloadRequest['user']
}) => boolean | Promise<boolean>

// ---------------------------------------------------------------------------
// Merchant Center product identity
// ---------------------------------------------------------------------------

export type MCProductIdentity = {
  contentLanguage: string
  dataSourceOverride?: string
  feedLabel: string
  offerId: string
}

// ---------------------------------------------------------------------------
// Merchant Center price
// ---------------------------------------------------------------------------

export type MCPrice = {
  amountMicros: string
  currencyCode: string
}

/** Merchant API shared Interval: inclusive start, exclusive end. */
export type MCInterval = {
  endTime?: string
  startTime?: string
}

export type MCProductDetail = {
  attributeName: string
  attributeValue: string
  sectionName?: string
}

export type MCStructuredContent = {
  content: string
  digitalSourceType?: 'DEFAULT' | 'DIGITAL_SOURCE_TYPE_UNSPECIFIED' | 'TRAINED_ALGORITHMIC_MEDIA'
}

// ---------------------------------------------------------------------------
// Merchant Center shipping
// ---------------------------------------------------------------------------

/**
 * Google's documented shipping sub-attributes. Text feeds declare this layout
 * in the column header and serialize the sub-attributes in a fixed positional
 * order, so a sub-attribute added by Google later must be mapped deliberately
 * rather than appended.
 */
export type MCShipping = {
  country?: string
  locationGroupName?: string
  locationId?: string
  maxHandlingTime?: string
  maxTransitTime?: string
  minHandlingTime?: string
  minTransitTime?: string
  postalCode?: string
  price?: MCPrice
  region?: string
  service?: string
}

export type MCShippingDimension = {
  unit?: string
  value?: number
}

export type MCFreeShippingThreshold = {
  country?: string
  priceThreshold?: MCPrice
}

export type MCAttributeValueRow = {
  value: string
}

export type MCAttributeUrlRow = {
  url: string
}

export type MCArrayField = MCAttributeValueRow[] | string[]
export type MCUrlArrayField = MCAttributeUrlRow[] | string[]

// ---------------------------------------------------------------------------
// Merchant Center product attributes
// ---------------------------------------------------------------------------

export type MCProductAttributes = {
  additionalImageLinks?: MCUrlArrayField
  adsGrouping?: string
  adsLabels?: MCArrayField
  adsRedirect?: string
  adult?: boolean
  ageGroup?: string
  autoPricingMinPrice?: MCPrice
  availability?: string
  availabilityDate?: string
  brand?: string
  canonicalLink?: string
  color?: string
  condition?: string
  costOfGoodsSold?: MCPrice
  customLabel0?: string
  customLabel1?: string
  customLabel2?: string
  customLabel3?: string
  customLabel4?: string
  description?: string
  disclosureDate?: string
  displayAdsId?: string
  displayAdsLink?: string
  displayAdsSimilarIds?: MCArrayField
  displayAdsTitle?: string
  displayAdsValue?: number
  energyEfficiencyClass?: string
  excludedDestinations?: MCArrayField
  expirationDate?: string
  externalSellerId?: string
  freeShippingThreshold?: MCFreeShippingThreshold[]
  gender?: string
  googleProductCategory?: string
  gtins?: MCArrayField
  identifierExists?: boolean
  imageLink?: string
  includedDestinations?: MCArrayField
  isBundle?: boolean
  itemGroupId?: string
  lifestyleImageLinks?: MCUrlArrayField
  link?: string
  linkTemplate?: string
  material?: string
  maxEnergyEfficiencyClass?: string
  maxHandlingTime?: string
  maximumRetailPrice?: MCPrice
  minEnergyEfficiencyClass?: string
  minHandlingTime?: string
  mobileLink?: string
  mobileLinkTemplate?: string
  mpn?: string
  multipack?: number | string
  pattern?: string
  pause?: string
  pickupMethod?: string
  pickupSla?: string
  price?: MCPrice
  productDetails?: MCProductDetail[]
  productHeight?: MCShippingDimension
  productHighlights?: string[]
  productLength?: MCShippingDimension
  productTypes?: MCArrayField
  productWeight?: MCShippingDimension
  productWidth?: MCShippingDimension
  promotionIds?: MCArrayField
  returnPolicyLabel?: string
  salePrice?: MCPrice
  salePriceEffectiveDate?: MCInterval
  sellOnGoogleQuantity?: string
  shipping?: MCShipping[]
  shippingHeight?: MCShippingDimension
  shippingLabel?: string
  shippingLength?: MCShippingDimension
  shippingWeight?: MCShippingDimension
  shippingWidth?: MCShippingDimension
  shoppingAdsExcludedCountries?: MCArrayField
  shortTitle?: string
  size?: string
  sizeSystem?: string
  /** @deprecated Merchant API v1 uses the repeated `sizeTypes` field. */
  sizeType?: string
  sizeTypes?: string[]
  structuredDescription?: MCStructuredContent
  structuredTitle?: MCStructuredContent
  title?: string
  transitTimeLabel?: string
  videoLinks?: MCUrlArrayField
  virtualModelLink?: string
}

// ---------------------------------------------------------------------------
// Merchant Center custom attributes
// ---------------------------------------------------------------------------

export type MCCustomAttribute = {
  name: string
  value: string
}

// ---------------------------------------------------------------------------
// Merchant Center product input (what we send to the API)
// ---------------------------------------------------------------------------

export type MCProductInput = {
  contentLanguage: string
  customAttributes?: MCCustomAttribute[]
  feedLabel: string
  /**
   * Merchant API v1 replacement for the Content API `LOCAL` channel: true marks
   * an offer sold only in physical stores.
   */
  legacyLocal?: boolean
  offerId: string
  productAttributes?: MCProductAttributes
}

// ---------------------------------------------------------------------------

export type DistributedRateLimitScope = 'inbound' | 'outbound'

export type DistributedRateLimitReservation = {
  allowed: boolean
  count: number
  resetAt: number
}

export type DistributedRateLimitStore = {
  claimSlot: (args: {
    key: string
    limit: number
    scope: DistributedRateLimitScope
    windowMs: number
  }) => Promise<DistributedRateLimitReservation>
}

export type RateLimitConfig = {
  baseRetryDelayMs?: number
  enabled?: boolean
  jitterFactor?: number
  maxConcurrency?: number
  maxQueueSize?: number
  maxRequestsPerMinute?: number
  maxRetries?: number
  maxRetryDelayMs?: number
  requestTimeoutMs?: number
  store?: DistributedRateLimitStore
}
