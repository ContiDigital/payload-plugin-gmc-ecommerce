import type { Payload } from 'payload'

import { randomBytes } from 'crypto'

import type {
  NormalizedPluginOptions,
  ResolvedMCIdentity,
  SyncResult,
} from '../../types/index.js'
import type { GoogleApiClient } from '../services/sub-services/googleApiClient.js'
import type { RetryService } from '../services/sub-services/retryService.js'

import {
  MC_FIELD_GROUP_NAME,
  MC_PRODUCT_ATTRIBUTES_FIELD_NAME,
} from '../../constants.js'
import { GoogleApiError } from '../services/sub-services/googleApiClient.js'
import { createPluginLogger } from '../utilities/logger.js'
import { asProductDoc, asRecord } from '../utilities/recordUtils.js'
import { extractMCProductLastModified, isRemoteNewerThanLocal } from './conflictResolver.js'
import { resolveIdentity } from './identityResolver.js'
import { syncLocalInventory } from './localInventorySync.js'
import { STATE_NOT_PERSISTED_WARNING, writeMCState } from './mcStateWriter.js'
import { prepareProductForSync, validateRequiredProductInput } from './productPreparation.js'
import {
  productAttributesContainRemoteSubset,
  productAttributesEquivalent,
  reverseTransformProduct,
} from './transformers.js'

/**
 * Value equality for one stored attribute, ignoring array-row ids — the sent
 * value has none and the stored one does.
 */
const attributeEquivalent = (left: unknown, right: unknown): boolean =>
  productAttributesEquivalent({ value: left }, { value: right })

export const CONTENT_CHANGED_MID_PUSH_WARNING =
  'The product changed while Merchant Center was being updated, so it stays queued for another sync. Merchant Center currently holds the earlier version.'

/**
 * The identity fields the live row does not set for itself, filled in with the
 * values this push actually used.
 *
 * `resolveIdentity` falls back to the plugin defaults for a blank
 * `contentLanguage` or `feedLabel`, so materialising them here pins the product
 * to the remote object it was really written to: a later change to those
 * defaults then cannot silently re-point the product and orphan its Merchant
 * Center listing. Fields the row already has are never touched, so this can
 * only ever fill a gap — including one an editor filled in mid-push.
 */
const blankIdentityFields = (
  stored: Record<string, unknown>,
  identity: ResolvedMCIdentity,
): Record<string, string> | undefined => {
  const seed: Record<string, string> = {}

  if (!stored.offerId) {
    seed.offerId = identity.offerId
  }
  if (!stored.contentLanguage) {
    seed.contentLanguage = identity.contentLanguage
  }
  if (!stored.feedLabel) {
    seed.feedLabel = identity.feedLabel
  }

  return Object.keys(seed).length > 0 ? seed : undefined
}

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

  // 1. Set syncing state, stamped with a token this push will look for again on
  //    the way back. `beforeChange` nulls it on every save, so finding it intact
  //    is proof that nothing was edited while Merchant Center was being updated.
  //
  //    This has to happen BEFORE the content is read: a save landing between the
  //    read and the stamp would be sent to Merchant Center stale and then
  //    certified clean by this push's own freshly-stamped token.
  const syncToken = randomBytes(12).toString('hex')

  await updateSyncMeta(payload, collectionSlug, productId, {
    lastAction: 'saveSync',
    lastError: undefined,
    state: 'syncing',
    syncSource: 'push',
    syncToken,
  })

  try {
    const pushStartedAt = new Date().toISOString()

    // 2. Fetch the product document (depth hydrates relationships for field
    //    mappings). Inside the try: the state has already been stamped, so a
    //    read failure has to be recorded rather than leaving the product
    //    stranded in `syncing` with a token nobody will clear.
    const product = await payload.findByID({
      id: productId,
      collection: collectionSlug,
      depth: options.collections.products.fetchDepth,
    }).then(asProductDoc)

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
    const { action, derivedAttributes, input, product: preparedProduct } = await prepareProductForSync({
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
    const warnings: string[] = []
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
        warnings.push(
          'Push succeeded, but Merchant Center is still serving an older processed product. Snapshot and pull may lag this push for a few minutes.',
        )
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

    // What the push is allowed to persist back.
    //
    // Everything here was either produced by this push or is plugin
    // bookkeeping. Editorial state — anything an editor typed, and anything a
    // `permanent` mapping recomputes on every save — is deliberately absent,
    // and what remains is assembled against the row as it stands at write time
    // rather than the document read before the Merchant Center round-trip. A
    // save that landed in between is therefore respected, not reverted.
    // What this push actually put on the wire, in storage shape, and the
    // attributes as they stood when the push read the product.
    const sentAttributes = reverseTransformProduct({
      productAttributes: input.productAttributes ?? {},
    }).productAttributes
    const attributesAtPushStart = asRecord(
      asRecord(product[MC_FIELD_GROUP_NAME])[MC_PRODUCT_ATTRIBUTES_FIELD_NAME],
    )

    let contentChangedMidPush = false

    const statePersisted = await writeMCState(payload, collectionSlug, productId, (row) => {
      const liveMCState = asRecord(row[MC_FIELD_GROUP_NAME])
      const liveSyncMeta = asRecord(liveMCState.syncMeta)
      const liveAttributes = asRecord(liveMCState[MC_PRODUCT_ATTRIBUTES_FIELD_NAME])

      contentChangedMidPush = liveSyncMeta.syncToken !== syncToken

      const persistedMCState: Record<string, unknown> = {
        syncMeta: {
          // Merchant Center holds what this push sent. If the product changed
          // since, that is not what the product says now, so it stays queued.
          dirty: contentChangedMidPush,
          lastAction: 'saveSync',
          lastError: null,
          lastSyncedAt: new Date().toISOString(),
          state: 'success',
          syncSource: 'push',
          syncToken: null,
        },
      }

      // Omitted rather than nulled when the refresh failed, so the merge keeps
      // whatever snapshot the document already had.
      if (snapshot) {
        persistedMCState.snapshot = snapshot
      }

      // Record what was sent, attribute by attribute.
      //
      // `mc.attrs` is what `refreshSnapshot` and `pullProduct` compare the
      // remote product against, and with the default `permanentSync: false` —
      // or for mappings defined in the runtime mappings collection, which
      // `beforeChange` never applies — this write is the only thing that puts
      // the sent values there.
      //
      // An attribute is only written when the row still holds what the push
      // read: anything an editor changed while the round-trip was in flight
      // keeps the editor's value. Attributes that already match are skipped so
      // an unchanged push does not churn the array tables.
      const attributeWrite = Object.fromEntries(
        Object.entries({ ...sentAttributes, ...derivedAttributes }).filter(([key, value]) => {
          const unchangedSinceRead = attributeEquivalent(
            liveAttributes[key],
            attributesAtPushStart[key],
          )

          return unchangedSinceRead && !attributeEquivalent(liveAttributes[key], value)
        }),
      )
      if (Object.keys(attributeWrite).length > 0) {
        persistedMCState[MC_PRODUCT_ATTRIBUTES_FIELD_NAME] = attributeWrite
      }

      const identitySeed = blankIdentityFields(asRecord(liveMCState.identity), identity)
      if (identitySeed) {
        persistedMCState.identity = identitySeed
      }

      return { [MC_FIELD_GROUP_NAME]: persistedMCState }
    })

    if (!statePersisted) {
      warnings.push(STATE_NOT_PERSISTED_WARNING)
    } else if (contentChangedMidPush) {
      warnings.push(CONTENT_CHANGED_MID_PUSH_WARNING)
    }

    // 9. Sync local inventory (non-critical — failures are logged but don't fail the push)
    if (options.localInventory.enabled) {
      const availability = input.productAttributes?.availability
      const localAvailability = options.localInventory.availabilityResolver
        ? options.localInventory.availabilityResolver(preparedProduct)
        : availability === 'IN_STOCK' ? 'in_stock' as const : null

      await syncLocalInventory({
        apiClient,
        identity,
        localAvailability,
        options,
        payload,
        price: input.productAttributes?.price,
        productId,
        retryService,
      }).catch((err) => {
        log.warn('Local inventory sync failed (non-critical)', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }

    return {
      action,
      productId,
      snapshot: snapshot ?? preparedProduct[MC_FIELD_GROUP_NAME]?.snapshot,
      statePersisted,
      success: true,
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
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

  const recordDeleteSuccess = () =>
    updateSyncMeta(payload, collectionSlug, productId, {
      lastError: undefined,
      lastSyncedAt: new Date().toISOString(),
      state: 'success',
    }, null)

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

    return deleteSucceeded(await recordDeleteSuccess(), productId)
  } catch (error) {
    // 404 means already deleted — treat as success
    if (error instanceof GoogleApiError && error.statusCode === 404) {
      return deleteSucceeded(await recordDeleteSuccess(), productId)
    }

    const message = error instanceof Error ? error.message : String(error)
    await updateSyncMeta(payload, collectionSlug, productId, {
      lastError: message,
      state: 'error',
    })
    return { action: 'delete', productId, success: false }
  }
}

const deleteSucceeded = (statePersisted: boolean, productId: string): SyncResult => ({
  action: 'delete',
  productId,
  statePersisted,
  success: true,
  ...(statePersisted ? {} : { warning: STATE_NOT_PERSISTED_WARNING }),
})

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

    const statePersisted = await updateSyncMeta(payload, collectionSlug, productId, {
      lastAction: 'refresh',
      lastError: undefined,
      state: 'success',
      syncSource: 'pull',
    }, remoteIsNewer === false && !remoteMatchesLocal ? undefined : response.data)

    const warnings = [
      ...(warning ? [warning] : []),
      ...(statePersisted ? [] : [STATE_NOT_PERSISTED_WARNING]),
    ]

    return {
      action: 'update',
      productId,
      snapshot:
        remoteIsNewer === false && !remoteMatchesLocal
          ? product[MC_FIELD_GROUP_NAME]?.snapshot
          : response.data,
      statePersisted,
      success: true,
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
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

/**
 * Persist a sync-metadata change, reporting whether it actually landed.
 *
 * Adapter failures are logged rather than thrown: every caller is already
 * either reporting an error or finishing a completed Merchant Center
 * operation, and losing that outcome to a bookkeeping failure would be worse
 * than recording it. The return value is what stops the caller from then
 * claiming the state was saved.
 */
const updateSyncMeta = async (
  payload: Payload,
  collectionSlug: string,
  productId: string,
  meta: Record<string, unknown>,
  snapshot?: null | Record<string, unknown>,
): Promise<boolean> => {
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
    return await writeMCState(payload, collectionSlug, productId, unflatten(updateData))
  } catch (error) {
    log.error('Failed to update sync metadata — product state may be stale in admin UI', {
      collection: collectionSlug,
      error: error instanceof Error ? error.message : String(error),
      meta,
      productId,
    })

    return false
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
