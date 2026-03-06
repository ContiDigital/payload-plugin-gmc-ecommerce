import { describe, expect, test } from 'vitest'

import type { FieldMapping } from '../../../types/index.js'

import { applyFieldMappings, deepMerge } from '../fieldMapping.js'

// ---------------------------------------------------------------------------
// applyFieldMappings
// ---------------------------------------------------------------------------

describe('applyFieldMappings', () => {
  test('maps simple source to target paths', () => {
    const product = { description: 'A description', title: 'My Product' }
    const mappings: FieldMapping[] = [
      { source: 'title', syncMode: 'permanent', target: 'title' },
      { source: 'description', syncMode: 'permanent', target: 'description' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.title).toBe('My Product')
    expect(result.description).toBe('A description')
  })

  test('maps nested source paths (e.g., "nested.value")', () => {
    const product = { meta: { seoTitle: 'SEO Title' } }
    const mappings: FieldMapping[] = [
      { source: 'meta.seoTitle', syncMode: 'permanent', target: 'title' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.title).toBe('SEO Title')
  })

  test('maps to nested target paths', () => {
    const product = { priceValue: 19.99 }
    const mappings: FieldMapping[] = [
      { source: 'priceValue', syncMode: 'permanent', target: 'price.amountMicros', transformPreset: 'toMicros' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect((result.price as Record<string, unknown>).amountMicros).toBe('19990000')
  })

  test('applies transformPreset toMicros for numbers', () => {
    const product = { price: 29.99 }
    const mappings: FieldMapping[] = [
      { source: 'price', syncMode: 'permanent', target: 'price.amountMicros', transformPreset: 'toMicros' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect((result.price as Record<string, unknown>).amountMicros).toBe('29990000')
  })

  test('toMicros does not transform non-numbers', () => {
    const product = { price: 'not-a-number' }
    const mappings: FieldMapping[] = [
      { source: 'price', syncMode: 'permanent', target: 'priceStr', transformPreset: 'toMicros' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.priceStr).toBe('not-a-number')
  })

  test('applies transformPreset toMicrosString for string numbers', () => {
    const product = { price: '49.99' }
    const mappings: FieldMapping[] = [
      { source: 'price', syncMode: 'permanent', target: 'priceMicros', transformPreset: 'toMicrosString' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.priceMicros).toBe('49990000')
  })

  test('toMicrosString handles numeric input', () => {
    const product = { price: 10 }
    const mappings: FieldMapping[] = [
      { source: 'price', syncMode: 'permanent', target: 'priceMicros', transformPreset: 'toMicrosString' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.priceMicros).toBe('10000000')
  })

  test('toMicrosString returns non-finite strings unchanged', () => {
    const product = { price: 'abc' }
    const mappings: FieldMapping[] = [
      { source: 'price', syncMode: 'permanent', target: 'priceMicros', transformPreset: 'toMicrosString' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.priceMicros).toBe('abc')
  })

  test('applies transformPreset extractUrl from object with url', () => {
    const product = { image: { alt: 'Photo', url: 'https://example.com/img.jpg' } }
    const mappings: FieldMapping[] = [
      { source: 'image', syncMode: 'permanent', target: 'imageLink', transformPreset: 'extractUrl' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.imageLink).toBe('https://example.com/img.jpg')
  })

  test('applies transformPreset extractUrl from object with src', () => {
    const product = { image: { src: 'https://example.com/img.jpg' } }
    const mappings: FieldMapping[] = [
      { source: 'image', syncMode: 'permanent', target: 'imageLink', transformPreset: 'extractUrl' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.imageLink).toBe('https://example.com/img.jpg')
  })

  test('applies transformPreset extractUrl from object with href', () => {
    const product = { image: { href: 'https://example.com/img.jpg' } }
    const mappings: FieldMapping[] = [
      { source: 'image', syncMode: 'permanent', target: 'imageLink', transformPreset: 'extractUrl' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.imageLink).toBe('https://example.com/img.jpg')
  })

  test('extractUrl returns original value for non-objects', () => {
    const product = { image: 'https://example.com/img.jpg' }
    const mappings: FieldMapping[] = [
      { source: 'image', syncMode: 'permanent', target: 'imageLink', transformPreset: 'extractUrl' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.imageLink).toBe('https://example.com/img.jpg')
  })

  test('applies transformPreset toArray wrapping non-arrays', () => {
    const product = { category: 'Clothing' }
    const mappings: FieldMapping[] = [
      { source: 'category', syncMode: 'permanent', target: 'productTypes', transformPreset: 'toArray' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.productTypes).toEqual(['Clothing'])
  })

  test('toArray passes through existing arrays', () => {
    const product = { categories: ['Clothing', 'Shoes'] }
    const mappings: FieldMapping[] = [
      { source: 'categories', syncMode: 'permanent', target: 'productTypes', transformPreset: 'toArray' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.productTypes).toEqual(['Clothing', 'Shoes'])
  })

  test('applies transformPreset toString converting to string', () => {
    const product = { count: 42 }
    const mappings: FieldMapping[] = [
      { source: 'count', syncMode: 'permanent', target: 'countStr', transformPreset: 'toString' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.countStr).toBe('42')
  })

  test('applies transformPreset toBoolean converting to boolean', () => {
    const product = { inStock: 1 }
    const mappings: FieldMapping[] = [
      { source: 'inStock', syncMode: 'permanent', target: 'available', transformPreset: 'toBoolean' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.available).toBe(true)
  })

  test('toBoolean converts falsy to false', () => {
    const product = { inStock: 0 }
    const mappings: FieldMapping[] = [
      { source: 'inStock', syncMode: 'permanent', target: 'available', transformPreset: 'toBoolean' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.available).toBe(false)
  })

  test('filters by syncMode when filterMode provided', () => {
    const product = { sku: 'SKU', title: 'Title' }
    const mappings: FieldMapping[] = [
      { source: 'title', syncMode: 'permanent', target: 'title' },
      { source: 'sku', syncMode: 'initialOnly', target: 'offerId' },
    ]

    const result = applyFieldMappings(product, mappings, 'permanent')

    expect(result.title).toBe('Title')
    expect(result).not.toHaveProperty('offerId')
  })

  test('includes all mappings when filterMode is not provided', () => {
    const product = { sku: 'SKU', title: 'Title' }
    const mappings: FieldMapping[] = [
      { source: 'title', syncMode: 'permanent', target: 'title' },
      { source: 'sku', syncMode: 'initialOnly', target: 'offerId' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.title).toBe('Title')
    expect(result.offerId).toBe('SKU')
  })

  test('respects ordering via order field', () => {
    const product = { val1: 'first', val2: 'second' }
    const mappings: FieldMapping[] = [
      { order: 1, source: 'val2', syncMode: 'permanent', target: 'result' },
      { order: 2, source: 'val1', syncMode: 'permanent', target: 'result' },
    ]

    // val2 runs first (order 1), then val1 overwrites (order 2)
    const result = applyFieldMappings(product, mappings)

    expect(result.result).toBe('first')
  })

  test('skips null source values', () => {
    const product = { description: 'desc', title: null }
    const mappings: FieldMapping[] = [
      { source: 'title', syncMode: 'permanent', target: 'title' },
      { source: 'description', syncMode: 'permanent', target: 'description' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result).not.toHaveProperty('title')
    expect(result.description).toBe('desc')
  })

  test('skips undefined source values', () => {
    const product = { description: 'desc' }
    const mappings: FieldMapping[] = [
      { source: 'nonExistent', syncMode: 'permanent', target: 'title' },
      { source: 'description', syncMode: 'permanent', target: 'description' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result).not.toHaveProperty('title')
    expect(result.description).toBe('desc')
  })

  test('handles array indexing in source path (e.g., "images[0]")', () => {
    const product = {
      images: [
        { url: 'https://example.com/img1.jpg' },
        { url: 'https://example.com/img2.jpg' },
      ],
    }
    const mappings: FieldMapping[] = [
      { source: 'images[0].url', syncMode: 'permanent', target: 'imageLink' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.imageLink).toBe('https://example.com/img1.jpg')
  })

  test('array indexing returns undefined for out-of-bounds', () => {
    const product = { images: [{ url: 'img.jpg' }] }
    const mappings: FieldMapping[] = [
      { source: 'images[5].url', syncMode: 'permanent', target: 'imageLink' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result).not.toHaveProperty('imageLink')
  })

  test('array indexing returns undefined for non-array field', () => {
    const product = { images: 'not-an-array' }
    const mappings: FieldMapping[] = [
      { source: 'images[0]', syncMode: 'permanent', target: 'imageLink' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result).not.toHaveProperty('imageLink')
  })

  test('none transformPreset passes value through', () => {
    const product = { title: 'Hello' }
    const mappings: FieldMapping[] = [
      { source: 'title', syncMode: 'permanent', target: 'title', transformPreset: 'none' },
    ]

    const result = applyFieldMappings(product, mappings)

    expect(result.title).toBe('Hello')
  })

  test('returns empty object for empty mappings', () => {
    const product = { title: 'Test' }

    const result = applyFieldMappings(product, [])

    expect(result).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

describe('deepMerge', () => {
  test('deep merges nested objects', () => {
    const target = { a: { b: 1, c: 2 } }
    const source = { a: { d: 3 } }

    const result = deepMerge(target, source)

    expect(result).toEqual({ a: { b: 1, c: 2, d: 3 } })
  })

  test('source values overwrite target values', () => {
    const target = { a: 1, b: 2 }
    const source = { b: 3 }

    const result = deepMerge(target, source)

    expect(result).toEqual({ a: 1, b: 3 })
  })

  test('source arrays replace target arrays (not merge)', () => {
    const target = { tags: ['a', 'b'] }
    const source = { tags: ['c'] }

    const result = deepMerge(target, source)

    expect(result).toEqual({ tags: ['c'] })
  })

  test('skips undefined source values', () => {
    const target = { a: 1, b: 2 }
    const source = { a: undefined, b: 3 }

    const result = deepMerge(target, source)

    expect(result).toEqual({ a: 1, b: 3 })
  })

  test('handles empty target object', () => {
    const target = {}
    const source = { a: 1, b: { c: 2 } }

    const result = deepMerge(target, source)

    expect(result).toEqual({ a: 1, b: { c: 2 } })
  })

  test('handles empty source object', () => {
    const target = { a: 1, b: { c: 2 } }
    const source = {}

    const result = deepMerge(target, source)

    expect(result).toEqual({ a: 1, b: { c: 2 } })
  })

  test('does not mutate target or source', () => {
    const target = { a: { b: 1 } }
    const source = { a: { c: 2 } }

    const result = deepMerge(target, source)

    expect(target).toEqual({ a: { b: 1 } })
    expect(source).toEqual({ a: { c: 2 } })
    expect(result).toEqual({ a: { b: 1, c: 2 } })
  })

  test('overwrites nested object with array from source', () => {
    const target = { a: { b: 1 } }
    const source = { a: [1, 2, 3] }

    const result = deepMerge(target, source as Record<string, unknown>)

    expect(result.a).toEqual([1, 2, 3])
  })

  test('handles null source values by overwriting', () => {
    const target = { a: { b: 1 } }
    const source = { a: null }

    const result = deepMerge(target, source as Record<string, unknown>)

    expect(result.a).toBeNull()
  })
})
