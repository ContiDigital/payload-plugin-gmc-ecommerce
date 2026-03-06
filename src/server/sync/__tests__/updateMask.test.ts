import { describe, expect, test } from 'vitest'

import type { MCCustomAttribute, MCProductAttributes } from '../../../types/index.js'

import { buildUpdateMask } from '../updateMask.js'

// ---------------------------------------------------------------------------
// buildUpdateMask
// ---------------------------------------------------------------------------

describe('buildUpdateMask', () => {
  test('returns comma-separated list of product_attributes paths', () => {
    const attrs: MCProductAttributes = {
      description: 'A product',
      title: 'Test',
    }

    const result = buildUpdateMask(attrs)

    expect(result).toContain('product_attributes.title')
    expect(result).toContain('product_attributes.description')
    expect(result.split(',')).toHaveLength(2)
  })

  test('converts camelCase to snake_case', () => {
    const attrs: MCProductAttributes = {
      googleProductCategory: 'Apparel',
      imageLink: 'https://example.com/img.jpg',
      itemGroupId: 'GROUP-1',
    }

    const result = buildUpdateMask(attrs)

    expect(result).toContain('product_attributes.image_link')
    expect(result).toContain('product_attributes.google_product_category')
    expect(result).toContain('product_attributes.item_group_id')
  })

  test('handles nested objects like price', () => {
    const attrs: MCProductAttributes = {
      price: { amountMicros: '19990000', currencyCode: 'USD' },
    }

    const result = buildUpdateMask(attrs)

    expect(result).toBe('product_attributes.price')
  })

  test('handles salePrice nested object', () => {
    const attrs: MCProductAttributes = {
      salePrice: { amountMicros: '9990000', currencyCode: 'USD' },
    }

    const result = buildUpdateMask(attrs)

    expect(result).toBe('product_attributes.sale_price')
  })

  test('skips undefined values', () => {
    const attrs: MCProductAttributes = {
      description: undefined,
      title: 'Test',
    }

    const result = buildUpdateMask(attrs)

    expect(result).toBe('product_attributes.title')
    expect(result).not.toContain('description')
  })

  test('handles custom attributes', () => {
    const customAttrs: MCCustomAttribute[] = [
      { name: 'warehouse', value: 'us-east' },
      { name: 'priority', value: 'high' },
    ]

    const result = buildUpdateMask(undefined, customAttrs)

    expect(result).toContain('custom_attributes.warehouse')
    expect(result).toContain('custom_attributes.priority')
  })

  test('returns empty string for no attributes', () => {
    const result = buildUpdateMask(undefined, undefined)

    expect(result).toBe('')
  })

  test('returns empty string for empty product attributes object', () => {
    const result = buildUpdateMask({})

    expect(result).toBe('')
  })

  test('trims whitespace from custom attribute names', () => {
    const customAttrs: MCCustomAttribute[] = [
      { name: '  warehouse  ', value: 'us-east' },
    ]

    const result = buildUpdateMask(undefined, customAttrs)

    expect(result).toBe('custom_attributes.warehouse')
  })

  test('skips custom attributes with empty names', () => {
    const customAttrs: MCCustomAttribute[] = [
      { name: '', value: 'val' },
      { name: 'valid', value: 'val' },
    ]

    const result = buildUpdateMask(undefined, customAttrs)

    expect(result).toBe('custom_attributes.valid')
  })

  test('skips custom attributes with whitespace-only names', () => {
    const customAttrs: MCCustomAttribute[] = [
      { name: '   ', value: 'val' },
    ]

    const result = buildUpdateMask(undefined, customAttrs)

    expect(result).toBe('')
  })

  test('combines product and custom attributes', () => {
    const attrs: MCProductAttributes = {
      title: 'Test',
    }
    const customAttrs: MCCustomAttribute[] = [
      { name: 'warehouse', value: 'us-east' },
    ]

    const result = buildUpdateMask(attrs, customAttrs)

    expect(result).toContain('product_attributes.title')
    expect(result).toContain('custom_attributes.warehouse')
    expect(result.split(',')).toHaveLength(2)
  })

  test('handles array values like additionalImageLinks', () => {
    const attrs: MCProductAttributes = {
      additionalImageLinks: ['https://example.com/img1.jpg'],
    }

    const result = buildUpdateMask(attrs)

    expect(result).toBe('product_attributes.additional_image_links')
  })

  test('handles boolean values', () => {
    const attrs: MCProductAttributes = {
      adult: false,
      identifierExists: true,
    }

    const result = buildUpdateMask(attrs)

    expect(result).toContain('product_attributes.adult')
    expect(result).toContain('product_attributes.identifier_exists')
  })

  test('handles empty custom attributes array', () => {
    const result = buildUpdateMask(undefined, [])

    expect(result).toBe('')
  })
})
