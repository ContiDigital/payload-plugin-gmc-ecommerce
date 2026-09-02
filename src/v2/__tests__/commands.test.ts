import { describe, expect, it } from 'vitest'

import type { GmcCommand } from '../types.js'

import {
  assertGmcCommand,
  createCatalogPublishCommand,
  createDataSourcesValidateCommand,
  createLocalInventoryApplyCommand,
  createOfferDeleteCommand,
  createOfferPublishCommand,
  createProductDeleteCommand,
  createProductPublishCommand,
  getGmcCommandIdempotencyDigest,
  getGmcCommandSubject,
} from '../commands.js'

const identity = {
  contentLanguage: 'en',
  feedLabel: 'US',
  offerId: 'sku-1',
}

const offerInput = {
  ...identity,
  productAttributes: {
    availability: 'IN_STOCK' as const,
    description: 'Description',
    imageLink: 'https://example.com/image.jpg',
    link: 'https://example.com/sku-1',
    price: { amountMicros: '1000000', currencyCode: 'USD' },
    title: 'Product',
  },
}

const offerPublish = () =>
  createOfferPublishCommand({
    digest: 'a'.repeat(64),
    input: offerInput,
    productId: 'product-1',
    requestedAt: '2026-08-29T12:00:00.000Z',
  })

const localApply = () =>
  createLocalInventoryApplyCommand({
    identity,
    inventory: null,
    productId: 'product-1',
    requestedAt: '2026-08-29T12:00:00.000Z',
    storeCode: 'store-1',
  })

describe('GMC v2 commands', () => {
  it('fingerprints semantic intent independently of retry wall-clock metadata', () => {
    const first = {
      type: 'catalog.publish',
      cause: 'api',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    } satisfies GmcCommand
    const replay = {
      ...first,
      requestedAt: '2026-08-29T12:05:00.000Z',
    }
    const conflict = {
      ...first,
      cause: 'manual' as const,
    }

    expect(getGmcCommandIdempotencyDigest(first)).toBe(getGmcCommandIdempotencyDigest(replay))
    expect(getGmcCommandIdempotencyDigest(first)).not.toBe(getGmcCommandIdempotencyDigest(conflict))
    expect(getGmcCommandIdempotencyDigest(first)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('creates versioned, serializable product commands', () => {
    const command = createProductPublishCommand({
      cause: 'update',
      previousIdentities: [identity],
      productId: 42,
      requestedAt: '2026-08-29T12:00:00.000Z',
    })

    expect(() => assertGmcCommand(JSON.parse(JSON.stringify(command)))).not.toThrow()
    expect(getGmcCommandSubject(command)).toBe('product:42')
  })

  it('creates catalog commands for canonical dependency and schedule events', () => {
    for (const cause of ['delete', 'schedule', 'update'] as const) {
      const command = createCatalogPublishCommand({
        cause,
        requestedAt: '2026-08-29T12:00:00.000Z',
      })
      expect(() => assertGmcCommand(command)).not.toThrow()
      expect(getGmcCommandSubject(command)).toBe('catalog')
    }
  })

  it('canonicalizes and validates bounded targeted catalog roots', () => {
    const command = createCatalogPublishCommand({
      cause: 'update',
      productIds: ['product-2', 3, 'product-1', 3],
      requestedAt: '2026-08-29T12:00:00.000Z',
    })

    expect(command.productIds).toEqual([3, 'product-1', 'product-2'])
    expect(() => assertGmcCommand(command)).not.toThrow()
    expect(() => assertGmcCommand({ ...command, productIds: ['product-2', 'product-1'] })).toThrow(
      /canonical order/i,
    )
    expect(() => assertGmcCommand({ ...command, productIds: [] })).toThrow(/1-1000/)
    expect(() =>
      assertGmcCommand({ ...command, productIds: Array.from({ length: 1_001 }, (_, id) => id) }),
    ).toThrow(/1-1000/)
  })

  it('creates a durable catalog-scoped data-source preflight command', () => {
    const command = createDataSourcesValidateCommand({
      requestedAt: '2026-08-29T12:00:00.000Z',
    })

    expect(() => assertGmcCommand(command)).not.toThrow()
    expect(command.type).toBe('dataSources.validate')
    expect(getGmcCommandSubject(command)).toBe('catalog')
  })

  it('orders a single-offer status refresh with writes for that offer', () => {
    const command = {
      type: 'status.refresh',
      identities: [identity],
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    } satisfies GmcCommand

    expect(() => assertGmcCommand(command)).not.toThrow()
    expect(getGmcCommandSubject(command)).toBe('offer:2:en|2:US|5:sku-1')
  })

  it('requires delete identities so deletion is recoverable after the document is gone', () => {
    const command = createProductDeleteCommand({
      cause: 'delete',
      identities: [identity],
      productId: 'product-1',
    })

    expect(() => assertGmcCommand(command)).not.toThrow()
    expect(() => assertGmcCommand({ ...command, identities: [{}] })).toThrow(/identit/i)
    expect(() =>
      assertGmcCommand({
        ...command,
        identities: [{ ...identity, offerId: ' sku-1 ' }],
      }),
    ).toThrow(/identit/i)
  })

  it('rejects unknown command schemas before execution', () => {
    expect(() =>
      assertGmcCommand({
        type: 'product.publish',
        requestedAt: '2026-08-29T12:00:00.000Z',
        schemaVersion: 3,
      }),
    ).toThrow(/schema version/i)
  })

  it('rejects ignored command and nested identity fields', () => {
    expect(() =>
      assertGmcCommand({
        ...createCatalogPublishCommand({ cause: 'manual' }),
        ignoredIntent: true,
      }),
    ).toThrow(/unsupported field.*ignoredIntent/i)

    expect(() =>
      assertGmcCommand(
        createProductDeleteCommand({
          cause: 'delete',
          identities: [{ ...identity, ignoredRoute: 'other' } as never],
        }),
      ),
    ).toThrow(/identit/i)
  })

  it('rejects ambiguous string document IDs', () => {
    expect(() =>
      assertGmcCommand(createProductPublishCommand({ cause: 'update', productId: ' product-1 ' })),
    ).toThrow(/productId/i)
  })

  it('rejects non-JSON and oversized durable envelopes before dispatch', () => {
    const circular = createProductPublishCommand({
      cause: 'update',
      productId: 'product-1',
    }) as unknown as Record<string, unknown>
    circular.circular = circular
    expect(() => assertGmcCommand(circular)).toThrow(/finite, acyclic JSON/i)

    expect(() =>
      assertGmcCommand({
        ...createProductPublishCommand({ cause: 'update', productId: 'product-1' }),
        padding: 'x'.repeat(1_048_576),
      }),
    ).toThrow(/1048576 serialized bytes/i)
  })

  it('rejects ambiguous local-inventory continuation coordinates', () => {
    expect(() =>
      assertGmcCommand({
        type: 'localInventory.reconcile',
        cursor: 'cursor-1',
        productId: 'product-1',
        requestedAt: '2026-08-29T12:00:00.000Z',
        schemaVersion: 2,
      }),
    ).toThrow(/both productId and cursor/i)

    expect(() =>
      assertGmcCommand({
        type: 'localInventory.reconcile',
        pageIndex: 1,
        productId: 'product-1',
        requestedAt: '2026-08-29T12:00:00.000Z',
        schemaVersion: 2,
      }),
    ).toThrow(/productId cannot have a pageIndex/i)
  })

  it('rejects unsafe store codes in local-inventory reconcile and delete commands', () => {
    const base = {
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'x'.repeat(65),
    } as const
    expect(() => assertGmcCommand({ ...base, type: 'localInventory.reconcile' })).toThrow(
      /1-64 safe characters/i,
    )
    expect(() =>
      assertGmcCommand({
        ...base,
        type: 'localInventory.apply',
        identity,
        inventory: null,
        productId: 'product-1',
      }),
    ).toThrow(/1-64 safe characters/i)
  })

  it('requires a canonical content digest on every offer and inventory write command', () => {
    expect(() => assertGmcCommand(offerPublish())).not.toThrow()
    expect(() => assertGmcCommand({ ...offerPublish(), digest: 'not-a-digest' })).toThrow(
      /hexadecimal digest/i,
    )
    expect(() => assertGmcCommand({ ...offerPublish(), digest: undefined })).toThrow(
      /hexadecimal digest/i,
    )

    expect(() => assertGmcCommand(localApply())).not.toThrow()
    expect(() => assertGmcCommand({ ...localApply(), digest: 'A'.repeat(64) })).toThrow(
      /hexadecimal digest/i,
    )
  })

  it('forwards an optional projector version and rejects a malformed one', () => {
    expect(() => assertGmcCommand({ ...offerPublish(), versionNumber: '17' })).not.toThrow()
    expect(() =>
      assertGmcCommand({ ...offerPublish(), versionNumber: '9223372036854775808' }),
    ).toThrow(/versionNumber/i)
    expect(() => assertGmcCommand({ ...offerPublish(), versionNumber: 17 })).toThrow(
      /versionNumber/i,
    )
  })

  it('orders an offer delete by an ISO desired-state boundary', () => {
    const command = createOfferDeleteCommand({
      identity,
      onlyIfDesiredBefore: '2026-08-29T12:00:00.000Z',
      requestedAt: '2026-08-29T12:00:00.000Z',
    })
    expect(() => assertGmcCommand(command)).not.toThrow()
    expect(() => assertGmcCommand({ ...command, onlyIfDesiredBefore: 'yesterday' })).toThrow(
      /onlyIfDesiredBefore/i,
    )
  })

  it.each([
    ['offer.delete', 'deleteIfDesiredBefore', '2026-08-29T12:00:00.000Z'],
    ['offer.delete', 'deleteIfDesiredVersionBefore', '1'],
    ['offer.delete', 'deleteVersion', '1'],
    ['offer.delete', 'desiredVersion', '1'],
    ['offer.delete', 'sourceVersion', '1'],
    ['offer.publish', 'desiredVersion', '1'],
    ['offer.publish', 'sourceVersion', '1'],
    ['localInventory.apply', 'desiredVersion', '1'],
    ['localInventory.apply', 'sourceVersion', '1'],
    ['catalog.reconcile', 'startedVersion', '1'],
  ] as const)(
    'accepts and ignores the rc.35 %s field %s left on a durable row',
    (type, field, value) => {
      const base: Record<string, GmcCommand> = {
        'catalog.reconcile': {
          type: 'catalog.reconcile',
          phase: 'remote',
          requestedAt: '2026-08-29T12:00:00.000Z',
          schemaVersion: 2,
          startedAt: '2026-08-29T12:00:00.000Z',
        },
        'localInventory.apply': localApply(),
        'offer.delete': createOfferDeleteCommand({
          identity,
          requestedAt: '2026-08-29T12:00:00.000Z',
        }),
        'offer.publish': offerPublish(),
      }
      expect(() => assertGmcCommand({ ...base[type], [field]: value })).not.toThrow()
    },
  )

  it('still rejects a legacy field on a command type that never carried it', () => {
    expect(() =>
      assertGmcCommand({
        ...createProductPublishCommand({
          cause: 'update',
          productId: 'product-1',
          requestedAt: '2026-08-29T12:00:00.000Z',
        }),
        sourceVersion: '1',
      }),
    ).toThrow(/unsupported field.*sourceVersion/i)
  })

  it('bounds remote reconciliation pagination coordinates', () => {
    expect(() =>
      assertGmcCommand({
        type: 'catalog.reconcile',
        pageIndex: 1_000_001,
        pageToken: 'next',
        phase: 'remote',
        requestedAt: '2026-08-29T12:00:00.000Z',
        schemaVersion: 2,
        startedAt: '2026-08-29T12:00:00.000Z',
      }),
    ).toThrow(/pageIndex/i)

    expect(() =>
      assertGmcCommand({
        type: 'catalog.publish',
        cause: 'manual',
        pageIndex: -1,
        requestedAt: '2026-08-29T12:00:00.000Z',
        schemaVersion: 2,
      }),
    ).toThrow(/pageIndex/i)
  })
})
