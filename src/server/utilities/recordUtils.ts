import type { PayloadProductDoc } from '../../types/index.js'

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

export const asRecord = (value: unknown): Record<string, unknown> => {
  return isRecord(value) ? value : {}
}

/**
 * Cast an unknown value (typically a Payload document) to a PayloadProductDoc.
 * Typed convenience over `asRecord` for product documents that carry the
 * injected merchant center group.
 */
export const asProductDoc = (value: unknown): PayloadProductDoc => {
  const record = asRecord(value)
  return record as PayloadProductDoc
}

export const getRecordID = (value: unknown): number | string | undefined => {
  const record = asRecord(value)
  return typeof record.id === 'number' || typeof record.id === 'string'
    ? record.id
    : undefined
}
