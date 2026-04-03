import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { MerchantService } from '../../server/services/merchantService.js'
import type { NormalizedPluginOptions } from '../../types/index.js'

const createMerchantService = vi.fn()

vi.mock('../../server/services/merchantService.js', () => ({
  createMerchantService,
}))

const {
  getMerchantServiceInstance,
  initMerchantService,
  resetMerchantServiceRegistry,
} = await import('../serviceRegistry.js')

const buildOptions = (
  merchantId = 'merchant-1',
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
  merchantId,
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

type FakeService = {
  destroy: ReturnType<typeof vi.fn>
  label: string
} & MerchantService

const createFakeService = (label: string): FakeService =>
  ({
    destroy: vi.fn(),
    label,
  }) as unknown as FakeService

describe('serviceRegistry', () => {
  beforeEach(() => {
    createMerchantService.mockReset()
    resetMerchantServiceRegistry()
  })

  afterEach(() => {
    resetMerchantServiceRegistry()
  })

  test('replaces an existing service when the same merchant is re-initialized', () => {
    const firstService = createFakeService('first')
    const secondService = createFakeService('second')
    createMerchantService
      .mockReturnValueOnce(firstService)
      .mockReturnValueOnce(secondService)

    const firstResult = initMerchantService(buildOptions('merchant-1'))
    const secondResult = initMerchantService(buildOptions('merchant-1', {
      siteUrl: 'https://updated.example.com',
    }))

    expect(firstResult).toBe(firstService)
    expect(secondResult).toBe(secondService)
    expect(firstService.destroy).toHaveBeenCalledTimes(1)
    expect(getMerchantServiceInstance('merchant-1')).toBe(secondService)
  })

  test('tracks the last registered merchant for default lookups', () => {
    const firstService = createFakeService('first')
    const secondService = createFakeService('second')
    createMerchantService
      .mockReturnValueOnce(firstService)
      .mockReturnValueOnce(secondService)

    initMerchantService(buildOptions('merchant-1'))
    initMerchantService(buildOptions('merchant-2'))

    expect(getMerchantServiceInstance()).toBe(secondService)
    expect(getMerchantServiceInstance('merchant-1')).toBe(firstService)
    expect(getMerchantServiceInstance('merchant-2')).toBe(secondService)
  })

  test('reset destroys all services and clears lookups', () => {
    const firstService = createFakeService('first')
    const secondService = createFakeService('second')
    createMerchantService
      .mockReturnValueOnce(firstService)
      .mockReturnValueOnce(secondService)

    initMerchantService(buildOptions('merchant-1'))
    initMerchantService(buildOptions('merchant-2'))

    resetMerchantServiceRegistry()

    expect(firstService.destroy).toHaveBeenCalledTimes(1)
    expect(secondService.destroy).toHaveBeenCalledTimes(1)
    expect(getMerchantServiceInstance()).toBeNull()
    expect(getMerchantServiceInstance('merchant-1')).toBeNull()
    expect(getMerchantServiceInstance('merchant-2')).toBeNull()
  })
})
