// ---------------------------------------------------------------------------
// Plugin identity
// ---------------------------------------------------------------------------

export const PLUGIN_SLUG = 'payload-plugin-gmc-ecommerce'

// ---------------------------------------------------------------------------
// Admin defaults
// ---------------------------------------------------------------------------

export const DEFAULT_ADMIN_ROUTE_PATH = '/merchant-center'
export const DEFAULT_ADMIN_NAV_LABEL = 'Merchant Center'

// ---------------------------------------------------------------------------
// API defaults
// ---------------------------------------------------------------------------

export const DEFAULT_API_BASE_PATH = '/gmc'
export const MERCHANT_API_BASE_URL = 'https://merchantapi.googleapis.com'
export const GOOGLE_AUTH_SCOPES = ['https://www.googleapis.com/auth/content']

// ---------------------------------------------------------------------------
// Collection slugs
// ---------------------------------------------------------------------------

export const GMC_FIELD_MAPPINGS_SLUG = 'gmc-field-mappings'
export const GMC_SYNC_LOG_SLUG = 'gmc-sync-log'
export const GMC_SYNC_QUEUE_NAME = 'gmc-sync'
export const GMC_PUSH_PRODUCT_TASK_SLUG = 'gmcPushProduct'
export const GMC_DELETE_PRODUCT_TASK_SLUG = 'gmcDeleteProduct'
export const GMC_SYNC_DIRTY_TASK_SLUG = 'gmcSyncDirty'
export const GMC_BATCH_PUSH_TASK_SLUG = 'gmcBatchPush'
export const GMC_INITIAL_SYNC_TASK_SLUG = 'gmcInitialSync'
export const GMC_PULL_ALL_TASK_SLUG = 'gmcPullAll'

// ---------------------------------------------------------------------------
// Product defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONTENT_LANGUAGE = 'en'
export const DEFAULT_FEED_LABEL = 'PRODUCTS'
export const DEFAULT_CURRENCY = 'USD'
export const DEFAULT_CONDITION = 'NEW'

// ---------------------------------------------------------------------------
// Sync defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SYNC_MODE = 'manual'
export const DEFAULT_SCHEDULE_CRON = '0 4 * * *'
export const DEFAULT_INITIAL_SYNC_ENABLED = true
export const DEFAULT_INITIAL_SYNC_DRY_RUN = true
export const DEFAULT_INITIAL_SYNC_BATCH_SIZE = 100
export const DEFAULT_INITIAL_SYNC_ONLY_IF_REMOTE_MISSING = true

// ---------------------------------------------------------------------------
// Rate limiting & retry defaults
// ---------------------------------------------------------------------------

export const DEFAULT_RATE_LIMIT_ENABLED = true
export const DEFAULT_MAX_CONCURRENCY = 4
export const DEFAULT_MAX_QUEUE_SIZE = 200
export const DEFAULT_MAX_RETRIES = 4
export const DEFAULT_BASE_RETRY_DELAY_MS = 300
export const DEFAULT_MAX_RETRY_DELAY_MS = 4_000
export const DEFAULT_RETRY_JITTER_FACTOR = 0.2
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 120

// ---------------------------------------------------------------------------
// Retryable HTTP status codes
// ---------------------------------------------------------------------------

export const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_PAGE_SIZE = 250
export const BATCH_PROGRESS_INTERVAL_MS = 2_000

// ---------------------------------------------------------------------------
// Merchant Center field group name on product documents
// ---------------------------------------------------------------------------

export const MC_FIELD_GROUP_NAME = 'mc'
export const MC_PRODUCT_ATTRIBUTES_FIELD_NAME = 'attrs'
export const MC_SYNC_META_DIRTY_PATH = `${MC_FIELD_GROUP_NAME}.syncMeta.dirty`
export const MC_IDENTITY_OFFER_ID_PATH = `${MC_FIELD_GROUP_NAME}.identity.offerId`

// ---------------------------------------------------------------------------
// Merchant Center product attributes field catalog
// Used for generating UI fields and update masks.
// ---------------------------------------------------------------------------

export const MC_PRODUCT_ATTRIBUTE_FIELDS = [
  // Basic info
  'title',
  'description',
  'link',
  'mobileLink',
  'canonicalLink',
  'imageLink',
  'additionalImageLinks',

  // Price
  'price',
  'salePrice',
  'salePriceEffectiveDate',
  'costOfGoodsSold',

  // Categorization
  'googleProductCategory',
  'productTypes',
  'brand',
  'gtins',
  'mpn',
  'identifierExists',

  // Product details
  'condition',
  'adult',
  'ageGroup',
  'availability',
  'availabilityDate',
  'color',
  'gender',
  'material',
  'pattern',
  'size',
  'sizeType',
  'sizeSystem',
  'itemGroupId',

  // Dimensions
  'productWeight',
  'productLength',
  'productWidth',
  'productHeight',

  // Shipping
  'shipping',
  'shippingWeight',
  'shippingLength',
  'shippingWidth',
  'shippingHeight',
  'freeShippingThreshold',

  // Tax
  'taxes',

  // Custom labels
  'customLabel0',
  'customLabel1',
  'customLabel2',
  'customLabel3',
  'customLabel4',

  // Additional
  'multipack',
  'isBundle',
  'energyEfficiencyClass',
  'minEnergyEfficiencyClass',
  'maxEnergyEfficiencyClass',
  'promotionIds',
  'excludedDestinations',
  'includedDestinations',
  'externalSellerId',
  'pause',
] as const

export type MCProductAttributeField = (typeof MC_PRODUCT_ATTRIBUTE_FIELDS)[number]
