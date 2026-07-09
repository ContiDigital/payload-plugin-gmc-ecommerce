import type { RequestContext } from 'payload'

export const GMC_SKIP_SYNC_HOOKS_CONTEXT_KEY = 'gmc:skip-sync-hooks'

export const buildInternalSyncContext = (
  context?: RequestContext,
): RequestContext => ({
  ...(context ?? {}),
  [GMC_SKIP_SYNC_HOOKS_CONTEXT_KEY]: true,
})

export const shouldSkipSyncHooks = (context?: RequestContext): boolean => {
  // Many host apps use `skipCollectionHooks` on bulk/internal writes. Treat it
  // the same as the plugin's own opt-out flag for GMC hooks.
  return (
    context?.[GMC_SKIP_SYNC_HOOKS_CONTEXT_KEY] === true ||
    context?.skipCollectionHooks === true
  )
}
