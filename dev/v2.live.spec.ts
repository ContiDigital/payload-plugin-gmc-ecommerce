/**
 * Destructive-by-design packaged-transport smoke against an explicitly
 * designated Merchant test data source. It imports only the package's public
 * v2 API, creates one uniquely namespaced ProductInput, and deletes only that
 * exact identity in afterAll.
 *
 * This proves the external Google boundary (API-source validation, insert,
 * processed read, update, delete, and already-absent delete). Deterministic
 * release suites separately prove the executor, durable adapter, batch/feed,
 * reconciliation, state-store, and local-inventory contracts.
 *
 * The full lifecycle can take up to ~20 minutes: Google's processed view
 * usually reflects an insert within a minute or two, but an update (refresh)
 * or a delete can lag minutes behind before the processed product converges
 * or disappears.
 *
 * Required opt-in:
 *   GOOGLE_MERCHANT_LIVE_TESTS_ENABLED=true
 *   GOOGLE_MERCHANT_TEST_DATA_SOURCE_ID=<non-production primary data source>
 *   GOOGLE_MERCHANT_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL,
 *   GOOGLE_SERVICE_ACCOUNT_KEY
 */

import type { Payload } from 'payload'

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
  assertGmcApiDataSourceAcceptsIdentity,
  createGoogleMerchantTransport,
  normalizeGmcV2Options,
  type GmcMerchantTransport,
  type MCProductIdentity,
} from 'payload-plugin-gmc-ecommerce'

const specDirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Guards the point of this suite: `pnpm test:live` builds first and
 * `vitest.live.config.js` aliases the package name to `dist/`, so the live
 * smoke exercises what npm publishes. If that alias ever regresses to `src/`,
 * the statically imported binding is a different module instance than the one
 * loaded straight from `dist/index.js` and this fails — before anything talks
 * to Google, and without needing credentials.
 */
test('resolves the package to the built dist entrypoint, not src', async () => {
  const distEntry = pathToFileURL(path.resolve(specDirname, '../dist/index.js')).href
  const built = (await import(/* @vite-ignore */ distEntry)) as {
    normalizeGmcV2Options: typeof normalizeGmcV2Options
  }
  expect(built.normalizeGmcV2Options).toBe(normalizeGmcV2Options)
})

const enabled = process.env.GOOGLE_MERCHANT_LIVE_TESTS_ENABLED === 'true'
const liveTest = enabled ? describe : describe.skip
const offerId = `gmc-v2-live-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
const feedLabel = process.env.GOOGLE_MERCHANT_TEST_FEED_LABEL?.trim() || 'PRODUCTS'
const identity: MCProductIdentity = {
  contentLanguage: 'en',
  feedLabel,
  offerId,
}
const payload = {} as Payload

let attemptedInsert = false
let dataSourceName = ''
let transport: GmcMerchantTransport

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new TypeError(`Live GMC v2 smoke requires ${name}`)
  }
  return value
}

const waitFor = async <T>(args: {
  attempts?: number
  intervalMs?: number
  read: () => Promise<T>
  ready: (value: T) => boolean
}): Promise<T> => {
  let last: T | undefined
  const attempts = args.attempts ?? 24
  const intervalMs = args.intervalMs ?? 5_000
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await args.read()
    if (args.ready(last)) {
      return last
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw new Error(
    `Merchant live smoke did not converge after ${attempts} attempts: ${JSON.stringify(last)}`,
  )
}

beforeAll(() => {
  if (!enabled) {
    return
  }
  const merchantId = requiredEnvironment('GOOGLE_MERCHANT_ID')
  const dataSourceId = requiredEnvironment('GOOGLE_MERCHANT_TEST_DATA_SOURCE_ID')
  const clientEmail = requiredEnvironment('GOOGLE_SERVICE_ACCOUNT_EMAIL')
  const privateKey = requiredEnvironment('GOOGLE_SERVICE_ACCOUNT_KEY').replace(/\\n/g, '\n')
  const options = normalizeGmcV2Options({
    access: () => false,
    async: {
      name: 'live-smoke-never-dispatches',
      capabilities: {
        delivery: 'at-least-once',
        durable: true,
        exclusiveCatalogReconciliation: true,
        globalSourceVersion: true,
        orderedBySubject: true,
        transactionAware: true,
        workflowStatus: true,
      },
      dispatch: () => Promise.reject(new Error('Live transport smoke must not dispatch commands')),
      getOperation: () => Promise.resolve(null),
      health: () =>
        Promise.resolve({
          checkedAt: new Date().toISOString(),
          status: 'ok',
        }),
    },
    dataSourceId,
    feeds: [
      {
        access: 'public',
        delivery: 'dynamic',
        id: 'live-smoke',
        path: '/never-mounted-live-smoke.tsv',
        selector: { contentLanguage: 'en', feedLabel },
      },
    ],
    getCredentials: () =>
      Promise.resolve({
        credentials: { client_email: clientEmail, private_key: privateKey },
        type: 'json',
      }),
    merchantId,
    productIngestion: { mode: 'api-primary' },
    products: {
      // The live smoke never reads Payload; this slug intentionally names no
      // collection, and so is not a member of the dev app's generated union.
      collection: 'unused-live-smoke-products' as never,
      project: () => ({ products: [], sourceVersion: '0' }),
      resolveIdentities: () => [],
    },
    rateLimit: {
      maxConcurrency: 1,
      maxRequestsPerMinute: 30,
      requestTimeoutMs: 30_000,
    },
    workerAccess: () => false,
  })
  dataSourceName = options.dataSourceName
  transport = createGoogleMerchantTransport(options)
}, 30_000)

afterAll(async () => {
  if (!enabled || !attemptedInsert || !transport) {
    return
  }
  await transport.deleteProductInput({ dataSourceName, identity, payload })
  await waitFor({
    attempts: 60,
    intervalMs: 10_000,
    read: () => transport.getProcessedProduct({ identity, payload }),
    ready: (product) => product === null,
  })
}, 900_000)

liveTest('Google Merchant API v1 transport lifecycle', () => {
  test('inserts, observes, refreshes, and idempotently deletes one isolated offer', async () => {
    const dataSource = await transport.getApiPrimaryDataSource({ dataSourceName, payload })
    expect(dataSource).toMatchObject({ input: 'API', name: dataSourceName })
    expect(() => assertGmcApiDataSourceAcceptsIdentity(dataSource, identity)).not.toThrow()

    const initialVersion = String(Date.now())
    attemptedInsert = true
    await transport.insertProductInput({
      dataSourceName,
      input: {
        contentLanguage: identity.contentLanguage,
        feedLabel: identity.feedLabel,
        offerId: identity.offerId,
        productAttributes: {
          availability: 'IN_STOCK',
          condition: 'NEW',
          description: 'Ephemeral payload-plugin-gmc-ecommerce v2 live transport smoke product.',
          imageLink: 'https://www.gstatic.com/webp/gallery/1.jpg',
          link: `https://example.com/gmc-v2-live/${offerId}`,
          price: { amountMicros: '1000000', currencyCode: 'USD' },
          title: `GMC v2 live smoke ${offerId}`,
        },
        versionNumber: initialVersion,
      },
      payload,
    })

    const inserted = await waitFor({
      read: () => transport.getProcessedProduct({ identity, payload }),
      ready: (product) =>
        product !== null && BigInt(product.versionNumber ?? '0') >= BigInt(initialVersion),
    })
    expect(inserted).toMatchObject({
      dataSourceName,
      identity,
    })
    expect(
      inserted?.productStatus === undefined || typeof inserted.productStatus === 'object',
    ).toBe(true)

    const refreshVersion = String(BigInt(initialVersion) + 1n)
    await transport.insertProductInput({
      dataSourceName,
      input: {
        contentLanguage: identity.contentLanguage,
        feedLabel: identity.feedLabel,
        offerId: identity.offerId,
        productAttributes: {
          availability: 'OUT_OF_STOCK',
          condition: 'NEW',
          description: 'Refreshed ephemeral v2 live transport smoke product.',
          imageLink: 'https://www.gstatic.com/webp/gallery/1.jpg',
          link: `https://example.com/gmc-v2-live/${offerId}`,
          price: { amountMicros: '1000000', currencyCode: 'USD' },
          title: `Refreshed GMC v2 live smoke ${offerId}`,
        },
        versionNumber: refreshVersion,
      },
      payload,
    })
    const refreshed = await waitFor({
      attempts: 60,
      intervalMs: 10_000,
      read: () => transport.getProcessedProduct({ identity, payload }),
      ready: (product) => product?.versionNumber === refreshVersion,
    })
    expect(refreshed?.versionNumber).toBe(refreshVersion)

    await transport.deleteProductInput({ dataSourceName, identity, payload })
    await waitFor({
      attempts: 60,
      intervalMs: 10_000,
      read: () => transport.getProcessedProduct({ identity, payload }),
      ready: (product) => product === null,
    })
    await expect(
      transport.deleteProductInput({ dataSourceName, identity, payload }),
    ).resolves.toBeUndefined()
  }, 1_500_000)
})
