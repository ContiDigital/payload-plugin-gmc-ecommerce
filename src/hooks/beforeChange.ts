import type { CollectionBeforeChangeHook } from 'payload'

import type {
  MCProductAttributes,
  MCProductState,
  MCSyncMeta,
  NormalizedPluginOptions,
  PayloadProductDoc,
} from '../types/index.js'

import { MC_FIELD_GROUP_NAME } from '../constants.js'
import { applyFieldMappings, deepMerge } from '../server/sync/fieldMapping.js'
import { shouldSkipSyncHooks } from '../server/sync/hookContext.js'

const resolveEnabledState = (
  data: PayloadProductDoc,
  originalDoc?: PayloadProductDoc,
): boolean => {
  const incoming = data[MC_FIELD_GROUP_NAME]
  if (typeof incoming?.enabled === 'boolean') {
    return incoming.enabled
  }

  const existing = originalDoc?.[MC_FIELD_GROUP_NAME]
  return existing?.enabled === true
}

const ensureMCState = (data: PayloadProductDoc): MCProductState => {
  if (!data[MC_FIELD_GROUP_NAME] || typeof data[MC_FIELD_GROUP_NAME] !== 'object') {
    data[MC_FIELD_GROUP_NAME] = {}
  }

  return data[MC_FIELD_GROUP_NAME]
}

const normalizeIdentityFieldValue = (value: unknown): null | string => {
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return String(value)
  }

  return null
}

export const createBeforeChangeHook = (
  options: NormalizedPluginOptions,
): CollectionBeforeChangeHook => {
  return ({ context, data, originalDoc }) => {
    if (shouldSkipSyncHooks(context)) {
      return data
    }

    const original = (originalDoc ?? {}) as PayloadProductDoc
    if (!resolveEnabledState(data as PayloadProductDoc, original)) {
      return data
    }

    const mergedDoc = deepMerge(
      original as Record<string, unknown>,
      data as Record<string, unknown>,
    ) as PayloadProductDoc
    const mcState: MCProductState = mergedDoc[MC_FIELD_GROUP_NAME] ?? {}
    const incomingMCState = ensureMCState(data as PayloadProductDoc)

    // 1. Auto-populate offerId from identity field if not set
    const identity = mcState.identity ?? {}
    if (!identity.offerId || identity.offerId.trim().length === 0) {
      const identityFieldValue = normalizeIdentityFieldValue(
        mergedDoc[options.collections.products.identityField],
      )
      if (identityFieldValue) {
        if (!incomingMCState.identity || typeof incomingMCState.identity !== 'object') {
          incomingMCState.identity = {}
        }
        incomingMCState.identity.offerId = identityFieldValue
      }
    }

    // 2. Apply permanent field mappings
    const permanentMappings = options.collections.products.fieldMappings.filter(
      (m) => m.syncMode === 'permanent',
    )

    if (permanentMappings.length > 0 && options.sync.permanentSync) {
      const mappedValues = applyFieldMappings(
        mergedDoc as Record<string, unknown>,
        permanentMappings,
        'permanent',
        { siteUrl: options.siteUrl },
      )
      const currentAttrs: MCProductAttributes = mcState.productAttributes ?? {}
      const mappedAttrs = (mappedValues.productAttributes ?? mappedValues) as Record<string, unknown>
      incomingMCState.productAttributes = deepMerge(
        currentAttrs as Record<string, unknown>,
        mappedAttrs,
      ) as MCProductAttributes
    }

    // 3. Mark enabled products as dirty on create and update so onChange and
    // scheduled flows both see the same state transition.
    const incomingSyncMeta: MCSyncMeta = (incomingMCState.syncMeta ?? {}) as MCSyncMeta
    incomingSyncMeta.dirty = true

    const existingSyncMeta: MCSyncMeta = mcState.syncMeta ?? { state: 'idle' }
    incomingMCState.syncMeta = deepMerge(
      existingSyncMeta as Record<string, unknown>,
      incomingSyncMeta as Record<string, unknown>,
    ) as MCSyncMeta

    return data
  }
}
