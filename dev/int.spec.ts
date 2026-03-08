import fs from 'fs'
import path from 'path'
import type { Payload } from 'payload'

import config from '@payload-config'
import { getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { fileURLToPath } from 'url'

import { MC_FIELD_GROUP_NAME } from '../src/constants.js'

let payload: Payload
const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

afterAll(async () => {
  if (typeof payload?.db?.destroy === 'function') {
    await payload.db.destroy()
  }
})

beforeAll(async () => {
  const workerId = process.env.VITEST_WORKER_ID ?? process.pid.toString()
  fs.rmSync(path.resolve(dirname, '.tmp', `vitest-${workerId}.db`), { force: true })
  payload = await getPayload({ config })
}, 60_000)

describe('Plugin integration tests', () => {
  test('plugin registers hidden gmc-field-mappings collection', () => {
    expect(payload.collections['gmc-field-mappings']).toBeDefined()
  })

  test('plugin registers hidden gmc-sync-log collection', () => {
    expect(payload.collections['gmc-sync-log']).toBeDefined()
  })

  test('products collection has mc group field', () => {
    const productsConfig = payload.config.collections?.find((c) => c.slug === 'products')
    expect(productsConfig).toBeDefined()

    const flatFields = flattenFields(productsConfig!.fields ?? [])
    const mcField = flatFields.find((f) => 'name' in f && f.name === MC_FIELD_GROUP_NAME)
    expect(mcField).toBeDefined()
  })

  test('can create a product with mc fields', async () => {
    const product = await payload.create({
      collection: 'products',
      data: {
        title: 'Test Statue',
        sku: 'TEST-001',
        price: 1999.99,
        description: 'A test product',
        mc: {
          enabled: true,
          identity: {
            offerId: 'TEST-001',
          },
        },
      },
    })

    expect(product.mc?.enabled).toBe(true)
    expect(product.mc?.identity?.offerId).toBe('TEST-001')
  })

  test('can query products with mc.enabled filter', async () => {
    const { docs } = await payload.find({
      collection: 'products',
      where: {
        'mc.enabled': { equals: true },
      },
    })

    expect(docs.length).toBeGreaterThan(0)
    expect(
      docs.every(
        (d: Record<string, unknown>) =>
          (d.mc as Record<string, unknown>)?.enabled === true,
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
