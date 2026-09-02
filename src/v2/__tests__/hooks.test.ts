import type { Payload, PayloadRequest } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { GmcAsyncAdapter, PayloadGmcEcommerceV2Options } from '../types.js'

import { normalizeGmcV2Options } from '../config.js'
import {
  createGmcV2AfterChangeHook,
  createGmcV2AfterDeleteHook,
  createGmcV2DependencyAfterChangeHook,
  createGmcV2DependencyAfterDeleteHook,
  createGmcV2GlobalDependencyAfterChangeHook,
} from '../hooks.js'

const build = (adapter: GmcAsyncAdapter) =>
  normalizeGmcV2Options({
    access: () => true,
    async: adapter,
    dataSourceId: '987654321',
    feeds: [
      {
        id: 'primary',
        access: 'public',
        delivery: 'dynamic',
        path: '/feeds/google.tsv',
        selector: { contentLanguage: 'en', feedLabel: 'US' },
      },
    ],
    getCredentials: () =>
      Promise.resolve({
        type: 'json',
        credentials: { client_email: 'test@example.com', private_key: 'secret' },
      }),
    merchantId: '123456',
    products: {
      collection: 'products',
      project: () => ({ products: [], sourceVersion: '1' }),
      resolveIdentities: ({ doc }) => [
        {
          contentLanguage: 'en',
          feedLabel: 'US',
          offerId: String(doc.sku),
        },
      ],
    },
  } satisfies PayloadGmcEcommerceV2Options)

const payloadWarn = vi.fn()
const request = {
  payload: { logger: { warn: payloadWarn } } as unknown as Payload,
  transactionID: 'transaction-1',
} as PayloadRequest

describe('GMC v2 Payload hooks', () => {
  it('fails closed before dispatch when an automatic hook has no ambient transaction', async () => {
    const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>(() =>
      Promise.resolve({ operationId: 'operation-1', state: 'queued' }),
    )
    const normalized = build({
      name: 'test',
      dispatch,
      getOperation: vi.fn(() => Promise.resolve(null)),
      health: vi.fn(() =>
        Promise.resolve({ checkedAt: '2026-08-30T12:00:00.000Z', status: 'ok' as const }),
      ),
    })
    const nonTransactionalRequests = [
      { payload: {} as Payload },
      // Payload's disabled-transaction adapter leaves this exact shape on the
      // request: a truthy Promise which resolves to no transaction handle.
      { payload: {} as Payload, transactionID: Promise.resolve(null) },
    ] as PayloadRequest[]

    for (const nonTransactionalRequest of nonTransactionalRequests) {
      await expect(
        createGmcV2AfterChangeHook(normalized)({
          doc: { id: 'product-1', sku: 'new' },
          operation: 'update',
          req: nonTransactionalRequest,
        } as never),
      ).rejects.toMatchObject({ code: 'GMC_TRANSACTION_REQUIRED' })
      await expect(
        createGmcV2AfterDeleteHook(normalized)({
          doc: { id: 'product-1', sku: 'old' },
          req: nonTransactionalRequest,
        } as never),
      ).rejects.toMatchObject({ code: 'GMC_TRANSACTION_REQUIRED' })
      await expect(
        createGmcV2DependencyAfterChangeHook(normalized, {
          collection: 'categories',
          select: ({ doc }) => doc.slug,
        })({
          doc: { id: 'category-1', slug: 'new' },
          operation: 'update',
          previousDoc: { id: 'category-1', slug: 'old' },
          req: nonTransactionalRequest,
        } as never),
      ).rejects.toMatchObject({ code: 'GMC_TRANSACTION_REQUIRED' })
      await expect(
        createGmcV2GlobalDependencyAfterChangeHook(normalized, {
          global: 'merchant-settings',
          select: ({ doc }) => doc.enabled,
        })({
          doc: { enabled: true },
          previousDoc: { enabled: false },
          req: nonTransactionalRequest,
        } as never),
      ).rejects.toMatchObject({ code: 'GMC_TRANSACTION_REQUIRED' })
    }
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('awaits transaction-aware durable dispatch and carries previous identities', async () => {
    let release: ((value: { operationId: string; state: 'queued' }) => void) | undefined
    const dispatch = vi.fn(
      () =>
        new Promise<{ operationId: string; state: 'queued' }>((resolve) => {
          release = resolve
        }),
    )
    const hook = createGmcV2AfterChangeHook(
      build({
        name: 'test',
        dispatch,
        getOperation: vi.fn(() => Promise.resolve(null)),
        health: vi.fn(() =>
          Promise.resolve({
            checkedAt: '2026-08-29T12:00:00.000Z',
            status: 'ok' as const,
          }),
        ),
      }),
    )
    let settled = false
    const pending = hook({
      doc: { id: 'product-1', sku: 'new', updatedAt: '2026-08-29T12:00:00.000Z' },
      operation: 'update',
      previousDoc: { id: 'product-1', sku: 'old' },
      req: request,
    } as never).then(() => {
      settled = true
    })

    // Resolving the ambient handle adds an async boundary before identity
    // resolution. Wait only until dispatch starts; its promise stays pending.
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled())
    expect(settled).toBe(false)
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: 'product.publish',
          previousIdentities: [expect.objectContaining({ offerId: 'old' })],
        }),
        req: request,
      }),
    )
    release?.({ operationId: 'operation-1', state: 'queued' })
    await pending
    expect(settled).toBe(true)
  })

  it('does not accept a false success receipt from an adapter', async () => {
    const hook = createGmcV2AfterChangeHook(
      build({
        name: 'test',
        dispatch: () => Promise.resolve({ operationId: '', state: 'queued' }),
        getOperation: vi.fn(() => Promise.resolve(null)),
        health: vi.fn(() =>
          Promise.resolve({
            checkedAt: '2026-08-29T12:00:00.000Z',
            status: 'ok' as const,
          }),
        ),
      }),
    )

    await expect(
      hook({
        doc: { id: 'product-1', sku: 'new', updatedAt: '2026-08-29T12:00:00.000Z' },
        operation: 'update',
        req: request,
      } as never),
    ).rejects.toThrow(/invalid durable dispatch receipt/i)
  })

  it('never interprets Payload synthetic previousDoc data as an owned identity on create', async () => {
    const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>(() =>
      Promise.resolve({ operationId: 'operation-1', state: 'queued' }),
    )
    const normalized = build({
      name: 'test',
      dispatch,
      getOperation: vi.fn(() => Promise.resolve(null)),
      health: vi.fn(() =>
        Promise.resolve({ checkedAt: '2026-08-29T12:00:00.000Z', status: 'ok' as const }),
      ),
    })
    const resolveIdentities = vi.fn(normalized.products.resolveIdentities)
    normalized.products.resolveIdentities = resolveIdentities

    await createGmcV2AfterChangeHook(normalized)({
      doc: { id: 'product-1', sku: 'new' },
      operation: 'create',
      previousDoc: { id: 'product-1', sku: undefined },
      req: request,
    } as never)

    expect(resolveIdentities).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ previousIdentities: [] }),
      }),
    )
  })

  it('validates resolved deletion identities and hook fingerprints before dispatch', async () => {
    const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>(() =>
      Promise.resolve({ operationId: 'operation-1', state: 'queued' }),
    )
    const normalized = build({
      name: 'test',
      dispatch,
      getOperation: vi.fn(() => Promise.resolve(null)),
      health: vi.fn(() =>
        Promise.resolve({
          checkedAt: '2026-08-29T12:00:00.000Z',
          status: 'ok' as const,
        }),
      ),
    })
    normalized.products.resolveIdentities = () => [
      { contentLanguage: 'en', feedLabel: 'US', offerId: ' ambiguous ' },
    ]
    await expect(
      createGmcV2AfterDeleteHook(normalized)({
        doc: { id: 'product-1' },
        req: request,
      } as never),
    ).rejects.toThrow(/identities/i)

    normalized.products.resolveIdentities = () => []
    const circular: Record<string, unknown> = { id: 'product-1' }
    circular.self = circular
    await expect(
      createGmcV2AfterChangeHook(normalized)({
        doc: circular,
        operation: 'update',
        req: request,
      } as never),
    ).rejects.toThrow(/fingerprint input/i)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('derives a stable fallback idempotency key when host timestamps are disabled', async () => {
    const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>(() =>
      Promise.resolve({
        operationId: 'operation-1',
        state: 'queued' as const,
      }),
    )
    const hook = createGmcV2AfterChangeHook(
      build({
        name: 'test',
        dispatch,
        getOperation: vi.fn(() => Promise.resolve(null)),
        health: vi.fn(() =>
          Promise.resolve({
            checkedAt: '2026-08-29T12:00:00.000Z',
            status: 'ok' as const,
          }),
        ),
      }),
    )
    const args = {
      doc: { id: 'product-1', sku: 'stable', title: 'Product' },
      operation: 'update',
      req: request,
    } as never

    await hook(args)
    await hook(args)

    expect(dispatch.mock.calls[0]?.[0]?.idempotencyKey).toBe(
      dispatch.mock.calls[1]?.[0]?.idempotencyKey,
    )
  })

  it('does not collapse divergent saves which share the same database timestamp', async () => {
    const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>(() =>
      Promise.resolve({
        operationId: 'operation-1',
        state: 'queued' as const,
      }),
    )
    const hook = createGmcV2AfterChangeHook(
      build({
        name: 'test',
        dispatch,
        getOperation: vi.fn(() => Promise.resolve(null)),
        health: vi.fn(() =>
          Promise.resolve({
            checkedAt: '2026-08-29T12:00:00.000Z',
            status: 'ok' as const,
          }),
        ),
      }),
    )
    const base = {
      id: 'product-1',
      sku: 'stable',
      updatedAt: '2026-08-29T12:00:00.000Z',
    }

    await hook({ doc: { ...base, title: 'First' }, operation: 'update', req: request } as never)
    await hook({ doc: { ...base, title: 'Second' }, operation: 'update', req: request } as never)

    expect(dispatch.mock.calls[0]?.[0]?.idempotencyKey).not.toBe(
      dispatch.mock.calls[1]?.[0]?.idempotencyKey,
    )
  })

  it('does not collapse a repeated product state after an intervening transition', async () => {
    const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>(() =>
      Promise.resolve({ operationId: 'operation-1', state: 'queued' as const }),
    )
    const hook = createGmcV2AfterChangeHook(
      build({
        name: 'test',
        dispatch,
        getOperation: vi.fn(() => Promise.resolve(null)),
        health: vi.fn(() =>
          Promise.resolve({ checkedAt: '2026-08-29T12:00:00.000Z', status: 'ok' as const }),
        ),
      }),
    )
    const transition = (current: string, previous: string) =>
      hook({
        doc: {
          id: 'product-1',
          sku: 'stable',
          title: current,
          updatedAt: '2026-08-29T12:00:00.000Z',
        },
        operation: 'update',
        previousDoc: {
          id: 'product-1',
          sku: 'stable',
          title: previous,
          updatedAt: '2026-08-29T12:00:00.000Z',
        },
        req: request,
      } as never)

    await transition('A', 'before-A')
    await transition('B', 'A')
    await transition('A', 'B')
    const firstA = dispatch.mock.calls[0]?.[0].idempotencyKey
    const finalA = dispatch.mock.calls[2]?.[0].idempotencyKey
    expect(finalA).not.toBe(firstA)

    await transition('A', 'B')
    expect(dispatch.mock.calls[3]?.[0].idempotencyKey).toBe(finalA)
  })

  it('dispatches deletion even when identity resolution is empty so state recovery can finish it', async () => {
    const dispatch = vi.fn(() =>
      Promise.resolve({ operationId: 'operation-1', state: 'queued' as const }),
    )
    const normalized = build({
      name: 'test',
      dispatch,
      getOperation: vi.fn(() => Promise.resolve(null)),
      health: vi.fn(() =>
        Promise.resolve({
          checkedAt: '2026-08-29T12:00:00.000Z',
          status: 'ok' as const,
        }),
      ),
    })
    normalized.products.resolveIdentities = () => []
    const hook = createGmcV2AfterDeleteHook(normalized)

    await hook({
      doc: { id: 'product-1', updatedAt: '2026-08-29T12:00:00.000Z' },
      req: request,
    } as never)
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ type: 'product.delete', identities: [] }),
        req: request,
      }),
    )
  })

  it('owns canonical dependency changes and future temporal boundaries through durable dispatch', async () => {
    const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>(() =>
      Promise.resolve({
        operationId: 'operation-1',
        state: 'queued' as const,
      }),
    )
    const normalized = build({
      name: 'test',
      capabilities: { scheduledDelivery: true },
      dispatch,
      getOperation: vi.fn(() => Promise.resolve(null)),
      health: vi.fn(() =>
        Promise.resolve({
          checkedAt: '2026-08-29T12:00:00.000Z',
          status: 'ok' as const,
        }),
      ),
    })
    const dependency = {
      collection: 'promos' as const,
      scheduleAt: ({ doc }: { doc: Record<string, unknown> }) => [
        String(doc.startDate),
        String(doc.endDate),
      ],
      select: ({ doc }: { doc: Record<string, unknown> }) => ({ title: doc.title }),
    }
    const afterChange = createGmcV2DependencyAfterChangeHook(normalized, dependency)
    const afterDelete = createGmcV2DependencyAfterDeleteHook(normalized, dependency)

    await afterChange({
      doc: {
        id: 7,
        endDate: '2099-07-01T00:00:00.000Z',
        startDate: '2099-06-01T00:00:00.000Z',
        title: 'Summer sale',
      },
      operation: 'update',
      previousDoc: {
        id: 7,
        endDate: '2099-07-01T00:00:00.000Z',
        startDate: '2099-05-01T00:00:00.000Z',
        title: 'Old title',
      },
      req: request,
    } as never)

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: expect.objectContaining({ type: 'catalog.publish', cause: 'update' }),
        req: request,
        subject: 'gmc:123456:catalog',
      }),
    )
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: expect.objectContaining({ type: 'catalog.publish', cause: 'schedule' }),
        scheduledFor: '2099-06-01T00:00:00.000Z',
      }),
    )

    await afterDelete({
      doc: { id: 7, title: 'Summer sale' },
      req: request,
    } as never)
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ type: 'catalog.publish', cause: 'delete' }),
      }),
    )

    dependency.scheduleAt = () => ['2099-02-30T00:00:00Z']
    await expect(
      afterChange({
        doc: { id: 7, title: 'Stable title' },
        operation: 'update',
        previousDoc: { id: 7, title: 'Stable title' },
        req: request,
      } as never),
    ).rejects.toThrow(/scheduleAt.*valid ISO dates/i)
  })

  it('does not collapse a repeated collection transition after an intervening state', async () => {
    const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>(() =>
      Promise.resolve({ operationId: 'operation-1', state: 'queued' as const }),
    )
    const normalized = build({
      name: 'test',
      dispatch,
      getOperation: vi.fn(() => Promise.resolve(null)),
      health: vi.fn(() =>
        Promise.resolve({ checkedAt: '2026-08-29T12:00:00.000Z', status: 'ok' as const }),
      ),
    })
    const hook = createGmcV2DependencyAfterChangeHook(normalized, {
      collection: 'categories',
      select: ({ doc }) => doc.title,
    })

    const transition = (current: string, previous: string, updatedAt: string) =>
      hook({
        doc: { id: 7, title: current, updatedAt },
        operation: 'update',
        previousDoc: { id: 7, title: previous, updatedAt: `${updatedAt}-previous` },
        req: request,
      } as never)

    await transition('B', 'A', '1')
    await transition('A', 'B', '2')
    await transition('B', 'A', '3')
    const firstKey = dispatch.mock.calls[0]?.[0].idempotencyKey
    const latestKey = dispatch.mock.calls[2]?.[0].idempotencyKey
    expect(latestKey).not.toBe(firstKey)

    await transition('B', 'A', '3')
    expect(dispatch.mock.calls[3]?.[0].idempotencyKey).toBe(latestKey)
  })

  it('persists one bounded targeted dependency root and keeps schedules full-catalog', async () => {
    const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>(() =>
      Promise.resolve({ operationId: 'operation-1', state: 'queued' as const }),
    )
    const normalized = build({
      name: 'test',
      capabilities: { scheduledDelivery: true },
      dispatch,
      getOperation: vi.fn(() => Promise.resolve(null)),
      health: vi.fn(() =>
        Promise.resolve({ checkedAt: '2026-08-29T12:00:00.000Z', status: 'ok' as const }),
      ),
    })
    const resolveProductIds = vi.fn(() => [9, 2, 9])
    const hook = createGmcV2DependencyAfterChangeHook(normalized, {
      collection: 'promos',
      resolveProductIds,
      scheduleAt: ({ doc }) => [String(doc.nextBoundary)],
      select: ({ doc }) => doc.title,
    })

    await hook({
      doc: { id: 7, nextBoundary: '2099-06-01T00:00:00.000Z', title: 'New' },
      operation: 'update',
      previousDoc: { id: 7, nextBoundary: '2099-05-01T00:00:00.000Z', title: 'Old' },
      req: request,
    } as never)

    expect(resolveProductIds).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: 'update',
        doc: expect.objectContaining({ title: 'New' }),
        previousDoc: expect.objectContaining({ title: 'Old' }),
        previousSelection: 'Old',
        selection: 'New',
      }),
    )
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: expect.objectContaining({ type: 'catalog.publish', productIds: [2, 9] }),
      }),
    )
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: expect.not.objectContaining({ productIds: expect.anything() }),
        scheduledFor: '2099-06-01T00:00:00.000Z',
      }),
    )
  })

  it('suppresses empty targeted invalidations and falls oversized sets back to one full root', async () => {
    const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>(() =>
      Promise.resolve({ operationId: 'operation-1', state: 'queued' as const }),
    )
    const normalized = build({
      name: 'test',
      dispatch,
      getOperation: vi.fn(() => Promise.resolve(null)),
      health: vi.fn(() =>
        Promise.resolve({ checkedAt: '2026-08-29T12:00:00.000Z', status: 'ok' as const }),
      ),
    })
    const resolveProductIds = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce(Array.from({ length: 1_001 }, (_, id) => id + 1))
    const hook = createGmcV2DependencyAfterChangeHook(normalized, {
      collection: 'media',
      resolveProductIds,
      select: ({ doc }) => doc.url,
    })

    await hook({
      doc: { id: 7, url: '/new-a.jpg' },
      operation: 'update',
      previousDoc: { id: 7, url: '/old-a.jpg' },
      req: request,
    } as never)
    expect(dispatch).not.toHaveBeenCalled()

    await hook({
      doc: { id: 7, url: '/new-b.jpg' },
      operation: 'update',
      previousDoc: { id: 7, url: '/old-b.jpg' },
      req: request,
    } as never)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.not.objectContaining({ productIds: expect.anything() }),
      }),
    )
    expect(payloadWarn).toHaveBeenCalledWith(
      expect.stringMatching(/falling back to a full catalog root/i),
    )
  })

  it('owns projection-relevant Payload Global changes without dispatching unchanged state', async () => {
    const dispatch = vi.fn<GmcAsyncAdapter['dispatch']>(() =>
      Promise.resolve({ operationId: 'operation-1', state: 'queued' as const }),
    )
    const normalized = build({
      name: 'test',
      capabilities: { scheduledDelivery: true },
      dispatch,
      getOperation: vi.fn(() => Promise.resolve(null)),
      health: vi.fn(() =>
        Promise.resolve({ checkedAt: '2026-08-29T12:00:00.000Z', status: 'ok' as const }),
      ),
    })
    const hook = createGmcV2GlobalDependencyAfterChangeHook(normalized, {
      global: 'merchantRules',
      scheduleAt: ({ doc }) => [String(doc.nextBoundary)],
      select: ({ doc }) => ({ enabled: doc.enabled, product: doc.product }),
    })

    await hook({
      doc: {
        enabled: true,
        nextBoundary: '2099-06-01T00:00:00.000Z',
        product: 42,
        updatedAt: '2026-08-30T00:00:01.000Z',
      },
      previousDoc: {
        enabled: false,
        nextBoundary: '2099-05-01T00:00:00.000Z',
        product: 42,
        updatedAt: '2026-08-30T00:00:00.000Z',
      },
      req: request,
    } as never)

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: expect.objectContaining({ type: 'catalog.publish', cause: 'update' }),
        subject: 'gmc:123456:catalog',
      }),
    )
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: expect.objectContaining({ type: 'catalog.publish', cause: 'schedule' }),
        scheduledFor: '2099-06-01T00:00:00.000Z',
      }),
    )

    dispatch.mockClear()
    await hook({
      doc: { enabled: true, nextBoundary: '2099-06-01T00:00:00.000Z', product: 42 },
      previousDoc: {
        enabled: true,
        nextBoundary: '2099-06-01T00:00:00.000Z',
        product: 42,
      },
      req: request,
    } as never)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
