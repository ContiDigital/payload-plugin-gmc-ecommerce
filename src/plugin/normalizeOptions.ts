import type {
  AdminMode,
  CategoriesCollectionConfig,
  ConflictStrategy,
  NormalizedLocalInventoryConfig,
  NormalizedPluginOptions,
  PayloadGMCEcommercePluginOptions,
  SyncMode,
} from '../types/index.js'

import {
  DEFAULT_ADMIN_NAV_LABEL,
  DEFAULT_ADMIN_ROUTE_PATH,
  DEFAULT_API_BASE_PATH,
  DEFAULT_BASE_RETRY_DELAY_MS,
  DEFAULT_CONDITION,
  DEFAULT_CONTENT_LANGUAGE,
  DEFAULT_CURRENCY,
  DEFAULT_FEED_LABEL,
  DEFAULT_INITIAL_SYNC_BATCH_SIZE,
  DEFAULT_INITIAL_SYNC_DRY_RUN,
  DEFAULT_INITIAL_SYNC_ENABLED,
  DEFAULT_INITIAL_SYNC_ONLY_IF_REMOTE_MISSING,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_QUEUE_SIZE,
  DEFAULT_MAX_REQUESTS_PER_MINUTE,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_RATE_LIMIT_ENABLED,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_JITTER_FACTOR,
  DEFAULT_SCHEDULE_CRON,
  DEFAULT_SYNC_MODE,
  PLUGIN_SLUG,
} from '../constants.js'

// ---------------------------------------------------------------------------
// Primitive normalizers
// ---------------------------------------------------------------------------

const normalizePath = (value: string): `/${string}` => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) {
    return `/${trimmed}`
  }
  return trimmed as `/${string}`
}

const normalizePositiveInteger = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(1, Math.floor(value))
}

const normalizeNonNegativeInteger = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(0, Math.floor(value))
}

const normalizeFloat01 = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(0, Math.min(1, value))
}

const normalizeNonEmptyString = (value: string | undefined, fallback: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback
  }
  return value.trim()
}

// ---------------------------------------------------------------------------
// Domain normalizers
// ---------------------------------------------------------------------------

const normalizeAdminMode = (value: string | undefined): AdminMode => {
  if (value === 'both' || value === 'dashboard' || value === 'headless' || value === 'route') {
    return value
  }
  return 'route'
}

const normalizeSyncMode = (value: string | undefined): SyncMode => {
  if (value === 'manual' || value === 'onChange' || value === 'scheduled') {
    return value
  }
  return DEFAULT_SYNC_MODE
}

const normalizeConflictStrategy = (value: string | undefined): ConflictStrategy => {
  if (value === 'mc-wins' || value === 'payload-wins' || value === 'newest-wins') {
    return value
  }
  return 'newest-wins'
}

const normalizeLocalInventory = (
  config: PayloadGMCEcommercePluginOptions['localInventory'],
): NormalizedLocalInventoryConfig => {
  if (!config || !config.enabled) {
    return { enabled: false, storeCode: '' }
  }

  if (!config.storeCode || typeof config.storeCode !== 'string' || config.storeCode.trim().length === 0) {
    throw new Error(`${PLUGIN_SLUG}: localInventory.storeCode is required when localInventory is enabled`)
  }

  return {
    availabilityResolver: config.availabilityResolver,
    enabled: true,
    pickup: config.pickup,
    storeCode: config.storeCode.trim(),
  }
}

const normalizeCategories = (
  config: CategoriesCollectionConfig | undefined,
): Required<CategoriesCollectionConfig> | undefined => {
  if (!config) {
    return undefined
  }

  if (!config.slug) {
    throw new Error(`${PLUGIN_SLUG}: collections.categories.slug is required`)
  }

  if (!config.nameField || typeof config.nameField !== 'string') {
    throw new Error(`${PLUGIN_SLUG}: collections.categories.nameField is required`)
  }

  return {
    slug: config.slug,
    googleCategoryIdField: config.googleCategoryIdField ?? '',
    nameField: config.nameField,
    parentField: config.parentField ?? '',
    productCategoryField: config.productCategoryField ?? '',
    productTypeField: config.productTypeField ?? '',
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const normalizePluginOptions = (
  options: PayloadGMCEcommercePluginOptions,
): NormalizedPluginOptions => {
  if (options.disabled) {
    return buildNormalizedOptions(options, { disabled: true })
  }

  const merchantId = (options.merchantId ?? '').trim()
  if (!merchantId) {
    throw new Error(`${PLUGIN_SLUG}: merchantId is required`)
  }

  const dataSourceId = (options.dataSourceId ?? '').trim()
  if (!dataSourceId) {
    throw new Error(`${PLUGIN_SLUG}: dataSourceId is required`)
  }

  if (typeof options.getCredentials !== 'function') {
    throw new Error(`${PLUGIN_SLUG}: getCredentials must be a function`)
  }

  if (!options.collections?.products?.slug) {
    throw new Error(`${PLUGIN_SLUG}: collections.products.slug is required`)
  }

  if (!options.collections.products.identityField) {
    throw new Error(`${PLUGIN_SLUG}: collections.products.identityField is required`)
  }

  return buildNormalizedOptions(options, { disabled: false })
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const buildNormalizedOptions = (
  options: PayloadGMCEcommercePluginOptions,
  overrides: { disabled: boolean },
): NormalizedPluginOptions => {
  const merchantId = (options.merchantId ?? '').trim()
  const dataSourceId = (options.dataSourceId ?? '').trim()

  return {
    access: options.access,
    admin: {
      mode: normalizeAdminMode(options.admin?.mode),
      navLabel: options.admin?.navLabel ?? DEFAULT_ADMIN_NAV_LABEL,
      route: normalizePath(options.admin?.route ?? DEFAULT_ADMIN_ROUTE_PATH),
    },
    api: {
      basePath: normalizePath(options.api?.basePath ?? DEFAULT_API_BASE_PATH),
    },
    beforePush: options.beforePush,
    collections: {
      categories: normalizeCategories(options.collections?.categories),
      products: {
        slug: options.collections?.products?.slug ?? ('products' as never),
        autoInjectTab: options.collections?.products?.autoInjectTab ?? true,
        fetchDepth: options.collections?.products?.fetchDepth ?? 1,
        fieldMappings: options.collections?.products?.fieldMappings ?? [],
        identityField: options.collections?.products?.identityField ?? 'id',
        tabPosition: options.collections?.products?.tabPosition ?? 'append',
      },
    },
    dataSourceId,
    dataSourceName: merchantId && dataSourceId
      ? `accounts/${merchantId}/dataSources/${dataSourceId}`
      : '',
    defaults: {
      condition: normalizeNonEmptyString(options.defaults?.condition, DEFAULT_CONDITION),
      contentLanguage: normalizeNonEmptyString(
        options.defaults?.contentLanguage,
        DEFAULT_CONTENT_LANGUAGE,
      ),
      currency: normalizeNonEmptyString(options.defaults?.currency, DEFAULT_CURRENCY),
      feedLabel: normalizeNonEmptyString(options.defaults?.feedLabel, DEFAULT_FEED_LABEL),
    },
    disabled: overrides.disabled,
    getCredentials: options.getCredentials,
    localInventory: normalizeLocalInventory(options.localInventory),
    merchantId,
    rateLimit: {
      baseRetryDelayMs: normalizePositiveInteger(
        options.rateLimit?.baseRetryDelayMs,
        DEFAULT_BASE_RETRY_DELAY_MS,
      ),
      enabled: options.rateLimit?.enabled ?? DEFAULT_RATE_LIMIT_ENABLED,
      jitterFactor: normalizeFloat01(
        options.rateLimit?.jitterFactor,
        DEFAULT_RETRY_JITTER_FACTOR,
      ),
      maxConcurrency: normalizePositiveInteger(
        options.rateLimit?.maxConcurrency,
        DEFAULT_MAX_CONCURRENCY,
      ),
      maxQueueSize: normalizePositiveInteger(
        options.rateLimit?.maxQueueSize,
        DEFAULT_MAX_QUEUE_SIZE,
      ),
      maxRequestsPerMinute: normalizePositiveInteger(
        options.rateLimit?.maxRequestsPerMinute,
        DEFAULT_MAX_REQUESTS_PER_MINUTE,
      ),
      maxRetries: normalizeNonNegativeInteger(
        options.rateLimit?.maxRetries,
        DEFAULT_MAX_RETRIES,
      ),
      maxRetryDelayMs: normalizePositiveInteger(
        options.rateLimit?.maxRetryDelayMs,
        DEFAULT_MAX_RETRY_DELAY_MS,
      ),
      requestTimeoutMs: normalizePositiveInteger(
        options.rateLimit?.requestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
      ),
      store: options.rateLimit?.store,
    },
    siteUrl: (options.siteUrl ?? '').trim().replace(/\/+$/, ''),
    sync: {
      conflictStrategy: normalizeConflictStrategy(options.sync?.conflictStrategy),
      initialSync: {
        batchSize: normalizePositiveInteger(
          options.sync?.initialSync?.batchSize,
          DEFAULT_INITIAL_SYNC_BATCH_SIZE,
        ),
        dryRun: options.sync?.initialSync?.dryRun ?? DEFAULT_INITIAL_SYNC_DRY_RUN,
        enabled: options.sync?.initialSync?.enabled ?? DEFAULT_INITIAL_SYNC_ENABLED,
        onlyIfRemoteMissing: options.sync?.initialSync?.onlyIfRemoteMissing
          ?? DEFAULT_INITIAL_SYNC_ONLY_IF_REMOTE_MISSING,
      },
      mode: normalizeSyncMode(options.sync?.mode),
      permanentSync: options.sync?.permanentSync ?? false,
      schedule: {
        apiKey: options.sync?.schedule?.apiKey ?? '',
        cron: normalizeNonEmptyString(
          options.sync?.schedule?.cron ?? options.sync?.scheduleCron,
          DEFAULT_SCHEDULE_CRON,
        ),
        strategy: options.sync?.schedule?.strategy === 'payload-jobs' ? 'payload-jobs' : 'external',
      },
      scheduleCron: normalizeNonEmptyString(options.sync?.scheduleCron, DEFAULT_SCHEDULE_CRON),
    },
  }
}
