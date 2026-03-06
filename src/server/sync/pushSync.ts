import type { Payload } from 'payload'

import type { MCProductState, NormalizedPluginOptions, SyncResult } from '../../types/index.js'
import type { GoogleApiClient } from '../services/sub-services/googleApiClient.js'
import type { RetryService } from '../services/sub-services/retryService.js'

import { MC_FIELD_GROUP_NAME } from '../../constants.js'
import { GoogleApiError } from '../services/sub-services/googleApiClient.js'
import { createPluginLogger } from '../utilities/logger.js'
import { resolveIdentity } from './identityResolver.js'
import { buildProductInput } from './transformers.js'

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

  // 1. Fetch the product document
  const product = await payload.findByID({
    id: productId,
    collection: collectionSlug,
    depth: 0,
  }) as unknown as Record<string, unknown>

  // 2. Set syncing state
  await updateSyncMeta(payload, collectionSlug, productId, {
    lastAction: 'saveSync',
    lastError: undefined,
    state: 'syncing',
    syncSource: 'push',
  })

  try {
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
    const input = buildProductInput(product, identity, options)

    // 4. Insert product input (MC v1 insert is an upsert — creates or replaces)
    const mcState = product.merchantCenter as MCProductState | undefined
    const hasSnapshot = mcState?.snapshot && Object.keys(mcState.snapshot).length > 0
    const action: 'insert' | 'update' = hasSnapshot ? 'update' : 'insert'

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

    // 5. Fetch processed snapshot
    let snapshot: Record<string, unknown> | undefined
    try {
      const snapshotResponse = await retryService.execute(
        () => apiClient.getProduct(identity.productName, payload),
        {
          merchantProductId: identity.merchantProductId,
          operation: 'getProduct',
          productId,
        },
      )
      snapshot = snapshotResponse.data
    } catch (snapshotError) {
      // Snapshot fetch is non-critical — product was still synced
      log.warn('Failed to fetch snapshot after sync', {
        error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
        merchantProductId: identity.merchantProductId,
      })
    }

    // 6. Update success state and clear dirty flag
    await updateSyncMeta(payload, collectionSlug, productId, {
      dirty: false,
      lastError: undefined,
      lastSyncedAt: new Date().toISOString(),
      state: 'success',
    }, snapshot)

    return { action, productId, snapshot, success: true }
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)
    if (error instanceof GoogleApiError && error.responseBody) {
      message += ` | Response: ${JSON.stringify(error.responseBody)}`
    }
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
  }) as unknown as Record<string, unknown>

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
  }) as unknown as Record<string, unknown>

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

    await updateSyncMeta(payload, collectionSlug, productId, {
      lastAction: 'refresh',
      lastError: undefined,
      lastSyncedAt: new Date().toISOString(),
      state: 'success',
    }, response.data)

    return { action: 'update', productId, snapshot: response.data, success: true }
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
    updateData[`${MC_FIELD_GROUP_NAME}.syncMeta.${key}`] = value
  }

  if (snapshot !== undefined) {
    updateData[`${MC_FIELD_GROUP_NAME}.snapshot`] = snapshot
  }

  const log = createPluginLogger(payload.logger, { operation: 'updateSyncMeta', productId })

  try {
    await payload.update({
      id: productId,
      collection: collectionSlug as never,
      data: unflatten(updateData),
      depth: 0,
    })
  } catch (error) {
    log.error('Failed to update sync metadata', {
      error: error instanceof Error ? error.message : String(error),
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
