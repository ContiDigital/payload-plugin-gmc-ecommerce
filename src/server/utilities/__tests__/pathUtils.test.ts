import { describe, expect, test } from 'vitest'

import { getByPath, setByPath } from '../pathUtils.js'

describe('getByPath', () => {
  test('simple property access', () => {
    expect(getByPath({ title: 'Shirt' }, 'title')).toBe('Shirt')
  })

  test('nested dot path', () => {
    expect(getByPath({ product: { name: 'Hat' } }, 'product.name')).toBe('Hat')
  })

  test('array index syntax', () => {
    const obj = { images: ['a.png', 'b.png'] }
    expect(getByPath(obj, 'images[0]')).toBe('a.png')
  })

  test('missing property returns undefined', () => {
    expect(getByPath({ a: 1 }, 'b')).toBeUndefined()
  })

  test('null intermediate returns undefined', () => {
    expect(getByPath({ a: null }, 'a.b')).toBeUndefined()
  })
})

describe('setByPath', () => {
  test('set simple property', () => {
    const obj: Record<string, unknown> = {}
    setByPath(obj, 'title', 'Shirt')
    expect(obj.title).toBe('Shirt')
  })

  test('set nested creating intermediates', () => {
    const obj: Record<string, unknown> = {}
    setByPath(obj, 'product.name', 'Hat')
    expect((obj.product as Record<string, unknown>).name).toBe('Hat')
  })

  test('overwrite existing', () => {
    const obj = { title: 'Old' }
    setByPath(obj, 'title', 'New')
    expect(obj.title).toBe('New')
  })
})
