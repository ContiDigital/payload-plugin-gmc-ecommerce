import type { Field } from 'payload'

import { describe, expect, test, vi } from 'vitest'

import { PRODUCT_MISSING_SKIP_MESSAGE, writeMCState } from '../mcStateWriter.js'

const productFields: Field[] = [
  { name: 'title', type: 'text' },
  { name: 'gallery', type: 'array', fields: [{ name: 'caption', type: 'text' }] },
  {
    name: 'mc',
    type: 'group',
    fields: [
      { name: 'enabled', type: 'checkbox' },
      { name: 'snapshot', type: 'json' },
      {
        name: 'attrs',
        type: 'group',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'productTypes', type: 'array', fields: [{ name: 'value', type: 'text' }] },
        ],
      },
      {
        name: 'syncMeta',
        type: 'group',
        fields: [
          { name: 'state', type: 'text' },
          { name: 'dirty', type: 'checkbox' },
          { name: 'lastError', type: 'text' },
        ],
      },
    ],
  },
]

const liveRow = () => ({
  id: 'p1',
  _status: 'published',
  gallery: [{ id: 'g1', caption: 'first' }],
  mc: {
    attrs: { productTypes: [{ id: 't1', value: 'Statues' }], title: 'Synced' },
    enabled: true,
    snapshot: { name: 'accounts/1/products/en~PRODUCTS~SKU-1' },
    syncMeta: { dirty: true, lastError: 'boom', state: 'syncing' },
  },
  title: 'Live title',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const buildPayload = (
  args: { beginTransaction?: unknown; findOne?: unknown; updateOne?: unknown } = {},
) => ({
  collections: { products: { config: { fields: productFields } } },
  db: {
    beginTransaction: args.beginTransaction ?? vi.fn().mockResolvedValue('txn-1'),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    findOne: args.findOne ?? vi.fn().mockResolvedValue(liveRow()),
    rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    updateOne: args.updateOne ?? vi.fn().mockResolvedValue(liveRow()),
  },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  update: vi.fn(),
})

const patch = { mc: { syncMeta: { dirty: false, lastError: null, state: 'success' } } }

describe('writeMCState', () => {
  test('writes the merged row through the adapter and never through payload.update', async () => {
    const payload = buildPayload()

    await expect(writeMCState(payload as never, 'products', 'p1', patch)).resolves.toBe(true)

    expect(payload.update).not.toHaveBeenCalled()
    expect(payload.db.updateOne).toHaveBeenCalledTimes(1)

    const call = (payload.db.updateOne as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call).toMatchObject({ id: 'p1', collection: 'products' })
    expect(call.data.mc.syncMeta).toEqual({
      dirty: false,
      lastError: null,
      state: 'success',
    })
  })

  test('leaves publication state, timestamps and unrelated content exactly as the row had them', async () => {
    const payload = buildPayload()

    await writeMCState(payload as never, 'products', 'p1', patch)

    const { data } = (payload.db.updateOne as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(data._status).toBe('published')
    expect(data.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(data.title).toBe('Live title')
    expect(data.gallery).toEqual([{ id: 'g1', caption: 'first' }])
  })

  test('preserves mc fields the patch does not mention', async () => {
    const payload = buildPayload()

    await writeMCState(payload as never, 'products', 'p1', patch)

    const { data } = (payload.db.updateOne as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(data.mc.enabled).toBe(true)
    expect(data.mc.attrs).toEqual({ productTypes: [{ id: 't1', value: 'Statues' }], title: 'Synced' })
    expect(data.mc.snapshot).toEqual({ name: 'accounts/1/products/en~PRODUCTS~SKU-1' })
  })

  test('reads the row immediately before writing so the merge cannot use stale content', async () => {
    const calls: string[] = []
    const payload = buildPayload({
      findOne: vi.fn().mockImplementation(() => {
        calls.push('read')
        return Promise.resolve(liveRow())
      }),
      updateOne: vi.fn().mockImplementation(() => {
        calls.push('write')
        return Promise.resolve(null)
      }),
    })

    await writeMCState(payload as never, 'products', 'p1', patch)

    expect(calls).toEqual(['read', 'write'])
    expect(payload.db.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'products',
        where: { id: { equals: 'p1' } },
      }),
    )
  })

  test('gives new array rows an id so the adapter can insert them', async () => {
    const payload = buildPayload()

    await writeMCState(payload as never, 'products', 'p1', {
      mc: { attrs: { productTypes: [{ value: 'Statues > Marble' }] } },
    })

    const { data } = (payload.db.updateOne as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(data.mc.attrs.productTypes).toEqual([
      { id: expect.stringMatching(/^[0-9a-f]{24}$/), value: 'Statues > Marble' },
    ])
  })

  test('replaces the snapshot wholesale instead of fusing it with the previous one', async () => {
    const payload = buildPayload()

    await writeMCState(payload as never, 'products', 'p1', {
      mc: { snapshot: { offerId: 'SKU-1' } },
    })

    const { data } = (payload.db.updateOne as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(data.mc.snapshot).toEqual({ offerId: 'SKU-1' })
  })

  test('reports a skipped write when the product no longer exists', async () => {
    const payload = buildPayload({ findOne: vi.fn().mockResolvedValue(null) })

    await expect(writeMCState(payload as never, 'products', 'p1', patch)).resolves.toBe(false)
    expect(payload.db.updateOne).not.toHaveBeenCalled()
    expect(payload.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'products', productId: 'p1' }),
      `[GMC] ${PRODUCT_MISSING_SKIP_MESSAGE}`,
    )
  })

  test('rethrows adapter failures rather than reporting a successful write', async () => {
    const payload = buildPayload({
      updateOne: vi.fn().mockRejectedValue(new Error('constraint violation')),
    })

    await expect(writeMCState(payload as never, 'products', 'p1', patch)).rejects.toThrow(
      'constraint violation',
    )
  })

  test('reads and writes inside one transaction, then commits', async () => {
    const payload = buildPayload()

    await writeMCState(payload as never, 'products', 'p1', patch)

    expect(payload.db.beginTransaction).toHaveBeenCalled()
    expect(payload.db.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ req: { transactionID: 'txn-1' } }),
    )
    expect(payload.db.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ req: { transactionID: 'txn-1' } }),
    )
    expect(payload.db.commitTransaction).toHaveBeenCalledWith('txn-1')
    expect(payload.db.rollbackTransaction).not.toHaveBeenCalled()
  })

  test('rolls the transaction back when the write fails', async () => {
    const payload = buildPayload({
      updateOne: vi.fn().mockRejectedValue(new Error('constraint violation')),
    })

    await expect(writeMCState(payload as never, 'products', 'p1', patch)).rejects.toThrow(
      'constraint violation',
    )
    expect(payload.db.rollbackTransaction).toHaveBeenCalledWith('txn-1')
    expect(payload.db.commitTransaction).not.toHaveBeenCalled()
  })

  test('still writes on a host that has transactions turned off', async () => {
    const payload = buildPayload({ beginTransaction: vi.fn().mockResolvedValue(null) })

    await expect(writeMCState(payload as never, 'products', 'p1', patch)).resolves.toBe(true)

    expect(payload.db.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ req: undefined }),
    )
    expect(payload.db.commitTransaction).not.toHaveBeenCalled()
    expect(payload.db.rollbackTransaction).not.toHaveBeenCalled()
  })

  test('builds the patch from the freshly-read row when given a factory', async () => {
    const payload = buildPayload()

    await writeMCState(payload as never, 'products', 'p1', (row) => {
      const current = (row.mc as { syncMeta: { state: string } }).syncMeta.state

      return { mc: { syncMeta: { state: current === 'syncing' ? 'success' : 'conflict' } } }
    })

    const { data } = (payload.db.updateOne as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(data.mc.syncMeta.state).toBe('success')
  })

  test('reports a skipped write when the adapter matched no row', async () => {
    // Mongo's `updateOne` matches nothing and reports no error when the product
    // was deleted between the read and the write. Returning `true` there would
    // be the exact false success this module exists to prevent.
    const payload = buildPayload({ updateOne: vi.fn().mockResolvedValue(null) })

    await expect(writeMCState(payload as never, 'products', 'p1', patch)).resolves.toBe(false)
    expect(payload.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'p1' }),
      `[GMC] ${PRODUCT_MISSING_SKIP_MESSAGE}`,
    )
  })

  test('throws when the collection is not registered rather than silently skipping', async () => {
    const payload = { ...buildPayload(), collections: {} }

    await expect(writeMCState(payload as never, 'products', 'p1', patch)).rejects.toThrow(
      /products/,
    )
  })
})
