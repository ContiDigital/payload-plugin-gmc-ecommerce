import type { CollectionSlug, Config, GlobalSlug, Payload, PayloadRequest, Where } from 'payload'

import type {
  AccessFn,
  GetCredentialsFn,
  MCPrice,
  MCProductAttributes,
  MCProductIdentity,
  MCProductInput,
  RateLimitConfig,
} from '../types/index.js'

export const GMC_V2_COMMAND_SCHEMA_VERSION = 2
export const GMC_V2_MAX_TARGETED_PRODUCT_IDS = 1_000

export const GMC_V2_COMMAND_TYPES = [
  'product.publish',
  'product.delete',
  'offer.publish',
  'offer.delete',
  'catalog.publish',
  'catalog.reconcile',
  'dataSources.validate',
  'feed.build',
  'status.refresh',
  'localInventory.reconcile',
  'localInventory.apply',
] as const

export type GmcV2CommandType = (typeof GMC_V2_COMMAND_TYPES)[number]

export type GmcDocumentID = number | string

export type GmcCommandCause =
  | 'api'
  | 'delete'
  | 'manual'
  | 'publish'
  | 'reconcile'
  | 'schedule'
  | 'unpublish'
  | 'update'

export type GmcCommandBase<TType extends GmcV2CommandType> = {
  requestedAt: string
  schemaVersion: typeof GMC_V2_COMMAND_SCHEMA_VERSION
  type: TType
}

export type GmcProductPublishCommand = {
  cause: GmcCommandCause
  previousIdentities?: MCProductIdentity[]
  productId: GmcDocumentID
} & GmcCommandBase<'product.publish'>

export type GmcProductDeleteCommand = {
  cause: Extract<GmcCommandCause, 'delete' | 'reconcile' | 'unpublish'>
  identities: MCProductIdentity[]
  productId?: GmcDocumentID
} & GmcCommandBase<'product.delete'>

/** Internal durable transport command emitted by product.publish. */
export type GmcOfferPublishCommand = {
  /** Canonical content digest of `input`; the only publication ordering key. */
  digest: string
  input: GmcProjectedProductInput
  productId: GmcDocumentID
  /** Reconciliation verifies remote existence before applying the local idempotency shortcut. */
  verifyRemote?: boolean
  /**
   * Google's optimistic `ProductInput.versionNumber`, forwarded only when the
   * host projector supplies its own `sourceVersion`. Omitted otherwise.
   */
  versionNumber?: string
} & GmcCommandBase<'offer.publish'>

/** Internal durable transport command emitted by product.publish/delete. */
export type GmcOfferDeleteCommand = {
  expectedProductId?: GmcDocumentID
  identity: MCProductIdentity
  /** Reconciliation CAS: skip deletion when a desired claim exists at or after this instant. */
  onlyIfDesiredBefore?: string
} & GmcCommandBase<'offer.delete'>

export type GmcCatalogPublishCommand = {
  cause: Extract<GmcCommandCause, 'api' | 'delete' | 'manual' | 'schedule' | 'update'>
  cursor?: GmcDocumentID
  /** Zero-based page coordinate used to enforce the durable local scan ceiling. */
  pageIndex?: number
  /**
   * Complete, canonical-order Product ID set for a targeted dependency
   * invalidation. The coordinator still pages durable children; omission means
   * a full eligible-catalog scan.
   */
  productIds?: GmcDocumentID[]
} & GmcCommandBase<'catalog.publish'>

export type GmcCatalogReconcileCommand = {
  cursor?: GmcDocumentID
  /** Zero-based phase-local page coordinate used to enforce durable scan ceilings. */
  pageIndex?: number
  pageToken?: string
  phase?: 'desired' | 'remote'
  /** Stable lower bound for desired-state marks produced by this reconciliation. */
  startedAt?: string
} & GmcCommandBase<'catalog.reconcile'>

/** Non-mutating durable deployment preflight for every configured API source. */
export type GmcDataSourcesValidateCommand = GmcCommandBase<'dataSources.validate'>

export type GmcFeedBuildCommand = {
  feedId: string
} & GmcCommandBase<'feed.build'>

export type GmcStatusRefreshCommand = {
  identities?: MCProductIdentity[]
  productId?: GmcDocumentID
} & GmcCommandBase<'status.refresh'>

export type GmcLocalInventoryReconcileCommand = {
  cursor?: GmcDocumentID
  /** Zero-based page coordinate used to enforce the durable local scan ceiling. */
  pageIndex?: number
  productId?: GmcDocumentID
  storeCode?: string
} & GmcCommandBase<'localInventory.reconcile'>

export type GmcLocalInventoryApplyCommand = {
  /** Canonical digest of the desired store-scoped resource; the only ordering key. */
  digest: string
  identity: MCProductIdentity
  inventory: GmcLocalInventoryInput | null
  /** Canonical owner retained for durable per-offer/store fencing and diagnostics. */
  productId: GmcDocumentID
  storeCode: string
} & GmcCommandBase<'localInventory.apply'>

export type GmcCommand =
  | GmcCatalogPublishCommand
  | GmcCatalogReconcileCommand
  | GmcDataSourcesValidateCommand
  | GmcFeedBuildCommand
  | GmcLocalInventoryApplyCommand
  | GmcLocalInventoryReconcileCommand
  | GmcOfferDeleteCommand
  | GmcOfferPublishCommand
  | GmcProductDeleteCommand
  | GmcProductPublishCommand
  | GmcStatusRefreshCommand

export type GmcDispatchReceipt = {
  operationId: string
  state: 'pending' | 'queued'
}

export type GmcAsyncDispatchArgs = {
  command: GmcCommand
  /**
   * Stable across every retry of the event which caused this dispatch. The
   * adapter MUST atomically return the original operation for a duplicate key,
   * including after that operation is terminal. It must never supersede or
   * concurrently replace the original operation. This dispatch guarantee is
   * separate from idempotent Merchant writes inside the command executor.
   */
  idempotencyKey: string
  /** Durable parent command for workflow correlation and aggregate status. */
  parentOperationId?: string
  /** Runtime-only Payload instance used by host ledgers; never serialize it. */
  payload: Payload
  /**
   * Supplied only while enqueueing from a Payload request. Adapters use it to
   * join the host transaction or durable outbox; it must not be serialized.
   */
  req?: PayloadRequest
  /** Root operation inherited by every descendant in a batch workflow. */
  rootOperationId?: string
  /**
   * Durable not-before time for a root command. Adapters advertising
   * scheduledDelivery MUST retain this value in their ledger and must not make
   * the command executable before it. It is never used for child commands.
   */
  scheduledFor?: string
  /** Commands with the same subject must execute in dispatch order. */
  subject: string
}

export type GmcAsyncHealth = {
  checkedAt: string
  details?: Record<string, unknown>
  status: 'degraded' | 'error' | 'ok'
}

export type GmcAsyncChildState =
  | 'cancelled'
  | 'dead-lettered'
  | 'failed'
  | 'queued'
  | 'running'
  | 'succeeded'

/**
 * Bounded, aggregate reconciliation telemetry across every completed remote
 * page in a root workflow. The counts can be partial when the aggregate
 * workflow has not yet succeeded; callers must inspect `state` as well.
 */
export type GmcAsyncReconciliationSummary = {
  orphanCount: number
  orphanDeleteCount: number
  pagesCompleted: number
  remoteCount: number
}

export type GmcAsyncOperation = {
  attempts?: number
  /** Aggregate descendant counts when this operation belongs to a workflow. */
  childCounts?: Partial<Record<GmcAsyncChildState, number>>
  commandType?: GmcV2CommandType
  error?: { code?: string; message: string; retryable?: boolean }
  finishedAt?: string
  operationId: string
  parentOperationId?: string
  /** Aggregate telemetry for completed remote reconciliation pages. */
  reconciliation?: GmcAsyncReconciliationSummary
  /** State of the requested ledger row; `state` remains the whole workflow state. */
  requestedState?: GmcAsyncChildState
  rootOperationId?: string
  startedAt?: string
  /** Aggregate root-workflow state, not merely the requested coordinator row's state. */
  state: GmcAsyncChildState
  submittedAt?: string
}

export type GmcAsyncAdapterCapabilities = {
  /** Documented expectation; not verified. Default assumed true. */
  orderedBySubject?: boolean
  /** Required for catalogDependencies[].scheduleAt. */
  scheduledDelivery?: boolean
} & Record<string, unknown> // rc.35 flags are accepted and ignored

export type GmcAsyncAdapter = {
  capabilities?: GmcAsyncAdapterCapabilities
  dispatch: (args: GmcAsyncDispatchArgs) => Promise<GmcDispatchReceipt>
  getOperation: (args: {
    /** Isolates status reads when one durable adapter serves multiple plugin instances. */
    instanceId: string
    operationId: string
    payload: Payload
    req?: PayloadRequest
  }) => Promise<GmcAsyncOperation | null>
  health: (args: {
    /** Isolates ledger telemetry when one durable adapter serves multiple plugin instances. */
    instanceId: string
    payload: Payload
    req?: PayloadRequest
  }) => Promise<GmcAsyncHealth>
  /** Optional: add collections/tasks the adapter needs. Called once by the plugin. */
  install?: (args: { config: Config; options: NormalizedGmcV2Options }) => Config
  name: string
}

export type GmcProjectionWarning = {
  code: string
  message: string
  path?: string
}

/**
 * Merchant API-native input with an intentionally open ProductAttributes
 * object. Google adds attributes independently of this package's release
 * cadence, so API publication preserves unknown JSON-compatible fields.
 * Built-in TSV serialization remains fail-closed until each field has an
 * explicit, specification-correct column mapping.
 */
export type GmcApiProductInput = {
  customAttributes?: GmcApiCustomAttribute[]
  productAttributes?: MCProductAttributes & Record<string, unknown>
} & Omit<MCProductInput, 'customAttributes' | 'productAttributes'>

/** API-native generic attribute; exactly one of value/groupValues is validated at runtime. */
export type GmcApiCustomAttribute = {
  groupValues?: GmcApiCustomAttribute[]
  name: string
  value?: string
}

/** dataSourceOverride selects API-primary transport routing and is not sent in the API body. */
export type GmcProjectedProductInput = {
  dataSourceOverride?: string
} & GmcApiProductInput

/**
 * A single Payload document may project to multiple Google offers (variants).
 * An empty product list is an authoritative request to remove its old offers.
 */
export type GmcProductProjection = {
  products: GmcProjectedProductInput[]
  /**
   * Optional monotonic non-negative integer forwarded as
   * `ProductInput.versionNumber`. Ordering never depends on it: the executor
   * and the publication store order by `desiredAt` and skip by content digest.
   */
  sourceVersion?: string
  warnings?: GmcProjectionWarning[]
}

export type GmcProjectionArgs = {
  doc: Record<string, unknown>
  payload: Payload
  /** One execution-pinned instant for every time-derived value in this projection pass. */
  projectionTime?: string
}

export type GmcIdentityResolutionArgs = {
  doc: Record<string, unknown>
  payload: Payload
  req?: PayloadRequest
}

export type GmcProductSourceConfig = {
  /** Upper bound used by coordinator commands. */
  batchSize?: number
  collection: CollectionSlug
  fetchDepth?: number
  /** Hard ceiling for one local catalog/feed scan, including an empty terminal probe page. */
  maxCatalogPages?: number
  /** Hard ceiling for one processed-product reconciliation scan. */
  maxRemoteReconcilePages?: number
  project: (args: GmcProjectionArgs) => GmcProductProjection | Promise<GmcProductProjection>
  /**
   * Resolves every offer identity represented by a document. Required so a
   * deleted document and an identity change remain recoverable.
   */
  resolveIdentities: (
    args: GmcIdentityResolutionArgs,
  ) => MCProductIdentity[] | Promise<MCProductIdentity[]>
  where?: Where
}

export type GmcCanonicalProduct = {
  digest: string
  identity: MCProductIdentity
  input: GmcApiProductInput
  sourceVersion?: string
}

export type GmcFeedFormatContext = {
  feedId: string
  generatedAt: string
  products: readonly GmcCanonicalProduct[]
  selector: GmcFeedSelector
}

export type GmcFeedFormatResult = {
  body: Uint8Array
  contentType: string
  extension: string
  /**
   * Attributes the format could not represent. Serialization omits them rather
   * than failing a whole feed, and the caller surfaces them once per build.
   */
  warnings?: GmcProjectionWarning[]
}

export type GmcFeedFormatAdapter = {
  id: string
  serialize: (context: GmcFeedFormatContext) => GmcFeedFormatResult | Promise<GmcFeedFormatResult>
}

export type GmcArtifactDescriptor = {
  byteLength: number
  checksum: string
  contentType: string
  createdAt: string
  /** Build instant that fences pointer promotion; the feed.build `requestedAt`. */
  generatedAt: string
  key: string
}

export type GmcArtifactPromotionResult = 'promoted' | 'stale'

export type GmcFeedArtifactStore = {
  /**
   * Atomically promote only when artifact.generatedAt is newer than the
   * current pointer. Older builds return `stale` without changing it. An equal
   * `generatedAt` may return `stale` only when the descriptor is identical;
   * equal-instant descriptor divergence is an invariant violation and must
   * reject rather than select an arbitrary winner.
   */
  promote: (args: {
    artifact: GmcArtifactDescriptor
    feedId: string
    /** Required durable namespace when one artifact store serves multiple plugin instances. */
    instanceId: string
  }) => Promise<GmcArtifactPromotionResult>
  put: (args: {
    body: Uint8Array
    descriptor: GmcArtifactDescriptor
    feedId: string
    instanceId: string
  }) => Promise<void>
  /** Read the exact immutable object written by put(), without consulting the current pointer. */
  read: (args: { artifact: GmcArtifactDescriptor; feedId: string; instanceId: string }) => Promise<{
    body: Uint8Array
    descriptor: GmcArtifactDescriptor
  } | null>
  readCurrent: (args: { feedId: string; instanceId: string }) => Promise<{
    body: Uint8Array
    descriptor: GmcArtifactDescriptor
  } | null>
  /**
   * Read only the atomically promoted pointer descriptor. The executor uses
   * this before rebuilding so an at-least-once replay can recognize a prior
   * successful promotion without downloading an older full artifact.
   */
  readCurrentDescriptor: (args: {
    feedId: string
    instanceId: string
  }) => Promise<GmcArtifactDescriptor | null>
}

export type GmcFeedAccessArgs = {
  feedId: string
  req: PayloadRequest
}

type GmcFeedBaseConfig = {
  /**
   * Feeds are canonical exports of the same desired state sent through the
   * Merchant API. They must not be registered as another Merchant primary
   * product source for the same identities.
   */
  access: 'public' | ((args: GmcFeedAccessArgs) => boolean | Promise<boolean>)
  format?: 'tsv' | GmcFeedFormatAdapter
  id: string
  limits?: GmcFeedLimits
  path: `/${string}`
  selector: GmcFeedSelector
}

export type GmcFeedSelector = {
  contentLanguage: string
  dataSourceOverride?: string
  feedLabel: string
}

export type GmcFeedLimits = {
  /** Hard fail before retaining more canonical products in memory. */
  maxProducts?: number
  /** Hard fail before serving or promoting an oversized serialized artifact. */
  maxSerializedBytes?: number
}

export type GmcDynamicFeedConfig = {
  delivery: 'dynamic'
} & GmcFeedBaseConfig

export type GmcArtifactFeedConfig = {
  artifactStore: GmcFeedArtifactStore
  delivery: 'artifact'
} & GmcFeedBaseConfig

export type GmcFeedConfig = GmcArtifactFeedConfig | GmcDynamicFeedConfig

export type GmcWorkerAccessFn = (args: {
  /**
   * The parsed command, when available. The worker endpoint calls this
   * function before parsing the request body so it can reject unauthorized
   * callers without spending any work on an untrusted payload — `command` is
   * therefore always `undefined` at that call site.
   */
  command?: GmcCommand
  payload: Payload
  req: PayloadRequest
}) => boolean | Promise<boolean>

export type GmcV2LocalInventoryProjection = {
  identity: MCProductIdentity
  inventory: GmcLocalInventoryInput | null
  storeCode: string
}

export type GmcLocalInventoryAvailability =
  'IN_STOCK' | 'LIMITED_AVAILABILITY' | 'ON_DISPLAY_TO_ORDER' | 'OUT_OF_STOCK'

export type GmcLocalInventoryPickupMethod = 'BUY' | 'NOT_SUPPORTED' | 'RESERVE' | 'SHIP_TO_STORE'

export type GmcLocalInventoryPickupSla =
  | 'FIVE_DAY'
  | 'FOUR_DAY'
  | 'MULTI_WEEK'
  | 'NEXT_DAY'
  | 'SAME_DAY'
  | 'SEVEN_DAY'
  | 'SIX_DAY'
  | 'THREE_DAY'
  | 'TWO_DAY'

export type GmcInventoryLoyaltyProgram = {
  cashbackForFutureUse?: MCPrice
  loyaltyPoints?: string
  memberPriceEffectiveInterval?: { endTime?: string; startTime?: string }
  price?: MCPrice
  programLabel?: string
  shippingLabel?: string
  tierLabel?: string
}

export type GmcLocalInventoryInput = {
  localInventoryAttributes: {
    availability: GmcLocalInventoryAvailability
    customAttributes?: GmcApiCustomAttribute[]
    instoreProductLocation?: string
    localShippingLabel?: string
    loyaltyPrograms?: GmcInventoryLoyaltyProgram[]
    pickupMethod?: GmcLocalInventoryPickupMethod
    pickupSla?: GmcLocalInventoryPickupSla
    price?: MCPrice
    quantity?: string
    salePrice?: MCPrice
    salePriceEffectiveDate?: { endTime?: string; startTime?: string }
  }
  storeCode: string
}

export type GmcV2LocalInventoryConfig = {
  project: (
    args: { storeCode: string } & GmcProjectionArgs,
  ) => GmcV2LocalInventoryProjection[] | Promise<GmcV2LocalInventoryProjection[]>
  /**
   * Stores no longer managed by the host. V2 emits deletes without invoking
   * project(). Retain each code until a complete successful reconciliation
   * proves its formerly owned local inventory has been removed.
   */
  retiredStoreCodes?: string[]
  storeCodes: string[]
}

export type GmcReconciliationConfig = {
  /**
   * Remote orphan deletion is destructive and is disabled by default. Select
   * `exclusive-data-sources` only when every configured data source is owned
   * exclusively by this plugin instance.
   */
  orphanDeletion?: 'disabled' | 'exclusive-data-sources'
}

export type GmcCatalogDependencyContext = {
  doc: Record<string, unknown>
  payload: Payload
  req: PayloadRequest
}

export type GmcCatalogDependencyChangeContext = {
  cause: 'delete' | 'update'
  previousDoc?: Record<string, unknown>
  previousSelection?: unknown
  selection: unknown
} & GmcCatalogDependencyContext

export type GmcCatalogDependencyProductResolver = (
  context: GmcCatalogDependencyChangeContext,
) => GmcDocumentID[] | null | Promise<GmcDocumentID[] | null>

/**
 * A canonical collection whose published values can change product
 * projections without changing a Product row (for example taxonomy, color,
 * or promotion documents). The plugin owns the resulting catalog commands.
 */
export type GmcCatalogDependencyConfig = {
  collection: CollectionSlug
  /**
   * Return the complete affected Product ID set, `[]` when no Product can be
   * affected, or `null` for a full-catalog fallback. Results above the plugin's
   * bounded targeted-command limit also fall back to a full catalog root.
   * This resolver is intentionally not used for future schedule boundaries.
   */
  resolveProductIds?: GmcCatalogDependencyProductResolver
  /**
   * Future instants at which the same canonical state can project differently.
   * The plugin schedules catalog roots through the durable async adapter.
   */
  scheduleAt?: (context: GmcCatalogDependencyContext) => Promise<string[]> | string[]
  /** Select only projection-relevant content; equal selections suppress churn. */
  select: (context: GmcCatalogDependencyContext) => unknown
}

/**
 * A canonical Payload Global whose values can change product projections
 * without changing a Product row. The plugin appends a transaction-aware
 * afterChange hook and owns the resulting catalog commands.
 */
export type GmcCatalogGlobalDependencyConfig = {
  global: GlobalSlug
  /** See GmcCatalogDependencyConfig.resolveProductIds. */
  resolveProductIds?: GmcCatalogDependencyProductResolver
  /**
   * Future instants at which the same canonical state can project differently.
   * The plugin schedules catalog roots through the durable async adapter.
   */
  scheduleAt?: (context: GmcCatalogDependencyContext) => Promise<string[]> | string[]
  /** Select only projection-relevant content; equal selections suppress churn. */
  select: (context: GmcCatalogDependencyContext) => unknown
}

export type PayloadGmcEcommerceV2Options = {
  /** Default: hasDefaultPluginAccess from server/utilities/access. */
  access?: AccessFn
  additionalDataSourceIds?: string[]
  api?: {
    basePath?: `/${string}`
    exposeWorkerEndpoint?: boolean
  }
  async: GmcAsyncAdapter
  catalogDependencies?: GmcCatalogDependencyConfig[]
  catalogGlobalDependencies?: GmcCatalogGlobalDependencyConfig[]
  dataSourceId: string
  disabled?: boolean
  /** Optional; defaults to an empty array. */
  feeds?: GmcFeedConfig[]
  getCredentials: GetCredentialsFn
  /** Durable queue namespace. Defaults to merchantId; set explicitly for multiple installations. */
  instanceId?: string
  /**
   * Opts the installation into local-inventory publication state. Both store
   * lists may be empty to keep Payload schema/types/migrations stable while
   * the capability is inactive; no local-inventory work is then dispatched.
   */
  localInventory?: GmcV2LocalInventoryConfig
  merchantId: string
  /** @deprecated ignored since 2.0.0. */
  productIngestion?: {
    mode: 'api-primary'
  }
  products: GmcProductSourceConfig
  publicationState?: {
    collectionSlug?: string
  }
  rateLimit?: RateLimitConfig
  reconciliation?: GmcReconciliationConfig
  /** Fail closed when an automatic hook runs without an ambient transaction. Default false. */
  requireTransaction?: boolean
  /** Required iff api.exposeWorkerEndpoint. */
  workerAccess?: GmcWorkerAccessFn
}

export type NormalizedGmcV2Options = {
  access: AccessFn
  api: {
    basePath: `/${string}`
    exposeWorkerEndpoint: boolean
  }
  dataSourceId: string
  dataSourceName: string
  dataSourceNames: string[]
  disabled: boolean
  feeds: GmcFeedConfig[]
  instanceId: string
  localInventory?: {
    retiredStoreCodes: string[]
    storeCodes: string[]
  } & Omit<GmcV2LocalInventoryConfig, 'retiredStoreCodes' | 'storeCodes'>
  merchantId: string
  products: {
    batchSize: number
    fetchDepth: number
    maxCatalogPages: number
    maxRemoteReconcilePages: number
  } & GmcProductSourceConfig
  publicationState: {
    collectionSlug: string
  }
  rateLimit: Pick<RateLimitConfig, 'store'> & Required<Omit<RateLimitConfig, 'store'>>
  reconciliation: Required<GmcReconciliationConfig>
  requireTransaction: boolean
} & Omit<
  PayloadGmcEcommerceV2Options,
  | 'access'
  | 'additionalDataSourceIds'
  | 'api'
  | 'dataSourceId'
  | 'disabled'
  | 'feeds'
  | 'instanceId'
  | 'localInventory'
  | 'merchantId'
  | 'productIngestion'
  | 'products'
  | 'publicationState'
  | 'rateLimit'
  | 'reconciliation'
  | 'requireTransaction'
>

export type GmcCommandExecutionContext = {
  command: GmcCommand
  operationId: string
  payload: Payload
  /** Root workflow ID read from the host ledger; omitted only for a root command. */
  rootOperationId?: string
  /** @deprecated ignored since 2.0.0; retained so rc.35 workers compile. */
  sourceVersion?: string
}

export const GMC_PUBLICATION_STATUSES = [
  'delete-pending',
  'deleted',
  'failed',
  'publish-pending',
  'published',
] as const

export type GmcPublicationStatus = (typeof GMC_PUBLICATION_STATUSES)[number]

export type GmcPublicationState = {
  /** ISO timestamp of the newest accepted desired content for this identity. */
  desiredAt?: string
  desiredDigest?: string
  error?: { code?: string; message: string; retryable?: boolean }
  identity: MCProductIdentity
  operationId: string
  productId?: GmcDocumentID
  publishedAt?: string
  publishedDigest?: string
  remoteMissing?: boolean
  remoteStatus?: Record<string, unknown>
  /** Google's own `versionNumber` for the last observed remote product. Informational. */
  remoteVersion?: string
  revision: number
  status: GmcPublicationStatus
  /** Set only for local-inventory rows; offer rows leave it undefined. */
  storeCode?: string
  updatedAt: string
}

export type GmcPublicationClaim = {
  desiredAt: string
  desiredDigest: string
  identity: MCProductIdentity
  operationId: string
  payload: Payload
  productId: GmcDocumentID
}

export type GmcPublicationStateStore = {
  /**
   * Same claim rules as `claimPublication`, scoped to one identity/store row:
   * ownership by productId, `desiredAt` ordering, a same-digest-already-published
   * short-circuit, otherwise `publish-pending`. The row is keyed separately
   * from the base offer and `listByProduct` never returns it.
   */
  claimLocalInventory: (
    claim: { storeCode: string } & GmcPublicationClaim,
  ) => Promise<GmcPublicationState>
  claimPublication: (claim: GmcPublicationClaim) => Promise<GmcPublicationState>
  get: (args: {
    identity: MCProductIdentity
    payload: Payload
  }) => Promise<GmcPublicationState | null>
  getLocalInventory: (args: {
    identity: MCProductIdentity
    payload: Payload
    storeCode: string
  }) => Promise<GmcPublicationState | null>
  /** Return at most 1,000 non-deleted identities currently owned by this product. */
  listByProduct: (args: {
    payload: Payload
    productId: GmcDocumentID
  }) => Promise<GmcPublicationState[]>
  markDeleted: (args: {
    /**
     * Instant at which deletion became the desired state (the `offer.delete`
     * command's `requestedAt`). Retained in `desiredAt` so a publish claim
     * requested before it can never resurrect the offer.
     */
    deletedAt: string
    identity: MCProductIdentity
    operationId: string
    payload: Payload
    productId?: GmcDocumentID
  }) => Promise<GmcPublicationState>
  markDeletePending: (args: {
    /** Instant at which deletion became the desired state; retained in `desiredAt`. */
    deletedAt: string
    identity: MCProductIdentity
    /** Skip the delete when the stored desired claim is at or after this ISO timestamp. */
    onlyIfDesiredBefore?: string
    operationId: string
    payload: Payload
    productId?: GmcDocumentID
  }) => Promise<GmcPublicationState | null>
  markFailed: (args: {
    error: GmcPublicationState['error']
    identity: MCProductIdentity
    operationId: string
    payload: Payload
  }) => Promise<void>
  markLocalInventoryFailed: (args: {
    error: GmcPublicationState['error']
    identity: MCProductIdentity
    operationId: string
    payload: Payload
    storeCode: string
  }) => Promise<void>
  markLocalInventoryPublished: (
    args: { publishedAt: string; storeCode: string } & GmcPublicationClaim,
  ) => Promise<GmcPublicationState>
  markObserved: (args: {
    identity: MCProductIdentity
    observedAt: string
    payload: Payload
    remoteMissing: boolean
    remoteStatus?: Record<string, unknown>
    remoteVersion?: string
  }) => Promise<void>
  markPublished: (
    args: { publishedAt: string } & GmcPublicationClaim,
  ) => Promise<GmcPublicationState>
}

export type GmcMerchantTransport = {
  deleteLocalInventory: (args: {
    identity: MCProductIdentity
    payload: Payload
    storeCode: string
  }) => Promise<void>
  deleteProductInput: (args: {
    dataSourceName: string
    identity: MCProductIdentity
    payload: Payload
  }) => Promise<void>
  getApiPrimaryDataSource: (args: {
    dataSourceName: string
    payload: Payload
  }) => Promise<GmcApiPrimaryDataSource>
  getProcessedProduct: (args: {
    identity: MCProductIdentity
    payload: Payload
  }) => Promise<GmcRemoteProduct | null>
  insertLocalInventory: (args: {
    identity: MCProductIdentity
    inventory: GmcLocalInventoryInput
    payload: Payload
  }) => Promise<void>
  insertProductInput: (args: {
    dataSourceName: string
    input: { versionNumber?: string } & GmcApiProductInput
    payload: Payload
  }) => Promise<void>
  listProcessedProducts: (args: {
    pageSize?: number
    pageToken?: string
    payload: Payload
  }) => Promise<{ nextPageToken?: string; products: GmcRemoteProduct[] }>
}

export type GmcApiPrimaryDataSource = {
  contentLanguage?: string
  feedLabel?: string
  input: 'API'
  name: string
}

export type GmcRemoteProduct = {
  dataSourceName: string
  identity: MCProductIdentity
  name: string
  productStatus?: Record<string, unknown>
  versionNumber?: string
}

export type GmcCommandExecutionResult = {
  commandType: GmcV2CommandType
  dispatched?: GmcDispatchReceipt[]
  operationId: string
  /** Remote offers absent from desired state, whether or not deletion is enabled. */
  orphanCount?: number
  /** Orphan delete commands actually dispatched under explicit exclusive ownership. */
  orphanDeleteCount?: number
  outcome: 'completed' | 'skipped'
  productCount?: number
  remoteCount?: number
}
