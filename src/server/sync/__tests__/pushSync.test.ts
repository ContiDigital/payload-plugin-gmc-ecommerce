import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { NormalizedPluginOptions, ResolvedMCIdentity } from '../../../types/index.js'
import type { WrittenRow } from './helpers/payloadDouble.js'

import { MC_FIELD_GROUP_NAME, MC_PRODUCT_ATTRIBUTES_FIELD_NAME } from '../../../constants.js'
import {
  buildPayloadDouble as buildPayload,
  buildRow,
  writtenMC,
  writtenRow,
} from './helpers/payloadDouble.js'

const prepareProductForSync = vi.fn()
const validateRequiredProductInput = vi.fn()
const resolveIdentity = vi.fn()

vi.mock('../productPreparation.js', () => ({
  prepareProductForSync,
  validateRequiredProductInput,
}))

vi.mock('../identityResolver.js', () => ({
  resolveIdentity,
}))

const { GoogleApiError } = await import('../../services/sub-services/googleApiClient.js')
const { deleteFromMC, deleteFromMCByIdentity, pushProduct, refreshSnapshot } = await import(
  '../pushSync.js'
)
const { STATE_NOT_PERSISTED_WARNING } = await import('../mcStateWriter.js')

const buildOptions = (overrides?: Partial<NormalizedPluginOptions>): NormalizedPluginOptions => ({
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
    mode: 'manual',
    permanentSync: true,
    schedule: {
      apiKey: '',
      cron: '0 4 * * *',
      strategy: 'external',
    },
    scheduleCron: '0 4 * * *',
  },
  ...overrides,
})

const buildIdentity = (): ResolvedMCIdentity => ({
  contentLanguage: 'en',
  dataSourceName: 'accounts/123/dataSources/ds-123',
  feedLabel: 'US',
  merchantProductId: 'en~US~SKU-1',
  offerId: 'SKU-1',
  productInputName: 'accounts/123/productInputs/en~US~SKU-1',
  productName: 'accounts/123/products/en~US~SKU-1',
})


// ---------------------------------------------------------------------------
// Payload double
// ---------------------------------------------------------------------------
//
// Bookkeeping is written through the database adapter, so the double has to
// carry both the collection's field config (the merge is field-aware) and a
// live row for `writeMCState` to merge into.

const successfulInput = (overrides?: Record<string, unknown>) => ({
  contentLanguage: 'en',
  feedLabel: 'US',
  offerId: 'SKU-1',
  productAttributes: {
    availability: 'IN_STOCK',
    imageLink: 'https://example.com/image.jpg',
    link: 'https://example.com/product',
    title: 'Product 1',
    ...(overrides ?? {}),
  },
})

const mockSuccessfulPreparation = (overrides?: Record<string, unknown>) => {
  resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
  prepareProductForSync.mockResolvedValue({
    action: 'insert',
    derivedAttributes: {},
    input: successfulInput(),
    product: { id: 'prod-1' },
    ...(overrides ?? {}),
  })
  validateRequiredProductInput.mockReturnValue([])
}

const workingApiClient = () => ({
  getProduct: vi.fn().mockResolvedValue({ data: { name: 'snapshot-1' } }),
  insertProductInput: vi.fn().mockResolvedValue({}),
})

const passthroughRetry = () => ({ execute: vi.fn((fn: () => Promise<unknown>) => fn()) })

describe('pushSync', () => {
  beforeEach(() => {
    prepareProductForSync.mockReset()
    validateRequiredProductInput.mockReset()
    resolveIdentity.mockReset()
  })

  test('pushProduct persists syncing state, snapshot, and a cleared dirty flag on success', async () => {
    mockSuccessfulPreparation()
    const payload = buildPayload()
    const apiClient = workingApiClient()

    const result = await pushProduct({
      apiClient: apiClient as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(result).toEqual({
      action: 'insert',
      productId: 'prod-1',
      snapshot: { name: 'snapshot-1' },
      statePersisted: true,
      success: true,
    })
    expect(payload.db.updateOne).toHaveBeenCalledTimes(2)
    expect(writtenMC(payload, 0).syncMeta).toMatchObject({
      lastAction: 'saveSync',
      lastError: null,
      state: 'syncing',
      syncSource: 'push',
    })
    expect(writtenMC(payload).syncMeta).toMatchObject({
      dirty: false,
      lastAction: 'saveSync',
      lastError: null,
      lastSyncedAt: expect.any(String),
      state: 'success',
      syncSource: 'push',
    })
    expect(writtenMC(payload).snapshot).toEqual({ name: 'snapshot-1' })
    expect(apiClient.insertProductInput).toHaveBeenCalledWith(
      expect.objectContaining({ offerId: 'SKU-1' }),
      payload,
      undefined,
    )
  })

  test('never writes bookkeeping through the collection API', async () => {
    mockSuccessfulPreparation()
    const payload = buildPayload()

    await pushProduct({
      apiClient: workingApiClient() as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(payload.update).not.toHaveBeenCalled()
  })

  test('leaves the live row publication state, content and unrelated arrays alone', async () => {
    mockSuccessfulPreparation()
    const payload = buildPayload()

    await pushProduct({
      apiClient: workingApiClient() as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    const row = writtenRow(payload)
    expect(row._status).toBe('published')
    expect(row.title).toBe('Live title')
    expect(row.gallery).toEqual([{ id: 'g1', caption: 'first' }])
  })

  test('writes derived attributes alongside the sent ones, merged into the live group', async () => {
    mockSuccessfulPreparation({
      derivedAttributes: {
        description: 'Seeded once',
        productTypes: [{ value: 'Statues > Marble' }],
      },
    })
    const payload = buildPayload()

    await pushProduct({
      apiClient: workingApiClient() as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(writtenMC(payload)[MC_PRODUCT_ATTRIBUTES_FIELD_NAME]).toMatchObject({
      description: 'Seeded once',
      productTypes: [{ id: expect.stringMatching(/^[0-9a-f]{24}$/), value: 'Statues > Marble' }],
      title: 'Product 1',
    })
  })

  test('seeds a blank identity but never overwrites one the document already has', async () => {
    mockSuccessfulPreparation()
    const blank = buildPayload()

    await pushProduct({
      apiClient: workingApiClient() as never,
      options: buildOptions(),
      payload: blank as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(writtenMC(blank).identity).toEqual({
      contentLanguage: 'en',
      feedLabel: 'US',
      offerId: 'SKU-1',
    })

    mockSuccessfulPreparation()
    const ownedRow = buildRow()
    ;(ownedRow[MC_FIELD_GROUP_NAME] as WrittenRow).identity = {
      contentLanguage: 'de',
      feedLabel: 'DE',
      offerId: 'EDITOR-SET',
    }
    const owned = buildPayload({ row: ownedRow })

    await pushProduct({
      apiClient: workingApiClient() as never,
      options: buildOptions(),
      payload: owned as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(writtenMC(owned).identity).toEqual({
      contentLanguage: 'de',
      feedLabel: 'DE',
      offerId: 'EDITOR-SET',
    })
  })

  test('warns instead of reporting a clean success when the state could not be persisted', async () => {
    mockSuccessfulPreparation()
    // The product was deleted while the Merchant Center round-trip was running.
    const payload = buildPayload({ row: null })

    const result = await pushProduct({
      apiClient: workingApiClient() as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(result.success).toBe(true)
    expect(result.warning).toBe(STATE_NOT_PERSISTED_WARNING)
  })

  test('marks the product clean only when its own sync token survived the round-trip', async () => {
    mockSuccessfulPreparation()
    const payload = buildPayload()

    await pushProduct({
      apiClient: workingApiClient() as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    // The row handed to the final write still carries the token this push
    // stamped on it when it set `state: 'syncing'`.
    const token = writtenMC(payload, 0).syncMeta.syncToken as string
    expect(token).toEqual(expect.any(String))
    expect(writtenMC(payload).syncMeta).toMatchObject({ dirty: false, syncToken: null })
  })

  test('leaves the product dirty when an editor saved during the round-trip', async () => {
    mockSuccessfulPreparation()
    const payload = buildPayload()

    // An editor saves while Merchant Center is being updated. `beforeChange`
    // nulls the sync token on every save, which is the signal the push reads.
    const apiClient = workingApiClient()
    apiClient.insertProductInput.mockImplementation(async () => {
      const current = (await payload.db.findOne({
        collection: 'products',
        where: { id: { equals: 'prod-1' } },
      } as never)) as WrittenRow

      await payload.db.updateOne({
        id: 'prod-1',
        collection: 'products',
        data: {
          ...current,
          [MC_FIELD_GROUP_NAME]: {
            ...current[MC_FIELD_GROUP_NAME],
            syncMeta: { ...current[MC_FIELD_GROUP_NAME].syncMeta, dirty: true, syncToken: null },
          },
        },
      } as never)

      return {}
    })

    const result = await pushProduct({
      apiClient: apiClient as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(writtenMC(payload).syncMeta).toMatchObject({ dirty: true })
    expect(result.success).toBe(true)
    expect(result.warning).toMatch(/changed while/i)
  })

  test('does not overwrite a derived attribute the live row has since acquired', async () => {
    mockSuccessfulPreparation({
      derivedAttributes: { description: 'Seeded once', googleProductCategory: 'Resolved' },
    })
    const row = buildRow()
    ;(row[MC_FIELD_GROUP_NAME] as WrittenRow)[MC_PRODUCT_ATTRIBUTES_FIELD_NAME] = {
      description: 'Written by an editor',
      title: 'Live attr title',
    }
    const payload = buildPayload({ row })

    await pushProduct({
      apiClient: workingApiClient() as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    // `description` was not on the document the push read, so the row acquiring
    // it counts as an edit and the derived value is not written over it.
    expect(writtenMC(payload)[MC_PRODUCT_ATTRIBUTES_FIELD_NAME].description).toBe(
      'Written by an editor',
    )
    expect(writtenMC(payload)[MC_PRODUCT_ATTRIBUTES_FIELD_NAME].googleProductCategory).toBe(
      'Resolved',
    )
  })

  test('stamps its sync token before reading the content it is about to send', async () => {
    // A save landing between the read and the stamp would otherwise be sent
    // stale to Merchant Center and then certified clean by the push's own
    // freshly-stamped token.
    const order: string[] = []
    mockSuccessfulPreparation()
    const payload = buildPayload()

    payload.db.updateOne.mockImplementationOnce((write: { data: WrittenRow; id: unknown }) => {
      order.push('stamp')

      return Promise.resolve(write.data)
    })
    payload.findByID.mockImplementation(() => {
      order.push('read')

      return Promise.resolve({ id: 'prod-1' })
    })

    await pushProduct({
      apiClient: workingApiClient() as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(order.slice(0, 2)).toEqual(['stamp', 'read'])
  })

  test('does not overwrite an identity an editor filled in during the round-trip', async () => {
    mockSuccessfulPreparation()
    const payload = buildPayload()

    const apiClient = workingApiClient()
    apiClient.insertProductInput.mockImplementation(async () => {
      const current = (await payload.db.findOne({
        collection: 'products',
        where: { id: { equals: 'prod-1' } },
      } as never)) as WrittenRow

      await payload.db.updateOne({
        id: 'prod-1',
        collection: 'products',
        data: {
          ...current,
          [MC_FIELD_GROUP_NAME]: {
            ...current[MC_FIELD_GROUP_NAME],
            identity: { contentLanguage: 'de', feedLabel: 'DE', offerId: 'EDITOR-SET' },
          },
        },
      } as never)

      return {}
    })

    await pushProduct({
      apiClient: apiClient as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(writtenMC(payload).identity).toEqual({
      contentLanguage: 'de',
      feedLabel: 'DE',
      offerId: 'EDITOR-SET',
    })
  })

  test('flags an unpersisted push structurally, not by matching warning text', async () => {
    mockSuccessfulPreparation()
    const payload = buildPayload({ row: null })

    const result = await pushProduct({
      apiClient: workingApiClient() as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(result.statePersisted).toBe(false)
  })

  test('records what it sent, so later comparisons have something to compare against', async () => {
    // `permanentSync` defaults to false and runtime mappings are never applied
    // by `beforeChange`, so the push write-back is the only thing that puts the
    // sent attributes on the document. `refreshSnapshot` and `pullProduct`
    // compare the remote product against them.
    mockSuccessfulPreparation()
    const payload = buildPayload()

    await pushProduct({
      apiClient: workingApiClient() as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(writtenMC(payload)[MC_PRODUCT_ATTRIBUTES_FIELD_NAME]).toMatchObject({
      availability: 'IN_STOCK',
      imageLink: 'https://example.com/image.jpg',
      link: 'https://example.com/product',
      title: 'Product 1',
    })
  })

  test('does not record what it sent over an attribute edited during the round-trip', async () => {
    mockSuccessfulPreparation()
    const payload = buildPayload({
      doc: {
        id: 'prod-1',
        [MC_FIELD_GROUP_NAME]: {
          [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: { title: 'Title as the push read it' },
        },
      },
    })

    const apiClient = workingApiClient()
    apiClient.insertProductInput.mockImplementation(async () => {
      const current = (await payload.db.findOne({
        collection: 'products',
        where: { id: { equals: 'prod-1' } },
      } as never)) as WrittenRow

      await payload.db.updateOne({
        id: 'prod-1',
        collection: 'products',
        data: {
          ...current,
          [MC_FIELD_GROUP_NAME]: {
            ...current[MC_FIELD_GROUP_NAME],
            [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: { title: 'Edited mid-push' },
          },
        },
      } as never)

      return {}
    })

    await pushProduct({
      apiClient: apiClient as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(writtenMC(payload)[MC_PRODUCT_ATTRIBUTES_FIELD_NAME].title).toBe('Edited mid-push')
  })

  test('records a failed state write without claiming the product was deleted', async () => {
    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    const payload = buildPayload()
    payload.db.updateOne.mockRejectedValue(new Error('database unavailable'))

    const result = await refreshSnapshot({
      apiClient: { getProduct: vi.fn().mockResolvedValue({ data: { name: 'snapshot-7' } }) } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(result.statePersisted).toBe(false)
    expect(result.warning).not.toMatch(/no longer exists/)
  })

  test('records the failure when the product cannot be read after the state was stamped', async () => {
    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    const payload = buildPayload()
    payload.findByID.mockRejectedValue(new Error('relationship hydration failed'))

    const result = await pushProduct({
      apiClient: workingApiClient() as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(result.success).toBe(false)
    // Not left stranded in `syncing` with a token nobody will ever clear.
    expect(writtenMC(payload).syncMeta).toMatchObject({
      lastError: 'relationship hydration failed',
      state: 'error',
    })
  })

  test('pushProduct passes prepared videoLinks string[] through to insertProductInput unchanged', async () => {
    // prepareProductForSync runs the transformers, so its output is already in
    // MC wire shape: videoLinks as string[], not [{ url }].
    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    prepareProductForSync.mockResolvedValue({
      action: 'insert',
      derivedAttributes: {},
      input: successfulInput({
        videoLinks: ['https://example.com/v1.mp4', 'https://www.youtube.com/watch?v=abc'],
      }),
      product: { id: 'prod-1' },
    })
    validateRequiredProductInput.mockReturnValue([])
    const apiClient = workingApiClient()
    const payload = buildPayload()

    await pushProduct({
      apiClient: apiClient as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(apiClient.insertProductInput).toHaveBeenCalledWith(
      expect.objectContaining({
        productAttributes: expect.objectContaining({
          videoLinks: ['https://example.com/v1.mp4', 'https://www.youtube.com/watch?v=abc'],
        }),
      }),
      payload,
      undefined,
    )
  })

  test('pushProduct marks the record as error when validation fails', async () => {
    mockSuccessfulPreparation()
    validateRequiredProductInput.mockReturnValue(['link', 'imageLink', 'availability'])
    const payload = buildPayload()

    const result = await pushProduct({
      apiClient: { getProduct: vi.fn(), insertProductInput: vi.fn() } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: { execute: vi.fn() } as never,
    })

    expect(result).toEqual({ action: 'insert', productId: 'prod-1', success: false })
    expect(writtenMC(payload).syncMeta).toMatchObject({
      lastError: 'Missing required fields: link, imageLink, availability',
      state: 'error',
    })
  })

  test('pushProduct succeeds even when snapshot refresh fails after insert', async () => {
    mockSuccessfulPreparation()
    const payload = buildPayload()
    const apiClient = {
      getProduct: vi.fn().mockRejectedValue(new Error('snapshot unavailable')),
      insertProductInput: vi.fn().mockResolvedValue({}),
    }

    const result = await pushProduct({
      apiClient: apiClient as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(result).toMatchObject({ action: 'insert', productId: 'prod-1', success: true })
    expect(payload.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'snapshot unavailable',
        merchantProductId: buildIdentity().merchantProductId,
        operation: 'push',
        productId: 'prod-1',
      }),
      '[GMC] Failed to fetch snapshot after sync',
    )
    expect(writtenMC(payload).syncMeta).toMatchObject({
      dirty: false,
      lastAction: 'saveSync',
      lastError: null,
      lastSyncedAt: expect.any(String),
      state: 'success',
      syncSource: 'push',
    })
  })

  test('leaves an existing snapshot in place when the refresh fails', async () => {
    mockSuccessfulPreparation()
    const row = buildRow()
    ;(row[MC_FIELD_GROUP_NAME] as Record<string, unknown>).snapshot = { name: 'previous' }
    const payload = buildPayload({ row })

    await pushProduct({
      apiClient: {
        getProduct: vi.fn().mockRejectedValue(new Error('snapshot unavailable')),
        insertProductInput: vi.fn().mockResolvedValue({}),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(writtenMC(payload).snapshot).toEqual({ name: 'previous' })
  })

  test('pushProduct records an error when identity cannot be resolved', async () => {
    resolveIdentity.mockReturnValue({ errors: ['offerId is required'], ok: false })
    const payload = buildPayload()

    const result = await pushProduct({
      apiClient: { getProduct: vi.fn(), insertProductInput: vi.fn() } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: { execute: vi.fn() } as never,
    })

    expect(result).toEqual({ action: 'insert', productId: 'prod-1', success: false })
    expect(prepareProductForSync).not.toHaveBeenCalled()
    expect(writtenMC(payload).syncMeta).toMatchObject({
      lastError: 'offerId is required',
      state: 'error',
    })
  })

  test('pushProduct stores API response details when the insert request fails', async () => {
    mockSuccessfulPreparation()
    const payload = buildPayload()

    const result = await pushProduct({
      apiClient: {
        getProduct: vi.fn(),
        insertProductInput: vi
          .fn()
          .mockRejectedValue(new GoogleApiError('Bad request', 400, { code: 'INVALID_ARGUMENT' })),
      } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(result).toEqual({ action: 'insert', productId: 'prod-1', success: false })
    expect(writtenMC(payload).syncMeta).toMatchObject({
      lastError: 'Bad request',
      state: 'error',
    })
  })

  test('deleteFromMC updates sync metadata after a successful delete', async () => {
    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    const payload = buildPayload()

    const result = await deleteFromMC({
      apiClient: { deleteProductInput: vi.fn().mockResolvedValue({}) } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(result).toEqual({
      action: 'delete',
      productId: 'prod-1',
      statePersisted: true,
      success: true,
    })
    expect(writtenMC(payload)).toMatchObject({
      snapshot: null,
      syncMeta: expect.objectContaining({
        lastError: null,
        lastSyncedAt: expect.any(String),
        state: 'success',
      }),
    })
  })

  test('refreshSnapshot stores the latest Merchant Center snapshot', async () => {
    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    const payload = buildPayload()

    const result = await refreshSnapshot({
      apiClient: { getProduct: vi.fn().mockResolvedValue({ data: { name: 'snapshot-7' } }) } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(result).toEqual({
      action: 'update',
      productId: 'prod-1',
      snapshot: { name: 'snapshot-7' },
      statePersisted: true,
      success: true,
    })
    expect(writtenMC(payload)).toMatchObject({
      snapshot: { name: 'snapshot-7' },
      syncMeta: expect.objectContaining({
        lastAction: 'refresh',
        lastError: null,
        state: 'success',
        syncSource: 'pull',
      }),
    })
  })

  test('refreshSnapshot warns instead of reporting a clean success when nothing was recorded', async () => {
    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    const payload = buildPayload({ row: null })

    const result = await refreshSnapshot({
      apiClient: { getProduct: vi.fn().mockResolvedValue({ data: { name: 'snapshot-7' } }) } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(result.warning).toBe(STATE_NOT_PERSISTED_WARNING)
  })

  test('deleteFromMC warns instead of reporting a clean success when nothing was recorded', async () => {
    resolveIdentity.mockReturnValue({ ok: true, value: buildIdentity() })
    const payload = buildPayload({ row: null })

    const result = await deleteFromMC({
      apiClient: { deleteProductInput: vi.fn().mockResolvedValue({}) } as never,
      options: buildOptions(),
      payload: payload as never,
      productId: 'prod-1',
      retryService: passthroughRetry() as never,
    })

    expect(result.success).toBe(true)
    expect(result.warning).toBe(STATE_NOT_PERSISTED_WARNING)
  })

  test('deleteFromMCByIdentity treats 404 responses as already deleted', async () => {
    const result = await deleteFromMCByIdentity({
      apiClient: {
        deleteProductInput: vi
          .fn()
          .mockRejectedValue(new GoogleApiError('Not found', 404, { error: 'gone' })),
      } as never,
      identity: buildIdentity(),
      options: buildOptions(),
      payload: {} as never,
      productId: 'prod-3',
      retryService: passthroughRetry() as never,
    })

    expect(result).toEqual({ action: 'delete', productId: 'prod-3', success: true })
  })
})
