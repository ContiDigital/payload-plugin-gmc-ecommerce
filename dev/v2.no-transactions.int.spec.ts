import type { Payload } from 'payload'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BasePayload, buildConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type {
  GmcAsyncAdapter,
  GmcAsyncDispatchArgs,
  PayloadGmcEcommerceV2Options,
} from '../src/v2/types.js'

import { payloadGmcEcommerceV2 } from '../src/v2/plugin.js'
import { testEmailAdapter } from './helpers/testEmailAdapter.js'

// @payloadcms/drizzle's dev schema-push memoizes the last-pushed table set
// at module scope for the whole process. This file builds two Payload
// instances against byte-identical collection schemas (in separate
// databases); without forcing it, the second push would be silently skipped
// because it looks unchanged from the first.
process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const databaseKind = process.env.GMC_V2_TEST_DATABASE ?? 'sqlite'
const postgresUrl = process.env.GMC_V2_POSTGRES_URL?.trim()

if (databaseKind !== 'sqlite' && databaseKind !== 'postgres') {
  throw new Error(
    `Unsupported GMC_V2_TEST_DATABASE for the disabled-transaction suite: ${databaseKind}`,
  )
}

const productsCollection = {
  slug: 'products' as const,
  fields: [
    { name: 'title', type: 'text' as const, required: true },
    { name: 'sku', type: 'text' as const, required: true, unique: true },
    { name: 'sourceVersion', type: 'number' as const, required: true },
  ],
}

// Neither adapter is given transactionOptions: Payload's SQLite adapter
// defaults transactions off, and Postgres is explicitly disabled here so
// both exercise the exact ambient-transaction-absent path this suite tests.
const disabledTransactionAdapter = (args: { databaseFile: string; schemaName: string }) => {
  if (databaseKind === 'postgres') {
    if (!postgresUrl) {
      throw new Error('GMC_V2_POSTGRES_URL is required when GMC_V2_TEST_DATABASE=postgres')
    }
    return postgresAdapter({
      pool: { connectionString: postgresUrl },
      push: true,
      schemaName: args.schemaName,
      transactionOptions: false,
    })
  }
  return sqliteAdapter({ client: { url: `file:${args.databaseFile}` } })
}

const rawPluginOptions = (
  dispatch: GmcAsyncAdapter['dispatch'],
): Omit<PayloadGmcEcommerceV2Options, 'requireTransaction'> => ({
  access: () => true,
  async: {
    name: 'disabled-transaction-regression',
    dispatch,
    getOperation: () => Promise.resolve(null),
    health: () => Promise.resolve({ checkedAt: '2026-08-30T12:00:00.000Z', status: 'ok' as const }),
  },
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
})

/**
 * This suite builds its own Payload config, so the dev app's generated types —
 * which describe a different collection that happens to share the `products`
 * slug — do not apply to it. `adHoc` widens exactly at that boundary.
 */
const adHoc = <T>(value: T): never => value as never

type Harness = {
  databaseFile?: string
  dispatch: GmcAsyncAdapter['dispatch']
  dispatched: GmcAsyncDispatchArgs[]
  payload: Payload
}

const buildHarness = async (args: {
  requireTransaction?: boolean
  suffix: string
}): Promise<Harness> => {
  const dispatched: GmcAsyncDispatchArgs[] = []
  const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>((dispatchArgs) => {
    dispatched.push(dispatchArgs)
    return Promise.resolve({
      operationId: `operation-${dispatched.length}`,
      state: 'queued' as const,
    })
  })

  const options: PayloadGmcEcommerceV2Options = {
    ...rawPluginOptions(dispatch),
    ...(args.requireTransaction === undefined
      ? {}
      : { requireTransaction: args.requireTransaction }),
  }

  const databaseFile = path.resolve(dirname, '.tmp', `v2-no-tx-${args.suffix}-${process.pid}.db`)
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true })
  fs.rmSync(databaseFile, { force: true })

  const config = await buildConfig({
    collections: [productsCollection],
    db: disabledTransactionAdapter({
      databaseFile,
      schemaName: `gmc_v2_no_tx_${args.suffix}_${process.pid}`,
    }),
    email: testEmailAdapter,
    plugins: [payloadGmcEcommerceV2(options)],
    secret: `gmc-v2-no-transactions-test-secret-${args.suffix}`,
  })

  // getPayload's per-key instance cache (payload/dist/index.js) only keys
  // global._payload by `key` from Payload 3.88 onward; on the 3.37.0 peer
  // floor, global._payload is a single unkeyed slot, so a second
  // getPayload({ config, key }) call in this process would silently return
  // the *first* harness's already-destroyed Payload instance instead of
  // building one from this harness's own config. Constructing BasePayload
  // directly bypasses that cache entirely (it's exactly what getPayload does
  // internally on a cache miss) and behaves identically on every supported
  // Payload version.
  const payload = await new BasePayload().init({ config })
  return {
    databaseFile: databaseKind === 'sqlite' ? databaseFile : undefined,
    dispatch,
    dispatched,
    payload,
  }
}

const destroyHarness = async (harness: Harness | undefined): Promise<void> => {
  if (harness && typeof harness.payload.db.destroy === 'function') {
    await harness.payload.db.destroy()
  }
  if (harness?.databaseFile) {
    fs.rmSync(harness.databaseFile, { force: true })
  }
}

describe(`GMC v2 dispatches without an ambient transaction by default on ${databaseKind}`, () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await buildHarness({ suffix: 'default' })
  }, 120_000)

  afterAll(async () => {
    await destroyHarness(harness)
  })

  it('creates a published product, dispatches once, and warns once', async () => {
    const warn = vi.spyOn(harness.payload.logger, 'warn')

    const created = await harness.payload.create({
      collection: 'products',
      data: adHoc({
        sku: 'NO-TRANSACTION-DEFAULT-1',
        sourceVersion: 1,
        title: 'No ambient transaction, default options',
      }),
    })

    expect(created.id).toBeDefined()
    expect(harness.dispatch).toHaveBeenCalledTimes(1)
    expect(harness.dispatched[0]?.command.type).toBe('product.publish')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'payload-plugin-gmc-ecommerce: dispatching Merchant command outside a database transaction; a crash between commit and dispatch is repaired by catalog.reconcile. Set requireTransaction: true to fail closed.',
    )
  })
})

describe(`GMC v2 fails closed with requireTransaction: true and no ambient transaction on ${databaseKind}`, () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await buildHarness({ requireTransaction: true, suffix: 'strict' })
  }, 120_000)

  afterAll(async () => {
    await destroyHarness(harness)
  })

  it('rejects before the canonical row commits when beginTransaction resolves to null', async () => {
    await expect(
      harness.payload.create({
        collection: 'products',
        data: adHoc({
          sku: 'NO-TRANSACTION-STRICT-1',
          sourceVersion: 1,
          title: 'Must not commit',
        }),
      }),
    ).rejects.toMatchObject({ code: 'GMC_TRANSACTION_REQUIRED' })

    const absent = await harness.payload.find({
      collection: 'products',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { sku: { equals: 'NO-TRANSACTION-STRICT-1' } },
    })
    expect(absent.docs).toHaveLength(0)
    expect(harness.dispatch).not.toHaveBeenCalled()
  })
})
