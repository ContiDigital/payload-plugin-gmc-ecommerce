import { describe, expect, test } from 'vitest'

import { parseBatchInput } from '../validation.js'

describe('parseBatchInput', () => {
  test('valid productIds', () => {
    const result = parseBatchInput({ productIds: ['id1', 'id2'] })
    expect(result.productIds).toEqual(['id1', 'id2'])
  })

  test('productIds with non-string entry throws', () => {
    expect(() => parseBatchInput({ productIds: ['id1', 123 as unknown as string] })).toThrow()
  })

  test('productIds with empty string throws', () => {
    expect(() => parseBatchInput({ productIds: ['id1', ''] })).toThrow()
  })

  test('non-array productIds throws', () => {
    expect(() => parseBatchInput({ productIds: 'not-an-array' as unknown as string[] })).toThrow()
  })

  test('valid filter object', () => {
    const filter = { status: 'draft' }
    const result = parseBatchInput({ filter })
    expect(result.filter).toEqual(filter)
  })

  test('non-object filter throws', () => {
    expect(() => parseBatchInput({ filter: 'bad' as unknown as Record<string, unknown> })).toThrow()
  })

  test('array filter throws', () => {
    expect(() => parseBatchInput({ filter: [] as unknown as Record<string, unknown> })).toThrow()
  })

  test('both undefined is fine', () => {
    const result = parseBatchInput({})
    expect(result.productIds).toBeUndefined()
    expect(result.filter).toBeUndefined()
  })
})
