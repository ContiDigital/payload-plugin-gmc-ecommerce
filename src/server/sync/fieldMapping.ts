import type { FieldMapping, FieldSyncMode, TransformPreset } from '../../types/index.js'

import { getByPath, setByPath } from '../utilities/pathUtils.js'
import { toMicros } from './transformers.js'

// ---------------------------------------------------------------------------
// Transform presets
// ---------------------------------------------------------------------------

export type TransformContext = {
  siteUrl?: string
}

const extractUrlFromValue = (value: unknown): unknown => {
  if (typeof value === 'object' && value !== null) {
    return (value as Record<string, unknown>).url
      ?? (value as Record<string, unknown>).src
      ?? (value as Record<string, unknown>).href
      ?? value
  }
  return value
}

const applyTransformPreset = (value: unknown, preset: TransformPreset, ctx?: TransformContext): unknown => {
  switch (preset) {
    case 'extractAbsoluteUrl': {
      const url = extractUrlFromValue(value)
      if (typeof url === 'string' && url.startsWith('/') && ctx?.siteUrl) {
        return `${ctx.siteUrl}${url}`
      }
      return url
    }

    case 'extractUrl':
      return extractUrlFromValue(value)

    case 'toArray':
      if (Array.isArray(value)) {
        return value
      }
      if (value !== null && value !== undefined) {
        return [value]
      }
      return []

    case 'toBoolean':
      return Boolean(value)

    case 'toMicros':
      if (typeof value === 'number') {
        return toMicros(value)
      }
      return value

    case 'toMicrosString':
      if (typeof value === 'number') {
        return toMicros(value)
      }
      if (typeof value === 'string') {
        const num = Number(value)
        return Number.isFinite(num) ? toMicros(num) : value
      }
      return value

    case 'toString':
      if (value === null || value === undefined) {
        return ''
      }
      return typeof value === 'object' ? JSON.stringify(value) : String(value as boolean | number | string)

    case 'none':
    default:
      return value
  }
}

// ---------------------------------------------------------------------------
// Apply field mappings to populate MC fields from product data
// ---------------------------------------------------------------------------

export const applyFieldMappings = (
  product: Record<string, unknown>,
  mappings: FieldMapping[],
  filterMode?: FieldSyncMode,
  ctx?: TransformContext,
): Record<string, unknown> => {
  const mcInput: Record<string, unknown> = {}

  const filteredMappings = filterMode
    ? mappings.filter((m) => m.syncMode === filterMode)
    : mappings

  const sortedMappings = [...filteredMappings].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  for (const mapping of sortedMappings) {
    const sourceValue = getByPath(product, mapping.source)

    if (sourceValue === undefined || sourceValue === null) {
      continue
    }

    const transformed = mapping.transformPreset && mapping.transformPreset !== 'none'
      ? applyTransformPreset(sourceValue, mapping.transformPreset, ctx)
      : sourceValue

    setByPath(mcInput, mapping.target, transformed)
  }

  return mcInput
}

// ---------------------------------------------------------------------------
// Deep merge: target values are overwritten by source values
// ---------------------------------------------------------------------------

export const deepMerge = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...target }

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue
    }

    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    } else {
      result[key] = value
    }
  }

  return result
}
