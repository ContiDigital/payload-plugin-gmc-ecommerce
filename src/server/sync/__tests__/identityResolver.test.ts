import { describe, expect, test } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { MC_FIELD_GROUP_NAME } from '../../../constants.js'
import { resolveIdentity } from '../identityResolver.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockOptions = (overrides?: Partial<NormalizedPluginOptions>): NormalizedPluginOptions => ({
  admin: { mode: 'route', navLabel: 'GMC', route: '/gmc' },
  api: { basePath: '/api/gmc' },
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
  dataSourceName: 'accounts/12345/dataSources/ds-123',
  defaults: {
    condition: 'NEW',
    contentLanguage: 'en',
    currency: 'USD',
    feedLabel: 'US',
  },
  disabled: false,
  localInventory: { enabled: false, storeCode: '' },
  getCredentials: () => Promise.resolve({ type: 'json' as const, credentials: { client_email: '', private_key: '' } }),
  merchantId: '12345',
  rateLimit: {
    baseRetryDelayMs: 1000,
    enabled: false,
    jitterFactor: 0.2,
    maxConcurrency: 5,
    maxQueueSize: 100,
    maxRequestsPerMinute: 120,
    maxRetries: 3,
    maxRetryDelayMs: 30000,
    requestTimeoutMs: 30000,
  },
  siteUrl: '',
  sync: {
    conflictStrategy: 'mc-wins',
    initialSync: {
      batchSize: 50,
      dryRun: false,
      enabled: false,
      onlyIfRemoteMissing: true,
    },
    mode: 'manual',
    permanentSync: false,
    schedule: { apiKey: '', cron: '0 4 * * *', strategy: 'payload-jobs' },
    scheduleCron: '0 4 * * *',
  },
  ...overrides,
})

// ---------------------------------------------------------------------------
// resolveIdentity
// ---------------------------------------------------------------------------

describe('resolveIdentity', () => {
  test('returns ok result with resolved identity from mcState', () => {
    const product = {
      [MC_FIELD_GROUP_NAME]: {
        identity: {
          contentLanguage: 'en',
          feedLabel: 'US',
          offerId: 'SKU-001',
        },
      },
      sku: 'FALLBACK-SKU',
    }

    const result = resolveIdentity(product, mockOptions())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.offerId).toBe('SKU-001')
      expect(result.value.contentLanguage).toBe('en')
      expect(result.value.feedLabel).toBe('US')
    }
  })

  test('falls back to identityField value when offerId not set in mcState', () => {
    const product = {
      [MC_FIELD_GROUP_NAME]: {
        identity: {},
      },
      sku: 'FALLBACK-SKU',
    }

    const result = resolveIdentity(product, mockOptions())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.offerId).toBe('FALLBACK-SKU')
    }
  })

  test('falls back to identityField when mc is missing', () => {
    const product = { sku: 'MY-SKU-123' }

    const result = resolveIdentity(product, mockOptions())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.offerId).toBe('MY-SKU-123')
    }
  })

  test('uses defaults for contentLanguage and feedLabel', () => {
    const product = {
      [MC_FIELD_GROUP_NAME]: {
        identity: { offerId: 'SKU-001' },
      },
      sku: 'SKU-001',
    }

    const result = resolveIdentity(product, mockOptions({
      defaults: {
        condition: 'NEW',
        contentLanguage: 'de',
        currency: 'EUR',
        feedLabel: 'DE',
      },
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.contentLanguage).toBe('de')
      expect(result.value.feedLabel).toBe('DE')
    }
  })

  test('returns error when offerId is missing/empty', () => {
    const product = {
      [MC_FIELD_GROUP_NAME]: {
        identity: {},
      },
      sku: '',
    }

    const result = resolveIdentity(product, mockOptions())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('offerId'))).toBe(true)
    }
  })

  test('returns error when offerId is only whitespace', () => {
    const product = {
      [MC_FIELD_GROUP_NAME]: {
        identity: {},
      },
      sku: '   ',
    }

    const result = resolveIdentity(product, mockOptions())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('offerId'))).toBe(true)
    }
  })

  test('returns error when merchantId is not configured', () => {
    const product = {
      sku: 'SKU-001',
    }

    const result = resolveIdentity(product, mockOptions({ merchantId: '' }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('merchantId'))).toBe(true)
    }
  })

  test('returns error when dataSourceId is missing and no override', () => {
    const product = {
      [MC_FIELD_GROUP_NAME]: {
        identity: { offerId: 'SKU-001' },
      },
      sku: 'SKU-001',
    }

    const result = resolveIdentity(product, mockOptions({
      dataSourceId: '',
      dataSourceName: '',
    }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('dataSourceId'))).toBe(true)
    }
  })

  test('correctly builds merchantProductId as "lang~label~offerId"', () => {
    const product = {
      [MC_FIELD_GROUP_NAME]: {
        identity: {
          contentLanguage: 'en',
          feedLabel: 'US',
          offerId: 'SKU-001',
        },
      },
    }

    const result = resolveIdentity(product, mockOptions())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.merchantProductId).toBe('en~US~SKU-001')
    }
  })

  test('correctly builds productInputName and productName', () => {
    const product = {
      [MC_FIELD_GROUP_NAME]: {
        identity: {
          contentLanguage: 'en',
          feedLabel: 'US',
          offerId: 'SKU-001',
        },
      },
    }

    const result = resolveIdentity(product, mockOptions({ merchantId: '99999' }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.productInputName).toBe('accounts/99999/productInputs/en~US~SKU-001')
      expect(result.value.productName).toBe('accounts/99999/products/en~US~SKU-001')
    }
  })

  test('handles dataSourceOverride correctly', () => {
    const product = {
      [MC_FIELD_GROUP_NAME]: {
        identity: {
          contentLanguage: 'en',
          dataSourceOverride: 'override-ds-456',
          feedLabel: 'US',
          offerId: 'SKU-001',
        },
      },
    }

    const result = resolveIdentity(product, mockOptions())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.dataSourceName).toBe('accounts/12345/dataSources/override-ds-456')
      expect(result.value.dataSourceOverride).toBe('override-ds-456')
    }
  })

  test('uses default dataSourceName when no override', () => {
    const product = {
      [MC_FIELD_GROUP_NAME]: {
        identity: {
          contentLanguage: 'en',
          feedLabel: 'US',
          offerId: 'SKU-001',
        },
      },
    }

    const result = resolveIdentity(product, mockOptions())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.dataSourceName).toBe('accounts/12345/dataSources/ds-123')
    }
  })

  test('resolves nested identityField path', () => {
    const product = {
      [MC_FIELD_GROUP_NAME]: {
        identity: {},
      },
      meta: { sku: 'NESTED-SKU' },
    }

    const result = resolveIdentity(product, mockOptions({
      collections: {
        products: {
          slug: 'products' as never,
          autoInjectTab: true,
          fetchDepth: 1,
          fieldMappings: [],
          identityField: 'meta.sku',
          tabPosition: 'append',
        },
      },
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.offerId).toBe('NESTED-SKU')
    }
  })

  test('collects multiple errors at once', () => {
    const product = {
      sku: '',
    }

    const result = resolveIdentity(product, mockOptions({
      dataSourceId: '',
      dataSourceName: '',
      merchantId: '',
    }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2)
    }
  })
})
