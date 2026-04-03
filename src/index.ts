import type { Config } from 'payload'

import type { PayloadGMCEcommercePluginOptions } from './types/index.js'

import { applyAdminEnhancements } from './plugin/applyAdminEnhancements.js'
import { applyCollectionEnhancements } from './plugin/applyCollectionEnhancements.js'
import { applyEndpointEnhancements } from './plugin/applyEndpointEnhancements.js'
import { applyHooks } from './plugin/applyHooks.js'
import { applyScheduledSync } from './plugin/applyScheduledSync.js'
import { applySyncCollections } from './plugin/applySyncCollections.js'
import { applyJobEnhancements } from './plugin/jobTasks.js'
import { normalizePluginOptions } from './plugin/normalizeOptions.js'
import { initMerchantService } from './plugin/serviceRegistry.js'

export const payloadGmcEcommerce =
  (incomingOptions: PayloadGMCEcommercePluginOptions) =>
  (incomingConfig: Config): Config => {
    const options = normalizePluginOptions(incomingOptions)

    if (options.disabled) {
      return incomingConfig
    }

    // Eagerly create the MerchantService so hooks and scheduled jobs
    // can look it up immediately — not lazily on first endpoint hit
    initMerchantService(options)

    let config = applySyncCollections(incomingConfig, options)
    config = applyCollectionEnhancements(config, options)
    config = applyJobEnhancements(config, options)
    config = applyEndpointEnhancements(config, options)
    config = applyAdminEnhancements(config, options)
    config = applyHooks(config, options)
    config = applyScheduledSync(config, options)

    return config
  }

// --- Public exports ---

export {
  getMerchantCenterField,
  getMerchantCenterTab,
  MerchantCenterUIPlaceholder,
} from './plugin/applyCollectionEnhancements.js'

export { createMerchantService } from './server/services/merchantService.js'
export type { MerchantService } from './server/services/merchantService.js'

export { applyFieldMappings, deepMerge } from './server/sync/fieldMapping.js'
export { resolveIdentity } from './server/sync/identityResolver.js'
export { fromMicros, toMicros } from './server/sync/transformers.js'
export { buildUpdateMask } from './server/sync/updateMask.js'

export type { PayloadGMCEcommercePluginOptions } from './types/index.js'
export type {
  AccessFn,
  AdminMode,
  BatchSyncReport,
  BeforePushHook,
  BeforePushHookArgs,
  ConflictStrategy,
  CredentialResolution,
  FieldMapping,
  FieldSyncMode,
  GetCredentialsFn,
  GoogleServiceAccount,
  HealthResult,
  InitialSyncReport,
  LocalInventoryAvailability,
  LocalInventoryConfig,
  LocalInventoryInput,
  LocalInventoryPickupConfig,
  LocalInventoryPickupSla,
  LocalInventorySyncResult,
  MCAvailability,
  MCCondition,
  MCCustomAttribute,
  MCPerformanceRow,
  MCPrice,
  MCProductAnalytics,
  MCProductAttributes,
  MCProductIdentity,
  MCProductInput,
  MCProductState,
  MCSyncMeta,
  NormalizedPluginOptions,
  PullAllReport,
  PullResult,
  ResolvedMCIdentity,
  ScheduleConfig,
  SyncAction,
  SyncMode,
  SyncResult,
  SyncSource,
  SyncState,
  TransformPreset,
} from './types/index.js'

export default payloadGmcEcommerce
