import type { ConflictStrategy, MCSyncMeta } from '../../types/index.js'

export type ConflictCheckResult =
  | { action: 'proceed' }
  | { action: 'skip'; reason: string }

/**
 * Determines whether a pull operation should proceed based on the
 * conflict strategy and local modification state.
 *
 * Called before overwriting local data with MC data during pull operations.
 */
export const checkPullConflict = (args: {
  localSyncMeta?: MCSyncMeta
  mcLastModified?: string
  strategy: ConflictStrategy
}): ConflictCheckResult => {
  const { localSyncMeta, mcLastModified, strategy } = args

  switch (strategy) {
    case 'mc-wins':
      // MC is source of truth — always overwrite local data
      return { action: 'proceed' }

    case 'newest-wins': {
      // Compare lastSyncedAt with mcLastModified; proceed only if MC is newer
      if (!mcLastModified) {
        // Cannot determine MC modification time — proceed to be safe
        return { action: 'proceed' }
      }

      if (!localSyncMeta?.lastSyncedAt) {
        // Never synced before — proceed
        return { action: 'proceed' }
      }

      const mcDate = new Date(mcLastModified).getTime()
      const localDate = new Date(localSyncMeta.lastSyncedAt).getTime()

      if (Number.isNaN(mcDate) || Number.isNaN(localDate)) {
        // Invalid dates — proceed to be safe
        return { action: 'proceed' }
      }

      if (mcDate > localDate) {
        return { action: 'proceed' }
      }

      return {
        action: 'skip',
        reason: `MC product is not newer than last sync (mc=${mcLastModified}, lastSync=${localSyncMeta.lastSyncedAt}); newest-wins strategy skips pull`,
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
