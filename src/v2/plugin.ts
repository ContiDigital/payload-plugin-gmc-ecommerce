import type { CollectionConfig, Config, Endpoint } from 'payload'

import type { PayloadGmcEcommerceV2Options } from './types.js'

import { normalizeGmcV2Options } from './config.js'
import { buildGmcV2Endpoints } from './endpoints.js'
import {
  createGmcV2AfterChangeHook,
  createGmcV2AfterDeleteHook,
  createGmcV2DependencyAfterChangeHook,
  createGmcV2DependencyAfterDeleteHook,
  createGmcV2GlobalDependencyAfterChangeHook,
  createGmcV2TransactionBeforeChangeHook,
  createGmcV2TransactionBeforeDeleteHook,
  createGmcV2TransactionGlobalBeforeChangeHook,
} from './hooks.js'
import { buildGmcPublicationCollection } from './state/collection.js'
import { buildGmcLocalInventoryPublicationCollection } from './state/localInventoryCollection.js'

type PayloadPlugin = Exclude<Config['plugins'], undefined>[number]

const endpointKey = (endpoint: Pick<Endpoint, 'method' | 'path'>): string => {
  return `${endpoint.method.toUpperCase()} ${endpoint.path}`
}

const endpointRoutesOverlap = (
  left: Pick<Endpoint, 'method' | 'path'>,
  right: Pick<Endpoint, 'method' | 'path'>,
): boolean => {
  if (left.method.toUpperCase() !== right.method.toUpperCase()) {
    return false
  }
  const leftSegments = left.path.split('/').filter(Boolean)
  const rightSegments = right.path.split('/').filter(Boolean)
  const memo = new Map<string, boolean>()
  const isCatchAll = (segment: string): boolean => segment.includes('*')
  const isOptional = (segment: string): boolean => segment.startsWith(':') && segment.endsWith('?')
  const isDynamic = (segment: string): boolean => segment.startsWith(':')
  const compatible = (leftSegment: string, rightSegment: string): boolean =>
    leftSegment === rightSegment || isDynamic(leftSegment) || isDynamic(rightSegment)

  // Payload endpoint paths are path-to-regexp patterns. Compare the route
  // languages, not only their segment counts: `/gmc/*` and
  // `/gmc/v2/catalog/publish` overlap even though their literal lengths do
  // not. The recursion is intentionally conservative for wildcard syntax so
  // ambiguous host routing fails during config construction.
  const overlaps = (leftIndex: number, rightIndex: number): boolean => {
    const key = `${leftIndex}:${rightIndex}`
    const retained = memo.get(key)
    if (retained !== undefined) {
      return retained
    }
    // Break recursive wildcard cycles until this state has a result.
    memo.set(key, false)
    if (leftIndex === leftSegments.length && rightIndex === rightSegments.length) {
      memo.set(key, true)
      return true
    }

    const leftSegment = leftSegments[leftIndex]
    const rightSegment = rightSegments[rightIndex]
    let result = false
    if (leftSegment !== undefined && isCatchAll(leftSegment)) {
      result =
        overlaps(leftIndex + 1, rightIndex) ||
        (rightSegment !== undefined && overlaps(leftIndex, rightIndex + 1))
    } else if (rightSegment !== undefined && isCatchAll(rightSegment)) {
      result =
        overlaps(leftIndex, rightIndex + 1) ||
        (leftSegment !== undefined && overlaps(leftIndex + 1, rightIndex))
    } else if (leftSegment !== undefined && isOptional(leftSegment)) {
      result =
        overlaps(leftIndex + 1, rightIndex) ||
        (rightSegment !== undefined &&
          compatible(leftSegment, rightSegment) &&
          overlaps(leftIndex + 1, rightIndex + 1))
    } else if (rightSegment !== undefined && isOptional(rightSegment)) {
      result =
        overlaps(leftIndex, rightIndex + 1) ||
        (leftSegment !== undefined &&
          compatible(leftSegment, rightSegment) &&
          overlaps(leftIndex + 1, rightIndex + 1))
    } else if (
      leftSegment !== undefined &&
      rightSegment !== undefined &&
      compatible(leftSegment, rightSegment)
    ) {
      result = overlaps(leftIndex + 1, rightIndex + 1)
    }
    memo.set(key, result)
    return result
  }

  return overlaps(0, 0)
}

export const payloadGmcEcommerceV2 = (
  incomingOptions: PayloadGmcEcommerceV2Options,
): PayloadPlugin => {
  return (incomingConfig: Config): Config => {
    const options = normalizeGmcV2Options(incomingOptions)
    const config = options.async.install?.({ config: incomingConfig, options }) ?? incomingConfig
    const existingCollections = config.collections ?? []
    const productIndex = existingCollections.findIndex(
      (collection) => collection.slug === options.products.collection,
    )
    if (productIndex < 0) {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: product collection ${options.products.collection} is not configured`,
      )
    }

    const collections: CollectionConfig[] = [...existingCollections]
    const existingGlobals = config.globals ?? []
    const globals = [...existingGlobals]
    if (
      existingCollections.some(
        (collection) => collection.slug === options.publicationState.collectionSlug,
      )
    ) {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: publication collection slug ${options.publicationState.collectionSlug} already exists; choose a different publicationState.collectionSlug`,
      )
    }
    collections.push(
      buildGmcPublicationCollection({
        slug: options.publicationState.collectionSlug,
        access: options.access,
      }),
    )
    if (options.localInventory) {
      if (
        collections.some(
          (collection) => collection.slug === options.localInventory?.collectionSlug,
        )
      ) {
        throw new TypeError(
          `payload-plugin-gmc-ecommerce/v2: local-inventory publication collection slug ${options.localInventory.collectionSlug} already exists; choose a different local-inventory collection slug`,
        )
      }
      collections.push(
        buildGmcLocalInventoryPublicationCollection({
          slug: options.localInventory.collectionSlug,
          access: options.access,
        }),
      )
    }

    if (!options.disabled) {
      const productCollection = existingCollections[productIndex]
      collections[productIndex] = {
        ...productCollection,
        hooks: {
          ...productCollection.hooks,
          afterChange: [
            ...(productCollection.hooks?.afterChange ?? []),
            createGmcV2AfterChangeHook(options),
          ],
          afterDelete: [
            ...(productCollection.hooks?.afterDelete ?? []),
            createGmcV2AfterDeleteHook(options),
          ],
          beforeChange: [
            ...(options.requireTransaction
              ? [createGmcV2TransactionBeforeChangeHook(options)]
              : []),
            ...(productCollection.hooks?.beforeChange ?? []),
          ],
          beforeDelete: [
            ...(options.requireTransaction
              ? [createGmcV2TransactionBeforeDeleteHook(options)]
              : []),
            ...(productCollection.hooks?.beforeDelete ?? []),
          ],
        },
      }

      for (const dependency of options.catalogDependencies ?? []) {
        if (dependency.collection === options.products.collection) {
          throw new TypeError(
            'payload-plugin-gmc-ecommerce/v2: product collection cannot also be a catalog dependency',
          )
        }
        const dependencyIndex = existingCollections.findIndex(
          (collection) => collection.slug === dependency.collection,
        )
        if (dependencyIndex < 0) {
          throw new TypeError(
            `payload-plugin-gmc-ecommerce/v2: catalog dependency collection ${dependency.collection} is not configured`,
          )
        }
        const dependencyCollection = collections[dependencyIndex]
        collections[dependencyIndex] = {
          ...dependencyCollection,
          hooks: {
            ...dependencyCollection.hooks,
            afterChange: [
              ...(dependencyCollection.hooks?.afterChange ?? []),
              createGmcV2DependencyAfterChangeHook(options, dependency),
            ],
            afterDelete: [
              ...(dependencyCollection.hooks?.afterDelete ?? []),
              createGmcV2DependencyAfterDeleteHook(options, dependency),
            ],
            beforeChange: [
              ...(options.requireTransaction
                ? [createGmcV2TransactionBeforeChangeHook(options)]
                : []),
              ...(dependencyCollection.hooks?.beforeChange ?? []),
            ],
            beforeDelete: [
              ...(options.requireTransaction
                ? [createGmcV2TransactionBeforeDeleteHook(options)]
                : []),
              ...(dependencyCollection.hooks?.beforeDelete ?? []),
            ],
          },
        }
      }

      for (const dependency of options.catalogGlobalDependencies ?? []) {
        const dependencyIndex = existingGlobals.findIndex(
          (global) => global.slug === dependency.global,
        )
        if (dependencyIndex < 0) {
          throw new TypeError(
            `payload-plugin-gmc-ecommerce/v2: catalog dependency Global ${dependency.global} is not configured`,
          )
        }
        const dependencyGlobal = globals[dependencyIndex]
        globals[dependencyIndex] = {
          ...dependencyGlobal,
          hooks: {
            ...dependencyGlobal.hooks,
            afterChange: [
              ...(dependencyGlobal.hooks?.afterChange ?? []),
              createGmcV2GlobalDependencyAfterChangeHook(options, dependency),
            ],
            beforeChange: [
              ...(options.requireTransaction
                ? [createGmcV2TransactionGlobalBeforeChangeHook(options)]
                : []),
              ...(dependencyGlobal.hooks?.beforeChange ?? []),
            ],
          },
        }
      }
    }

    const endpoints = [...(config.endpoints ?? [])]
    if (!options.disabled) {
      for (const endpoint of buildGmcV2Endpoints(options)) {
        const key = endpointKey(endpoint)
        const collision = endpoints.find((existing) => endpointRoutesOverlap(existing, endpoint))
        if (collision) {
          throw new TypeError(`payload-plugin-gmc-ecommerce/v2: endpoint collision at ${key}`)
        }
        endpoints.push(endpoint)
      }
    }

    return {
      ...config,
      collections,
      endpoints,
      globals,
    }
  }
}

export default payloadGmcEcommerceV2
