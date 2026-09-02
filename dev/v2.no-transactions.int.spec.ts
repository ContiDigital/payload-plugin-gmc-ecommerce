import type { Payload } from 'payload'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { GmcAsyncAdapter, PayloadGmcEcommerceV2Options } from '../src/v2/types.js'

import { payloadGmcEcommerceV2 } from '../src/v2/plugin.js'
import { testEmailAdapter } from './helpers/testEmailAdapter.js'

const shouldRun = process.env.GMC_V2_TEST_NO_TRANSACTIONS === '1'
const databaseUrl = process.env.GMC_V2_POSTGRES_URL?.trim()
const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>(() =>
  Promise.resolve({ operationId: 'must-not-dispatch', state: 'queued' }),
)

const asyncAdapter: GmcAsyncAdapter = {
  name: 'disabled-transaction-regression',
  dispatch,
  getOperation: () => Promise.resolve(null),
  health: () =>
    Promise.resolve({ checkedAt: '2026-08-30T12:00:00.000Z', status: 'ok' as const }),
}

let payload: Payload | undefined

describe.runIf(shouldRun)('GMC v2 disabled Payload transaction regression', () => {
  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error('GMC_V2_POSTGRES_URL is required')
    }

    const options: PayloadGmcEcommerceV2Options = {
      access: () => true,
      async: asyncAdapter,
      dataSourceId: '987654321',
      feeds: [
        {
          id: 'primary',
          access: 'public',
          delivery: 'dynamic',
          path: '/feeds/google.tsv',
          selector: { contentLanguage: 'en', feedLabel: 'US' },
        },
      ],
      getCredentials: () =>
        Promise.resolve({
          type: 'json',
          credentials: { client_email: 'merchant@example.test', private_key: 'not-used' },
        }),
      merchantId: '123456',
      products: {
        collection: 'products',
        project: ({ doc }) => ({
          products: [],
          sourceVersion: String(doc.sourceVersion),
        }),
        resolveIdentities: ({ doc }) => [
          {
            contentLanguage: 'en',
            feedLabel: 'US',
            offerId: String(doc.sku),
          },
        ],
      },
    }

    const config = await buildConfig({
      collections: [
        {
          slug: 'products',
          fields: [
            { name: 'title', type: 'text', required: true },
            { name: 'sku', type: 'text', required: true, unique: true },
            { name: 'sourceVersion', type: 'number', required: true },
          ],
        },
      ],
      db: postgresAdapter({
        pool: { connectionString: databaseUrl },
        push: true,
        schemaName: `gmc_v2_no_transactions_${process.pid}`,
        transactionOptions: false,
      }),
      email: testEmailAdapter,
      plugins: [payloadGmcEcommerceV2(options)],
      secret: 'gmc-v2-disabled-transaction-test-secret',
    })

    payload = await getPayload({ config })
  }, 120_000)

  afterAll(async () => {
    if (payload && typeof payload.db.destroy === 'function') {
      await payload.db.destroy()
    }
  })

  it('rejects before the canonical row commits when beginTransaction resolves to null', async () => {
    if (!payload) throw new Error('Payload was not initialized')

    await expect(
      payload.create({
        collection: 'products',
        data: {
          sku: 'NO-TRANSACTION-CREATE',
          sourceVersion: 1,
          title: 'Must not commit',
        },
      }),
    ).rejects.toMatchObject({ code: 'GMC_TRANSACTION_REQUIRED' })

    const absent = await payload.find({
      collection: 'products',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { sku: { equals: 'NO-TRANSACTION-CREATE' } },
    })
    expect(absent.docs).toHaveLength(0)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
