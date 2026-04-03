import type { Endpoint, PayloadRequest } from 'payload'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../types/index.js'

const getMerchantServiceInstance = vi.fn()
const queueBatchPushJob = vi.fn()
const queueDirtySyncJob = vi.fn()
const queueInitialSyncJob = vi.fn()
const queuePullAllJob = vi.fn()

vi.mock('../serviceRegistry.js', () => ({
  getMerchantServiceInstance,
}))

vi.mock('../jobTasks.js', () => ({
  queueBatchPushJob,
  queueDirtySyncJob,
  queueInitialSyncJob,
  queuePullAllJob,
}))

const { applyEndpointEnhancements } = await import('../applyEndpointEnhancements.js')

const buildOptions = (
  overrides?: Partial<NormalizedPluginOptions>,
): NormalizedPluginOptions => ({
  access: () => Promise.resolve(true),
  admin: { mode: 'route', navLabel: 'GMC', route: '/merchant-center' },
  api: { basePath: '/gmc' },
  collections: {
    products: {
      slug: 'products' as never,
      autoInjectTab: true,
      fetchDepth: 1,
      fieldMappings: [],
      identityField: 'sku',
      tabPosition: 'append',
    },
  },
  dataSourceId: 'ds-123',
  dataSourceName: 'accounts/123/dataSources/ds-123',
  defaults: {
    condition: 'NEW',
    contentLanguage: 'en',
    currency: 'USD',
    feedLabel: 'US',
  },
  disabled: false,
  getCredentials: () =>
    Promise.resolve({
      type: 'json' as const,
      credentials: { client_email: 'test@example.com', private_key: 'key' },
    }),
  localInventory: { enabled: false, storeCode: '' },
  merchantId: '123',
  rateLimit: {
    baseRetryDelayMs: 100,
    enabled: false,
    jitterFactor: 0,
    maxConcurrency: 2,
    maxQueueSize: 10,
    maxRequestsPerMinute: 60,
    maxRetries: 1,
    maxRetryDelayMs: 1000,
    requestTimeoutMs: 5000,
  },
  siteUrl: 'https://example.com',
  sync: {
    conflictStrategy: 'mc-wins',
    initialSync: {
      batchSize: 50,
      dryRun: false,
      enabled: true,
      onlyIfRemoteMissing: true,
    },
    mode: 'manual',
    permanentSync: true,
    schedule: {
      apiKey: 'secret',
      cron: '0 4 * * *',
      strategy: 'external',
    },
    scheduleCron: '0 4 * * *',
  },
  ...overrides,
})

const getEndpoint = (
  endpoints: Endpoint[],
  path: string,
  method: string,
): Endpoint => {
  const endpoint = endpoints.find((candidate) => candidate.path === path && candidate.method === method)
  if (!endpoint) {
    throw new Error(`Endpoint ${method.toUpperCase()} ${path} not found`)
  }
  return endpoint
}

const createReq = (args: {
  body?: Record<string, unknown>
  headers?: HeadersInit
  payload?: Record<string, unknown>
  url?: string
  user?: Record<string, unknown>
}): PayloadRequest => ({
  headers: new Headers(args.headers),
  json: args.body,
  payload: {
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...args.payload,
  },
  text: () => Promise.resolve(args.body ? JSON.stringify(args.body) : ''),
  url: args.url ?? 'http://localhost/gmc',
  user: args.user,
}) as unknown as PayloadRequest

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('applyEndpointEnhancements', () => {
  beforeEach(() => {
    getMerchantServiceInstance.mockReset()
    queueBatchPushJob.mockReset()
    queueDirtySyncJob.mockReset()
    queueInitialSyncJob.mockReset()
    queuePullAllJob.mockReset()
    queueBatchPushJob.mockResolvedValue('job-batch')
    queueDirtySyncJob.mockResolvedValue('job-queued')
    queueInitialSyncJob.mockResolvedValue('job-initial')
    queuePullAllJob.mockResolvedValue('job-pull')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('shallow health redacts merchant details for unauthenticated requests', async () => {
    getMerchantServiceInstance.mockReturnValue({
      getHealth: () => ({
        admin: { mode: 'route' },
        merchant: { accountId: '123', dataSourceId: 'ds-123' },
        rateLimit: { enabled: false },
        status: 'ok',
        sync: { mode: 'manual' },
        timestamp: '2026-03-07T12:00:00Z',
      }),
    })

    const config = applyEndpointEnhancements({ endpoints: [] } as never, buildOptions({
      access: undefined,
    }))
    const endpoint = getEndpoint(config.endpoints ?? [], '/gmc/health', 'get')

    const response = await endpoint.handler(createReq({}))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      admin: { mode: 'route' },
      rateLimit: { enabled: false },
      status: 'ok',
      sync: { mode: 'manual' },
      timestamp: '2026-03-07T12:00:00Z',
    })
  })

  test('mappings endpoint rolls back partial replacement writes', async () => {
    const createdIds: string[] = []
    const payload = {
      create: vi
        .fn()
        .mockImplementationOnce(() => {
          createdIds.push('new-1')
          return Promise.resolve({ id: 'new-1' })
        })
        .mockRejectedValueOnce(new Error('write failed')),
      delete: vi.fn().mockResolvedValue({}),
      find: vi.fn().mockResolvedValue({
        docs: [{ id: 'old-1' }, { id: 'old-2' }],
      }),
      logger: {
        error: vi.fn(),
      },
    }

    const config = applyEndpointEnhancements({ endpoints: [] } as never, buildOptions())
    const endpoint = getEndpoint(config.endpoints ?? [], '/gmc/mappings', 'post')

    const response = await endpoint.handler(createReq({
      body: {
        mappings: [
          {
            source: 'title',
            syncMode: 'permanent',
            target: 'productAttributes.title',
          },
          {
            source: 'description',
            syncMode: 'initialOnly',
            target: 'productAttributes.description',
          },
        ],
      },
      payload,
      user: { email: 'admin@example.com' },
    }) as never)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Internal server error' })
    expect(createdIds).toEqual(['new-1'])
    expect(payload.delete).toHaveBeenCalledTimes(1)
    expect(payload.delete).toHaveBeenCalledWith({
      id: 'new-1',
      collection: 'gmc-field-mappings',
      overrideAccess: true,
    })
  })

  test('cron sync endpoint validates API key and dispatches dirty batch push', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-07T12:00:00Z'))

    const pushBatch = vi.fn().mockResolvedValue({
      completedAt: '2026-03-07T12:00:03Z',
      errors: [],
      failed: 0,
      jobId: 'batch-1',
      processed: 1,
      startedAt: '2026-03-07T12:00:00Z',
      status: 'completed',
      succeeded: 1,
      total: 1,
    })
    const cleanupSyncLogs = vi.fn().mockResolvedValue(undefined)
    getMerchantServiceInstance.mockReturnValue({
      cleanupSyncLogs,
      pushBatch,
    })

    const payload = {
      create: vi.fn().mockResolvedValue({ id: 'log-1' }),
      logger: {
        error: vi.fn(),
      },
      update: vi.fn().mockResolvedValue({}),
    }

    const config = applyEndpointEnhancements({ endpoints: [] } as never, buildOptions())
    const endpoint = getEndpoint(config.endpoints ?? [], '/gmc/cron/sync', 'post')

    const response = await endpoint.handler(createReq({
      headers: { 'x-gmc-api-key': 'secret' },
      payload,
      url: 'http://localhost/gmc/cron/sync',
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.objectContaining({
      jobId: expect.stringMatching(/^gmc-cron-/),
      status: 'running',
    }))

    await flushMicrotasks()

    expect(pushBatch).toHaveBeenCalledWith({
      filter: { 'mc.syncMeta.dirty': { equals: true } },
      onProgress: expect.any(Function),
      payload,
    })
    expect(cleanupSyncLogs).toHaveBeenCalledWith({ payload })
  })

  test('product push endpoint validates access and delegates to the merchant service', async () => {
    const pushProduct = vi.fn().mockResolvedValue({
      action: 'insert',
      productId: 'prod-1',
      success: true,
    })
    getMerchantServiceInstance.mockReturnValue({ pushProduct })

    const config = applyEndpointEnhancements({ endpoints: [] } as never, buildOptions())
    const endpoint = getEndpoint(config.endpoints ?? [], '/gmc/product/push', 'post')

    const response = await endpoint.handler(createReq({
      body: { productId: 'prod-1' },
      user: { email: 'admin@example.com' },
    }) as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      action: 'insert',
      productId: 'prod-1',
      success: true,
    })
    expect(pushProduct).toHaveBeenCalledWith({
      payload: expect.any(Object),
      productId: 'prod-1',
    })
  })

  test('push-dirty queues a Payload job when payload-jobs mode is enabled', async () => {
    const payload = {
      create: vi.fn().mockResolvedValue({ id: 'log-queued' }),
      logger: {
        error: vi.fn(),
      },
    }

    const config = applyEndpointEnhancements({ endpoints: [] } as never, buildOptions({
      sync: {
        ...buildOptions().sync,
        schedule: {
          ...buildOptions().sync.schedule,
          strategy: 'payload-jobs',
        },
      },
    }))
    const endpoint = getEndpoint(config.endpoints ?? [], '/gmc/batch/push-dirty', 'post')

    const response = await endpoint.handler(createReq({
      payload,
      user: { email: 'admin@example.com' },
    }) as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      jobId: expect.stringMatching(/^gmc-batch-dirty-/),
      status: 'queued',
    })
    expect(queueDirtySyncJob).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/^gmc-batch-dirty-/),
      logDocId: 'log-queued',
      merchantId: '123',
      metadata: { trigger: 'manual-dirty-push' },
      payload,
      req: expect.objectContaining({ payload }),
      triggeredBy: 'admin@example.com',
    })
  })

  test('batch push, initial sync, and pull-all queue Payload jobs when payload-jobs mode is enabled', async () => {
    const payload = {
      create: vi.fn()
        .mockResolvedValueOnce({ id: 'log-batch' })
        .mockResolvedValueOnce({ id: 'log-initial' })
        .mockResolvedValueOnce({ id: 'log-pull' }),
      logger: {
        error: vi.fn(),
      },
    }

    const config = applyEndpointEnhancements({ endpoints: [] } as never, buildOptions({
      sync: {
        ...buildOptions().sync,
        schedule: {
          ...buildOptions().sync.schedule,
          strategy: 'payload-jobs',
        },
      },
    }))

    const pushEndpoint = getEndpoint(config.endpoints ?? [], '/gmc/batch/push', 'post')
    const initialEndpoint = getEndpoint(config.endpoints ?? [], '/gmc/batch/initial-sync', 'post')
    const pullEndpoint = getEndpoint(config.endpoints ?? [], '/gmc/batch/pull-all', 'post')

    const pushResponse = await pushEndpoint.handler(createReq({
      body: { productIds: ['prod-1'] },
      payload,
      user: { email: 'admin@example.com' },
    }) as never)
    const initialResponse = await initialEndpoint.handler(createReq({
      body: { dryRun: true, limit: 5 },
      payload,
      user: { email: 'admin@example.com' },
    }) as never)
    const pullResponse = await pullEndpoint.handler(createReq({
      payload,
      user: { email: 'admin@example.com' },
    }) as never)

    expect(pushResponse.status).toBe(200)
    expect(await pushResponse.json()).toEqual({
      jobId: expect.stringMatching(/^gmc-batch-/),
      status: 'queued',
    })
    expect(queueBatchPushJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: expect.stringMatching(/^gmc-batch-/),
      logDocId: 'log-batch',
      merchantId: '123',
      metadata: {
        hasFilter: false,
        productCount: 1,
        trigger: 'manual-batch-push',
      },
      productIds: ['prod-1'],
      triggeredBy: 'admin@example.com',
    }))

    expect(initialResponse.status).toBe(200)
    expect(await initialResponse.json()).toEqual({
      jobId: expect.stringMatching(/^gmc-isync-/),
      status: 'queued',
    })
    expect(queueInitialSyncJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: expect.stringMatching(/^gmc-isync-/),
      logDocId: 'log-initial',
      merchantId: '123',
      metadata: {
        dryRun: true,
        trigger: 'manual-initial-sync',
      },
      overrides: { dryRun: true, limit: 5 },
      triggeredBy: 'admin@example.com',
    }))

    expect(pullResponse.status).toBe(200)
    expect(await pullResponse.json()).toEqual({
      jobId: expect.stringMatching(/^gmc-pull-/),
      status: 'queued',
    })
    expect(queuePullAllJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: expect.stringMatching(/^gmc-pull-/),
      logDocId: 'log-pull',
      merchantId: '123',
      metadata: { trigger: 'manual-pull-all' },
      triggeredBy: 'admin@example.com',
    }))
  })

  test('worker delete endpoint accepts API-key auth and identity payloads', async () => {
    const deleteProductByIdentity = vi.fn().mockResolvedValue({
      action: 'delete',
      productId: 'deleted-1',
      success: true,
    })
    getMerchantServiceInstance.mockReturnValue({
      deleteProduct: vi.fn(),
      deleteProductByIdentity,
    })

    const config = applyEndpointEnhancements({ endpoints: [] } as never, buildOptions())
    const endpoint = getEndpoint(config.endpoints ?? [], '/gmc/worker/product/delete', 'post')

    const response = await endpoint.handler(createReq({
      body: {
        identity: {
          contentLanguage: 'en',
          feedLabel: 'US',
          offerId: 'SKU-9',
        },
        productId: 'deleted-1',
      },
      headers: { 'x-gmc-api-key': 'secret' },
      payload: {},
    }) as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      action: 'delete',
      productId: 'deleted-1',
      success: true,
    })
    expect(deleteProductByIdentity).toHaveBeenCalledWith({
      identity: expect.objectContaining({
        merchantProductId: 'en~US~SKU-9',
        productInputName: 'accounts/123/productInputs/en~US~SKU-9',
        productName: 'accounts/123/products/en~US~SKU-9',
      }),
      payload: expect.any(Object),
      productId: 'deleted-1',
    })
  })

  test('worker push endpoint rejects requests without a valid API key', async () => {
    getMerchantServiceInstance.mockReturnValue({
      pushProduct: vi.fn(),
    })

    const config = applyEndpointEnhancements({ endpoints: [] } as never, buildOptions())
    const endpoint = getEndpoint(config.endpoints ?? [], '/gmc/worker/product/push', 'post')

    const response = await endpoint.handler(createReq({
      body: { productId: 'prod-2' },
      payload: {},
    }) as never)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Invalid or missing API key' })
  })

  test('deep health requires access', async () => {
    getMerchantServiceInstance.mockReturnValue({
      getHealth: () => ({
        admin: { mode: 'route' },
        merchant: { accountId: '123', dataSourceId: 'ds-123' },
        rateLimit: { enabled: false },
        status: 'ok',
        sync: { mode: 'manual' },
        timestamp: '2026-03-07T12:00:00Z',
      }),
      getHealthDeep: vi.fn(),
    })

    const config = applyEndpointEnhancements({ endpoints: [] } as never, buildOptions({
      access: undefined,
    }))
    const endpoint = getEndpoint(config.endpoints ?? [], '/gmc/health', 'get')

    const response = await endpoint.handler(createReq({
      url: 'http://localhost/gmc/health?deep=true',
    }) as never)

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })
})
