import type { MerchantService } from '../server/services/merchantService.js'
import type { NormalizedPluginOptions } from '../types/index.js'

import { createMerchantService } from '../server/services/merchantService.js'

type RegistryLogger = {
  debug: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

// Service instances keyed by merchantId — supports multiple plugin instances.
// Re-registering the same merchant replaces the existing instance so option
// changes in dev reloads or repeated plugin init do not leave stale services.
const serviceRegistry = new Map<string, MerchantService>()
let lastRegisteredMerchantId: null | string = null

/**
 * Eagerly initialise the MerchantService for the given options and register it.
 * Called once during plugin init so hooks and scheduled jobs can look it up.
 */
export const initMerchantService = (
  options: NormalizedPluginOptions,
  logger?: unknown,
): MerchantService => {
  const key = options.merchantId

  const existingService = serviceRegistry.get(key)
  if (existingService) {
    existingService.destroy()
  }

  const service = createMerchantService(options, logger as RegistryLogger)
  serviceRegistry.set(key, service)
  lastRegisteredMerchantId = key

  return service
}

/**
 * Look up a previously-registered service. Returns null only if the plugin
 * was disabled or not yet initialised (should not happen in normal flow).
 */
export const getMerchantServiceInstance = (merchantId?: string): MerchantService | null => {
  if (merchantId) {
    return serviceRegistry.get(merchantId) ?? null
  }
  if (lastRegisteredMerchantId) {
    return serviceRegistry.get(lastRegisteredMerchantId) ?? null
  }
  return null
}

export const resetMerchantServiceRegistry = (): void => {
  for (const service of serviceRegistry.values()) {
    service.destroy()
  }

  serviceRegistry.clear()
  lastRegisteredMerchantId = null
}
