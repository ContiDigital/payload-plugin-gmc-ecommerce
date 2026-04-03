import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../types/index.js'

const getMerchantServiceInstance = vi.fn()

vi.mock('../serviceRegistry.js', () => ({
  getMerchantServiceInstance,
}))

const {
  buildBatchPushTaskConfig,
  buildDeleteProductTaskConfig,
  buildInitialSyncTaskConfig,
  buildPullAllTaskConfig,
  buildPushProductTaskConfig,
  buildSyncDirtyTaskConfig,
} =
  await import('../jobTaskDefinitions.js')
const { applyJobEnhancements } = await import('../jobTasks.js')

const buildOptions = (): NormalizedPluginOptions => ({
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
  localInventory: { enabled: false, storeCode: '' },
  getCredentials: () =>
    Promise.resolve({
      type: 'json' as const,
      credentials: { client_email: 'test@example.com', private_key: 'key' },
    }),
  merchantId: '123',
  rateLimit: {
    baseRetryDelayMs: 100,
    enabled: true,
    jitterFactor: 0,
    maxConcurrency: 2,
    maxQueueSize: 10,
    maxRequestsPerMinute: 120,
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
    mode: 'scheduled',
    permanentSync: true,
    schedule: {
      apiKey: 'secret',
      cron: '0 4 * * *',
      strategy: 'payload-jobs',
    },
    scheduleCron: '0 4 * * *',
  },
})

describe('job task definitions', () => {
  beforeEach(() => {
    getMerchantServiceInstance.mockReset()
  })

  test('applyJobEnhancements registers each GMC task only once', () => {
    const config = applyJobEnhancements({} as never, buildOptions())
    const taskSlugs = (config.jobs?.tasks ?? []).map((task) => {
      return (task as { slug: string }).slug
    })

    expect(taskSlugs).toEqual([
      'gmcPushProduct',
      'gmcDeleteProduct',
      'gmcSyncDirty',
      'gmcBatchPush',
      'gmcInitialSync',
      'gmcPullAll',
    ])

    const secondPass = applyJobEnhancements(config, buildOptions())
    expect(secondPass.jobs?.tasks).toHaveLength(6)
  })

  test('push task delegates to the merchant service', async () => {
    getMerchantServiceInstance.mockReturnValue({
      pushProduct: vi.fn().mockResolvedValue({
        action: 'insert',
        productId: 'prod-1',
        success: true,
      }),
    })

    const task = buildPushProductTaskConfig(buildOptions())
    const result = await task.handler({
      input: {
        merchantId: '123',
        productId: 'prod-1',
      },
      req: { payload: {} } as never,
    })

    expect(result).toEqual({
      output: {
        action: 'insert',
        productId: 'prod-1',
        queuedWithMerchant: '123',
        success: true,
      },
    })
  })

  test('delete task records a sync log when deletion fails', async () => {
    getMerchantServiceInstance.mockReturnValue({
      deleteProductByIdentity: vi.fn().mockRejectedValue(new Error('delete failed')),
    })

    const payload = {
      create: vi.fn().mockResolvedValue({ id: 'log-1' }),
    }
    const task = buildDeleteProductTaskConfig()
    const result = await task.handler({
      input: {
        identity: {
          contentLanguage: 'en',
          dataSourceName: 'accounts/123/dataSources/ds-123',
          feedLabel: 'US',
          merchantProductId: 'en~US~SKU-1',
          offerId: 'SKU-1',
          productInputName: 'accounts/123/productInputs/en~US~SKU-1',
          productName: 'accounts/123/products/en~US~SKU-1',
        },
        merchantId: '123',
        productId: 'prod-2',
      },
      req: { payload } as never,
    })

    expect(result).toEqual({
      errorMessage: 'delete failed',
      state: 'failed',
    })
    expect(payload.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'push',
        jobId: expect.stringMatching(/^gmc-delete-prod-2-/),
        status: 'failed',
      }),
    }))
  })

  test('dirty sync task updates progress and completion via the sync log', async () => {
    const pushBatch = vi.fn().mockImplementation(async ({ onProgress }: { onProgress: (report: Record<string, unknown>) => Promise<void> }) => {
      await onProgress({
        errors: [],
        failed: 0,
        processed: 2,
        succeeded: 2,
        total: 3,
      })

      return {
        completedAt: '2026-03-07T12:00:00Z',
        errors: [],
        failed: 0,
        processed: 3,
        status: 'completed',
        succeeded: 3,
        total: 3,
      }
    })

    getMerchantServiceInstance.mockReturnValue({
      cleanupSyncLogs: vi.fn(),
      pushBatch,
    })

    const payload = {
      create: vi.fn().mockResolvedValue({ id: 'log-1' }),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
      },
      update: vi.fn().mockResolvedValue({}),
    }
    const task = buildSyncDirtyTaskConfig()
    const result = await task.handler({
      input: {
        merchantId: '123',
        triggeredBy: 'cron',
      },
      req: { payload } as never,
    })

    expect(result).toEqual({
      output: {
        failed: 0,
        message: 'Synced 3/3 products',
        succeeded: 3,
        success: true,
        total: 3,
      },
    })
    expect(payload.update).toHaveBeenCalled()
    expect(pushBatch).toHaveBeenCalledWith(expect.objectContaining({
      filter: { 'mc.syncMeta.dirty': { equals: true } },
    }))
  })

  test('batch push, initial sync, and pull-all tasks delegate to the merchant service', async () => {
    const payload = {
      create: vi.fn().mockResolvedValue({ id: 'log-1' }),
      update: vi.fn().mockResolvedValue({}),
    }

    const pushBatch = vi.fn().mockResolvedValue({
      completedAt: '2026-03-07T12:00:00Z',
      errors: [],
      failed: 0,
      jobId: 'batch-1',
      processed: 1,
      startedAt: '2026-03-07T11:59:00Z',
      status: 'completed',
      succeeded: 1,
      total: 1,
    })
    const runInitialSync = vi.fn().mockResolvedValue({
      completedAt: '2026-03-07T12:00:00Z',
      dryRun: true,
      errors: [],
      existingRemote: 0,
      failed: 0,
      jobId: 'initial-1',
      processed: 2,
      skipped: 0,
      startedAt: '2026-03-07T11:59:00Z',
      status: 'completed',
      succeeded: 2,
      total: 2,
    })
    const pullAllProducts = vi.fn().mockResolvedValue({
      completedAt: '2026-03-07T12:00:00Z',
      errors: [],
      failed: 0,
      jobId: 'pull-1',
      matched: 2,
      orphaned: 1,
      processed: 3,
      startedAt: '2026-03-07T11:59:00Z',
      status: 'completed',
      succeeded: 2,
      total: 3,
    })

    getMerchantServiceInstance.mockReturnValue({
      cleanupSyncLogs: vi.fn(),
      pullAllProducts,
      pushBatch,
      runInitialSync,
    })

    const batchResult = await buildBatchPushTaskConfig().handler({
      input: {
        filter: { sku: { equals: 'SKU-1' } } as never,
        merchantId: '123',
        productIds: ['prod-1'],
      },
      req: { payload } as never,
    })
    const initialResult = await buildInitialSyncTaskConfig().handler({
      input: {
        merchantId: '123',
        overrides: { dryRun: true, limit: 2 },
      },
      req: { payload } as never,
    })
    const pullResult = await buildPullAllTaskConfig().handler({
      input: {
        merchantId: '123',
      },
      req: { payload } as never,
    })

    expect(batchResult).toEqual({
      output: {
        failed: 0,
        message: 'Synced 1/1 products',
        succeeded: 1,
        success: true,
        total: 1,
      },
    })
    expect(initialResult).toEqual({
      output: {
        failed: 0,
        message: 'Processed 2/2 products',
        succeeded: 2,
        success: true,
        total: 2,
      },
    })
    expect(pullResult).toEqual({
      output: {
        failed: 0,
        matched: 2,
        message: 'Pulled 2/3 products',
        orphaned: 1,
        success: true,
        total: 3,
      },
    })

    expect(pushBatch).toHaveBeenCalledWith(expect.objectContaining({
      filter: { sku: { equals: 'SKU-1' } },
      productIds: ['prod-1'],
    }))
    expect(runInitialSync).toHaveBeenCalledWith(expect.objectContaining({
      overrides: { dryRun: true, limit: 2 },
    }))
    expect(pullAllProducts).toHaveBeenCalledWith(expect.objectContaining({
      onProgress: expect.any(Function),
    }))
  })
})
