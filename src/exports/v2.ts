export type {
  AccessFn,
  CredentialResolution,
  DistributedRateLimitStore,
  GetCredentialsFn,
  MCArrayField,
  MCCustomAttribute,
  MCFreeShippingThreshold,
  MCInterval,
  MCPrice,
  MCProductAttributes,
  MCProductDetail,
  MCProductIdentity,
  MCProductInput,
  MCShipping,
  MCShippingDimension,
  MCStructuredContent,
  MCUrlArrayField,
  RateLimitConfig,
} from '../types/index.js'
export {
  assertGmcAsyncHealth,
  assertGmcAsyncOperation,
  assertGmcDispatchReceipt,
  GmcAsyncIdempotencyConflictError,
  GmcAsyncWorkflowConflictError,
} from '../v2/async.js'
export {
  canonicalizeProductInput,
  canonicalizeProjection,
  canonicalJson,
  getIdentityKey,
  getProcessedIdentityKey,
  GMC_V2_MAX_PRODUCTS_PER_PROJECTION,
  GmcProjectionValidationError,
  priceToFeedValue,
} from '../v2/canonical.js'
export { collectCanonicalProducts, mergeGmcCursorWhere } from '../v2/catalog.js'
export {
  assertGmcCommand,
  createCatalogPublishCommand,
  createDataSourcesValidateCommand,
  createLocalInventoryApplyCommand,
  createOfferDeleteCommand,
  createOfferPublishCommand,
  createProductDeleteCommand,
  createProductPublishCommand,
  getGmcCommandIdempotencyDigest,
  getGmcCommandSubject,
} from '../v2/commands.js'
export { normalizeGmcV2Options } from '../v2/config.js'
export {
  assertGmcApiDataSourceAcceptsIdentity,
  assertGmcApiPrimaryDataSource,
  assertGmcApiPrimaryDataSourceTopology,
  GmcApiPrimaryDataSourceRequiredError,
  GmcProcessedProductNotReadyError,
  GmcProductDataSourceConflictError,
  parseGmcApiPrimaryDataSource,
} from '../v2/dataSource.js'
export { buildGmcV2Endpoints } from '../v2/endpoints.js'
export { classifyGmcCommandError } from '../v2/errors.js'
export { createGmcCommandExecutor } from '../v2/executor.js'
export {
  assertFeedArtifactDescriptor,
  assertFeedArtifactIntegrity,
  buildCanonicalFeed,
  publishFeedArtifact,
} from '../v2/feed/buildFeed.js'
export { GMC_V2_DEFAULT_FEED_LIMITS, GmcFeedLimitError } from '../v2/feed/limits.js'
export { GMC_TSV_COLUMNS, gmcTsvFormat, serializeCanonicalTsv } from '../v2/feed/tsv.js'
export { GmcTransactionalHookRequiredError } from '../v2/hooks.js'
export {
  getMerchantProductId,
  getProcessedProductName,
  getProductInputName,
  normalizeGmcIdentityRoute,
  resolveGmcDataSourceName,
} from '../v2/identity.js'
export { canonicalizeLocalInventoryInput } from '../v2/localInventory.js'
export {
  isGmcNonNegativeInt64String,
  isGmcRfc3339Timestamp,
  parseGmcRfc3339Timestamp,
} from '../v2/merchantWire.js'
export { payloadGmcEcommerceV2 } from '../v2/plugin.js'
export { default } from '../v2/plugin.js'
export { buildGmcPublicationCollection } from '../v2/state/collection.js'
export { buildGmcLocalInventoryPublicationCollection } from '../v2/state/localInventoryCollection.js'
export {
  createPayloadLocalInventoryPublicationStateStore,
  GmcLocalInventorySourceVersionConflictError,
} from '../v2/state/localInventoryPayloadStateStore.js'
export {
  createPayloadPublicationStateStore,
  GmcIdentityOwnershipError,
} from '../v2/state/payloadStateStore.js'
export { createGoogleMerchantTransport } from '../v2/transport/googleTransport.js'
export {
  GMC_V2_COMMAND_SCHEMA_VERSION,
  GMC_V2_COMMAND_TYPES,
  GMC_V2_MAX_TARGETED_PRODUCT_IDS,
} from '../v2/types.js'
export type * from '../v2/types.js'
