import type { RateLimitConfig } from '../types/index.js'
import type {
  GmcAsyncAdapter,
  GmcCatalogDependencyConfig,
  GmcCatalogGlobalDependencyConfig,
  GmcFeedConfig,
  GmcProductSourceConfig,
  NormalizedGmcV2Options,
  PayloadGmcEcommerceV2Options,
} from './types.js'

import { hasDefaultPluginAccess } from '../server/utilities/access.js'
import { GMC_V2_DEFAULT_FEED_LIMITS } from './feed/limits.js'

const DEFAULT_RATE_LIMIT = {
  baseRetryDelayMs: 1_000,
  enabled: true,
  jitterFactor: 0.2,
  maxConcurrency: 4,
  maxQueueSize: 1_000,
  maxRequestsPerMinute: 60,
  maxRetries: 5,
  maxRetryDelayMs: 60_000,
  requestTimeoutMs: 30_000,
} as const

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })

/**
 * Validates a required string option and returns it trimmed. The type
 * parameter lets a caller keep a host's narrower slug type (`CollectionSlug`,
 * `GlobalSlug`) on the normalized value: the runtime check is the same, and
 * the widening happens once here rather than at every call site.
 */
const requireNonEmpty = <T extends string = string>(name: string, value: unknown): T => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`payload-plugin-gmc-ecommerce/v2: ${name} is required`)
  }
  return value.trim() as T
}

const payloadCollectionSlug = (name: string, value: unknown): string => {
  const slug = requireNonEmpty(name, value)
  if (!/^[A-Z][\w-]{0,99}$/i.test(slug)) {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: ${name} must start with a letter and contain at most 100 letters, digits, underscores, or hyphens`,
    )
  }
  return slug
}

const normalizeRoute = (name: string, value: unknown): `/${string}` => {
  const route = requireNonEmpty(name, value)
  if (
    !route.startsWith('/') ||
    route.includes('?') ||
    route.includes('#') ||
    route.includes('//') ||
    route.includes('\\') ||
    /\s/.test(route) ||
    hasControlCharacters(route) ||
    route.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: ${name} must be an absolute path without query or fragment`,
    )
  }
  return (route.length > 1 ? route.replace(/\/+$/, '') : route) as `/${string}`
}

const positiveInteger = (
  name: string,
  value: number | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const candidate = value ?? fallback
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > maximum) {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: ${name} must be a positive integer no greater than ${maximum}`,
    )
  }
  return candidate
}

const nonNegativeInteger = (
  name: string,
  value: number | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const candidate = value ?? fallback
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > maximum) {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: ${name} must be a non-negative integer no greater than ${maximum}`,
    )
  }
  return candidate
}

const resourceSegment = (name: string, value: unknown): string => {
  const segment = requireNonEmpty(name, value)
  if (segment.length > 200 || !/^[\w.~-]+$/.test(segment)) {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: ${name} must be a 1-200 character URL-safe resource ID`,
    )
  }
  return segment
}

const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n

/**
 * Merchant API account and data-source IDs are positive int64 values. Disabled
 * configurations may retain inert placeholders so hosts do not need production
 * secrets merely to compile or run unrelated local tooling.
 */
const merchantResourceId = (name: string, value: unknown, disabled: boolean): string => {
  const segment = resourceSegment(name, value)
  if (disabled) {
    return segment
  }
  if (!/^[1-9]\d{0,18}$/.test(segment) || BigInt(segment) > MAX_SIGNED_INT64) {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: ${name} must be a positive canonical int64 Merchant API resource ID`,
    )
  }
  return segment
}

const assertAsyncAdapter = (adapter: GmcAsyncAdapter): void => {
  if (
    !adapter ||
    typeof adapter.dispatch !== 'function' ||
    typeof adapter.getOperation !== 'function' ||
    typeof adapter.health !== 'function'
  ) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: async.dispatch, async.getOperation, and async.health are required',
    )
  }
  const adapterName = requireNonEmpty('async.name', adapter.name)
  if (adapterName.length > 100 || hasControlCharacters(adapterName)) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: async.name must contain 1-100 safe characters',
    )
  }
  if (adapter.install !== undefined && typeof adapter.install !== 'function') {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: async.install must be a function')
  }
}

const normalizeFeed = (
  feed: GmcFeedConfig,
  seenIds: Set<string>,
  seenPaths: Set<string>,
  apiBasePath: `/${string}`,
): GmcFeedConfig => {
  if (!feed || typeof feed !== 'object') {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: each feed must be an object')
  }
  if (
    feed.limits !== undefined &&
    (typeof feed.limits !== 'object' || feed.limits === null || Array.isArray(feed.limits))
  ) {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: feeds[].limits must be an object')
  }
  if (!feed.selector || typeof feed.selector !== 'object' || Array.isArray(feed.selector)) {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: feeds[].selector must be an object')
  }
  const id = requireNonEmpty('feeds[].id', feed.id)
  if (id.length > 100 || !/^[\w.-]+$/.test(id) || id === '.' || id === '..') {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: feed id ${id} must be URL and object-key safe`,
    )
  }
  const path = normalizeRoute('feeds[].path', feed.path)
  if (path.split('/').some((segment) => segment.startsWith(':') || segment.includes('*'))) {
    throw new TypeError(`payload-plugin-gmc-ecommerce/v2: feed ${id} path must be static`)
  }
  if (path === apiBasePath || path.startsWith(`${apiBasePath}/`)) {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: feed ${id} path must be outside the API base path ${apiBasePath}`,
    )
  }
  if (feed.delivery !== 'artifact' && feed.delivery !== 'dynamic') {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: feed ${id} delivery must be dynamic or artifact`,
    )
  }
  if (
    feed.format !== undefined &&
    feed.format !== 'tsv' &&
    (!feed.format || typeof feed.format !== 'object' || Array.isArray(feed.format))
  ) {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: feed ${id} format must be tsv or a format adapter`,
    )
  }
  if (seenIds.has(id)) {
    throw new TypeError(`payload-plugin-gmc-ecommerce/v2: duplicate feed id ${id}`)
  }
  if (seenPaths.has(path)) {
    throw new TypeError(`payload-plugin-gmc-ecommerce/v2: duplicate feed path ${path}`)
  }
  seenIds.add(id)
  seenPaths.add(path)

  if (feed.access !== 'public' && typeof feed.access !== 'function') {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: feed ${id} must explicitly configure access`,
    )
  }
  const contentLanguage = requireNonEmpty(
    `feeds[${id}].selector.contentLanguage`,
    feed.selector?.contentLanguage,
  )
  const feedLabel = requireNonEmpty(`feeds[${id}].selector.feedLabel`, feed.selector?.feedLabel)
  if (!/^[a-z]{2}$/.test(contentLanguage)) {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: feed ${id} contentLanguage must be lowercase ISO 639-1`,
    )
  }
  if (!/^[A-Z0-9_-]{1,20}$/.test(feedLabel)) {
    throw new TypeError(`payload-plugin-gmc-ecommerce/v2: feed ${id} feedLabel is invalid`)
  }
  if (feed.delivery === 'artifact') {
    if (
      !feed.artifactStore ||
      typeof feed.artifactStore.put !== 'function' ||
      typeof feed.artifactStore.read !== 'function' ||
      typeof feed.artifactStore.promote !== 'function' ||
      typeof feed.artifactStore.readCurrentDescriptor !== 'function' ||
      typeof feed.artifactStore.readCurrent !== 'function'
    ) {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: artifact feed ${id} requires put, read, promote, readCurrentDescriptor, and readCurrent artifactStore operations`,
      )
    }
  }
  if (feed.format !== undefined && feed.format !== 'tsv') {
    const formatId = requireNonEmpty(`feeds[${id}].format.id`, feed.format.id)
    if (
      formatId.length > 100 ||
      !/^[\w.-]+$/.test(formatId) ||
      formatId === '.' ||
      formatId === '..'
    ) {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: feed ${id} format.id must contain 1-100 safe characters`,
      )
    }
    if (typeof feed.format.serialize !== 'function') {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: feed ${id} format.serialize is required`,
      )
    }
  }

  return {
    ...feed,
    ...(feed.format !== undefined && feed.format !== 'tsv'
      ? { format: { ...feed.format, id: feed.format.id.trim() } }
      : {}),
    id,
    limits: {
      maxProducts: positiveInteger(
        `feeds[${id}].limits.maxProducts`,
        feed.limits?.maxProducts,
        GMC_V2_DEFAULT_FEED_LIMITS.maxProducts,
        1_000_000,
      ),
      maxSerializedBytes: positiveInteger(
        `feeds[${id}].limits.maxSerializedBytes`,
        feed.limits?.maxSerializedBytes,
        GMC_V2_DEFAULT_FEED_LIMITS.maxSerializedBytes,
        1_073_741_824,
      ),
    },
    path,
    selector: {
      contentLanguage,
      dataSourceOverride: feed.selector.dataSourceOverride?.trim() || undefined,
      feedLabel,
    },
  }
}

const normalizeRateLimit = (
  value: RateLimitConfig | undefined,
): NormalizedGmcV2Options['rateLimit'] => {
  const jitterFactor = value?.jitterFactor ?? DEFAULT_RATE_LIMIT.jitterFactor
  if (!Number.isFinite(jitterFactor) || jitterFactor < 0 || jitterFactor > 1) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: rateLimit.jitterFactor must be between 0 and 1',
    )
  }
  if (value?.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: rateLimit.enabled must be a boolean')
  }
  if (
    value?.store !== undefined &&
    (!value.store ||
      (typeof value.store !== 'object' && typeof value.store !== 'function') ||
      typeof value.store.claimSlot !== 'function')
  ) {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: rateLimit.store.claimSlot is required')
  }

  return {
    baseRetryDelayMs: positiveInteger(
      'rateLimit.baseRetryDelayMs',
      value?.baseRetryDelayMs,
      DEFAULT_RATE_LIMIT.baseRetryDelayMs,
      300_000,
    ),
    enabled: value?.enabled ?? DEFAULT_RATE_LIMIT.enabled,
    jitterFactor,
    maxConcurrency: positiveInteger(
      'rateLimit.maxConcurrency',
      value?.maxConcurrency,
      DEFAULT_RATE_LIMIT.maxConcurrency,
      100,
    ),
    maxQueueSize: positiveInteger(
      'rateLimit.maxQueueSize',
      value?.maxQueueSize,
      DEFAULT_RATE_LIMIT.maxQueueSize,
      100_000,
    ),
    maxRequestsPerMinute: positiveInteger(
      'rateLimit.maxRequestsPerMinute',
      value?.maxRequestsPerMinute,
      DEFAULT_RATE_LIMIT.maxRequestsPerMinute,
      100_000,
    ),
    maxRetries: nonNegativeInteger(
      'rateLimit.maxRetries',
      value?.maxRetries,
      DEFAULT_RATE_LIMIT.maxRetries,
      20,
    ),
    maxRetryDelayMs: positiveInteger(
      'rateLimit.maxRetryDelayMs',
      value?.maxRetryDelayMs,
      DEFAULT_RATE_LIMIT.maxRetryDelayMs,
      900_000,
    ),
    requestTimeoutMs: positiveInteger(
      'rateLimit.requestTimeoutMs',
      value?.requestTimeoutMs,
      DEFAULT_RATE_LIMIT.requestTimeoutMs,
      900_000,
    ),
    store: value?.store,
  }
}

export const normalizeGmcV2Options = (
  options: PayloadGmcEcommerceV2Options,
): NormalizedGmcV2Options => {
  if (!options || typeof options !== 'object') {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: options are required')
  }
  if (options.disabled !== undefined && typeof options.disabled !== 'boolean') {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: disabled must be a boolean')
  }
  if (
    options.requireTransaction !== undefined &&
    typeof options.requireTransaction !== 'boolean'
  ) {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: requireTransaction must be a boolean')
  }
  if (options.api !== undefined && (typeof options.api !== 'object' || options.api === null)) {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: api must be an object')
  }
  if (
    options.publicationState !== undefined &&
    (typeof options.publicationState !== 'object' ||
      options.publicationState === null ||
      Array.isArray(options.publicationState))
  ) {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: publicationState must be an object')
  }
  if (
    options.rateLimit !== undefined &&
    (typeof options.rateLimit !== 'object' ||
      options.rateLimit === null ||
      Array.isArray(options.rateLimit))
  ) {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: rateLimit must be an object')
  }
  if (
    options.reconciliation !== undefined &&
    (typeof options.reconciliation !== 'object' || options.reconciliation === null)
  ) {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: reconciliation must be an object')
  }
  if (
    options.reconciliation?.orphanDeletion !== undefined &&
    !['disabled', 'exclusive-data-sources'].includes(options.reconciliation.orphanDeletion)
  ) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: reconciliation.orphanDeletion must be disabled or exclusive-data-sources',
    )
  }
  if (
    options.api?.exposeWorkerEndpoint !== undefined &&
    typeof options.api.exposeWorkerEndpoint !== 'boolean'
  ) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: api.exposeWorkerEndpoint must be a boolean',
    )
  }

  assertAsyncAdapter(options.async)
  if (options.access !== undefined && typeof options.access !== 'function') {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: access must be a function')
  }
  if (options.api?.exposeWorkerEndpoint === true && typeof options.workerAccess !== 'function') {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: workerAccess is required when api.exposeWorkerEndpoint is true',
    )
  }
  if (options.workerAccess !== undefined && typeof options.workerAccess !== 'function') {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: workerAccess must be a function')
  }
  if (typeof options.getCredentials !== 'function') {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: getCredentials is required')
  }
  if (!options.products || typeof options.products.project !== 'function') {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: products.project is required')
  }
  if (typeof options.products.resolveIdentities !== 'function') {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: products.resolveIdentities is required')
  }
  if (options.feeds !== undefined && !Array.isArray(options.feeds)) {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: feeds must be an array')
  }
  if ((options.feeds?.length ?? 0) > 100) {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: no more than 100 feeds may be configured')
  }
  if (
    options.catalogDependencies !== undefined &&
    (!Array.isArray(options.catalogDependencies) || options.catalogDependencies.length > 100)
  ) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: catalogDependencies must contain at most 100 entries',
    )
  }
  if (
    options.catalogGlobalDependencies !== undefined &&
    (!Array.isArray(options.catalogGlobalDependencies) ||
      options.catalogGlobalDependencies.length > 100)
  ) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: catalogGlobalDependencies must contain at most 100 entries',
    )
  }
  if (
    (options.catalogDependencies?.length ?? 0) + (options.catalogGlobalDependencies?.length ?? 0) >
    100
  ) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: catalog dependencies must contain at most 100 total collection and Global entries',
    )
  }
  if (
    options.additionalDataSourceIds !== undefined &&
    (!Array.isArray(options.additionalDataSourceIds) ||
      options.additionalDataSourceIds.length > 100)
  ) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: additionalDataSourceIds must contain at most 100 IDs',
    )
  }
  if (options.localInventory) {
    if (typeof options.localInventory.project !== 'function') {
      throw new TypeError('payload-plugin-gmc-ecommerce/v2: localInventory.project is required')
    }
    if (!Array.isArray(options.localInventory.storeCodes)) {
      throw new TypeError(
        'payload-plugin-gmc-ecommerce/v2: localInventory.storeCodes must be an array',
      )
    }
    if (
      options.localInventory.retiredStoreCodes !== undefined &&
      !Array.isArray(options.localInventory.retiredStoreCodes)
    ) {
      throw new TypeError(
        'payload-plugin-gmc-ecommerce/v2: localInventory.retiredStoreCodes must be an array',
      )
    }
    if (
      options.localInventory.storeCodes.length +
        (options.localInventory.retiredStoreCodes?.length ?? 0) >
      1_000
    ) {
      throw new TypeError(
        'payload-plugin-gmc-ecommerce/v2: no more than 1000 active and retired local inventory stores may be configured',
      )
    }
  }

  const disabled = options.disabled ?? false
  const dependencyCollections = new Set<string>()
  const catalogDependencies = (options.catalogDependencies ?? []).map((dependency, index) => {
    if (!dependency || typeof dependency !== 'object') {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: catalogDependencies[${index}] must be an object`,
      )
    }
    const dependencyCollection = requireNonEmpty<GmcCatalogDependencyConfig['collection']>(
      `catalogDependencies[${index}].collection`,
      dependency.collection,
    )
    if (dependencyCollections.has(dependencyCollection)) {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: duplicate catalog dependency ${dependencyCollection}`,
      )
    }
    dependencyCollections.add(dependencyCollection)
    if (typeof dependency.select !== 'function') {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: catalogDependencies[${index}].select is required`,
      )
    }
    if (
      dependency.resolveProductIds !== undefined &&
      typeof dependency.resolveProductIds !== 'function'
    ) {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: catalogDependencies[${index}].resolveProductIds must be a function`,
      )
    }
    if (dependency.scheduleAt !== undefined && typeof dependency.scheduleAt !== 'function') {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: catalogDependencies[${index}].scheduleAt must be a function`,
      )
    }
    if (
      !disabled &&
      dependency.scheduleAt &&
      options.async.capabilities?.scheduledDelivery !== true
    ) {
      throw new TypeError(
        'payload-plugin-gmc-ecommerce/v2: catalog dependency schedules require async.capabilities.scheduledDelivery',
      )
    }
    return { ...dependency, collection: dependencyCollection }
  })
  const dependencyGlobals = new Set<string>()
  const catalogGlobalDependencies = (options.catalogGlobalDependencies ?? []).map(
    (dependency, index) => {
      if (!dependency || typeof dependency !== 'object') {
        throw new TypeError(
          `payload-plugin-gmc-ecommerce/v2: catalogGlobalDependencies[${index}] must be an object`,
        )
      }
      const dependencyGlobal = requireNonEmpty<GmcCatalogGlobalDependencyConfig['global']>(
        `catalogGlobalDependencies[${index}].global`,
        dependency.global,
      )
      if (dependencyGlobals.has(dependencyGlobal)) {
        throw new TypeError(
          `payload-plugin-gmc-ecommerce/v2: duplicate catalog Global dependency ${dependencyGlobal}`,
        )
      }
      dependencyGlobals.add(dependencyGlobal)
      if (typeof dependency.select !== 'function') {
        throw new TypeError(
          `payload-plugin-gmc-ecommerce/v2: catalogGlobalDependencies[${index}].select is required`,
        )
      }
      if (
        dependency.resolveProductIds !== undefined &&
        typeof dependency.resolveProductIds !== 'function'
      ) {
        throw new TypeError(
          `payload-plugin-gmc-ecommerce/v2: catalogGlobalDependencies[${index}].resolveProductIds must be a function`,
        )
      }
      if (dependency.scheduleAt !== undefined && typeof dependency.scheduleAt !== 'function') {
        throw new TypeError(
          `payload-plugin-gmc-ecommerce/v2: catalogGlobalDependencies[${index}].scheduleAt must be a function`,
        )
      }
      if (
        !disabled &&
        dependency.scheduleAt &&
        options.async.capabilities?.scheduledDelivery !== true
      ) {
        throw new TypeError(
          'payload-plugin-gmc-ecommerce/v2: catalog Global dependency schedules require async.capabilities.scheduledDelivery',
        )
      }
      return { ...dependency, global: dependencyGlobal }
    },
  )
  const merchantId = merchantResourceId('merchantId', options.merchantId, disabled)
  const instanceId = requireNonEmpty('instanceId', options.instanceId ?? merchantId)
  if (
    instanceId.length > 100 ||
    !/^[\w.-]+$/.test(instanceId) ||
    instanceId === '.' ||
    instanceId === '..'
  ) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: instanceId must use 1-100 letters, digits, dots, underscores, or hyphens',
    )
  }
  const dataSourceId = merchantResourceId('dataSourceId', options.dataSourceId, disabled)
  const collection = requireNonEmpty<GmcProductSourceConfig['collection']>(
    'products.collection',
    options.products.collection,
  )
  const apiBasePath = normalizeRoute('api.basePath', options.api?.basePath ?? '/gmc/v2')
  if (apiBasePath.split('/').some((segment) => segment.startsWith(':') || segment.includes('*'))) {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: api.basePath must be static')
  }
  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()
  const dataSourceIds = [
    dataSourceId,
    ...(options.additionalDataSourceIds ?? []).map((id, index) =>
      merchantResourceId(`additionalDataSourceIds[${index}]`, id, disabled),
    ),
  ]
  if (new Set(dataSourceIds).size !== dataSourceIds.length) {
    throw new TypeError('payload-plugin-gmc-ecommerce/v2: data source IDs must be unique')
  }
  const storeCodes = options.localInventory?.storeCodes.map((storeCode, index) => {
    const normalized = requireNonEmpty(`localInventory.storeCodes[${index}]`, storeCode)
    if ([...normalized].length > 64 || hasControlCharacters(normalized)) {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: localInventory.storeCodes[${index}] must contain 1-64 safe characters`,
      )
    }
    return normalized
  })
  if (storeCodes && new Set(storeCodes).size !== storeCodes.length) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: local inventory store codes must be unique',
    )
  }
  const retiredStoreCodes = options.localInventory?.retiredStoreCodes?.map((storeCode, index) => {
    const normalized = requireNonEmpty(`localInventory.retiredStoreCodes[${index}]`, storeCode)
    if ([...normalized].length > 64 || hasControlCharacters(normalized)) {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: localInventory.retiredStoreCodes[${index}] must contain 1-64 safe characters`,
      )
    }
    return normalized
  })
  if (retiredStoreCodes && new Set(retiredStoreCodes).size !== retiredStoreCodes.length) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: retired local inventory store codes must be unique',
    )
  }
  const activeStores = new Set(storeCodes ?? [])
  const overlappingStore = retiredStoreCodes?.find((storeCode) => activeStores.has(storeCode))
  if (overlappingStore) {
    throw new TypeError(
      `payload-plugin-gmc-ecommerce/v2: local inventory store ${overlappingStore} cannot be both active and retired`,
    )
  }
  const dataSourceNames = dataSourceIds.map((id) => `accounts/${merchantId}/dataSources/${id}`)
  const feeds = (options.feeds ?? [])
    .map((feed) => normalizeFeed(feed, seenIds, seenPaths, apiBasePath))
    .map((feed) => {
      const override = feed.selector.dataSourceOverride
      if (!override) {
        return feed
      }
      const resolved = override.startsWith('accounts/')
        ? override
        : `accounts/${merchantId}/dataSources/${override}`
      if (!dataSourceNames.includes(resolved)) {
        throw new TypeError(
          `payload-plugin-gmc-ecommerce/v2: feed ${feed.id} selects an unconfigured API data source`,
        )
      }
      return {
        ...feed,
        selector: {
          ...feed.selector,
          dataSourceOverride: resolved === dataSourceNames[0] ? undefined : resolved,
        },
      }
    })

  // `productIngestion` is accepted for 1.x compatibility and ignored; keeping it
  // on the spread would put a key on the runtime object that
  // `NormalizedGmcV2Options` says is not there.
  const { productIngestion: _ignoredProductIngestion, ...forwarded } = options

  return {
    ...forwarded,
    access: options.access ?? hasDefaultPluginAccess,
    api: {
      basePath: apiBasePath,
      exposeWorkerEndpoint: options.api?.exposeWorkerEndpoint ?? false,
    },
    catalogDependencies,
    catalogGlobalDependencies,
    dataSourceId,
    dataSourceName: `accounts/${merchantId}/dataSources/${dataSourceId}`,
    dataSourceNames,
    disabled,
    feeds,
    instanceId,
    localInventory: options.localInventory
      ? {
          ...options.localInventory,
          retiredStoreCodes: retiredStoreCodes ?? [],
          storeCodes: storeCodes ?? [],
        }
      : undefined,
    merchantId,
    products: {
      ...options.products,
      batchSize: positiveInteger('products.batchSize', options.products.batchSize, 100, 1_000),
      collection,
      fetchDepth: nonNegativeInteger('products.fetchDepth', options.products.fetchDepth, 1, 10),
      maxCatalogPages: positiveInteger(
        'products.maxCatalogPages',
        options.products.maxCatalogPages,
        10_000,
        1_000_000,
      ),
      maxRemoteReconcilePages: positiveInteger(
        'products.maxRemoteReconcilePages',
        options.products.maxRemoteReconcilePages,
        10_000,
        1_000_000,
      ),
    },
    publicationState: {
      collectionSlug: payloadCollectionSlug(
        'publicationState.collectionSlug',
        options.publicationState?.collectionSlug ?? 'gmc-publications-v2',
      ),
    },
    rateLimit: normalizeRateLimit(options.rateLimit),
    reconciliation: {
      orphanDeletion: options.reconciliation?.orphanDeletion ?? 'disabled',
    },
    requireTransaction: options.requireTransaction ?? false,
  }
}
