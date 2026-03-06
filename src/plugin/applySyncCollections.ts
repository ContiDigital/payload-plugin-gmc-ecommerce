import type { Config } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { buildGMCFieldMappingsCollection } from '../collections/gmcFieldMappings.js'
import { buildGMCSyncLogCollection } from '../collections/gmcSyncLog.js'

export const applySyncCollections = (
  config: Config,
  _options: NormalizedPluginOptions,
): Config => {
  if (!config.collections) {
    config.collections = []
  }

  config.collections.push(buildGMCFieldMappingsCollection())
  config.collections.push(buildGMCSyncLogCollection())

  return config
}
