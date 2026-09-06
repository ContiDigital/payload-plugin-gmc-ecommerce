import type { Payload, PayloadRequest } from 'payload'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as GmcExecutorModule from '../executor.js'
import type * as GmcBuildFeedModule from '../feed/buildFeed.js'
import type {
  GmcCommandExecutionContext,
  GmcCommandExecutionResult,
  GmcFeedConfig,
  PayloadGmcEcommerceV2Options,
} from '../types.js'

// Only the two "executor error mapping" tests below set `current`; every
// other test leaves it null so `createGmcCommandExecutor` behaves exactly as
// the real module — this lets a single deterministic executor failure be
// injected without mocking away the executor's real dispatch-forwarding
// behavior that other worker-endpoint tests depend on.
const executorOverride = vi.hoisted(() => ({
  current: null as
    | ((args: GmcCommandExecutionContext) => Promise<GmcCommandExecutionResult>)
    | null,
}))
vi.mock('../executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GmcExecutorModule>()
  return {
    ...actual,
    createGmcCommandExecutor: (
      ...args: Parameters<typeof actual.createGmcCommandExecutor>
    ): ReturnType<typeof actual.createGmcCommandExecutor> => {
      const real = actual.createGmcCommandExecutor(...args)
      return (executeArgs) =>
        executorOverride.current ? executorOverride.current(executeArgs) : real(executeArgs)
    },
  }
})

// Counts real catalog scans so the dynamic-feed single-flight and TTL cache can
// be asserted on the thing they exist to bound: how often a feed is rebuilt.
const feedBuilds = vi.hoisted(() => ({ count: 0 }))
vi.mock('../feed/buildFeed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GmcBuildFeedModule>()
  return {
    ...actual,
    buildCanonicalFeed: (...args: Parameters<typeof actual.buildCanonicalFeed>) => {
      feedBuilds.count += 1
      return actual.buildCanonicalFeed(...args)
    },
  }
})

import { GmcAsyncIdempotencyConflictError, GmcAsyncWorkflowConflictError } from '../async.js'
import { normalizeGmcV2Options } from '../config.js'
import { buildGmcV2Endpoints } from '../endpoints.js'

const dynamicFeed: GmcFeedConfig = {
  id: 'primary',
  access: 'public',
  delivery: 'dynamic',
  path: '/feeds/google.tsv',
  selector: { contentLanguage: 'en', feedLabel: 'US' },
}

const build = (
  args: {
    exposeWorkerEndpoint?: boolean
    feed?: GmcFeedConfig
    find?: Payload['find']
    // The dynamic-feed cache is module-scoped and keyed per plugin instance, so
    // a feed test that must observe a real rebuild gives itself its own id.
    instanceId?: string
    workerAccess?: boolean
  } = {},
) => {
  const dispatch = vi.fn(() =>
    Promise.resolve({ operationId: 'operation-1', state: 'queued' as const }),
  )
  const options = normalizeGmcV2Options({
    access: () => true,
    api: { exposeWorkerEndpoint: args.exposeWorkerEndpoint },
    async: {
      name: 'test-adapter',
      dispatch,
      getOperation: vi.fn(() =>
        Promise.resolve({
          operationId: 'operation-1',
          state: 'queued' as const,
        }),
      ),
      health: vi.fn(() =>
        Promise.resolve({
          checkedAt: '2026-08-29T12:00:00.000Z',
          status: 'ok' as const,
        }),
      ),
    },
    dataSourceId: '987654321',
    feeds: [args.feed ?? dynamicFeed],
    getCredentials: () =>
      Promise.resolve({
        type: 'json',
        credentials: { client_email: 'test@example.com', private_key: 'secret' },
      }),
    instanceId: args.instanceId,
    merchantId: '123456',
    products: {
      collection: 'products',
      project: ({ doc }) => ({
        products: [
          {
            contentLanguage: 'en',
            feedLabel: 'US',
            offerId: String(doc.id),
            productAttributes: {
              availability: 'IN_STOCK',
              description: 'Description',
              imageLink: 'https://example.com/image.jpg',
              link: `https://example.com/${String(doc.id)}`,
              price: { amountMicros: '1000000', currencyCode: 'USD' },
              title: 'Product',
            },
          },
        ],
        sourceVersion: '1',
      }),
      resolveIdentities: () => [],
    },
    workerAccess: () => args.workerAccess ?? false,
  } satisfies PayloadGmcEcommerceV2Options)
  const payload = {
    find: args.find ?? vi.fn(() => Promise.resolve({ docs: [{ id: 'sku-1' }] })),
    logger: { error: vi.fn() },
  } as unknown as Payload
  return { dispatch, endpoints: buildGmcV2Endpoints(options), options, payload }
}

const request = (args: {
  data?: Record<string, unknown>
  headers?: Record<string, string>
  payload: Payload
  routeParams?: Record<string, unknown>
  user?: null | Record<string, unknown>
}): PayloadRequest =>
  ({
    data: args.data,
    headers: new Headers(args.headers),
    payload: args.payload,
    routeParams: args.routeParams,
    user: args.user as never,
  }) as unknown as PayloadRequest

describe('GMC v2 endpoints', () => {
  afterEach(() => {
    executorOverride.current = null
    feedBuilds.count = 0
    vi.useRealTimers()
  })

  it('durably dispatches a non-mutating API-source deployment preflight', async () => {
    const test = build()
    const endpoint = test.endpoints.find((candidate) =>
      candidate.path.endsWith('/data-sources/validate'),
    )
    const req = request({
      headers: { 'idempotency-key': 'source-preflight-1' },
      payload: test.payload,
      user: { id: 'user-1' },
    })

    const response = await endpoint?.handler(req)

    expect(response?.status).toBe(202)
    await expect(response?.json()).resolves.toMatchObject({
      command: 'dataSources.validate',
      operationId: 'operation-1',
      state: 'queued',
    })
    expect(test.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ type: 'dataSources.validate' }),
        idempotencyKey: expect.stringMatching(/^gmc-v2:http:[a-f0-9]{64}$/),
        subject: 'gmc:123456:catalog',
      }),
    )
  })

  it('authenticates and durably acknowledges on-demand product publication', async () => {
    const test = build()
    const endpoint = test.endpoints.find((candidate) =>
      candidate.path.endsWith('/products/publish'),
    )
    const req = request({
      data: { productId: 'product-1' },
      headers: { 'idempotency-key': 'request-1' },
      payload: test.payload,
      user: { id: 'user-1' },
    })
    const response = await endpoint?.handler(req)

    expect(response?.status).toBe(202)
    await expect(response?.json()).resolves.toMatchObject({
      command: 'product.publish',
      operationId: 'operation-1',
      state: 'queued',
    })
    expect(test.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^gmc-v2:http:[a-f0-9]{64}$/),
        req,
      }),
    )
  })

  it('hashes the longest accepted caller key into a bounded host-ledger key', async () => {
    const test = build()
    const endpoint = test.endpoints.find((candidate) =>
      candidate.path.endsWith('/products/publish'),
    )
    const callerKey = 'k'.repeat(200)
    const response = await endpoint?.handler(
      request({
        data: { productId: 'product-1' },
        headers: { 'idempotency-key': callerKey },
        payload: test.payload,
        user: { id: 'user-1' },
      }),
    )

    expect(response?.status).toBe(202)
    const durableKey = vi.mocked(test.options.async.dispatch).mock.calls[0]?.[0].idempotencyKey
    expect(durableKey).toMatch(/^gmc-v2:http:[a-f0-9]{64}$/)
    expect(durableKey).toHaveLength(76)
  })

  it('fails closed for anonymous or non-idempotent mutations', async () => {
    const test = build()
    const endpoint = test.endpoints.find((candidate) =>
      candidate.path.endsWith('/products/publish'),
    )
    const anonymous = await endpoint?.handler(
      request({
        data: { productId: 'product-1' },
        headers: { 'idempotency-key': 'request-1' },
        payload: test.payload,
        user: null,
      }),
    )
    const missingKey = await endpoint?.handler(
      request({
        data: { productId: 'product-1' },
        payload: test.payload,
        user: { id: 'user-1' },
      }),
    )

    expect(anonymous?.status).toBe(403)
    expect(missingKey?.status).toBe(400)
    expect(test.dispatch).not.toHaveBeenCalled()
  })

  it('returns a stable 409 when an immutable idempotency key changes intent', async () => {
    const test = build()
    test.dispatch.mockRejectedValueOnce(new GmcAsyncIdempotencyConflictError('request-1'))
    const endpoint = test.endpoints.find((candidate) =>
      candidate.path.endsWith('/products/publish'),
    )
    const response = await endpoint?.handler(
      request({
        data: { productId: 'product-2' },
        headers: { 'idempotency-key': 'request-1' },
        payload: test.payload,
        user: { id: 'user-1' },
      }),
    )

    expect(response?.status).toBe(409)
    await expect(response?.json()).resolves.toMatchObject({
      error: expect.stringMatching(/already bound to different command intent/i),
    })
  })

  it('returns a stable 409 when a full reconciliation workflow is already active', async () => {
    const test = build()
    test.dispatch.mockRejectedValueOnce(new GmcAsyncWorkflowConflictError('operation-7000'))
    const endpoint = test.endpoints.find((candidate) =>
      candidate.path.endsWith('/catalog/reconcile'),
    )
    const response = await endpoint?.handler(
      request({
        headers: { 'idempotency-key': 'reconcile-2' },
        payload: test.payload,
        user: { id: 'user-1' },
      }),
    )

    expect(response?.status).toBe(409)
    await expect(response?.json()).resolves.toEqual({
      error: 'GMC catalog.reconcile cannot start while operation operation-7000 is still active',
    })
  })

  it('stops a chunked request stream at the byte limit before JSON parsing', async () => {
    const test = build()
    const endpoint = test.endpoints.find((candidate) =>
      candidate.path.endsWith('/products/publish'),
    )
    const streamed = new Request('https://example.test/gmc/v2/products/publish', {
      body: JSON.stringify({ padding: 'x'.repeat(1_048_576), productId: 'product-1' }),
      headers: { 'idempotency-key': 'oversized-stream' },
      method: 'POST',
    }) as unknown as PayloadRequest
    Object.assign(streamed, { payload: test.payload, user: { id: 'user-1' } })

    const response = await endpoint?.handler(streamed)

    expect(response?.status).toBe(413)
    expect(test.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a non-integral document ID before durable dispatch', async () => {
    const test = build()
    const endpoint = test.endpoints.find((candidate) =>
      candidate.path.endsWith('/products/publish'),
    )
    const response = await endpoint?.handler(
      request({
        data: { productId: 1.5 },
        headers: { 'idempotency-key': 'request-1' },
        payload: test.payload,
        user: { id: 'user-1' },
      }),
    )

    expect(response?.status).toBe(400)
    expect(test.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a whitespace-ambiguous document ID before durable dispatch', async () => {
    const test = build()
    const endpoint = test.endpoints.find((candidate) =>
      candidate.path.endsWith('/products/publish'),
    )
    const response = await endpoint?.handler(
      request({
        data: { productId: ' product-1 ' },
        headers: { 'idempotency-key': 'request-1' },
        payload: test.payload,
        user: { id: 'user-1' },
      }),
    )

    expect(response?.status).toBe(400)
    expect(test.dispatch).not.toHaveBeenCalled()
  })

  it('rejects unknown single-product request fields before durable dispatch', async () => {
    const test = build()
    const paths = ['/products/publish', '/products/status/refresh']

    for (const path of paths) {
      const endpoint = test.endpoints.find((candidate) => candidate.path.endsWith(path))
      const response = await endpoint?.handler(
        request({
          data: { productId: 'product-1', silentlyIgnored: true },
          headers: { 'idempotency-key': `exact-${path}` },
          payload: test.payload,
          user: { id: 'user-1' },
        }),
      )

      expect(response?.status).toBe(400)
      await expect(response?.json()).resolves.toEqual({
        error: 'Request body contains unsupported fields',
      })
    }

    expect(test.dispatch).not.toHaveBeenCalled()
  })

  it('rejects bodies on operations whose complete intent is carried by the route', async () => {
    const test = build()
    const paths = [
      '/data-sources/validate',
      '/catalog/publish',
      '/catalog/reconcile',
      '/feeds/:feedId/build',
      '/local-inventory/reconcile',
    ]

    for (const path of paths) {
      const endpoint = test.endpoints.find((candidate) => candidate.path.endsWith(path))
      const response = await endpoint?.handler(
        request({
          data: { silentlyIgnored: true },
          headers: { 'idempotency-key': `bodyless-${path}` },
          payload: test.payload,
          routeParams: path.includes(':feedId') ? { feedId: 'primary' } : undefined,
          user: { id: 'user-1' },
        }),
      )

      expect(response?.status).toBe(400)
      await expect(response?.json()).resolves.toEqual({
        error: 'Request body is not supported for this operation',
      })
    }

    expect(test.dispatch).not.toHaveBeenCalled()
  })

  it('rejects an unparsed chunked body on a bodyless operation', async () => {
    const test = build()
    const endpoint = test.endpoints.find((candidate) => candidate.path.endsWith('/catalog/publish'))
    const streamed = new Request('https://example.test/gmc/v2/catalog/publish', {
      body: '{}',
      headers: { 'idempotency-key': 'unexpected-stream' },
      method: 'POST',
    }) as unknown as PayloadRequest
    Object.assign(streamed, { payload: test.payload, user: { id: 'user-1' } })

    const response = await endpoint?.handler(streamed)

    expect(response?.status).toBe(400)
    expect(test.dispatch).not.toHaveBeenCalled()
  })

  it('serves a deterministic public feed with ETag and no draft reads', async () => {
    const find = vi.fn(() =>
      Promise.resolve({ docs: [{ id: 'sku-1' }] }),
    ) as unknown as Payload['find']
    const test = build({ find, instanceId: 'feed-etag' })
    const endpoint = test.endpoints.find((candidate) => candidate.path === '/feeds/google.tsv')
    const response = await endpoint?.handler(request({ payload: test.payload }))
    const etag = response?.headers.get('etag')

    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-type')).toContain('text/tab-separated-values')
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/)
    expect(await response?.text()).toContain('sku-1')
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ draft: false, sort: 'id' }))

    const notModified = await endpoint?.handler(
      request({
        headers: { 'if-none-match': etag ?? '' },
        payload: test.payload,
      }),
    )
    expect(notModified?.status).toBe(304)
    expect(notModified?.headers.get('cache-control')).toBe(
      'public, max-age=300, stale-if-error=86400',
    )
    expect(notModified?.headers.get('content-type')).toMatch(/tab-separated-values/i)
  })

  it('never marks an access-controlled feed as publicly cacheable', async () => {
    const test = build({ feed: { ...dynamicFeed, access: () => true }, instanceId: 'feed-private' })
    const endpoint = test.endpoints.find((candidate) => candidate.path === '/feeds/google.tsv')
    const response = await endpoint?.handler(request({ payload: test.payload }))

    expect(response?.status).toBe(200)
    expect(response?.headers.get('cache-control')).toBe('private, no-store')
  })

  it('coalesces concurrent dynamic feed requests into a single catalog scan', async () => {
    // A public dynamic feed is an unauthenticated full-catalog scan. A burst
    // must cost one build, not one build per connection.
    const test = build({ instanceId: 'feed-single-flight' })
    const endpoint = test.endpoints.find((candidate) => candidate.path === '/feeds/google.tsv')

    const [first, second] = await Promise.all([
      endpoint?.handler(request({ payload: test.payload })),
      endpoint?.handler(request({ payload: test.payload })),
    ])

    expect(feedBuilds.count).toBe(1)
    expect(first?.status).toBe(200)
    expect(second?.status).toBe(200)
    expect(first?.headers.get('etag')).toBe(second?.headers.get('etag'))
    await expect(second?.text()).resolves.toContain('sku-1')
  })

  it('serves the last dynamic feed build from memory until the cache expires', async () => {
    vi.useFakeTimers()
    const test = build({ instanceId: 'feed-ttl' })
    const endpoint = test.endpoints.find((candidate) => candidate.path === '/feeds/google.tsv')

    const first = await endpoint?.handler(request({ payload: test.payload }))
    expect(feedBuilds.count).toBe(1)
    const body = await first?.text()

    vi.advanceTimersByTime(59_000)
    const cached = await endpoint?.handler(request({ payload: test.payload }))
    expect(feedBuilds.count).toBe(1)
    expect(cached?.status).toBe(200)
    await expect(cached?.text()).resolves.toBe(body)

    vi.advanceTimersByTime(2_000)
    const rebuilt = await endpoint?.handler(request({ payload: test.payload }))
    expect(feedBuilds.count).toBe(2)
    expect(rebuilt?.status).toBe(200)
  })

  it('does not queue an artifact build for a dynamic feed', async () => {
    const test = build()
    const endpoint = test.endpoints.find((candidate) =>
      candidate.path.endsWith('/feeds/:feedId/build'),
    )
    const response = await endpoint?.handler(
      request({
        headers: { 'idempotency-key': 'build-1' },
        payload: test.payload,
        routeParams: { feedId: 'primary' },
        user: { id: 'user-1' },
      }),
    )

    expect(response?.status).toBe(409)
    expect(test.dispatch).not.toHaveBeenCalled()
  })

  it('rejects worker access before parsing the request body', async () => {
    // workerAccess defaults to false in this suite's build(); an invalid,
    // malformed body must never reach parsing/validation once access is
    // denied — the caller should see 403, never a 400 that would confirm the
    // shape of a body it wasn't authorized to submit.
    const test = build({ exposeWorkerEndpoint: true })
    const endpoint = test.endpoints.find((candidate) => candidate.path.endsWith('/worker/execute'))
    const response = await endpoint?.handler(
      request({
        data: { command: { type: 'invalid' }, notAllowedField: true, operationId: 'operation-1' },
        payload: test.payload,
      }),
    )

    expect(response?.status).toBe(403)
  })

  it('keeps worker execution unexposed by default and rejects malformed commands when enabled', async () => {
    expect(build().endpoints.some((endpoint) => endpoint.path.endsWith('/worker/execute'))).toBe(
      false,
    )
    const test = build({ exposeWorkerEndpoint: true, workerAccess: true })
    const endpoint = test.endpoints.find((candidate) => candidate.path.endsWith('/worker/execute'))
    const response = await endpoint?.handler(
      request({
        data: { command: { type: 'invalid' }, operationId: 'operation-1' },
        payload: test.payload,
      }),
    )

    expect(response?.status).toBe(400)

    const invalidVersion = await build({ exposeWorkerEndpoint: true, workerAccess: true })
      .endpoints.find((candidate) => candidate.path.endsWith('/worker/execute'))
      ?.handler(
        request({
          data: {
            command: {
              type: 'catalog.publish',
              cause: 'manual',
              requestedAt: '2026-08-29T12:00:00.000Z',
              schemaVersion: 2,
            },
            operationId: 'operation-1',
            sourceVersion: '9223372036854775808',
          },
          payload: test.payload,
        }),
      )
    expect(invalidVersion?.status).toBe(400)

    // sourceVersion is deprecated and optional: a worker that no longer sends
    // one must still execute.
    const missingVersion = await build({ exposeWorkerEndpoint: true, workerAccess: true })
      .endpoints.find((candidate) => candidate.path.endsWith('/worker/execute'))
      ?.handler(
        request({
          data: {
            command: {
              type: 'catalog.publish',
              cause: 'manual',
              requestedAt: '2026-08-29T12:00:00.000Z',
              schemaVersion: 2,
            },
            operationId: 'operation-1',
          },
          payload: test.payload,
        }),
      )
    expect(missingVersion?.status).toBe(200)
  })

  it('propagates root workflow lineage through the optional worker bridge', async () => {
    const test = build({ exposeWorkerEndpoint: true, workerAccess: true })
    const endpoint = test.endpoints.find((candidate) => candidate.path.endsWith('/worker/execute'))
    const response = await endpoint?.handler(
      request({
        data: {
          command: {
            type: 'catalog.publish',
            cause: 'manual',
            requestedAt: '2026-08-29T12:00:00.000Z',
            schemaVersion: 2,
          },
          operationId: 'catalog-page-1',
          rootOperationId: 'catalog-root',
          sourceVersion: '100',
        },
        payload: test.payload,
      }),
    )

    expect(response?.status).toBe(200)
    expect(test.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        parentOperationId: 'catalog-page-1',
        rootOperationId: 'catalog-root',
      }),
    )
  })

  it('rejects unknown worker-envelope fields and whitespace-ambiguous operation IDs', async () => {
    const test = build({ exposeWorkerEndpoint: true, workerAccess: true })
    const endpoint = test.endpoints.find((candidate) => candidate.path.endsWith('/worker/execute'))
    const command = {
      type: 'catalog.publish' as const,
      cause: 'manual' as const,
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2 as const,
    }

    const unknownField = await endpoint?.handler(
      request({
        data: {
          command,
          operationId: 'operation-1',
          silentlyIgnored: true,
          sourceVersion: '100',
        },
        payload: test.payload,
      }),
    )
    const ambiguousId = await endpoint?.handler(
      request({
        data: {
          command,
          operationId: ' operation-1 ',
          sourceVersion: '100',
        },
        payload: test.payload,
      }),
    )

    expect(unknownField?.status).toBe(400)
    await expect(unknownField?.json()).resolves.toEqual({
      error: 'Request body contains unsupported fields',
    })
    expect(ambiguousId?.status).toBe(400)
    expect(test.dispatch).not.toHaveBeenCalled()
  })

  it('maps a retryable executor failure to 500 with a classification body, not a leaked message', async () => {
    executorOverride.current = () => Promise.reject(new Error('temporary infrastructure failure'))
    const test = build({ exposeWorkerEndpoint: true, workerAccess: true })
    const endpoint = test.endpoints.find((candidate) => candidate.path.endsWith('/worker/execute'))

    const response = await endpoint?.handler(
      request({
        data: {
          command: {
            type: 'catalog.publish',
            cause: 'manual',
            requestedAt: '2026-08-29T12:00:00.000Z',
            schemaVersion: 2,
          },
          operationId: 'operation-1',
        },
        payload: test.payload,
      }),
    )

    expect(response?.status).toBe(500)
    await expect(response?.json()).resolves.toEqual({
      code: undefined,
      message: 'temporary infrastructure failure',
      retryable: true,
    })
  })

  it('maps a terminal executor failure to 422 with a classification body', async () => {
    executorOverride.current = () => Promise.reject(new TypeError('invalid canonical projection'))
    const test = build({ exposeWorkerEndpoint: true, workerAccess: true })
    const endpoint = test.endpoints.find((candidate) => candidate.path.endsWith('/worker/execute'))

    const response = await endpoint?.handler(
      request({
        data: {
          command: {
            type: 'catalog.publish',
            cause: 'manual',
            requestedAt: '2026-08-29T12:00:00.000Z',
            schemaVersion: 2,
          },
          operationId: 'operation-1',
        },
        payload: test.payload,
      }),
    )

    expect(response?.status).toBe(422)
    await expect(response?.json()).resolves.toEqual({
      code: undefined,
      message: 'invalid canonical projection',
      retryable: false,
    })
  })

  it('proxies durable operation status and reports measured adapter health', async () => {
    const test = build()
    const operationEndpoint = test.endpoints.find((candidate) =>
      candidate.path.endsWith('/operations/:operationId'),
    )
    const operationResponse = await operationEndpoint?.handler(
      request({
        payload: test.payload,
        routeParams: { operationId: 'operation-1' },
        user: { id: 'user-1' },
      }),
    )
    const healthEndpoint = test.endpoints.find((candidate) => candidate.path.endsWith('/health'))
    const healthResponse = await healthEndpoint?.handler(
      request({
        payload: test.payload,
        user: { id: 'user-1' },
      }),
    )

    expect(operationResponse?.status).toBe(200)
    expect(operationResponse?.headers.get('cache-control')).toBe('private, no-store, max-age=0')
    expect(operationResponse?.headers.get('x-content-type-options')).toBe('nosniff')
    await expect(operationResponse?.json()).resolves.toMatchObject({
      operationId: 'operation-1',
      state: 'queued',
    })
    expect(test.options.async.getOperation).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: '123456', operationId: 'operation-1' }),
    )
    expect(healthResponse?.status).toBe(200)
    expect(healthResponse?.headers.get('cache-control')).toBe('private, no-store, max-age=0')
    await expect(healthResponse?.json()).resolves.toMatchObject({
      asyncAdapter: { health: { status: 'ok' } },
      commandSchemaVersion: 2,
      instanceId: '123456',
      status: 'ok',
    })
    expect(test.options.async.health).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: '123456' }),
    )
  })
})
