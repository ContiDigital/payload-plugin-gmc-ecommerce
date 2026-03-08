import type { CollectionConfig, Config } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { createAfterChangeHook } from '../hooks/afterChange.js'
import { createAfterDeleteHook } from '../hooks/afterDelete.js'
import { createBeforeChangeHook } from '../hooks/beforeChange.js'

export const applyHooks = (
  config: Config,
  options: NormalizedPluginOptions,
): Config => {
  if (!config.collections) {
    return config
  }

  const productCollection = config.collections.find(
    (c: CollectionConfig) => c.slug === options.collections.products.slug,
  )

  if (!productCollection) {
    return config
  }

  // Initialize hooks if needed
  if (!productCollection.hooks) {
    productCollection.hooks = {}
  }

  if (!productCollection.hooks.beforeChange) {
    productCollection.hooks.beforeChange = []
  }

  if (!productCollection.hooks.afterChange) {
    productCollection.hooks.afterChange = []
  }

  if (!productCollection.hooks.afterDelete) {
    productCollection.hooks.afterDelete = []
  }

  // Add our hooks
  productCollection.hooks.beforeChange.push(createBeforeChangeHook(options))
  productCollection.hooks.afterChange.push(createAfterChangeHook(options))
  productCollection.hooks.afterDelete.push(createAfterDeleteHook(options))

  return config
}
