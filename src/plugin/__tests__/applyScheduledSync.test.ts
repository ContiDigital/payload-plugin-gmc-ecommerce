import { describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../types/index.js'

const { applyScheduledSync } = await import('../applyScheduledSync.js')

const buildOptions = (
  overrides?: Partial<NormalizedPluginOptions>,
): NormalizedPluginOptions => ({
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
    enabled: true,
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
    mode: 'scheduled',
    permanentSync: true,
    schedule: {
      apiKey: 'secret',
      cron: '0 4 * * *',
      strategy: 'payload-jobs',
    },
    scheduleCron: '0 4 * * *',
  },
  ...overrides,
})

describe('applyScheduledSync', () => {
  test('returns config unchanged when payload-jobs strategy is not selected', () => {
    const config = {}

    const result = applyScheduledSync(
      config as never,
      buildOptions({
        sync: {
          ...buildOptions().sync,
          schedule: {
            ...buildOptions().sync.schedule,
            strategy: 'external',
          },
        },
      }),
    )

    expect(result).toBe(config)
    expect(result.onInit).toBeUndefined()
  })

  test('wraps any existing onInit handler and logs payload-jobs requirements once', async () => {
    const existingOnInit = vi.fn().mockResolvedValue(undefined)
    const config = { onInit: existingOnInit }
    const payload = {
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    }

    const result = applyScheduledSync(config as never, buildOptions())

    expect(result.onInit).toBeTypeOf('function')

    await result.onInit?.(payload as never)
    await result.onInit?.(payload as never)

    expect(existingOnInit).toHaveBeenCalledTimes(2)
    expect(payload.logger.info).toHaveBeenCalledTimes(1)
    expect(payload.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        note: expect.stringContaining('cron endpoint'),
        queue: 'gmc-sync',
        syncMode: 'scheduled',
      }),
      '[GMC] GMC payload-jobs mode enabled',
    )
  })

  test('emits the non-scheduled payload-jobs notice when used outside scheduled mode', async () => {
    const payload = {
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    }

    const result = applyScheduledSync({} as never, buildOptions({
      sync: {
        ...buildOptions().sync,
        mode: 'onChange',
      },
    }))

    await result.onInit?.(payload as never)

    expect(payload.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        note: expect.stringContaining('queued GMC tasks'),
        queue: 'gmc-sync',
        syncMode: 'onChange',
      }),
      '[GMC] GMC payload-jobs mode enabled',
    )
  })
})
