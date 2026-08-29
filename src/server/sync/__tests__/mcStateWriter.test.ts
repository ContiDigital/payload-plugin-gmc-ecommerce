import { describe, expect, test, vi } from 'vitest'

import {
  collectionHasDrafts,
  hasPendingDraft,
  PENDING_DRAFT_SKIP_MESSAGE,
  UNKNOWN_DRAFT_STATE_SKIP_MESSAGE,
  writeMCState,
} from '../mcStateWriter.js'

const buildLogger = () => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
})

const buildPayload = (args: {
  drafts?: boolean
  findVersions?: unknown
  update?: unknown
}) => ({
  collections: {
    products: {
      config: {
        versions: { drafts: args.drafts ?? false },
      },
    },
  },
  db: args.findVersions === null ? {} : { findVersions: args.findVersions ?? vi.fn() },
  logger: buildLogger(),
  update: args.update ?? vi.fn().mockResolvedValue({}),
})

const versionsResult = (status: unknown) => ({ docs: [{ version: { _status: status } }] })

describe('collectionHasDrafts', () => {
  test('false when the collection does not store drafts', () => {
    expect(collectionHasDrafts(buildPayload({ drafts: false }) as never, 'products')).toBe(false)
  })

  test('true for drafts: true and for drafts as an object', () => {
    expect(collectionHasDrafts(buildPayload({ drafts: true }) as never, 'products')).toBe(true)

    const withAutosave = {
      collections: { products: { config: { versions: { drafts: { autosave: true } } } } },
    }
    expect(collectionHasDrafts(withAutosave as never, 'products')).toBe(true)
  })

  test('false for an unknown collection', () => {
    expect(collectionHasDrafts(buildPayload({ drafts: true }) as never, 'nope')).toBe(false)
  })
})

describe('hasPendingDraft', () => {
  test('false when drafts are disabled — no version query is issued', async () => {
    const findVersions = vi.fn()
    const payload = buildPayload({ drafts: false, findVersions })

    await expect(hasPendingDraft(payload as never, 'products', 'p1')).resolves.toBe(false)
    expect(findVersions).not.toHaveBeenCalled()
  })

  test('true when the latest version is a draft', async () => {
    const findVersions = vi.fn().mockResolvedValue(versionsResult('draft'))
    const payload = buildPayload({ drafts: true, findVersions })

    await expect(hasPendingDraft(payload as never, 'products', 'p1')).resolves.toBe(true)
    expect(findVersions).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'products',
        limit: 1,
        sort: '-updatedAt',
        where: { and: [{ parent: { equals: 'p1' } }, { latest: { equals: true } }] },
      }),
    )
  })

  test('false when the latest version is published', async () => {
    const payload = buildPayload({
      drafts: true,
      findVersions: vi.fn().mockResolvedValue(versionsResult('published')),
    })

    await expect(hasPendingDraft(payload as never, 'products', 'p1')).resolves.toBe(false)
  })

  test('false when drafts are enabled but no version row exists yet', async () => {
    const payload = buildPayload({ drafts: true, findVersions: vi.fn().mockResolvedValue({ docs: [] }) })

    await expect(hasPendingDraft(payload as never, 'products', 'p1')).resolves.toBe(false)
  })

  test('handles a localized _status object', async () => {
    const allPublished = buildPayload({
      drafts: true,
      findVersions: vi.fn().mockResolvedValue(versionsResult({ en: 'published', es: 'published' })),
    })
    await expect(hasPendingDraft(allPublished as never, 'products', 'p1')).resolves.toBe(false)

    const oneDraft = buildPayload({
      drafts: true,
      findVersions: vi.fn().mockResolvedValue(versionsResult({ en: 'published', es: 'draft' })),
    })
    await expect(hasPendingDraft(oneDraft as never, 'products', 'p1')).resolves.toBe(true)
  })

  test('fails safe when the version timeline cannot be read', async () => {
    const payload = buildPayload({ drafts: true, findVersions: null })

    await expect(hasPendingDraft(payload as never, 'products', 'p1')).resolves.toBe(true)
  })
})

describe('writeMCState', () => {
  const data = { mc: { syncMeta: { state: 'success' } } }

  test('refuses to write when a pending draft exists, and warns', async () => {
    const update = vi.fn()
    const payload = buildPayload({
      drafts: true,
      findVersions: vi.fn().mockResolvedValue(versionsResult('draft')),
      update,
    })

    await expect(writeMCState(payload as never, 'products', 'p1', data)).resolves.toBe(false)
    expect(update).not.toHaveBeenCalled()
    expect(payload.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'products', operation: 'writeMCState', productId: 'p1' }),
      `[GMC] ${PENDING_DRAFT_SKIP_MESSAGE}`,
    )
  })

  test('persists with draft:false and never sends _status when there is no pending draft', async () => {
    const update = vi.fn().mockResolvedValue({})
    const payload = buildPayload({
      drafts: true,
      findVersions: vi.fn().mockResolvedValue(versionsResult('published')),
      update,
    })

    await expect(writeMCState(payload as never, 'products', 'p1', data)).resolves.toBe(true)
    expect(update).toHaveBeenCalledTimes(1)

    const call = update.mock.calls[0][0]
    expect(call).toMatchObject({
      id: 'p1',
      collection: 'products',
      context: expect.objectContaining({
        'gmc:skip-sync-hooks': true,
        skipCollectionHooks: true,
      }),
      data,
      depth: 0,
      draft: false,
      overrideAccess: true,
    })
    expect(call.data).not.toHaveProperty('_status')
    expect(call).not.toHaveProperty('_status')
  })

  test('persists on a collection without drafts', async () => {
    const update = vi.fn().mockResolvedValue({})
    const payload = buildPayload({ drafts: false, update })

    await expect(writeMCState(payload as never, 'products', 'p1', data)).resolves.toBe(true)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ draft: false }))
  })

  test('skips (does not throw) when the draft state cannot be determined', async () => {
    const update = vi.fn()
    const payload = buildPayload({
      drafts: true,
      findVersions: vi.fn().mockRejectedValue(new Error('versions table missing')),
      update,
    })

    await expect(writeMCState(payload as never, 'products', 'p1', data)).resolves.toBe(false)
    expect(update).not.toHaveBeenCalled()
    expect(payload.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'versions table missing' }),
      `[GMC] ${UNKNOWN_DRAFT_STATE_SKIP_MESSAGE}`,
    )
  })

  test('swallows a deleted product but rethrows other failures', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    const missing = buildPayload({ drafts: false, update: vi.fn().mockRejectedValue(notFound) })
    await expect(writeMCState(missing as never, 'products', 'p1', data)).resolves.toBe(false)
    expect(missing.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'products' }),
      '[GMC] Skipped MC-state write because product no longer exists',
    )

    const broken = buildPayload({ drafts: false, update: vi.fn().mockRejectedValue(new Error('boom')) })
    await expect(writeMCState(broken as never, 'products', 'p1', data)).rejects.toThrow('boom')
  })
})
