import { describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import {
  assertInboundRateLimit,
  InboundRateLimitExceededError,
} from '../inboundRateLimit.js'

const buildOptions = (
  overrides?: Partial<NormalizedPluginOptions['rateLimit']>,
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
    enabled: true,
    jitterFactor: 0,
    maxConcurrency: 2,
    maxQueueSize: 10,
    maxRequestsPerMinute: 1,
    maxRetries: 1,
    maxRetryDelayMs: 1000,
    requestTimeoutMs: 5000,
    ...overrides,
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
      apiKey: '',
      cron: '0 4 * * *',
      strategy: 'external',
    },
    scheduleCron: '0 4 * * *',
  },
})

describe('assertInboundRateLimit', () => {
  test('bypasses checks when inbound rate limiting is disabled', async () => {
    await expect(assertInboundRateLimit({
      headers: new Headers(),
    } as never, buildOptions({ enabled: false }), 'push')).resolves.toBeUndefined()
  })

  test('throws when the distributed store denies the request', async () => {
    await expect(assertInboundRateLimit({
      headers: new Headers({ 'x-forwarded-for': '127.0.0.1' }),
    } as never, buildOptions({
      store: {
        claimSlot: vi.fn().mockResolvedValue({
          allowed: false,
          count: 2,
          resetAt: Date.now() + 60_000,
        }),
      },
    }), 'push')).rejects.toBeInstanceOf(InboundRateLimitExceededError)
  })

  test('uses the distributed store when configured', async () => {
    const claimSlot = vi.fn().mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    })

    await expect(assertInboundRateLimit({
      headers: new Headers({ 'x-forwarded-for': '10.0.0.1' }),
    } as never, buildOptions({ store: { claimSlot } }), 'push')).resolves.toBeUndefined()

    expect(claimSlot).toHaveBeenCalledWith({
      key: 'push:10.0.0.1',
      limit: 1,
      scope: 'inbound',
      windowMs: 60_000,
    })
  })

  test('enforces the in-memory rate limit using x-real-ip fallback', async () => {
    const req = {
      headers: new Headers({ 'x-real-ip': '10.0.0.9' }),
    }

    await expect(assertInboundRateLimit(req as never, buildOptions(), 'push')).resolves.toBeUndefined()
    await expect(assertInboundRateLimit(req as never, buildOptions(), 'push')).rejects.toBeInstanceOf(
      InboundRateLimitExceededError,
    )
  })
})
