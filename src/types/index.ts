import type { CollectionSlug, Config, Payload, PayloadRequest } from 'payload'

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const SYNC_MODES = ['manual', 'onChange', 'scheduled'] as const
export type SyncMode = (typeof SYNC_MODES)[number]

export const FIELD_SYNC_MODES = ['permanent', 'initialOnly'] as const
export type FieldSyncMode = (typeof FIELD_SYNC_MODES)[number]

export const SYNC_STATES = ['idle', 'syncing', 'success', 'error'] as const
export type SyncState = (typeof SYNC_STATES)[number]

export const SYNC_SOURCES = ['push', 'pull', 'initial'] as const
export type SyncSource = (typeof SYNC_SOURCES)[number]

export const SYNC_ACTIONS = ['saveSync', 'refresh', 'delete', 'initialSync', 'pullSync'] as const
export type SyncAction = (typeof SYNC_ACTIONS)[number]

export const CONFLICT_STRATEGIES = ['mc-wins', 'payload-wins', 'newest-wins'] as const
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number]

export const ADMIN_MODES = ['route', 'dashboard', 'both', 'headless'] as const
export type AdminMode = (typeof ADMIN_MODES)[number]

export const JOB_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const JOB_TYPES = ['push', 'pull', 'initialSync', 'pullAll', 'batch'] as const
export type JobType = (typeof JOB_TYPES)[number]

export const MC_AVAILABILITY = ['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'BACKORDER'] as const
export type MCAvailability = (typeof MC_AVAILABILITY)[number]

export const MC_CONDITION = ['NEW', 'USED', 'REFURBISHED'] as const
export type MCCondition = (typeof MC_CONDITION)[number]

export const MC_AGE_GROUP = ['newborn', 'infant', 'toddler', 'kids', 'adult'] as const
export type MCAgeGroup = (typeof MC_AGE_GROUP)[number]

export const MC_GENDER = ['male', 'female', 'unisex'] as const
export type MCGender = (typeof MC_GENDER)[number]

export const MC_SIZE_TYPE = ['regular', 'petite', 'plus', 'tall', 'maternity'] as const
export type MCSizeType = (typeof MC_SIZE_TYPE)[number]

export const TRANSFORM_PRESETS = [
  'none',
  'toMicros',
  'toMicrosString',
  'extractUrl',
  'extractAbsoluteUrl',
  'toArray',
  'toString',
  'toBoolean',
] as const
export type TransformPreset = (typeof TRANSFORM_PRESETS)[number]

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

export type ResolvedMCIdentity = {
  dataSourceName: string
  merchantProductId: string
  productInputName: string
  productName: string
} & MCProductIdentity

// ---------------------------------------------------------------------------
// Merchant Center price
// ---------------------------------------------------------------------------

export type MCPrice = {
  amountMicros: string
  currencyCode: string
}

// ---------------------------------------------------------------------------
// Merchant Center shipping
// ---------------------------------------------------------------------------

export type MCShipping = {
  country?: string
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

// ---------------------------------------------------------------------------
// Merchant Center tax
// ---------------------------------------------------------------------------

export type MCTax = {
  country?: string
  rate?: number
  region?: string
  taxShip?: boolean
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
  adult?: boolean
  ageGroup?: string
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
  energyEfficiencyClass?: string
  excludedDestinations?: MCArrayField
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
  link?: string
  material?: string
  maxEnergyEfficiencyClass?: string
  minEnergyEfficiencyClass?: string
  mobileLink?: string
  mpn?: string
  multipack?: number
  pattern?: string
  pause?: string
  price?: MCPrice
  productHeight?: MCShippingDimension
  productLength?: MCShippingDimension
  productTypes?: MCArrayField
  productWeight?: MCShippingDimension
  productWidth?: MCShippingDimension
  promotionIds?: MCArrayField
  salePrice?: MCPrice
  salePriceEffectiveDate?: { endDate?: string; startDate?: string }
  shipping?: MCShipping[]
  shippingHeight?: MCShippingDimension
  shippingLength?: MCShippingDimension
  shippingWeight?: MCShippingDimension
  shippingWidth?: MCShippingDimension
  size?: string
  sizeSystem?: string
  sizeType?: string
  taxes?: MCTax[]
  title?: string
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
  offerId: string
  productAttributes?: MCProductAttributes
}

// ---------------------------------------------------------------------------
// Merchant Center sync metadata (stored on product documents)
// ---------------------------------------------------------------------------

export type MCSyncMeta = {
  dirty?: boolean
  lastAction?: SyncAction
  lastError?: string
  lastSyncedAt?: string
  state: SyncState
  syncSource?: SyncSource
}

// ---------------------------------------------------------------------------
// Merchant Center product state (the full group stored on products)
// ---------------------------------------------------------------------------

export type MCProductState = {
  customAttributes?: MCCustomAttribute[]
  enabled?: boolean
  identity?: Partial<MCProductIdentity>
  productAttributes?: MCProductAttributes
  snapshot?: Record<string, unknown>
  syncMeta?: MCSyncMeta
}

// ---------------------------------------------------------------------------
// Payload product document with MC fields injected by the plugin.
// Used internally to avoid casting through Record<string, unknown> when
// accessing the merchant center group on Payload documents.
// ---------------------------------------------------------------------------

export type PayloadProductDoc = {
  id: number | string
  merchantCenter?: MCProductState
} & Record<string, unknown>

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

export type FieldMapping = {
  order?: number
  source: string
  syncMode: FieldSyncMode
  target: string
  transformPreset?: TransformPreset
}

// ---------------------------------------------------------------------------
// Sync results
// ---------------------------------------------------------------------------

export type SyncResult = {
  action: 'delete' | 'insert' | 'update'
  productId: string
  snapshot?: Record<string, unknown>
  success: boolean
}

export type PullResult = {
  action: 'pull'
  populatedFields: string[]
  productId: string
  success: boolean
}

export type BatchSyncReport = {
  completedAt?: string
  errors: Array<{ message: string; offerId?: string; productId: string }>
  failed: number
  jobId: string
  processed: number
  startedAt: string
  status: JobStatus
  succeeded: number
  total: number
}

export type InitialSyncReport = {
  dryRun: boolean
  existingRemote: number
  skipped: number
} & BatchSyncReport

export type PullAllReport = {
  matched: number
  orphaned: number
} & BatchSyncReport

// ---------------------------------------------------------------------------
// Merchant Center analytics (from Reports API)
// ---------------------------------------------------------------------------

export type MCPerformanceRow = {
  clicks: number
  clickThroughRate: number
  conversions: number
  date: string
  impressions: number
}

export type MCProductAnalytics = {
  merchantProductId: string
  performance: MCPerformanceRow[]
  status?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthResult = {
  admin: { mode: AdminMode }
  jobs?: {
    queueName: string
    runnerRequired: boolean
    strategy: 'external' | 'payload-jobs'
    workerBasePath: string
    workerEndpointsEnabled: boolean
  }
  merchant: { accountId: string; dataSourceId: string }
  rateLimit: { distributed?: boolean; enabled: boolean }
  status: 'ok'
  sync: { mode: SyncMode }
  timestamp: string
}

export type DeepHealthResult = {
  apiConnection: 'error' | 'ok'
  apiError?: string
} & HealthResult

// ---------------------------------------------------------------------------
// Plugin options (user-facing)
// ---------------------------------------------------------------------------

export type ProductsCollectionConfig = {
  autoInjectTab?: boolean
  /** Depth used when fetching product documents for push/sync operations. Higher values hydrate more relationship levels (uploads, brands, etc.). Default: 1 */
  fetchDepth?: number
  fieldMappings?: FieldMapping[]
  identityField: string
  slug: CollectionSlug
  tabPosition?: 'append' | 'before-last' | number
}

export type CategoriesCollectionConfig = {
  googleCategoryIdField?: string
  nameField: string
  parentField?: string
  /** The field on the *product* document that holds the relationship to this categories collection */
  productCategoryField?: string
  /** Category field to use for MC `productTypes` (breadcrumb paths). Defaults to `nameField` if not set. */
  productTypeField?: string
  slug: CollectionSlug
}

export type ScheduleConfig = {
  /** API key for authenticating external scheduler requests (required for 'external' strategy) */
  apiKey?: string
  /** Cron expression for scheduled sync (default: '0 4 * * *' = 4am daily) */
  cron?: string
  /** Which strategy to use for scheduled sync */
  strategy?: 'external' | 'payload-jobs'
}

export type SyncConfig = {
  conflictStrategy?: ConflictStrategy
  initialSync?: {
    batchSize?: number
    dryRun?: boolean
    enabled?: boolean
    onlyIfRemoteMissing?: boolean
  }
  mode?: SyncMode
  permanentSync?: boolean
  /** Schedule config — only used when mode is 'scheduled' */
  schedule?: ScheduleConfig
  scheduleCron?: string
}

export type AdminConfig = {
  mode?: AdminMode
  navLabel?: string
  route?: `/${string}`
}

export type APIConfig = {
  basePath?: `/${string}`
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

export type BeforePushHookArgs = {
  doc: Record<string, unknown>
  operation: 'delete' | 'insert' | 'update'
  payload: Payload
  productInput: MCProductInput
}

export type BeforePushHook = (
  args: BeforePushHookArgs,
) => MCProductInput | Promise<MCProductInput>

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

export type PayloadGMCEcommercePluginOptions = {
  access?: AccessFn
  admin?: AdminConfig
  api?: APIConfig
  /** Called before each product is pushed to Merchant Center. Return a modified MCProductInput to customise what gets sent. */
  beforePush?: BeforePushHook
  collections: {
    categories?: CategoriesCollectionConfig
    products: ProductsCollectionConfig
  }
  dataSourceId: string
  defaults?: {
    condition?: string
    contentLanguage?: string
    currency?: string
    feedLabel?: string
  }
  disabled?: boolean
  getCredentials: GetCredentialsFn
  merchantId: string
  rateLimit?: RateLimitConfig
  /** Base URL of your site (e.g. 'https://example.com'). Used by extractAbsoluteUrl transform to resolve relative media URLs. */
  siteUrl?: string
  sync?: SyncConfig
}

// ---------------------------------------------------------------------------
// Normalized plugin options (internal, all defaults resolved)
// ---------------------------------------------------------------------------

export type NormalizedPluginOptions = {
  access?: AccessFn
  admin: {
    mode: AdminMode
    navLabel: string
    route: `/${string}`
  }
  api: {
    basePath: `/${string}`
  }
  beforePush?: BeforePushHook
  collections: {
    categories?: Required<CategoriesCollectionConfig>
    products: Required<ProductsCollectionConfig>
  }
  dataSourceId: string
  dataSourceName: string
  defaults: {
    condition: string
    contentLanguage: string
    currency: string
    feedLabel: string
  }
  disabled: boolean
  getCredentials: GetCredentialsFn
  merchantId: string
  rateLimit: {
    baseRetryDelayMs: number
    enabled: boolean
    jitterFactor: number
    maxConcurrency: number
    maxQueueSize: number
    maxRequestsPerMinute: number
    maxRetries: number
    maxRetryDelayMs: number
    requestTimeoutMs: number
    store?: DistributedRateLimitStore
  }
  siteUrl: string
  sync: {
    conflictStrategy: ConflictStrategy
    initialSync: {
      batchSize: number
      dryRun: boolean
      enabled: boolean
      onlyIfRemoteMissing: boolean
    }
    mode: SyncMode
    permanentSync: boolean
    schedule: {
      apiKey: string
      cron: string
      strategy: 'external' | 'payload-jobs'
    }
    scheduleCron: string
  }
}

// ---------------------------------------------------------------------------
// Plugin type alias
// ---------------------------------------------------------------------------

export type Plugin = Exclude<Config['plugins'], undefined>[number]
