import type { ConflictStrategy, MCSyncMeta } from '../../types/index.js'

import { asRecord } from '../utilities/recordUtils.js'

export type ConflictCheckResult =
  | { action: 'proceed' }
  | { action: 'skip'; reason: string }

const toTimestamp = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined
  }

  const timestamp = new Date(value).getTime()
  return Number.isNaN(timestamp) ? undefined : timestamp
}

export const extractMCProductLastModified = (
  mcProduct: Record<string, unknown>,
): string | undefined => {
  if (typeof mcProduct.updateTime === 'string' && mcProduct.updateTime) {
    return mcProduct.updateTime
  }

  const productStatus = asRecord(mcProduct.productStatus)
  if (
    typeof productStatus.lastUpdateDate === 'string' &&
    productStatus.lastUpdateDate
  ) {
    return productStatus.lastUpdateDate
  }

  return undefined
}

export const isRemoteNewerThanLocal = (args: {
  localLastSyncedAt?: string
  mcLastModified?: string
}): boolean | undefined => {
  const localTimestamp = toTimestamp(args.localLastSyncedAt)
  const remoteTimestamp = toTimestamp(args.mcLastModified)

  if (localTimestamp === undefined || remoteTimestamp === undefined) {
    return undefined
  }

  return remoteTimestamp > localTimestamp
}

/**
 * Determines whether a pull operation should proceed based on the
 * conflict strategy and local modification state.
 *
 * Called before overwriting local data with MC data during pull operations.
 */
export const checkPullConflict = (args: {
  localSyncMeta?: MCSyncMeta
  mcLastModified?: string
  remoteMatchesLocal?: boolean
  strategy: ConflictStrategy
}): ConflictCheckResult => {
  const { localSyncMeta, mcLastModified, remoteMatchesLocal, strategy } = args

  switch (strategy) {
    case 'mc-wins':
      // MC is source of truth — always overwrite local data
      return { action: 'proceed' }

    case 'newest-wins': {
      // Protect local unsynced edits first, then compare modification times.
      if (localSyncMeta?.dirty) {
        return {
          action: 'skip',
          reason: 'Local document has unsynced Merchant Center changes (dirty=true); newest-wins skips pull to protect local overrides',
        }
      }

      const remoteIsNewer = isRemoteNewerThanLocal({
        localLastSyncedAt: localSyncMeta?.lastSyncedAt,
        mcLastModified,
      })

      if (remoteMatchesLocal) {
        return { action: 'proceed' }
      }

      if (remoteIsNewer === undefined) {
        // Cannot determine recency reliably — proceed.
        return { action: 'proceed' }
      }

      if (remoteIsNewer) {
        return { action: 'proceed' }
      }

      return {
        action: 'skip',
        reason: `MC product is not newer than last sync (mc=${mcLastModified}, lastSync=${localSyncMeta?.lastSyncedAt ?? 'unknown'}); newest-wins strategy skips pull`,
      }
    }

    case 'payload-wins': {
      // Skip if local has been modified since last sync
      if (localSyncMeta?.dirty) {
        return {
          action: 'skip',
          reason: 'Local document has been modified (dirty=true); payload-wins strategy skips pull',
        }
      }
      return { action: 'proceed' }
    }

    default:
      return { action: 'proceed' }
  }
}
