import { beforeEach, describe, expect, test, vi } from 'vitest'

const {
  queueBatchPushJob,
  queueDirtySyncJob,
  queueInitialSyncJob,
  queueProductDeleteJob,
  queueProductPushJob,
  queuePullAllJob,
  runQueuedGmcJobs,
} =
  await import('../jobQueue.js')

describe('jobQueue', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('queues product push jobs with the correct task slug and input', async () => {
    const queue = vi.fn().mockResolvedValue({ id: 'job-1' })
    const payload = {
      jobs: { queue },
    }

    const jobId = await queueProductPushJob({
      merchantId: '123',
      payload: payload as never,
      productId: 'prod-1',
    })

    expect(jobId).toBe('job-1')
    expect(queue).toHaveBeenCalledWith({
      input: {
        merchantId: '123',
        productId: 'prod-1',
      },
      queue: 'gmc-sync',
      req: undefined,
      task: 'gmcPushProduct',
    })
  })

  test('queues delete and dirty-sync jobs with their specific payloads', async () => {
    const queue = vi.fn()
      .mockResolvedValueOnce({ id: 'delete-job' })
      .mockResolvedValueOnce({ id: 'dirty-job' })
      .mockResolvedValueOnce({ id: 'batch-job' })
      .mockResolvedValueOnce({ id: 'initial-job' })
      .mockResolvedValueOnce({ id: 'pull-job' })
    const payload = {
      jobs: { queue },
    }

    const deleteJobId = await queueProductDeleteJob({
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
      payload: payload as never,
      productId: 'prod-2',
    })

    const dirtyJobId = await queueDirtySyncJob({
      jobId: 'batch-1',
      logDocId: 'log-1',
      merchantId: '123',
      metadata: { trigger: 'cron' },
      payload: payload as never,
      triggeredBy: 'cron',
    })

    const batchJobId = await queueBatchPushJob({
      filter: { sku: { equals: 'SKU-1' } } as never,
      jobId: 'batch-2',
      logDocId: 'log-2',
      merchantId: '123',
      metadata: { trigger: 'manual-batch-push' },
      payload: payload as never,
      productIds: ['prod-1'],
      triggeredBy: 'admin@example.com',
    })

    const initialJobId = await queueInitialSyncJob({
      jobId: 'initial-1',
      logDocId: 'log-3',
      merchantId: '123',
      metadata: { dryRun: true },
      overrides: { dryRun: true, limit: 5 },
      payload: payload as never,
      triggeredBy: 'admin@example.com',
    })

    const pullJobId = await queuePullAllJob({
      jobId: 'pull-1',
      logDocId: 'log-4',
      merchantId: '123',
      metadata: { trigger: 'manual-pull-all' },
      payload: payload as never,
      triggeredBy: 'admin@example.com',
    })

    expect(deleteJobId).toBe('delete-job')
    expect(dirtyJobId).toBe('dirty-job')
    expect(batchJobId).toBe('batch-job')
    expect(initialJobId).toBe('initial-job')
    expect(pullJobId).toBe('pull-job')
    expect(queue).toHaveBeenNthCalledWith(1, expect.objectContaining({
      task: 'gmcDeleteProduct',
    }))
    expect(queue).toHaveBeenNthCalledWith(2, {
      input: {
        jobId: 'batch-1',
        logDocId: 'log-1',
        merchantId: '123',
        metadata: { trigger: 'cron' },
        triggeredBy: 'cron',
      },
      queue: 'gmc-sync',
      req: undefined,
      task: 'gmcSyncDirty',
    })
    expect(queue).toHaveBeenNthCalledWith(3, {
      input: {
        filter: { sku: { equals: 'SKU-1' } },
        jobId: 'batch-2',
        logDocId: 'log-2',
        merchantId: '123',
        metadata: { trigger: 'manual-batch-push' },
        productIds: ['prod-1'],
        triggeredBy: 'admin@example.com',
      },
      queue: 'gmc-sync',
      req: undefined,
      task: 'gmcBatchPush',
    })
    expect(queue).toHaveBeenNthCalledWith(4, {
      input: {
        jobId: 'initial-1',
        logDocId: 'log-3',
        merchantId: '123',
        metadata: { dryRun: true },
        overrides: { dryRun: true, limit: 5 },
        triggeredBy: 'admin@example.com',
      },
      queue: 'gmc-sync',
      req: undefined,
      task: 'gmcInitialSync',
    })
    expect(queue).toHaveBeenNthCalledWith(5, {
      input: {
        jobId: 'pull-1',
        logDocId: 'log-4',
        merchantId: '123',
        metadata: { trigger: 'manual-pull-all' },
        triggeredBy: 'admin@example.com',
      },
      queue: 'gmc-sync',
      req: undefined,
      task: 'gmcPullAll',
    })
  })

  test('deduplicates concurrent calls to runQueuedGmcJobs', async () => {
    let resolveRun: (() => void) | undefined
    const run = vi.fn().mockImplementation(() => {
      return new Promise<void>((resolve) => {
        resolveRun = resolve
      })
    })
    const payload = {
      jobs: { run },
      logger: {
        error: vi.fn(),
      },
    }

    const first = runQueuedGmcJobs(payload as never)
    const second = runQueuedGmcJobs(payload as never)

    expect(run).toHaveBeenCalledTimes(1)
    resolveRun?.()

    await Promise.all([first, second])
  })
})
