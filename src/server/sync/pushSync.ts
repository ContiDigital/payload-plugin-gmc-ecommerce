import type { Payload } from 'payload'

import type { NormalizedPluginOptions, ResolvedMCIdentity, SyncResult } from '../../types/index.js'
import type { GoogleApiClient } from '../services/sub-services/googleApiClient.js'
import type { RetryService } from '../services/sub-services/retryService.js'

import {
  MC_FIELD_GROUP_NAME,
  MC_PRODUCT_ATTRIBUTES_FIELD_NAME,
} from '../../constants.js'
import { GoogleApiError } from '../services/sub-services/googleApiClient.js'
import { createPluginLogger } from '../utilities/logger.js'
import { asProductDoc } from '../utilities/recordUtils.js'
import { extractMCProductLastModified, isRemoteNewerThanLocal } from './conflictResolver.js'
import { buildInternalSyncContext } from './hookContext.js'
import { resolveIdentity } from './identityResolver.js'
import { prepareProductForSync, validateRequiredProductInput } from './productPreparation.js'
import { productAttributesContainRemoteSubset, reverseTransformProduct } from './transformers.js'

// ---------------------------------------------------------------------------
// Single product push
// ---------------------------------------------------------------------------

export const pushProduct = async (args: {
  apiClient: GoogleApiClient
  options: NormalizedPluginOptions
  payload: Payload
  productId: string
  retryService: RetryService
}): Promise<SyncResult> => {
  const { apiClient, options, payload, productId, retryService } = args
  const log = createPluginLogger(payload.logger, { operation: 'push', productId })
  const collectionSlug = options.collections.products.slug

  // 1. Fetch the product document (depth hydrates relationships for field mappings)
  const product = await payload.findByID({
    id: productId,
    collection: collectionSlug,
    depth: options.collections.products.fetchDepth,
  }).then(asProductDoc)

  // 2. Set syncing state
  await updateSyncMeta(payload, collectionSlug, productId, {
    lastAction: 'saveSync',
    lastError: undefined,
    state: 'syncing',
    syncSource: 'push',
  })

  try {
    const pushStartedAt = new Date().toISOString()

    // 3. Resolve identity
    const identityResult = resolveIdentity(product, options)
    if (!identityResult.ok) {
      const errorMsg = identityResult.errors.join('; ')
      await updateSyncMeta(payload, collectionSlug, productId, {
        lastError: errorMsg,
        state: 'error',
      })
      return { action: 'insert', productId, success: false }
    }

    const identity = identityResult.value
    const { action, input, product: preparedProduct } = await prepareProductForSync({
      identity,
      options,
      payload,
      product,
    })

    // 5. Pre-flight validation — required MC fields
    const validationErrors = validateRequiredProductInput(input)
    if (validationErrors.length > 0) {
      const errorMsg = `Missing required fields: ${validationErrors.join(', ')}`
      log.error('Pre-flight validation failed', { errors: validationErrors })
      await updateSyncMeta(payload, collectionSlug, productId, {
        lastError: errorMsg,
        state: 'error',
      })
      return { action, productId, success: false }
    }

    // 6. Insert product input (MC v1 insert is an upsert — creates or replaces)

    await retryService.execute(
      () =>
        apiClient.insertProductInput(
          input as unknown as Record<string, unknown>,
          payload,
          identity.dataSourceOverride
            ? `accounts/${options.merchantId}/dataSources/${identity.dataSourceOverride}`
            : undefined,
        ),
      {
        merchantProductId: identity.merchantProductId,
        operation: 'insertProductInput',
        productId,
      },
    )

    // 7. Fetch processed snapshot
    let snapshot: Record<string, unknown> | undefined
    let warning: string | undefined
    try {
      const snapshotResponse = await retryService.execute(
        () => apiClient.getProduct(identity.productName, payload),
        {
          merchantProductId: identity.merchantProductId,
          operation: 'getProduct',
          productId,
        },
      )
      const fetchedSnapshot = snapshotResponse.data
      const remoteProductAttributes = reverseTransformProduct(fetchedSnapshot).productAttributes
      const remoteLastModified = extractMCProductLastModified(fetchedSnapshot)
      const pushReachedProcessedProduct = isRemoteNewerThanLocal({
        localLastSyncedAt: pushStartedAt,
        mcLastModified: remoteLastModified,
      })
      const preparedProductAttributes = reverseTransformProduct({
        ...(input.customAttributes ? { customAttributes: input.customAttributes } : {}),
        productAttributes: input.productAttributes ?? {},
      }).productAttributes

      if (
        pushReachedProcessedProduct === false &&
        !productAttributesContainRemoteSubset(
          preparedProductAttributes,
          remoteProductAttributes,
        )
      ) {
        warning =
          'Push succeeded, but Merchant Center is still serving an older processed product. Snapshot and pull may lag this push for a few minutes.'
      } else {
        snapshot = fetchedSnapshot
      }
    } catch (snapshotError) {
      // Snapshot fetch is non-critical — product was still synced
      log.warn('Failed to fetch snapshot after sync', {
        error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
        merchantProductId: identity.merchantProductId,
      })
    }

    const {
      customAttributes: storedCustomAttributes,
      productAttributes: storedProductAttributes,
    } = reverseTransformProduct({
      ...(input.customAttributes ? { customAttributes: input.customAttributes } : {}),
      productAttributes: input.productAttributes ?? {},
    })

    const preparedMCState = preparedProduct[MC_FIELD_GROUP_NAME]
    const persistedMCState = {
      ...(typeof preparedMCState === 'object' && preparedMCState ? preparedMCState : {}),
      ...(storedCustomAttributes ? { customAttributes: storedCustomAttributes } : {}),
      identity: {
        ...(typeof preparedMCState?.identity === 'object' && preparedMCState.identity
          ? preparedMCState.identity
          : {}),
        contentLanguage: input.contentLanguage,
        feedLabel: input.feedLabel,
        offerId: input.offerId,
      },
      [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: storedProductAttributes,
      snapshot: snapshot ?? preparedMCState?.snapshot,
      syncMeta: {
        ...(typeof preparedMCState?.syncMeta === 'object' && preparedMCState.syncMeta
          ? preparedMCState.syncMeta
          : {}),
        dirty: false,
        lastAction: 'saveSync',
        lastError: null,
        lastSyncedAt: new Date().toISOString(),
        state: 'success',
        syncSource: 'push',
      },
    }

    await payload.update({
      id: productId,
      collection: collectionSlug as never,
      context: buildInternalSyncContext(),
      data: {
        [MC_FIELD_GROUP_NAME]: persistedMCState,
      } as never,
      depth: 0,
      overrideAccess: true,
    })

    return {
      action,
      productId,
      snapshot: snapshot ?? preparedMCState?.snapshot,
      success: true,
      ...(warning ? { warning } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Push failed', { error: message })
    await updateSyncMeta(payload, collectionSlug, productId, {
      lastError: message,
      state: 'error',
    })
    return { action: 'insert', productId, success: false }
  }
}

// ---------------------------------------------------------------------------
// Delete from Merchant Center
// ---------------------------------------------------------------------------

export const deleteFromMC = async (args: {
  apiClient: GoogleApiClient
  options: NormalizedPluginOptions
  payload: Payload
  productId: string
  retryService: RetryService
}): Promise<SyncResult> => {
  const { apiClient, options, payload, productId, retryService } = args
  const collectionSlug = options.collections.products.slug

  const product = await payload.findByID({
    id: productId,
    collection: collectionSlug,
    depth: 0,
  }).then(asProductDoc)

  const identityResult = resolveIdentity(product, options)
  if (!identityResult.ok) {
    return { action: 'delete', productId, success: false }
  }

  const identity = identityResult.value

  await updateSyncMeta(payload, collectionSlug, productId, {
    lastAction: 'delete',
    lastError: undefined,
    state: 'syncing',
    syncSource: 'push',
  })

  try {
    await retryService.execute(
      () =>
        apiClient.deleteProductInput(
          identity.productInputName,
          payload,
          identity.dataSourceOverride
            ? `accounts/${options.merchantId}/dataSources/${identity.dataSourceOverride}`
            : undefined,
        ),
      {
        merchantProductId: identity.merchantProductId,
        operation: 'deleteProductInput',
        productId,
      },
    )

    await updateSyncMeta(payload, collectionSlug, productId, {
      lastError: undefined,
      lastSyncedAt: new Date().toISOString(),
      state: 'success',
    }, null)

    return { action: 'delete', productId, success: true }
  } catch (error) {
    // 404 means already deleted — treat as success
    if (error instanceof GoogleApiError && error.statusCode === 404) {
      await updateSyncMeta(payload, collectionSlug, productId, {
        lastError: undefined,
        lastSyncedAt: new Date().toISOString(),
        state: 'success',
      }, null)
      return { action: 'delete', productId, success: true }
    }

    const message = error instanceof Error ? error.message : String(error)
    await updateSyncMeta(payload, collectionSlug, productId, {
      lastError: message,
      state: 'error',
    })
    return { action: 'delete', productId, success: false }
  }
}

// ---------------------------------------------------------------------------
// Delete from MC by pre-resolved identity (used by afterDelete hook where
// the Payload document has already been deleted and cannot be re-fetched)
// ---------------------------------------------------------------------------

export const deleteFromMCByIdentity = async (args: {
  apiClient: GoogleApiClient
  identity: ResolvedMCIdentity
  options: NormalizedPluginOptions
  payload: Payload
  productId: string
  retryService: RetryService
}): Promise<SyncResult> => {
  const { apiClient, identity, options, payload, productId, retryService } = args

  try {
    await retryService.execute(
      () =>
        apiClient.deleteProductInput(
          identity.productInputName,
          payload,
          identity.dataSourceOverride
            ? `accounts/${options.merchantId}/dataSources/${identity.dataSourceOverride}`
            : undefined,
        ),
      {
        merchantProductId: identity.merchantProductId,
        operation: 'deleteProductInput (afterDelete)',
        productId,
      },
    )

    return { action: 'delete', productId, success: true }
  } catch (error) {
    if (error instanceof GoogleApiError && error.statusCode === 404) {
      return { action: 'delete', productId, success: true }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Refresh snapshot (read-only)
// ---------------------------------------------------------------------------

export const refreshSnapshot = async (args: {
  apiClient: GoogleApiClient
  options: NormalizedPluginOptions
  payload: Payload
  productId: string
  retryService: RetryService
}): Promise<SyncResult> => {
  const { apiClient, options, payload, productId, retryService } = args
  const collectionSlug = options.collections.products.slug

  const product = await payload.findByID({
    id: productId,
    collection: collectionSlug,
    depth: 0,
  }).then(asProductDoc)
  const localSyncMeta = product[MC_FIELD_GROUP_NAME]?.syncMeta

  const identityResult = resolveIdentity(product, options)
  if (!identityResult.ok) {
    return { action: 'update', productId, success: false }
  }

  const identity = identityResult.value

  try {
    const response = await retryService.execute(
      () => apiClient.getProduct(identity.productName, payload),
      {
        merchantProductId: identity.merchantProductId,
        operation: 'getProduct (refresh)',
        productId,
      },
    )

    const remoteProductAttributes = reverseTransformProduct(response.data).productAttributes
    const localProductAttributes =
      product[MC_FIELD_GROUP_NAME]?.[MC_PRODUCT_ATTRIBUTES_FIELD_NAME] as Record<string, unknown> | undefined
    const remoteLastModified = extractMCProductLastModified(response.data)
    const remoteIsNewer = isRemoteNewerThanLocal({
      localLastSyncedAt: localSyncMeta?.lastSyncedAt,
      mcLastModified: remoteLastModified,
    })
    const remoteMatchesLocal = productAttributesContainRemoteSubset(
      localProductAttributes,
      remoteProductAttributes,
    )

    const warning = remoteIsNewer === false && !remoteMatchesLocal
      ? 'Merchant Center is still serving an older processed product than the latest local sync. Snapshot was left unchanged; try again in a few minutes.'
      : undefined

    await updateSyncMeta(payload, collectionSlug, productId, {
      lastAction: 'refresh',
      lastError: undefined,
      state: 'success',
      syncSource: 'pull',
    }, remoteIsNewer === false && !remoteMatchesLocal ? undefined : response.data)

    return {
      action: 'update',
      productId,
      snapshot:
        remoteIsNewer === false && !remoteMatchesLocal
          ? product[MC_FIELD_GROUP_NAME]?.snapshot
          : response.data,
      success: true,
      ...(warning ? { warning } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateSyncMeta(payload, collectionSlug, productId, {
      lastAction: 'refresh',
      lastError: message,
      state: 'error',
    })
    return { action: 'update', productId, success: false }
  }
}

// ---------------------------------------------------------------------------
// Sync metadata persistence
// ---------------------------------------------------------------------------

const updateSyncMeta = async (
  payload: Payload,
  collectionSlug: string,
  productId: string,
  meta: Record<string, unknown>,
  snapshot?: null | Record<string, unknown>,
): Promise<void> => {
  const updateData: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(meta)) {
    updateData[`${MC_FIELD_GROUP_NAME}.syncMeta.${key}`] =
      key === 'lastError' && value === undefined ? null : value
  }

  if (snapshot !== undefined) {
    updateData[`${MC_FIELD_GROUP_NAME}.snapshot`] = snapshot
  }

  const log = createPluginLogger(payload.logger, { operation: 'updateSyncMeta', productId })

  try {
    await payload.update({
      id: productId,
      collection: collectionSlug as never,
      context: buildInternalSyncContext(),
      data: unflatten(updateData),
      depth: 0,
      overrideAccess: true,
    })
  } catch (error) {
    log.error('Failed to update sync metadata — product state may be stale in admin UI', {
      collection: collectionSlug,
      error: error instanceof Error ? error.message : String(error),
      meta,
      productId,
    })
  }
}

// ---------------------------------------------------------------------------
// Unflatten dot-notation keys into nested object
// ---------------------------------------------------------------------------

const unflatten = (obj: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    const parts = key.split('.')
    let current = result

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
        current[part] = {}
      }
      current = current[part] as Record<string, unknown>
    }

    current[parts[parts.length - 1]] = value
  }

  return result
}
