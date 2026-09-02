import type { Payload, Where } from 'payload'

import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  GmcAsyncAdapter,
  GmcCommand,
  GmcCommandExecutionContext,
  GmcFeedConfig,
  GmcLocalInventoryPublicationState,
  GmcLocalInventoryPublicationStateStore,
  GmcMerchantTransport,
  GmcPublicationState,
  GmcPublicationStateStore,
  GmcV2LocalInventoryProjection,
  PayloadGmcEcommerceV2Options,
} from '../types.js'

import { GoogleApiError } from '../../server/services/sub-services/googleApiClient.js'
import {
  createOfferDeleteCommand,
  createOfferPublishCommand,
  createProductPublishCommand,
} from '../commands.js'
import { normalizeGmcV2Options } from '../config.js'
import { createGmcCommandExecutor } from '../executor.js'

const oldIdentity = { contentLanguage: 'en', feedLabel: 'US', offerId: 'old-sku' }
const newIdentity = { contentLanguage: 'en', feedLabel: 'US', offerId: 'new-sku' } as const
const newInput = {
  ...newIdentity,
  productAttributes: {
    availability: 'IN_STOCK',
    description: 'Description',
    imageLink: 'https://example.com/image.jpg',
    link: 'https://example.com/new-sku',
    price: { amountMicros: '1000000', currencyCode: 'USD' },
    title: 'Product',
  },
} as const

const state = (overrides: Partial<GmcPublicationState> = {}): GmcPublicationState => ({
  identity: oldIdentity,
  operationId: 'previous-operation',
  productId: 'product-1',
  status: 'published',
  updatedAt: '2026-08-29T12:00:00.000Z',
  ...overrides,
})

const localState = (
  overrides: Partial<GmcLocalInventoryPublicationState> = {},
): GmcLocalInventoryPublicationState => ({
  desiredAt: '2026-08-29T12:00:00.000Z',
  desiredDigest: 'a'.repeat(64),
  desiredVersion: '100',
  identity: newIdentity,
  operationId: 'inventory-operation',
  productId: 'product-1',
  status: 'publish-pending',
  storeCode: 'store-1',
  updatedAt: '2026-08-29T12:00:00.000Z',
  ...overrides,
})

const stateStore = (): GmcPublicationStateStore => ({
  claimPublication: vi.fn(() =>
    Promise.resolve(
      state({
        desiredDigest: 'different-until-claimed',
        desiredVersion: '100',
        identity: newIdentity,
        operationId: 'operation-1',
        status: 'publish-pending',
      }),
    ),
  ),
  get: vi.fn(() => Promise.resolve(null)),
  listByProduct: vi.fn(() => Promise.resolve([])),
  markDeleted: vi.fn(({ identity, operationId, productId }) =>
    Promise.resolve(
      state({
        identity,
        operationId,
        productId,
        status: 'deleted',
      }),
    ),
  ),
  markDeletePending: vi.fn(({ identity, operationId, productId }) =>
    Promise.resolve(
      state({
        identity,
        operationId,
        productId,
        status: 'delete-pending',
      }),
    ),
  ),
  markFailed: vi.fn(() => Promise.resolve()),
  markObserved: vi.fn(() => Promise.resolve()),
  markPublished: vi.fn((claim) =>
    Promise.resolve(
      state({
        desiredDigest: claim.desiredDigest,
        desiredVersion: claim.desiredVersion,
        identity: claim.identity,
        operationId: claim.operationId,
        productId: claim.productId,
        publishedAt: claim.publishedAt,
        publishedDigest: claim.desiredDigest,
        publishedVersion: claim.desiredVersion,
        status: 'published',
      }),
    ),
  ),
})

const localInventoryStateStore = (): GmcLocalInventoryPublicationStateStore => {
  let current: GmcLocalInventoryPublicationState | null = null
  const claim: GmcLocalInventoryPublicationStateStore['claim'] = vi.fn((value) => {
    if (current && BigInt(current.desiredVersion) > BigInt(value.desiredVersion)) {
      return Promise.resolve(current)
    }
    current = {
      desiredAt: value.desiredAt,
      desiredDigest: value.desiredDigest,
      desiredVersion: value.desiredVersion,
      identity: value.identity,
      operationId: value.operationId,
      productId: value.productId,
      status: 'publish-pending',
      storeCode: value.storeCode,
      updatedAt: value.desiredAt,
    }
    return Promise.resolve(current)
  })
  const store: GmcLocalInventoryPublicationStateStore = {
    claim,
    get: vi.fn(() => Promise.resolve(current)),
    markFailed: vi.fn(({ error, operationId }) => {
      const retained = current
      if (retained && retained.operationId === operationId) {
        current = { ...retained, error, status: 'failed' }
      }
      return Promise.resolve()
    }),
    markPublished: vi.fn((value) => {
      const retained = current
      if (retained && retained.operationId === value.operationId) {
        current = {
          ...retained,
          publishedAt: value.publishedAt,
          publishedDigest: value.desiredDigest,
          publishedVersion: value.desiredVersion,
          status: 'published',
        }
      }
      if (!current) {
        throw new Error('missing local-inventory test state')
      }
      return Promise.resolve(current)
    }),
  }
  return store
}

const transport = (): GmcMerchantTransport => ({
  deleteLocalInventory: vi.fn(() => Promise.resolve()),
  deleteProductInput: vi.fn(() => Promise.resolve()),
  getApiPrimaryDataSource: vi.fn(({ dataSourceName }) =>
    Promise.resolve({ name: dataSourceName, input: 'API' as const }),
  ),
  getProcessedProduct: vi.fn(() => Promise.resolve(null)),
  insertLocalInventory: vi.fn(() => Promise.resolve()),
  insertProductInput: vi.fn(() => Promise.resolve()),
  listProcessedProducts: vi.fn(() => Promise.resolve({ products: [] })),
})

const build = (args?: {
  additionalDataSourceIds?: string[]
  batchSize?: number
  feed?: GmcFeedConfig
  find?: Payload['find']
  findByID?: Payload['findByID']
  localInventory?: boolean
  maxCatalogPages?: number
  maxRemoteReconcilePages?: number
  rateLimit?: PayloadGmcEcommerceV2Options['rateLimit']
  reconciliation?: PayloadGmcEcommerceV2Options['reconciliation']
  retiredStoreCodes?: string[]
  storeCodes?: string[]
  where?: Where
}) => {
  let operation = 0
  const asyncAdapter: GmcAsyncAdapter = {
    name: 'durable-test-adapter',
    dispatch: vi.fn(() =>
      Promise.resolve({
        operationId: `child-${++operation}`,
        state: 'queued' as const,
      }),
    ),
    getOperation: vi.fn(() => Promise.resolve(null)),
    health: vi.fn(() =>
      Promise.resolve({
        checkedAt: '2026-08-29T12:00:00.000Z',
        status: 'ok' as const,
      }),
    ),
  }
  const localInventoryProject = vi.fn(
    ({ storeCode }: { storeCode: string }): GmcV2LocalInventoryProjection[] =>
      storeCode === 'store-1'
        ? [
            {
              identity: newIdentity,
              inventory: {
                localInventoryAttributes: { availability: 'IN_STOCK' as const, quantity: '2' },
                storeCode: 'store-1',
              },
              storeCode: 'store-1',
            },
          ]
        : [],
  )
  const productProject = vi.fn(() => ({ products: [newInput], sourceVersion: '100' }))
  const pluginOptions: PayloadGmcEcommerceV2Options = {
    access: () => true,
    additionalDataSourceIds: args?.additionalDataSourceIds,
    async: asyncAdapter,
    dataSourceId: '987654321',
    feeds: [
      args?.feed ?? {
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
    localInventory: args?.localInventory
      ? {
          project: localInventoryProject,
          retiredStoreCodes: args?.retiredStoreCodes,
          storeCodes: args?.storeCodes ?? ['store-1', 'store-2'],
        }
      : undefined,
    merchantId: '123456',
    productIngestion: { mode: 'api-primary' },
    products: {
      batchSize: args?.batchSize,
      collection: 'products',
      maxCatalogPages: args?.maxCatalogPages,
      maxRemoteReconcilePages: args?.maxRemoteReconcilePages,
      project: productProject,
      resolveIdentities: () => [newInput],
      where: args?.where,
    },
    rateLimit: args?.rateLimit,
    reconciliation: args?.reconciliation,
    workerAccess: () => true,
  }
  const payload = {
    find: args?.find ?? vi.fn(),
    findByID: args?.findByID ?? vi.fn(() => Promise.resolve({ id: 'product-1' })),
  } as unknown as Payload
  const store = stateStore()
  const localStore = localInventoryStateStore()
  const merchantTransport = transport()
  const rawExecute = createGmcCommandExecutor(normalizeGmcV2Options(pluginOptions), {
    localInventoryStateStore: localStore,
    stateStore: store,
    transport: merchantTransport,
  })
  const execute = (
    context: { sourceVersion?: string } & Omit<GmcCommandExecutionContext, 'sourceVersion'>,
  ) => rawExecute({ ...context, sourceVersion: context.sourceVersion ?? '100' })
  return {
    asyncAdapter,
    execute,
    localInventoryProject,
    localInventoryStateStore: localStore,
    payload,
    productProject,
    rawExecute,
    stateStore: store,
    transport: merchantTransport,
  }
}

describe('GMC v2 command executor', () => {
  beforeEach(() => vi.clearAllMocks())

  it('validates every configured API-primary source and canonical feed scope without writes', async () => {
    const test = build({ additionalDataSourceIds: ['222222222'] })
    vi.mocked(test.transport.getApiPrimaryDataSource).mockImplementation(({ dataSourceName }) =>
      Promise.resolve({
        name: dataSourceName,
        contentLanguage: dataSourceName.endsWith('/987654321') ? 'en' : 'fr',
        feedLabel: dataSourceName.endsWith('/987654321') ? 'US' : 'FR',
        input: 'API',
      }),
    )
    const command = {
      type: 'dataSources.validate',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    } as const

    const result = await test.execute({
      command,
      operationId: 'source-preflight',
      payload: test.payload,
    })

    expect(result).toMatchObject({
      commandType: 'dataSources.validate',
      operationId: 'source-preflight',
      outcome: 'completed',
      remoteCount: 2,
    })
    expect(test.transport.getApiPrimaryDataSource).toHaveBeenCalledTimes(2)
    expect(test.transport.getApiPrimaryDataSource).toHaveBeenCalledWith(
      expect.objectContaining({ dataSourceName: 'accounts/123456/dataSources/222222222' }),
    )
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
    expect(test.transport.deleteProductInput).not.toHaveBeenCalled()
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })

  it('fails the deployment preflight when a canonical feed is outside its source scope', async () => {
    const test = build()
    vi.mocked(test.transport.getApiPrimaryDataSource).mockResolvedValueOnce({
      name: 'accounts/123456/dataSources/987654321',
      contentLanguage: 'en',
      feedLabel: 'GB',
      input: 'API',
    })

    await expect(
      test.execute({
        command: {
          type: 'dataSources.validate',
          requestedAt: '2026-08-29T12:00:00.000Z',
          schemaVersion: 2,
        },
        operationId: 'source-preflight-wrong-scope',
        payload: test.payload,
      }),
    ).rejects.toMatchObject({ code: 'GMC_API_PRIMARY_DATA_SOURCE_REQUIRED' })
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
    expect(test.transport.deleteProductInput).not.toHaveBeenCalled()
  })

  it('fails every product-plane action for overlapping or unrestricted multi-source routing', async () => {
    const test = build({ additionalDataSourceIds: ['222222222'] })
    const command = createOfferPublishCommand({
      input: newInput,
      productId: 'product-1',
      sourceVersion: '100',
    })

    await expect(
      test.execute({ command, operationId: 'overlapping-source-topology', payload: test.payload }),
    ).rejects.toMatchObject({ code: 'GMC_API_PRIMARY_DATA_SOURCE_REQUIRED' })

    expect(test.transport.getApiPrimaryDataSource).toHaveBeenCalledTimes(2)
    expect(test.transport.getProcessedProduct).not.toHaveBeenCalled()
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
  })

  it('turns product reconciliation into identity-ordered durable offer commands', async () => {
    const test = build()
    vi.mocked(test.stateStore.listByProduct).mockResolvedValueOnce([state()])
    const command = createProductPublishCommand({
      cause: 'update',
      previousIdentities: [oldIdentity],
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
    })

    const result = await test.execute({
      command,
      operationId: 'operation-1',
      payload: test.payload,
    })
    const dispatched = vi.mocked(test.asyncAdapter.dispatch).mock.calls.map(([request]) => request)

    expect(result.productCount).toBe(1)
    expect(dispatched.map(({ command: child }) => child.type)).toEqual([
      'offer.delete',
      'offer.publish',
    ])
    expect(dispatched.map(({ subject }) => subject)).toEqual([
      expect.stringMatching(/^gmc:123456:offer:/),
      expect.stringMatching(/^gmc:123456:offer:/),
    ])
    expect(dispatched[0].subject).not.toBe(dispatched[1].subject)
    expect(dispatched[0].command).toMatchObject({ sourceVersion: '100' })
    expect(dispatched.every(({ idempotencyKey }) => idempotencyKey.startsWith('gmc-v2:'))).toBe(
      true,
    )
    expect(dispatched.every(({ parentOperationId }) => parentOperationId === 'operation-1')).toBe(
      true,
    )
    expect(dispatched.every(({ rootOperationId }) => rootOperationId === 'operation-1')).toBe(true)
    expect(test.payload.findByID).toHaveBeenCalledWith(expect.objectContaining({ draft: false }))
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
  })

  it('treats the configured source query as an eligibility boundary for single-product hooks', async () => {
    const find = vi.fn(() => Promise.resolve({ docs: [] })) as unknown as Payload['find']
    const test = build({ find, where: { enabledForGoogle: { equals: true } } })
    vi.mocked(test.stateStore.listByProduct).mockResolvedValueOnce([state()])
    const command = createProductPublishCommand({
      cause: 'update',
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
    })

    const result = await test.execute({
      command,
      operationId: 'operation-1',
      payload: test.payload,
    })
    const children = vi
      .mocked(test.asyncAdapter.dispatch)
      .mock.calls.map(([request]) => request.command)

    expect(result.productCount).toBe(0)
    expect(children).toEqual([expect.objectContaining({ type: 'offer.delete' })])
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: false,
        where: { and: [{ enabledForGoogle: { equals: true } }, { id: { equals: 'product-1' } }] },
      }),
    )
  })

  it('treats an explicit non-published Payload status as absent before projection', async () => {
    const test = build({
      findByID: vi.fn(() =>
        Promise.resolve({ id: 'product-1', _status: 'draft' }),
      ) as unknown as Payload['findByID'],
    })
    vi.mocked(test.stateStore.listByProduct).mockResolvedValueOnce([state()])
    const command = createProductPublishCommand({
      cause: 'unpublish',
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
    })

    const result = await test.execute({
      command,
      operationId: 'operation-1',
      payload: test.payload,
    })

    expect(result).toMatchObject({ outcome: 'completed', productCount: 0 })
    expect(test.productProject).not.toHaveBeenCalled()
    expect(
      vi.mocked(test.asyncAdapter.dispatch).mock.calls.map(([request]) => request.command),
    ).toEqual([expect.objectContaining({ type: 'offer.delete' })])
  })

  it('submits a complete offer with its monotonic Google version and records success', async () => {
    const test = build()
    const command = createOfferPublishCommand({
      input: newInput,
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      sourceVersion: '100',
    })

    await test.execute({ command, operationId: 'operation-1', payload: test.payload })

    expect(test.transport.insertProductInput).toHaveBeenCalledWith(
      expect.objectContaining({
        dataSourceName: 'accounts/123456/dataSources/987654321',
        input: expect.objectContaining({ offerId: 'new-sku', versionNumber: '100' }),
      }),
    )
    expect(test.stateStore.markPublished).toHaveBeenCalledOnce()
    expect(test.stateStore.claimPublication).toHaveBeenCalledWith(
      expect.objectContaining({ desiredAt: command.requestedAt }),
    )
    expect(test.transport.getApiPrimaryDataSource).toHaveBeenCalledOnce()
  })

  it('fails closed before publication when the configured source rejects the offer scope', async () => {
    const test = build()
    vi.mocked(test.transport.getApiPrimaryDataSource).mockResolvedValueOnce({
      name: 'accounts/123456/dataSources/987654321',
      contentLanguage: 'en',
      feedLabel: 'GB',
      input: 'API',
    })
    const command = createOfferPublishCommand({
      input: newInput,
      productId: 'product-1',
      sourceVersion: '100',
    })

    await expect(
      test.execute({ command, operationId: 'wrong-source-scope', payload: test.payload }),
    ).rejects.toMatchObject({ code: 'GMC_API_PRIMARY_DATA_SOURCE_REQUIRED' })
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
    expect(test.stateStore.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'GMC_API_PRIMARY_DATA_SOURCE_REQUIRED',
          retryable: false,
        }),
      }),
    )
  })

  it('uses a durable execution sequence instead of a colliding projector version', async () => {
    const test = build()
    const command = createProductPublishCommand({
      cause: 'manual',
      productId: 'product-1',
    })

    await test.execute({
      command,
      operationId: 'operation-sequenced',
      payload: test.payload,
      sourceVersion: '2000000000000001',
    })

    expect(test.asyncAdapter.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: 'offer.publish',
          sourceVersion: '2000000000000001',
        }),
      }),
    )
  })

  it('rejects an invalid durable execution sequence before doing work', async () => {
    const test = build()
    const command = createProductPublishCommand({
      cause: 'manual',
      productId: 'product-1',
    })

    await expect(
      test.execute({
        command,
        operationId: 'operation-invalid-sequence',
        payload: test.payload,
        sourceVersion: '9223372036854775808',
      }),
    ).rejects.toThrow(/execution sourceVersion/i)
    expect(test.payload.findByID).not.toHaveBeenCalled()
  })

  it('defaults a missing durable execution sequence to 0 instead of rejecting', async () => {
    const test = build()
    const command = createProductPublishCommand({
      cause: 'manual',
      productId: 'product-1',
    })

    const result = await test.rawExecute({
      command,
      operationId: 'operation-missing-sequence',
      payload: test.payload,
    } as never)
    expect(result.outcome).toBe('completed')
    expect(test.payload.findByID).toHaveBeenCalled()
  })

  it('skips a redelivery whose exact digest and source version are already published', async () => {
    const test = build()
    const command = createOfferPublishCommand({
      input: newInput,
      productId: 'product-1',
      sourceVersion: '100',
    })
    // The real digest is computed by execution, so mirror its claim argument.
    vi.mocked(test.stateStore.claimPublication).mockImplementationOnce((claim) =>
      Promise.resolve(
        state({
          desiredDigest: claim.desiredDigest,
          desiredVersion: claim.desiredVersion,
          identity: claim.identity,
          publishedDigest: claim.desiredDigest,
          publishedVersion: claim.desiredVersion,
          status: 'published',
        }),
      ),
    )
    const result = await test.execute({
      command,
      operationId: 'operation-2',
      payload: test.payload,
    })

    expect(result.outcome).toBe('skipped')
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
  })

  it('never resurrects an offer at or below a retained deletion fence', async () => {
    const test = build()
    const command = createOfferPublishCommand({
      input: newInput,
      productId: 'product-1',
      sourceVersion: '100',
    })
    vi.mocked(test.stateStore.claimPublication).mockResolvedValueOnce(
      state({
        deleteVersion: '100',
        desiredDigest: undefined,
        desiredVersion: undefined,
        identity: newIdentity,
        status: 'deleted',
      }),
    )

    const result = await test.execute({
      command,
      operationId: 'stale-publish',
      payload: test.payload,
    })

    expect(result.outcome).toBe('skipped')
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
  })

  it('fails closed when a custom state store returns an unbounded active identity set', async () => {
    const test = build()
    vi.mocked(test.stateStore.listByProduct).mockResolvedValueOnce(
      Array.from({ length: 1_001 }, (_, index) =>
        state({
          identity: { ...oldIdentity, offerId: `historical-${index}` },
          status: 'published',
        }),
      ),
    )
    const command = createProductPublishCommand({ cause: 'update', productId: 'product-1' })

    await expect(
      test.execute({ command, operationId: 'unbounded-states', payload: test.payload }),
    ).rejects.toThrow(/exceeds 1000 active publication identities/i)
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })

  it('records retryable transport failures without swallowing the worker failure', async () => {
    const test = build()
    vi.mocked(test.transport.insertProductInput).mockRejectedValueOnce(
      new Error('network unavailable'),
    )
    const command = createOfferPublishCommand({
      input: newInput,
      productId: 'product-1',
      sourceVersion: '100',
    })

    await expect(
      test.execute({
        command,
        operationId: 'operation-1',
        payload: test.payload,
      }),
    ).rejects.toThrow('network unavailable')
    expect(test.stateStore.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ retryable: true }),
      }),
    )
  })

  it('reserves distributed quota independently for every physical retry attempt', async () => {
    const claimSlot = vi.fn(() =>
      Promise.resolve({
        allowed: true,
        count: 1,
        resetAt: Date.now() + 60_000,
      }),
    )
    const test = build({
      rateLimit: {
        baseRetryDelayMs: 1,
        jitterFactor: 0,
        maxRetries: 1,
        maxRetryDelayMs: 1,
        store: { claimSlot },
      },
    })
    vi.mocked(test.transport.insertProductInput)
      .mockRejectedValueOnce(new GoogleApiError('temporary', 503))
      .mockResolvedValueOnce()
    const command = createOfferPublishCommand({
      input: newInput,
      productId: 'product-1',
      sourceVersion: '100',
    })

    await expect(
      test.execute({
        command,
        operationId: 'operation-retry-limiter',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ outcome: 'completed' })

    expect(test.transport.insertProductInput).toHaveBeenCalledTimes(2)
    // One control-plane source verification, one ownership read, and one slot
    // per physical write attempt.
    expect(claimSlot).toHaveBeenCalledTimes(4)
  })

  it('reserves a second quota slot for one rejected-token refresh and stops after a second 401', async () => {
    const claimSlot = vi.fn(() =>
      Promise.resolve({
        allowed: true,
        count: 1,
        resetAt: Date.now() + 60_000,
      }),
    )
    const test = build({
      rateLimit: {
        baseRetryDelayMs: 1,
        jitterFactor: 0,
        maxRetries: 0,
        maxRetryDelayMs: 1,
        store: { claimSlot },
      },
    })
    vi.mocked(test.transport.insertProductInput)
      .mockRejectedValueOnce(new GoogleApiError('expired token', 401))
      .mockResolvedValueOnce()
    const command = createOfferPublishCommand({
      input: newInput,
      productId: 'product-1',
      sourceVersion: '100',
    })

    await expect(
      test.execute({ command, operationId: 'operation-auth-refresh', payload: test.payload }),
    ).resolves.toMatchObject({ outcome: 'completed' })
    expect(test.transport.insertProductInput).toHaveBeenCalledTimes(2)
    expect(claimSlot).toHaveBeenCalledTimes(4)

    vi.mocked(test.transport.insertProductInput).mockReset()
    claimSlot.mockClear()
    vi.mocked(test.transport.insertProductInput).mockRejectedValue(
      new GoogleApiError('invalid credentials', 401),
    )
    await expect(
      test.execute({ command, operationId: 'operation-auth-failed', payload: test.payload }),
    ).rejects.toMatchObject({ statusCode: 401 })
    expect(test.transport.insertProductInput).toHaveBeenCalledTimes(2)
    expect(claimSlot).toHaveBeenCalledTimes(3)
  })

  it('does not delete an identity which the state store says belongs to another product', async () => {
    const test = build()
    vi.mocked(test.stateStore.markDeletePending).mockResolvedValueOnce(null)
    const command = createOfferDeleteCommand({
      expectedProductId: 'stale-product',
      identity: oldIdentity,
    })
    const result = await test.execute({
      command,
      operationId: 'operation-1',
      payload: test.payload,
    })

    expect(result.outcome).toBe('skipped')
    expect(test.transport.deleteProductInput).not.toHaveBeenCalled()
  })

  it('uses the durable operation version as the fence for a direct offer delete', async () => {
    const test = build()
    const command = createOfferDeleteCommand({ identity: oldIdentity })

    await test.execute({
      command,
      operationId: 'direct-delete',
      payload: test.payload,
      sourceVersion: '900',
    })

    expect(test.stateStore.markDeletePending).toHaveBeenCalledWith(
      expect.objectContaining({ deleteVersion: '900' }),
    )
  })

  it('fans a catalog page out durably and queues a bounded continuation', async () => {
    const find = vi.fn(() =>
      Promise.resolve({ docs: [{ id: 1 }, { id: 2 }] }),
    ) as unknown as Payload['find']
    const test = build({ batchSize: 2, find })
    const command: Extract<GmcCommand, { type: 'catalog.publish' }> = {
      type: 'catalog.publish',
      cause: 'manual',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    const result = await test.execute({
      command,
      operationId: 'catalog-page-2',
      payload: test.payload,
      rootOperationId: 'catalog-root',
    })
    const requests = vi.mocked(test.asyncAdapter.dispatch).mock.calls.map(([request]) => request)

    expect(result.productCount).toBe(2)
    expect(requests.map(({ command: child }) => child.type)).toEqual([
      'product.publish',
      'product.publish',
      'catalog.publish',
    ])
    expect(requests.every(({ parentOperationId }) => parentOperationId === 'catalog-page-2')).toBe(
      true,
    )
    expect(requests.every(({ rootOperationId }) => rootOperationId === 'catalog-root')).toBe(true)
  })

  it('pages only a targeted dependency set and preserves it on the continuation', async () => {
    const find = vi.fn(() =>
      Promise.resolve({ docs: [{ id: 2 }, { id: 7 }] }),
    ) as unknown as Payload['find']
    const test = build({ batchSize: 2, find })
    const command: Extract<GmcCommand, { type: 'catalog.publish' }> = {
      type: 'catalog.publish',
      cause: 'update',
      productIds: [2, 7, 11],
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    await test.execute({
      command,
      operationId: 'targeted-root',
      payload: test.payload,
      sourceVersion: '501',
    })

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [2, 7, 11] } } }),
    )
    const requests = vi.mocked(test.asyncAdapter.dispatch).mock.calls.map(([request]) => request)
    expect(requests.slice(0, 2).map(({ command: child }) => child)).toEqual([
      expect.objectContaining({ type: 'product.publish', productId: 2 }),
      expect.objectContaining({ type: 'product.publish', productId: 7 }),
    ])
    expect(requests[2]).toMatchObject({
      command: {
        type: 'catalog.publish',
        cursor: 7,
        pageIndex: 1,
        productIds: [2, 7, 11],
      },
    })
  })

  it('pins artifact metadata and projection time to the immutable command', async () => {
    let stored: unknown
    const promote = vi.fn(() => Promise.resolve('promoted' as const))
    const feed: GmcFeedConfig = {
      id: 'artifact',
      access: 'public',
      artifactStore: {
        promote,
        put: vi.fn((value) => {
          stored = { body: value.body, descriptor: value.descriptor }
          return Promise.resolve()
        }),
        read: vi.fn(() => Promise.resolve(stored as never)),
        readCurrent: vi.fn(() => Promise.resolve(null)),
        readCurrentDescriptor: vi.fn(() => Promise.resolve(null)),
      },
      delivery: 'artifact',
      path: '/feeds/artifact.tsv',
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    }
    const test = build({
      feed,
      find: vi.fn(() => Promise.resolve({ docs: [] })) as unknown as Payload['find'],
    })
    const command: Extract<GmcCommand, { type: 'feed.build' }> = {
      type: 'feed.build',
      feedId: 'artifact',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    const result = await test.execute({
      command,
      operationId: 'feed-1',
      payload: test.payload,
      sourceVersion: '9001',
    })

    expect(result.outcome).toBe('completed')
    expect(promote).toHaveBeenCalledWith({
      artifact: expect.objectContaining({
        createdAt: command.requestedAt,
        key: expect.stringMatching(/^123456\/artifact\/9001-[a-f0-9]{64}\.tsv$/),
        sourceVersion: '9001',
      }),
      feedId: 'artifact',
      instanceId: '123456',
    })
  })

  it('reuses an already-promoted equal-version artifact on durable replay without rebuilding', async () => {
    const body = new TextEncoder().encode('already promoted')
    const checksum = createHash('sha256').update(body).digest('hex')
    const descriptor = {
      byteLength: body.byteLength,
      checksum,
      contentType: 'text/tab-separated-values; charset=utf-8',
      createdAt: '2026-08-29T12:00:00.000Z',
      key: `123456/artifact/9001-${checksum}.tsv`,
      sourceVersion: '9001',
    }
    const put = vi.fn(() => Promise.resolve())
    const promote = vi.fn(() => Promise.resolve('promoted' as const))
    const find = vi.fn(() => Promise.resolve({ docs: [] })) as unknown as Payload['find']
    const feed: GmcFeedConfig = {
      id: 'artifact',
      access: 'public',
      artifactStore: {
        promote,
        put,
        read: vi.fn(() => Promise.resolve(null)),
        readCurrent: vi.fn(() => Promise.resolve({ body, descriptor })),
        readCurrentDescriptor: vi.fn(() => Promise.resolve(descriptor)),
      },
      delivery: 'artifact',
      path: '/feeds/artifact.tsv',
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    }
    const test = build({ feed, find })
    const command: Extract<GmcCommand, { type: 'feed.build' }> = {
      type: 'feed.build',
      feedId: 'artifact',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    await expect(
      test.execute({
        command,
        operationId: 'feed-replay',
        payload: test.payload,
        sourceVersion: '9001',
      }),
    ).resolves.toMatchObject({ outcome: 'skipped' })

    expect(find).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
    expect(promote).not.toHaveBeenCalled()
  })

  it('reconciliation scans desired pages before starting the remote phase', async () => {
    const find = vi.fn(() =>
      Promise.resolve({ docs: [{ id: 'product-1' }] }),
    ) as unknown as Payload['find']
    const test = build({ batchSize: 2, find })
    const command: Extract<GmcCommand, { type: 'catalog.reconcile' }> = {
      type: 'catalog.reconcile',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    await test.execute({
      command,
      operationId: 'reconcile-1',
      payload: test.payload,
      sourceVersion: '2000000000000001',
    })
    const children = vi
      .mocked(test.asyncAdapter.dispatch)
      .mock.calls.map(([request]) => request.command)

    expect(children.map((child) => child.type)).toEqual(['offer.publish', 'catalog.reconcile'])
    expect(children[0]).toMatchObject({ verifyRemote: true })
    expect(children[1]).toMatchObject({ phase: 'remote' })
    expect(children[1]).toHaveProperty('startedAt', command.requestedAt)
    expect(children[1]).toHaveProperty('startedVersion', '2000000000000001')
    expect(vi.mocked(test.stateStore.claimPublication).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(test.asyncAdapter.dispatch).mock.invocationCallOrder[1],
    )
    expect(test.productProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectionTime: command.requestedAt }),
    )
  })

  it('repairs a remotely missing offer even when local publication state is current', async () => {
    const test = build()
    const command = createOfferPublishCommand({
      input: newInput,
      productId: 'product-1',
      sourceVersion: '100',
      verifyRemote: true,
    })
    vi.mocked(test.stateStore.claimPublication).mockImplementationOnce((claim) =>
      Promise.resolve(
        state({
          desiredDigest: claim.desiredDigest,
          desiredVersion: claim.desiredVersion,
          identity: claim.identity,
          publishedDigest: claim.desiredDigest,
          publishedVersion: claim.desiredVersion,
          status: 'published',
        }),
      ),
    )
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce(null)

    const result = await test.execute({ command, operationId: 'repair-1', payload: test.payload })

    expect(result.outcome).toBe('completed')
    expect(test.transport.getProcessedProduct).toHaveBeenCalledOnce()
    expect(test.transport.insertProductInput).toHaveBeenCalledOnce()
  })

  it('permanently rejects an implicit processed-product source transfer', async () => {
    const test = build()
    const command = createOfferPublishCommand({
      input: newInput,
      productId: 'product-1',
      sourceVersion: '100',
      verifyRemote: true,
    })
    vi.mocked(test.stateStore.claimPublication).mockImplementationOnce((claim) =>
      Promise.resolve(
        state({
          desiredDigest: claim.desiredDigest,
          desiredVersion: claim.desiredVersion,
          identity: claim.identity,
          publishedDigest: claim.desiredDigest,
          publishedVersion: claim.desiredVersion,
          status: 'published',
        }),
      ),
    )
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce({
      name: 'accounts/123456/products/encoded',
      dataSourceName: 'accounts/123456/dataSources/111111',
      identity: newIdentity,
      versionNumber: '100',
    })

    await expect(
      test.execute({ command, operationId: 'repair-source-1', payload: test.payload }),
    ).rejects.toMatchObject({ code: 'GMC_PRODUCT_DATA_SOURCE_CONFLICT' })

    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
    expect(test.stateStore.markObserved).not.toHaveBeenCalled()
    expect(test.stateStore.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'GMC_PRODUCT_DATA_SOURCE_CONFLICT',
          retryable: false,
        }),
      }),
    )
  })

  it('conditionally deletes only remote orphans from configured API sources', async () => {
    const test = build({ reconciliation: { orphanDeletion: 'exclusive-data-sources' } })
    vi.mocked(test.transport.listProcessedProducts).mockResolvedValueOnce({
      products: [
        {
          name: 'accounts/123456/products/encoded',
          dataSourceName: 'accounts/123456/dataSources/987654321',
          identity: oldIdentity,
        },
        {
          name: 'accounts/123456/products/foreign',
          dataSourceName: 'accounts/123456/dataSources/222222',
          identity: { ...oldIdentity, offerId: 'foreign' },
        },
      ],
    })
    const command: Extract<GmcCommand, { type: 'catalog.reconcile' }> = {
      type: 'catalog.reconcile',
      phase: 'remote',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      startedAt: '2026-08-29T12:00:00.000Z',
    }

    const result = await test.execute({
      command,
      operationId: 'reconcile-1',
      payload: test.payload,
    })
    const children = vi
      .mocked(test.asyncAdapter.dispatch)
      .mock.calls.map(([request]) => request.command)

    expect(result).toMatchObject({ orphanCount: 1, orphanDeleteCount: 1, remoteCount: 1 })
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({
      type: 'offer.delete',
      deleteIfDesiredBefore: '2026-08-29T12:00:00.000Z',
    })
  })

  it('detects but does not delete remote orphan candidates without explicit ownership', async () => {
    const test = build()
    vi.mocked(test.transport.listProcessedProducts).mockResolvedValueOnce({
      products: [
        {
          name: 'accounts/123456/products/encoded',
          dataSourceName: 'accounts/123456/dataSources/987654321',
          identity: oldIdentity,
        },
      ],
    })
    const command: Extract<GmcCommand, { type: 'catalog.reconcile' }> = {
      type: 'catalog.reconcile',
      phase: 'remote',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      startedAt: '2026-08-29T12:00:00.000Z',
    }

    const result = await test.execute({
      command,
      operationId: 'reconcile-detect-only',
      payload: test.payload,
    })

    expect(result).toMatchObject({ orphanCount: 1, orphanDeleteCount: 0, remoteCount: 1 })
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })

  it('fails closed on non-advancing or over-limit remote reconciliation pagination', async () => {
    const repeated = build()
    vi.mocked(repeated.transport.listProcessedProducts).mockResolvedValueOnce({
      nextPageToken: 'same-token',
      products: [],
    })
    const repeatedCommand: Extract<GmcCommand, { type: 'catalog.reconcile' }> = {
      type: 'catalog.reconcile',
      pageIndex: 4,
      pageToken: 'same-token',
      phase: 'remote',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      startedAt: '2026-08-29T12:00:00.000Z',
    }
    await expect(
      repeated.execute({
        command: repeatedCommand,
        operationId: 'reconcile-repeat',
        payload: repeated.payload,
      }),
    ).rejects.toThrow(/pagination token did not advance/i)
    expect(repeated.asyncAdapter.dispatch).not.toHaveBeenCalled()

    const bounded = build({ maxRemoteReconcilePages: 1 })
    vi.mocked(bounded.transport.listProcessedProducts).mockResolvedValueOnce({
      nextPageToken: 'next-token',
      products: [],
    })
    await expect(
      bounded.execute({
        command: { ...repeatedCommand, pageIndex: 0, pageToken: undefined },
        operationId: 'reconcile-bounded',
        payload: bounded.payload,
      }),
    ).rejects.toThrow(/page safety limit/i)
    expect(bounded.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a non-advancing Payload cursor before coordinator fan-out', async () => {
    const find = vi.fn(() =>
      Promise.resolve({ docs: [{ id: 'same' }] }),
    ) as unknown as Payload['find']
    const test = build({ batchSize: 1, find })
    const command: Extract<GmcCommand, { type: 'catalog.publish' }> = {
      type: 'catalog.publish',
      cause: 'manual',
      cursor: 'same',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    await expect(
      test.execute({ command, operationId: 'catalog-stuck', payload: test.payload }),
    ).rejects.toThrow(/pagination did not advance/i)
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })

  it('fails a durable local catalog scan before creating an over-limit continuation', async () => {
    const find = vi.fn(() => Promise.resolve({ docs: [{ id: 1 }] })) as unknown as Payload['find']
    const test = build({ batchSize: 1, find, maxCatalogPages: 1 })
    const command: Extract<GmcCommand, { type: 'catalog.publish' }> = {
      type: 'catalog.publish',
      cause: 'manual',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    await expect(
      test.execute({ command, operationId: 'catalog-bounded', payload: test.payload }),
    ).rejects.toThrow(/page safety limit/i)
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })

  it('applies the local scan ceiling to reconciliation before desired-state fan-out', async () => {
    const find = vi.fn(() => Promise.resolve({ docs: [{ id: 1 }] })) as unknown as Payload['find']
    const test = build({ batchSize: 1, find, maxCatalogPages: 1 })
    const command: Extract<GmcCommand, { type: 'catalog.reconcile' }> = {
      type: 'catalog.reconcile',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    await expect(
      test.execute({ command, operationId: 'reconcile-local-bounded', payload: test.payload }),
    ).rejects.toThrow(/local page safety limit/i)
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })

  it('preserves a remote offer claimed after reconciliation began', async () => {
    const test = build()
    vi.mocked(test.transport.listProcessedProducts).mockResolvedValueOnce({
      products: [
        {
          name: 'accounts/123456/products/encoded',
          dataSourceName: 'accounts/123456/dataSources/987654321',
          identity: oldIdentity,
        },
      ],
    })
    vi.mocked(test.stateStore.get).mockResolvedValueOnce(
      state({
        desiredAt: '2026-08-29T11:59:59.000Z',
        desiredVersion: '2000000000000002',
        identity: oldIdentity,
      }),
    )
    const command: Extract<GmcCommand, { type: 'catalog.reconcile' }> = {
      type: 'catalog.reconcile',
      phase: 'remote',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      startedAt: '2026-08-29T12:00:00.000Z',
      startedVersion: '2000000000000001',
    }

    const result = await test.execute({
      command,
      operationId: 'reconcile-1',
      payload: test.payload,
      sourceVersion: '2000000000000003',
    })

    expect(result).toMatchObject({ orphanCount: 0, remoteCount: 1 })
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
    expect(test.stateStore.markObserved).toHaveBeenCalledOnce()
  })

  it('refreshes read-only processed status without writing Google data back to products', async () => {
    const test = build()
    vi.mocked(test.stateStore.listByProduct).mockResolvedValueOnce([state()])
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce({
      name: 'accounts/123456/products/encoded',
      dataSourceName: 'accounts/123456/dataSources/987654321',
      identity: oldIdentity,
      productStatus: { itemLevelIssues: [{ code: 'image_too_small' }] },
      versionNumber: '100',
    })
    const command: Extract<GmcCommand, { type: 'status.refresh' }> = {
      type: 'status.refresh',
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    const result = await test.execute({ command, operationId: 'status-1', payload: test.payload })

    expect(result).toMatchObject({ productCount: 1, remoteCount: 1 })
    expect(test.stateStore.markObserved).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteMissing: false,
        remoteStatus: { itemLevelIssues: [{ code: 'image_too_small' }] },
      }),
    )
    expect(test.payload.findByID).not.toHaveBeenCalled()
  })

  it('surfaces a processed-status ownership conflict instead of reporting false absence', async () => {
    const test = build()
    vi.mocked(test.stateStore.listByProduct).mockResolvedValueOnce([state()])
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce({
      name: 'accounts/123456/products/encoded',
      dataSourceName: 'accounts/123456/dataSources/111111',
      identity: oldIdentity,
      versionNumber: '100',
    })
    const command: Extract<GmcCommand, { type: 'status.refresh' }> = {
      type: 'status.refresh',
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    await expect(
      test.execute({ command, operationId: 'status-2', payload: test.payload }),
    ).rejects.toMatchObject({ code: 'GMC_PRODUCT_DATA_SOURCE_CONFLICT' })
    expect(test.stateStore.markObserved).not.toHaveBeenCalled()
  })

  it('fans multi-offer status refresh into one remote call per durable child', async () => {
    const test = build()
    const secondIdentity = { ...oldIdentity, offerId: 'offer-2' }
    vi.mocked(test.stateStore.listByProduct).mockResolvedValueOnce([
      state(),
      state({ identity: secondIdentity }),
    ])
    const command: Extract<GmcCommand, { type: 'status.refresh' }> = {
      type: 'status.refresh',
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    const result = await test.execute({
      command,
      operationId: 'status-many',
      payload: test.payload,
    })

    expect(result).toMatchObject({ productCount: 2 })
    expect(result).not.toHaveProperty('remoteCount')
    expect(test.transport.getProcessedProduct).not.toHaveBeenCalled()
    const requests = vi.mocked(test.asyncAdapter.dispatch).mock.calls.map(([request]) => request)
    expect(requests.map(({ command: child }) => child)).toEqual([
      expect.objectContaining({ type: 'status.refresh', identities: [oldIdentity] }),
      expect.objectContaining({ type: 'status.refresh', identities: [secondIdentity] }),
    ])
    expect(requests.map(({ subject }) => subject)).toEqual([
      expect.stringContaining('old-sku'),
      expect.stringContaining('offer-2'),
    ])
  })

  it('fans an all-store local inventory request into bounded store-scoped coordinators', async () => {
    const test = build({ localInventory: true })
    const command: Extract<GmcCommand, { type: 'localInventory.reconcile' }> = {
      type: 'localInventory.reconcile',
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    await test.execute({ command, operationId: 'inventory-1', payload: test.payload })
    const requests = vi.mocked(test.asyncAdapter.dispatch).mock.calls.map(([request]) => request)

    expect(requests.map(({ command: child }) => child)).toEqual([
      expect.objectContaining({
        type: 'localInventory.reconcile',
        productId: 'product-1',
        storeCode: 'store-1',
      }),
      expect.objectContaining({
        type: 'localInventory.reconcile',
        productId: 'product-1',
        storeCode: 'store-2',
      }),
    ])
    expect(requests[0].subject).toBe(requests[1].subject)
    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
  })

  it('fans a retirement-only request into deletion-only store coordination', async () => {
    const test = build({
      localInventory: true,
      retiredStoreCodes: ['final-store'],
      storeCodes: [],
    })
    const command: Extract<GmcCommand, { type: 'localInventory.reconcile' }> = {
      type: 'localInventory.reconcile',
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
    }

    await test.execute({
      command,
      operationId: 'inventory-final-retirement',
      payload: test.payload,
    })

    expect(test.asyncAdapter.dispatch).toHaveBeenCalledOnce()
    expect(test.asyncAdapter.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: 'localInventory.reconcile',
          productId: 'product-1',
          storeCode: 'final-store',
        }),
      }),
    )
    expect(test.localInventoryProject).not.toHaveBeenCalled()
  })

  it('does not enqueue poison local-inventory work for an absent canonical offer', async () => {
    const test = build({ localInventory: true })
    test.productProject.mockReturnValueOnce({ products: [], sourceVersion: '100' })
    const command = createProductPublishCommand({
      cause: 'update',
      productId: 'product-1',
    })

    const result = await test.execute({
      command,
      operationId: 'inventory-absent-offer',
      payload: test.payload,
    })

    expect(result).toMatchObject({ outcome: 'completed', productCount: 0 })
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
    expect(test.localInventoryProject).not.toHaveBeenCalled()
  })

  it('projects one store-scoped inventory command into bounded offer children', async () => {
    const test = build({ localInventory: true })
    const command: Extract<GmcCommand, { type: 'localInventory.reconcile' }> = {
      type: 'localInventory.reconcile',
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'store-1',
    }

    await test.execute({ command, operationId: 'inventory-store-1', payload: test.payload })
    const children = vi
      .mocked(test.asyncAdapter.dispatch)
      .mock.calls.map(([request]) => request.command)

    expect(children).toEqual([
      expect.objectContaining({
        type: 'localInventory.apply',
        inventory: expect.objectContaining({ storeCode: 'store-1' }),
        productId: 'product-1',
        storeCode: 'store-1',
      }),
    ])
    expect(test.localInventoryProject).toHaveBeenCalledWith(
      expect.objectContaining({ storeCode: 'store-1' }),
    )
  })

  it('retires a store by emitting deletes without invoking the active-store projector', async () => {
    const test = build({ localInventory: true, retiredStoreCodes: ['old-store'] })
    const command: Extract<GmcCommand, { type: 'localInventory.reconcile' }> = {
      type: 'localInventory.reconcile',
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'old-store',
    }

    await test.execute({ command, operationId: 'inventory-retired-store', payload: test.payload })

    expect(test.localInventoryProject).not.toHaveBeenCalled()
    expect(test.asyncAdapter.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: 'localInventory.apply',
          inventory: null,
          storeCode: 'old-store',
        }),
      }),
    )
  })

  it('applies the local scan ceiling to store inventory reconciliation', async () => {
    const find = vi.fn(() => Promise.resolve({ docs: [{ id: 1 }] })) as unknown as Payload['find']
    const test = build({
      batchSize: 1,
      find,
      localInventory: true,
      maxCatalogPages: 1,
    })
    const command: Extract<GmcCommand, { type: 'localInventory.reconcile' }> = {
      type: 'localInventory.reconcile',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'store-1',
    }

    await expect(
      test.execute({ command, operationId: 'inventory-bounded', payload: test.payload }),
    ).rejects.toThrow(/page safety limit/i)
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })

  it('executes a local inventory child with the current Inventories v1 wrapper shape', async () => {
    const test = build({ localInventory: true })
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce({
      name: 'accounts/123456/products/encoded',
      dataSourceName: 'accounts/123456/dataSources/987654321',
      identity: newIdentity,
    })
    const command: Extract<GmcCommand, { type: 'localInventory.apply' }> = {
      type: 'localInventory.apply',
      identity: newIdentity,
      inventory: {
        localInventoryAttributes: { availability: 'IN_STOCK' },
        storeCode: 'store-1',
      },
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'store-1',
    }

    await test.execute({ command, operationId: 'inventory-apply-1', payload: test.payload })

    expect(test.transport.insertLocalInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        inventory: {
          localInventoryAttributes: { availability: 'IN_STOCK' },
          storeCode: 'store-1',
        },
      }),
    )
  })

  it('skips a causally stale local inventory replacement after a newer offer publication', async () => {
    const test = build({ localInventory: true })
    vi.mocked(test.stateStore.get).mockResolvedValueOnce(
      state({
        desiredVersion: '101',
        identity: newIdentity,
        publishedVersion: '101',
        status: 'published',
      }),
    )
    const command: Extract<GmcCommand, { type: 'localInventory.apply' }> = {
      type: 'localInventory.apply',
      identity: newIdentity,
      inventory: {
        localInventoryAttributes: { availability: 'IN_STOCK' },
        storeCode: 'store-1',
      },
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'store-1',
    }

    await expect(
      test.execute({
        command,
        operationId: 'inventory-stale-version',
        payload: test.payload,
        sourceVersion: '100',
      }),
    ).resolves.toMatchObject({ outcome: 'skipped' })

    expect(test.transport.getApiPrimaryDataSource).not.toHaveBeenCalled()
    expect(test.transport.getProcessedProduct).not.toHaveBeenCalled()
    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
    expect(test.transport.deleteLocalInventory).not.toHaveBeenCalled()
  })

  it('skips an older independent local workflow after a newer per-store claim', async () => {
    const test = build({ localInventory: true })
    vi.mocked(test.localInventoryStateStore.claim).mockResolvedValueOnce(
      localState({
        desiredDigest: 'b'.repeat(64),
        desiredVersion: '101',
        operationId: 'newer-local-operation',
      }),
    )
    const command: Extract<GmcCommand, { type: 'localInventory.apply' }> = {
      type: 'localInventory.apply',
      identity: newIdentity,
      inventory: {
        localInventoryAttributes: { availability: 'IN_STOCK' },
        storeCode: 'store-1',
      },
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'store-1',
    }

    await expect(
      test.execute({
        command,
        operationId: 'older-local-operation',
        payload: test.payload,
        sourceVersion: '100',
      }),
    ).resolves.toMatchObject({ outcome: 'skipped' })

    expect(test.transport.getApiPrimaryDataSource).not.toHaveBeenCalled()
    expect(test.transport.getProcessedProduct).not.toHaveBeenCalled()
    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
  })

  it('fails closed when a custom local-inventory store returns another resource', async () => {
    const test = build({ localInventory: true })
    vi.mocked(test.localInventoryStateStore.claim).mockResolvedValueOnce(
      localState({ storeCode: 'different-store' }),
    )
    const command: Extract<GmcCommand, { type: 'localInventory.apply' }> = {
      type: 'localInventory.apply',
      identity: newIdentity,
      inventory: null,
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'store-1',
    }

    await expect(
      test.execute({ command, operationId: 'wrong-local-resource', payload: test.payload }),
    ).rejects.toThrow(/wrong resource/i)

    expect(test.transport.getApiPrimaryDataSource).not.toHaveBeenCalled()
    expect(test.transport.deleteLocalInventory).not.toHaveBeenCalled()
  })

  it('rechecks the per-store causal claim immediately before the remote mutation', async () => {
    const test = build({ localInventory: true })
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce({
      name: 'accounts/123456/products/encoded',
      dataSourceName: 'accounts/123456/dataSources/987654321',
      identity: newIdentity,
    })
    vi.mocked(test.localInventoryStateStore.get).mockResolvedValueOnce(
      localState({
        desiredDigest: 'b'.repeat(64),
        desiredVersion: '101',
        operationId: 'newer-local-operation',
      }),
    )
    const command: Extract<GmcCommand, { type: 'localInventory.apply' }> = {
      type: 'localInventory.apply',
      identity: newIdentity,
      inventory: {
        localInventoryAttributes: { availability: 'IN_STOCK' },
        storeCode: 'store-1',
      },
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'store-1',
    }

    await expect(
      test.execute({ command, operationId: 'inventory-raced', payload: test.payload }),
    ).resolves.toMatchObject({ outcome: 'skipped' })

    expect(test.transport.getProcessedProduct).toHaveBeenCalledOnce()
    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
    expect(test.localInventoryStateStore.markPublished).not.toHaveBeenCalled()
  })

  it('rechecks the local inventory fence after ownership I/O before replacing the resource', async () => {
    const test = build({ localInventory: true })
    vi.mocked(test.stateStore.get)
      .mockResolvedValueOnce(
        state({
          desiredVersion: '100',
          identity: newIdentity,
          publishedVersion: '100',
          status: 'published',
        }),
      )
      .mockResolvedValueOnce(
        state({
          desiredVersion: '101',
          identity: newIdentity,
          operationId: 'newer-product-operation',
          status: 'publish-pending',
        }),
      )
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce({
      name: 'accounts/123456/products/encoded',
      dataSourceName: 'accounts/123456/dataSources/987654321',
      identity: newIdentity,
    })
    const command: Extract<GmcCommand, { type: 'localInventory.apply' }> = {
      type: 'localInventory.apply',
      identity: newIdentity,
      inventory: {
        localInventoryAttributes: { availability: 'IN_STOCK' },
        storeCode: 'store-1',
      },
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'store-1',
    }

    await expect(
      test.execute({
        command,
        operationId: 'inventory-raced-by-newer-product',
        payload: test.payload,
        sourceVersion: '100',
      }),
    ).resolves.toMatchObject({ outcome: 'skipped' })

    expect(test.stateStore.get).toHaveBeenCalledTimes(2)
    expect(test.transport.getProcessedProduct).toHaveBeenCalledTimes(1)
    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
    expect(test.transport.deleteLocalInventory).not.toHaveBeenCalled()
  })

  it('does not attach local inventory after the base offer publication failed', async () => {
    const test = build({ localInventory: true })
    vi.mocked(test.stateStore.get).mockResolvedValueOnce(
      state({
        desiredVersion: '100',
        identity: newIdentity,
        status: 'failed',
      }),
    )
    const command: Extract<GmcCommand, { type: 'localInventory.apply' }> = {
      type: 'localInventory.apply',
      identity: newIdentity,
      inventory: {
        localInventoryAttributes: { availability: 'IN_STOCK' },
        storeCode: 'store-1',
      },
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'store-1',
    }

    await expect(
      test.execute({ command, operationId: 'inventory-base-failed', payload: test.payload }),
    ).resolves.toMatchObject({ outcome: 'skipped' })

    expect(test.transport.getProcessedProduct).not.toHaveBeenCalled()
    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
  })

  it('turns a queued insert into a delete when the store has since retired', async () => {
    const test = build({ localInventory: true, retiredStoreCodes: ['old-store'] })
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce({
      name: 'accounts/123456/products/encoded',
      dataSourceName: 'accounts/123456/dataSources/987654321',
      identity: newIdentity,
    })
    const command: Extract<GmcCommand, { type: 'localInventory.apply' }> = {
      type: 'localInventory.apply',
      identity: newIdentity,
      inventory: {
        localInventoryAttributes: { availability: 'IN_STOCK' },
        storeCode: 'old-store',
      },
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'old-store',
    }

    await test.execute({ command, operationId: 'inventory-retired-race', payload: test.payload })

    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
    expect(test.transport.deleteLocalInventory).toHaveBeenCalledWith(
      expect.objectContaining({ storeCode: 'old-store' }),
    )
  })

  it('retries an active local inventory write until its processed product is visible', async () => {
    const test = build({ localInventory: true })
    const command: Extract<GmcCommand, { type: 'localInventory.apply' }> = {
      type: 'localInventory.apply',
      identity: newIdentity,
      inventory: {
        localInventoryAttributes: { availability: 'IN_STOCK' },
        storeCode: 'store-1',
      },
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'store-1',
    }

    await expect(
      test.execute({ command, operationId: 'inventory-processing-lag', payload: test.payload }),
    ).rejects.toMatchObject({ code: 'GMC_PROCESSED_PRODUCT_NOT_READY' })

    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
    expect(test.transport.deleteLocalInventory).not.toHaveBeenCalled()
    expect(test.localInventoryStateStore.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'inventory-processing-lag', storeCode: 'store-1' }),
    )
  })

  it('refuses local inventory mutation after another data source takes ownership', async () => {
    const test = build({ localInventory: true })
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce({
      name: 'accounts/123456/products/encoded',
      dataSourceName: 'accounts/123456/dataSources/111111',
      identity: newIdentity,
    })
    const command: Extract<GmcCommand, { type: 'localInventory.apply' }> = {
      type: 'localInventory.apply',
      identity: newIdentity,
      inventory: null,
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'store-1',
    }

    await expect(
      test.execute({ command, operationId: 'inventory-source-conflict', payload: test.payload }),
    ).rejects.toMatchObject({ code: 'GMC_PRODUCT_DATA_SOURCE_CONFLICT' })

    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
    expect(test.transport.deleteLocalInventory).not.toHaveBeenCalled()
  })

  it('treats retirement cleanup as complete when the processed product is absent', async () => {
    const test = build({ localInventory: true, retiredStoreCodes: ['old-store'] })
    const command: Extract<GmcCommand, { type: 'localInventory.apply' }> = {
      type: 'localInventory.apply',
      identity: newIdentity,
      inventory: null,
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'old-store',
    }

    await expect(
      test.execute({ command, operationId: 'inventory-retired-missing', payload: test.payload }),
    ).resolves.toMatchObject({ outcome: 'skipped' })

    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
    expect(test.transport.deleteLocalInventory).not.toHaveBeenCalled()
  })

  it('rejects a stale local-inventory command after its store is fully removed', async () => {
    const test = build({ localInventory: true })
    const command: Extract<GmcCommand, { type: 'localInventory.apply' }> = {
      type: 'localInventory.apply',
      identity: newIdentity,
      inventory: null,
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'removed-store',
    }

    await expect(
      test.execute({ command, operationId: 'inventory-removed-store', payload: test.payload }),
    ).rejects.toThrow(/unknown local inventory store code/i)
    expect(test.transport.deleteLocalInventory).not.toHaveBeenCalled()
  })

  it('rejects local loyalty pricing that exceeds the canonical online offer', async () => {
    const test = build({ localInventory: true })
    test.localInventoryProject.mockReturnValueOnce([
      {
        identity: newIdentity,
        inventory: {
          localInventoryAttributes: {
            availability: 'IN_STOCK',
            loyaltyPrograms: [{ price: { amountMicros: '1000001', currencyCode: 'USD' } }],
          },
          storeCode: 'store-1',
        },
        storeCode: 'store-1',
      },
    ])
    const command: Extract<GmcCommand, { type: 'localInventory.reconcile' }> = {
      type: 'localInventory.reconcile',
      productId: 'product-1',
      requestedAt: '2026-08-29T12:00:00.000Z',
      schemaVersion: 2,
      storeCode: 'store-1',
    }

    await expect(
      test.execute({ command, operationId: 'inventory-price-check', payload: test.payload }),
    ).rejects.toThrow(/must not exceed regular price/i)
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })
})
