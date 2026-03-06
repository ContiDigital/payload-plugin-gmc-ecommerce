import type { Payload } from 'payload'

import config from '@payload-config'
import { getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

let payload: Payload

afterAll(async () => {
  if (typeof payload?.db?.destroy === 'function') {
    await payload.db.destroy()
  }
})

beforeAll(async () => {
  payload = await getPayload({ config })
})

describe('Plugin integration tests', () => {
  test('plugin registers hidden gmc-field-mappings collection', () => {
    expect(payload.collections['gmc-field-mappings']).toBeDefined()
  })

  test('plugin registers hidden gmc-sync-log collection', () => {
    expect(payload.collections['gmc-sync-log']).toBeDefined()
  })

  test('products collection has merchantCenter group field', () => {
    const productsConfig = payload.config.collections?.find((c) => c.slug === 'products')
    expect(productsConfig).toBeDefined()

    const flatFields = flattenFields(productsConfig!.fields ?? [])
    const mcField = flatFields.find((f) => 'name' in f && f.name === 'merchantCenter')
    expect(mcField).toBeDefined()
  })

  test('can create a product with merchantCenter fields', async () => {
    const product = await payload.create({
      collection: 'products',
      data: {
        title: 'Test Statue',
        sku: 'TEST-001',
        price: 1999.99,
        description: 'A test product',
        merchantCenter: {
          enabled: true,
          identity: {
            offerId: 'TEST-001',
          },
        },
      },
    })

    expect(product.merchantCenter?.enabled).toBe(true)
    expect(product.merchantCenter?.identity?.offerId).toBe('TEST-001')
  })

  test('can query products with merchantCenter.enabled filter', async () => {
    const { docs } = await payload.find({
      collection: 'products',
      where: {
        'merchantCenter.enabled': { equals: true },
      },
    })

    expect(docs.length).toBeGreaterThan(0)
    expect(
      docs.every(
        (d: Record<string, unknown>) =>
          (d.merchantCenter as Record<string, unknown>)?.enabled === true,
      ),
    ).toBe(true)
  })
})

// Utility: flatten tabs/row/collapsible fields to find nested fields
function flattenFields(fields: Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  for (const field of fields) {
    result.push(field)
    if (field.type === 'tabs' && Array.isArray(field.tabs)) {
      for (const tab of field.tabs as Record<string, unknown>[]) {
        if (Array.isArray(tab.fields)) {
          result.push(...flattenFields(tab.fields as Record<string, unknown>[]))
        }
      }
    }
    if (Array.isArray(field.fields)) {
      result.push(...flattenFields(field.fields as Record<string, unknown>[]))
    }
  }
  return result
}
