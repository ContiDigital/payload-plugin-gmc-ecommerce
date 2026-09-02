import type { Payload, Where } from 'payload'

import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  GmcAsyncAdapter,
  GmcCommand,
  GmcDocumentID,
  GmcFeedConfig,
  GmcLocalInventoryApplyCommand,
  GmcMerchantTransport,
  GmcOfferPublishCommand,
  GmcPublicationState,
  GmcV2LocalInventoryProjection,
  PayloadGmcEcommerceV2Options,
} from '../types.js'

import { GoogleApiError } from '../../server/services/sub-services/googleApiClient.js'
import { canonicalizeProductInput } from '../canonical.js'
import {
  createLocalInventoryApplyCommand,
  createOfferDeleteCommand,
  createOfferPublishCommand,
  createProductPublishCommand,
} from '../commands.js'
import { normalizeGmcV2Options } from '../config.js'
import { createGmcCommandExecutor } from '../executor.js'
import { createMemoryPublicationStateStore } from './helpers/memoryStateStore.js'

const REQUESTED_AT = '2026-08-29T12:00:00.000Z'
const DATA_SOURCE = 'accounts/123456/dataSources/987654321'

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
const newDigest = canonicalizeProductInput({ input: newInput }).digest
const otherInput = {
  ...newInput,
  offerId: 'other-sku',
  productAttributes: { ...newInput.productAttributes, link: 'https://example.com/other-sku' },
} as const
const otherDigest = canonicalizeProductInput({ input: otherInput }).digest

const remoteProduct = (overrides: Record<string, unknown> = {}) => ({
  name: 'accounts/123456/products/encoded',
  dataSourceName: DATA_SOURCE,
  identity: newIdentity,
  ...overrides,
})

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
        checkedAt: REQUESTED_AT,
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
  const find =
    args?.find ?? (vi.fn(() => Promise.resolve({ docs: [] })) as unknown as Payload['find'])
  const findByID =
    args?.findByID ??
    (vi.fn(() => Promise.resolve({ id: 'product-1' })) as unknown as Payload['findByID'])
  const memory = createMemoryPublicationStateStore({
    dataSourceName: DATA_SOURCE,
    delegate: { find, findByID },
    merchantId: '123456',
  })
  const merchantTransport = transport()
  const execute = createGmcCommandExecutor(normalizeGmcV2Options(pluginOptions), {
    stateStore: memory.store,
    transport: merchantTransport,
  })
  return {
    asyncAdapter,
    execute,
    find,
    findByID,
    localInventoryProject,
    payload: memory.payload,
    productProject,
    stateDocs: memory.docs,
    stateStore: memory.store,
    transport: merchantTransport,
  }
}

type Harness = ReturnType<typeof build>

const dispatchedCommands = (test: Harness): GmcCommand[] =>
  vi.mocked(test.asyncAdapter.dispatch).mock.calls.map(([request]) => request.command)

/**
 * Execute a root command and every durable child it queues, in dispatch order,
 * the way a real worker fleet would. Each command gets its own operation ID so
 * the publication-state claim rules see genuinely distinct workers.
 */
const runWorkflow = async (
  test: Harness,
  command: GmcCommand,
  rootOperationId = 'root-operation',
) => {
  const queue: GmcCommand[] = [command]
  let executed = 0
  while (queue.length > 0) {
    if (++executed > 50) {
      throw new Error('durable workflow did not terminate')
    }
    const next = queue.shift()!
    const before = vi.mocked(test.asyncAdapter.dispatch).mock.calls.length
    await test.execute({
      command: next,
      operationId: `${rootOperationId}-${executed}`,
      payload: test.payload,
      rootOperationId,
    })
    for (const [request] of vi.mocked(test.asyncAdapter.dispatch).mock.calls.slice(before)) {
      queue.push(request.command)
    }
  }
  return executed
}

const seedPublished = async (
  test: Harness,
  args: {
    desiredAt?: string
    digest?: string
    identity: GmcPublicationState['identity']
    productId?: GmcDocumentID
    status?: 'failed' | 'publish-pending' | 'published'
  },
): Promise<void> => {
  const claim = {
    desiredAt: args.desiredAt ?? REQUESTED_AT,
    desiredDigest: args.digest ?? 'seed-digest',
    identity: args.identity,
    operationId: 'seed-operation',
    payload: test.payload,
    productId: args.productId ?? 'product-1',
  }
  await test.stateStore.claimPublication(claim)
  if (args.status === 'failed') {
    await test.stateStore.markFailed({
      error: { message: 'seeded failure' },
      identity: claim.identity,
      operationId: claim.operationId,
      payload: test.payload,
    })
    return
  }
  if (args.status !== 'publish-pending') {
    await test.stateStore.markPublished({ ...claim, publishedAt: claim.desiredAt })
  }
}

const offerPublish = (overrides: Partial<GmcOfferPublishCommand> = {}): GmcOfferPublishCommand => ({
  ...createOfferPublishCommand({
    digest: newDigest,
    input: newInput,
    productId: 'product-1',
    requestedAt: REQUESTED_AT,
  }),
  ...overrides,
})

const localApply = (
  overrides: {
    digest?: string
    identity?: GmcLocalInventoryApplyCommand['identity']
    inventory?: GmcLocalInventoryApplyCommand['inventory']
    productId?: GmcDocumentID
    requestedAt?: string
    storeCode?: string
  } = {},
): GmcLocalInventoryApplyCommand => {
  const storeCode = overrides.storeCode ?? 'store-1'
  const command = createLocalInventoryApplyCommand({
    identity: overrides.identity ?? newIdentity,
    inventory:
      overrides.inventory === undefined
        ? { localInventoryAttributes: { availability: 'IN_STOCK' }, storeCode }
        : overrides.inventory,
    productId: overrides.productId ?? 'product-1',
    requestedAt: overrides.requestedAt ?? REQUESTED_AT,
    storeCode,
  })
  return overrides.digest === undefined ? command : { ...command, digest: overrides.digest }
}

const scopedMultiSource = (test: Harness): void => {
  vi.mocked(test.transport.getApiPrimaryDataSource).mockImplementation(({ dataSourceName }) =>
    Promise.resolve({
      name: dataSourceName,
      contentLanguage: dataSourceName.endsWith('/987654321') ? 'en' : 'fr',
      feedLabel: dataSourceName.endsWith('/987654321') ? 'US' : 'FR',
      input: 'API',
    }),
  )
}

describe('GMC v2 command executor', () => {
  beforeEach(() => vi.clearAllMocks())

  it('validates every configured API-primary source and canonical feed scope without writes', async () => {
    const test = build({ additionalDataSourceIds: ['222222222'] })
    scopedMultiSource(test)
    const command = {
      type: 'dataSources.validate',
      requestedAt: REQUESTED_AT,
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
      name: DATA_SOURCE,
      contentLanguage: 'en',
      feedLabel: 'GB',
      input: 'API',
    })

    await expect(
      test.execute({
        command: {
          type: 'dataSources.validate',
          requestedAt: REQUESTED_AT,
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

    await expect(
      test.execute({
        command: offerPublish(),
        operationId: 'overlapping-source-topology',
        payload: test.payload,
      }),
    ).rejects.toMatchObject({ code: 'GMC_API_PRIMARY_DATA_SOURCE_REQUIRED' })

    expect(test.transport.getApiPrimaryDataSource).toHaveBeenCalledTimes(2)
    expect(test.transport.getProcessedProduct).not.toHaveBeenCalled()
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
  })

  it('turns product reconciliation into identity-ordered durable offer commands', async () => {
    const test = build()
    await seedPublished(test, { identity: oldIdentity })
    const command = createProductPublishCommand({
      cause: 'update',
      previousIdentities: [oldIdentity],
      productId: 'product-1',
      requestedAt: '2026-08-29T12:01:00.000Z',
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
    expect(dispatched[1].command).toMatchObject({ digest: newDigest, versionNumber: '100' })
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

  it('omits versionNumber entirely when the projector supplies no source version', async () => {
    const test = build()
    test.productProject.mockReturnValueOnce({ products: [newInput] } as never)
    const command = createProductPublishCommand({
      cause: 'update',
      productId: 'product-1',
      requestedAt: REQUESTED_AT,
    })

    await test.execute({ command, operationId: 'operation-unversioned', payload: test.payload })

    const child = dispatchedCommands(test)[0]
    expect(child).toMatchObject({ type: 'offer.publish', digest: newDigest })
    expect(child).not.toHaveProperty('versionNumber', expect.anything())
    expect((child as GmcOfferPublishCommand).versionNumber).toBeUndefined()
  })

  it('treats the configured source query as an eligibility boundary for single-product hooks', async () => {
    const find = vi.fn(() => Promise.resolve({ docs: [] })) as unknown as Payload['find']
    const test = build({ find, where: { enabledForGoogle: { equals: true } } })
    await seedPublished(test, { identity: oldIdentity })
    const command = createProductPublishCommand({
      cause: 'update',
      productId: 'product-1',
      requestedAt: '2026-08-29T12:01:00.000Z',
    })

    const result = await test.execute({
      command,
      operationId: 'operation-1',
      payload: test.payload,
    })

    expect(result.productCount).toBe(0)
    expect(dispatchedCommands(test)).toEqual([expect.objectContaining({ type: 'offer.delete' })])
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
    await seedPublished(test, { identity: oldIdentity })
    const command = createProductPublishCommand({
      cause: 'unpublish',
      productId: 'product-1',
      requestedAt: '2026-08-29T12:01:00.000Z',
    })

    const result = await test.execute({
      command,
      operationId: 'operation-1',
      payload: test.payload,
    })

    expect(result).toMatchObject({ outcome: 'completed', productCount: 0 })
    expect(test.productProject).not.toHaveBeenCalled()
    expect(dispatchedCommands(test)).toEqual([expect.objectContaining({ type: 'offer.delete' })])
  })

  it('submits a complete offer with its forwarded Google version and records success', async () => {
    const test = build()

    await test.execute({
      command: offerPublish({ versionNumber: '100' }),
      operationId: 'operation-1',
      payload: test.payload,
    })

    expect(test.transport.insertProductInput).toHaveBeenCalledWith(
      expect.objectContaining({
        dataSourceName: DATA_SOURCE,
        input: expect.objectContaining({ offerId: 'new-sku', versionNumber: '100' }),
      }),
    )
    expect(test.stateStore.markPublished).toHaveBeenCalledOnce()
    expect(test.stateStore.claimPublication).toHaveBeenCalledWith(
      expect.objectContaining({ desiredAt: REQUESTED_AT, desiredDigest: newDigest }),
    )
    expect(test.transport.getApiPrimaryDataSource).toHaveBeenCalledOnce()
    await expect(
      test.stateStore.get({ identity: newIdentity, payload: test.payload }),
    ).resolves.toMatchObject({ publishedDigest: newDigest, status: 'published' })
  })

  it('sends no versionNumber to Google when the command carries none', async () => {
    const test = build()

    await test.execute({
      command: offerPublish(),
      operationId: 'operation-unversioned-write',
      payload: test.payload,
    })

    const [[written]] = vi.mocked(test.transport.insertProductInput).mock.calls
    expect(written.input).not.toHaveProperty('versionNumber')
  })

  it('ignores a deprecated execution sourceVersion supplied by an rc worker', async () => {
    const test = build()

    await expect(
      test.execute({
        command: offerPublish(),
        operationId: 'operation-legacy-context',
        payload: test.payload,
        sourceVersion: '9223372036854775808',
      }),
    ).resolves.toMatchObject({ outcome: 'completed' })
    const [[written]] = vi.mocked(test.transport.insertProductInput).mock.calls
    expect(written.input).not.toHaveProperty('versionNumber')
  })

  it('performs no ownership read for a single-source publish and one for a multi-source publish', async () => {
    const single = build()
    await single.execute({
      command: offerPublish(),
      operationId: 'single-source-publish',
      payload: single.payload,
    })
    expect(single.transport.getProcessedProduct).not.toHaveBeenCalled()
    expect(single.transport.insertProductInput).toHaveBeenCalledOnce()

    const multi = build({ additionalDataSourceIds: ['222222222'] })
    scopedMultiSource(multi)
    vi.mocked(multi.transport.getProcessedProduct).mockResolvedValueOnce(remoteProduct())
    await multi.execute({
      command: offerPublish(),
      operationId: 'multi-source-publish',
      payload: multi.payload,
    })
    expect(multi.transport.getProcessedProduct).toHaveBeenCalledOnce()
    expect(multi.transport.insertProductInput).toHaveBeenCalledOnce()
  })

  it('fails closed before publication when the configured source rejects the offer scope', async () => {
    const test = build()
    vi.mocked(test.transport.getApiPrimaryDataSource).mockResolvedValueOnce({
      name: DATA_SOURCE,
      contentLanguage: 'en',
      feedLabel: 'GB',
      input: 'API',
    })

    await expect(
      test.execute({
        command: offerPublish(),
        operationId: 'wrong-source-scope',
        payload: test.payload,
      }),
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

  it('rejects an offer.publish whose digest does not describe its own input', async () => {
    const test = build()

    await expect(
      test.execute({
        command: offerPublish({ digest: 'f'.repeat(64) }),
        operationId: 'operation-digest-mismatch',
        payload: test.payload,
      }),
    ).rejects.toThrow(/digest does not match/i)
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
  })

  it('skips a redelivery whose exact digest is already published', async () => {
    const test = build()
    await test.execute({
      command: offerPublish(),
      operationId: 'operation-1',
      payload: test.payload,
    })
    vi.mocked(test.transport.insertProductInput).mockClear()

    await expect(
      test.execute({
        command: offerPublish(),
        operationId: 'operation-2',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ outcome: 'skipped' })
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
  })

  it('skips a product.publish redelivery after its offer child already completed', async () => {
    const find = vi.fn(() => Promise.resolve({ docs: [] })) as unknown as Payload['find']
    const test = build({ find })
    const command = createProductPublishCommand({
      cause: 'update',
      productId: 'product-1',
      requestedAt: REQUESTED_AT,
    })
    await runWorkflow(test, command, 'first-delivery')
    expect(test.transport.insertProductInput).toHaveBeenCalledOnce()
    vi.mocked(test.asyncAdapter.dispatch).mockClear()
    vi.mocked(test.transport.insertProductInput).mockClear()

    await test.execute({ command, operationId: 'redelivery', payload: test.payload })

    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
  })

  it('fails closed when a custom state store returns an unbounded active identity set', async () => {
    const test = build()
    vi.mocked(test.stateStore.listByProduct).mockResolvedValueOnce(
      Array.from({ length: 1_001 }, (_, index) => ({
        identity: { ...oldIdentity, offerId: `historical-${index}` },
        operationId: 'previous-operation',
        productId: 'product-1',
        revision: 0,
        status: 'published' as const,
        updatedAt: REQUESTED_AT,
      })),
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

    await expect(
      test.execute({
        command: offerPublish(),
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

    await expect(
      test.execute({
        command: offerPublish(),
        operationId: 'operation-retry-limiter',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ outcome: 'completed' })

    expect(test.transport.insertProductInput).toHaveBeenCalledTimes(2)
    // One control-plane source verification plus one slot per physical write
    // attempt; a single-source publish performs no ownership read.
    expect(claimSlot).toHaveBeenCalledTimes(3)
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

    await expect(
      test.execute({
        command: offerPublish(),
        operationId: 'operation-auth-refresh',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ outcome: 'completed' })
    expect(test.transport.insertProductInput).toHaveBeenCalledTimes(2)
    expect(claimSlot).toHaveBeenCalledTimes(3)

    vi.mocked(test.transport.insertProductInput).mockReset()
    claimSlot.mockClear()
    vi.mocked(test.transport.insertProductInput).mockRejectedValue(
      new GoogleApiError('invalid credentials', 401),
    )
    await expect(
      test.execute({
        // A distinct offer so the already-published shortcut cannot skip it.
        command: offerPublish({
          digest: otherDigest,
          input: otherInput,
          requestedAt: '2026-08-29T12:02:00.000Z',
        }),
        operationId: 'operation-auth-failed',
        payload: test.payload,
      }),
    ).rejects.toMatchObject({ statusCode: 401 })
    expect(test.transport.insertProductInput).toHaveBeenCalledTimes(2)
    // The control-plane source read is still cached from the first execution.
    expect(claimSlot).toHaveBeenCalledTimes(2)
  })

  it('does not delete an identity which the state store says belongs to another product', async () => {
    const test = build()
    await seedPublished(test, { identity: oldIdentity, productId: 'product-1' })

    const result = await test.execute({
      command: createOfferDeleteCommand({
        expectedProductId: 'stale-product',
        identity: oldIdentity,
        requestedAt: '2026-08-29T12:01:00.000Z',
      }),
      operationId: 'operation-1',
      payload: test.payload,
    })

    expect(result.outcome).toBe('skipped')
    expect(test.transport.deleteProductInput).not.toHaveBeenCalled()
  })

  it('skips a reconciliation delete whose ordering guard predates the stored desired claim', async () => {
    const test = build()
    await seedPublished(test, { desiredAt: '2026-08-29T12:05:00.000Z', identity: oldIdentity })

    const result = await test.execute({
      command: createOfferDeleteCommand({
        identity: oldIdentity,
        onlyIfDesiredBefore: '2026-08-29T12:00:00.000Z',
        requestedAt: '2026-08-29T12:06:00.000Z',
      }),
      operationId: 'stale-orphan-delete',
      payload: test.payload,
    })

    expect(result.outcome).toBe('skipped')
    expect(test.stateStore.markDeletePending).toHaveBeenCalledWith(
      expect.objectContaining({ onlyIfDesiredBefore: '2026-08-29T12:00:00.000Z' }),
    )
    expect(test.transport.deleteProductInput).not.toHaveBeenCalled()
    await expect(
      test.stateStore.get({ identity: oldIdentity, payload: test.payload }),
    ).resolves.toMatchObject({ status: 'published' })
  })

  it('stamps the deletion instant so an older publish can never resurrect the offer', async () => {
    const test = build()
    await test.execute({
      command: createOfferDeleteCommand({
        identity: newIdentity,
        requestedAt: '2026-08-29T12:05:00.000Z',
      }),
      operationId: 'delete-operation',
      payload: test.payload,
    })
    expect(test.transport.deleteProductInput).toHaveBeenCalledOnce()
    vi.mocked(test.asyncAdapter.dispatch).mockClear()

    const result = await test.execute({
      command: createProductPublishCommand({
        cause: 'update',
        productId: 'product-1',
        requestedAt: '2026-08-29T12:01:00.000Z',
      }),
      operationId: 'stale-publish-operation',
      payload: test.payload,
    })

    expect(result).toMatchObject({ dispatched: [] })
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
  })

  it('fans a catalog page out durably and queues a bounded continuation', async () => {
    const find = vi.fn(() =>
      Promise.resolve({ docs: [{ id: 1 }, { id: 2 }] }),
    ) as unknown as Payload['find']
    const test = build({ batchSize: 2, find })
    const command: Extract<GmcCommand, { type: 'catalog.publish' }> = {
      type: 'catalog.publish',
      cause: 'manual',
      requestedAt: REQUESTED_AT,
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
      requestedAt: REQUESTED_AT,
      schemaVersion: 2,
    }

    await test.execute({ command, operationId: 'targeted-root', payload: test.payload })

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
    const test = build({ feed })
    const command: Extract<GmcCommand, { type: 'feed.build' }> = {
      type: 'feed.build',
      feedId: 'artifact',
      requestedAt: REQUESTED_AT,
      schemaVersion: 2,
    }

    const result = await test.execute({
      command,
      operationId: 'feed-1',
      payload: test.payload,
    })

    expect(result.outcome).toBe('completed')
    expect(promote).toHaveBeenCalledWith({
      artifact: expect.objectContaining({
        createdAt: command.requestedAt,
        generatedAt: command.requestedAt,
        key: expect.stringMatching(
          /^123456\/artifact\/2026-08-29T12-00-00-000Z-[a-f0-9]{64}\.tsv$/,
        ),
      }),
      feedId: 'artifact',
      instanceId: '123456',
    })
  })

  it('reuses an already-promoted artifact with the same generatedAt on durable replay', async () => {
    const body = new TextEncoder().encode('already promoted')
    const checksum = createHash('sha256').update(body).digest('hex')
    const descriptor = {
      byteLength: body.byteLength,
      checksum,
      contentType: 'text/tab-separated-values; charset=utf-8',
      createdAt: REQUESTED_AT,
      generatedAt: REQUESTED_AT,
      key: `123456/artifact/2026-08-29T12-00-00-000Z-${checksum}.tsv`,
    }
    const put = vi.fn(() => Promise.resolve())
    const promote = vi.fn(() => Promise.resolve('promoted' as const))
    const readCurrent = vi.fn(() => Promise.resolve({ body, descriptor }))
    const find = vi.fn(() => Promise.resolve({ docs: [] })) as unknown as Payload['find']
    const feed: GmcFeedConfig = {
      id: 'artifact',
      access: 'public',
      artifactStore: {
        promote,
        put,
        read: vi.fn(() => Promise.resolve(null)),
        readCurrent,
        readCurrentDescriptor: vi.fn(() => Promise.resolve(descriptor)),
      },
      delivery: 'artifact',
      path: '/feeds/artifact.tsv',
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    }
    const test = build({ feed, find })

    await expect(
      test.execute({
        command: {
          type: 'feed.build',
          feedId: 'artifact',
          requestedAt: REQUESTED_AT,
          schemaVersion: 2,
        },
        operationId: 'feed-replay',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ outcome: 'skipped' })

    // The equal-generatedAt replay still verifies the promoted artifact.
    expect(readCurrent).toHaveBeenCalledOnce()
    expect(find).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
    expect(promote).not.toHaveBeenCalled()
  })

  it('skips a feed build whose pointer was generated after the command was requested', async () => {
    const readCurrent = vi.fn(() => Promise.resolve(null))
    const checksum = 'a'.repeat(64)
    const descriptor = {
      byteLength: 4,
      checksum,
      contentType: 'text/tab-separated-values; charset=utf-8',
      createdAt: '2026-08-29T13:00:00.000Z',
      generatedAt: '2026-08-29T13:00:00.000Z',
      key: `123456/artifact/2026-08-29T13-00-00-000Z-${checksum}.tsv`,
    }
    const feed: GmcFeedConfig = {
      id: 'artifact',
      access: 'public',
      artifactStore: {
        promote: vi.fn(() => Promise.resolve('promoted' as const)),
        put: vi.fn(() => Promise.resolve()),
        read: vi.fn(() => Promise.resolve(null)),
        readCurrent,
        readCurrentDescriptor: vi.fn(() => Promise.resolve(descriptor)),
      },
      delivery: 'artifact',
      path: '/feeds/artifact.tsv',
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    }
    const test = build({ feed })

    await expect(
      test.execute({
        command: {
          type: 'feed.build',
          feedId: 'artifact',
          requestedAt: REQUESTED_AT,
          schemaVersion: 2,
        },
        operationId: 'feed-superseded',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ outcome: 'skipped' })
    expect(readCurrent).not.toHaveBeenCalled()
  })

  it('reconciliation fans desired pages into durable product children before the remote phase', async () => {
    const find = vi.fn(() =>
      Promise.resolve({ docs: [{ id: 'product-1' }] }),
    ) as unknown as Payload['find']
    const test = build({ batchSize: 2, find })
    const command: Extract<GmcCommand, { type: 'catalog.reconcile' }> = {
      type: 'catalog.reconcile',
      requestedAt: REQUESTED_AT,
      schemaVersion: 2,
    }

    await test.execute({ command, operationId: 'reconcile-1', payload: test.payload })
    const children = dispatchedCommands(test)

    expect(children.map((child) => child.type)).toEqual(['product.publish', 'catalog.reconcile'])
    expect(children[0]).toMatchObject({ cause: 'reconcile', productId: 'product-1' })
    expect(children[1]).toMatchObject({ phase: 'remote', startedAt: command.requestedAt })
    expect(children[1]).not.toHaveProperty('startedVersion')
    // Nothing is claimed or written inline any more; the children own that.
    expect(test.stateStore.claimPublication).not.toHaveBeenCalled()
    expect(test.productProject).not.toHaveBeenCalled()
  })

  it('reconciles an unchanged published product with a remote verification and no insert', async () => {
    const find = vi.fn(() =>
      Promise.resolve({ docs: [{ id: 'product-1' }] }),
    ) as unknown as Payload['find']
    const test = build({ batchSize: 2, find })
    await runWorkflow(
      test,
      {
        type: 'catalog.publish',
        cause: 'manual',
        requestedAt: REQUESTED_AT,
        schemaVersion: 2,
      },
      'initial-publish',
    )
    expect(test.transport.insertProductInput).toHaveBeenCalledOnce()

    vi.mocked(test.transport.insertProductInput).mockClear()
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValue(remoteProduct())
    vi.mocked(test.asyncAdapter.dispatch).mockClear()

    await runWorkflow(
      test,
      {
        type: 'catalog.reconcile',
        requestedAt: '2026-08-29T13:00:00.000Z',
        schemaVersion: 2,
      },
      'reconcile',
    )

    expect(test.transport.getProcessedProduct).toHaveBeenCalledOnce()
    expect(test.transport.insertProductInput).not.toHaveBeenCalled()
    expect(test.stateStore.markObserved).toHaveBeenCalledWith(
      expect.objectContaining({ remoteMissing: false }),
    )
  })

  it('repairs a remotely missing offer even when local publication state is current', async () => {
    const test = build()
    await test.execute({
      command: offerPublish(),
      operationId: 'initial-publish',
      payload: test.payload,
    })
    vi.mocked(test.transport.insertProductInput).mockClear()
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce(null)

    const result = await test.execute({
      command: offerPublish({ verifyRemote: true }),
      operationId: 'repair-1',
      payload: test.payload,
    })

    expect(result.outcome).toBe('completed')
    expect(test.transport.getProcessedProduct).toHaveBeenCalledOnce()
    expect(test.transport.insertProductInput).toHaveBeenCalledOnce()
  })

  it('permanently rejects an implicit processed-product source transfer', async () => {
    const test = build()
    await test.execute({
      command: offerPublish(),
      operationId: 'initial-publish',
      payload: test.payload,
    })
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce(
      remoteProduct({ dataSourceName: 'accounts/123456/dataSources/111111' }),
    )

    await expect(
      test.execute({
        command: offerPublish({ verifyRemote: true }),
        operationId: 'repair-source-1',
        payload: test.payload,
      }),
    ).rejects.toMatchObject({ code: 'GMC_PRODUCT_DATA_SOURCE_CONFLICT' })

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
          dataSourceName: DATA_SOURCE,
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
      requestedAt: REQUESTED_AT,
      schemaVersion: 2,
      startedAt: REQUESTED_AT,
    }

    const result = await test.execute({
      command,
      operationId: 'reconcile-1',
      payload: test.payload,
    })

    expect(result).toMatchObject({ orphanCount: 1, orphanDeleteCount: 1, remoteCount: 1 })
    const children = dispatchedCommands(test)
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({
      type: 'offer.delete',
      onlyIfDesiredBefore: REQUESTED_AT,
    })
  })

  it('treats a deleted state row as a remote orphan the sweep may repair', async () => {
    const test = build({ reconciliation: { orphanDeletion: 'exclusive-data-sources' } })
    await seedPublished(test, { identity: oldIdentity })
    await test.stateStore.markDeletePending({
      deletedAt: '2026-08-29T12:01:00.000Z',
      identity: oldIdentity,
      operationId: 'earlier-delete',
      payload: test.payload,
      productId: 'product-1',
    })
    await test.stateStore.markDeleted({
      deletedAt: '2026-08-29T12:01:00.000Z',
      identity: oldIdentity,
      operationId: 'earlier-delete',
      payload: test.payload,
      productId: 'product-1',
    })
    vi.mocked(test.transport.listProcessedProducts).mockResolvedValueOnce({
      products: [
        {
          name: 'accounts/123456/products/encoded',
          dataSourceName: DATA_SOURCE,
          identity: oldIdentity,
        },
      ],
    })

    const result = await test.execute({
      command: {
        type: 'catalog.reconcile',
        phase: 'remote',
        requestedAt: '2026-08-29T13:00:00.000Z',
        schemaVersion: 2,
        startedAt: '2026-08-29T13:00:00.000Z',
      },
      operationId: 'reconcile-deleted-row',
      payload: test.payload,
    })

    expect(result).toMatchObject({ orphanCount: 1, orphanDeleteCount: 1 })
  })

  it('detects but does not delete remote orphan candidates without explicit ownership', async () => {
    const test = build()
    vi.mocked(test.transport.listProcessedProducts).mockResolvedValueOnce({
      products: [
        {
          name: 'accounts/123456/products/encoded',
          dataSourceName: DATA_SOURCE,
          identity: oldIdentity,
        },
      ],
    })

    const result = await test.execute({
      command: {
        type: 'catalog.reconcile',
        phase: 'remote',
        requestedAt: REQUESTED_AT,
        schemaVersion: 2,
        startedAt: REQUESTED_AT,
      },
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
      requestedAt: REQUESTED_AT,
      schemaVersion: 2,
      startedAt: REQUESTED_AT,
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

    await expect(
      test.execute({
        command: {
          type: 'catalog.publish',
          cause: 'manual',
          cursor: 'same',
          requestedAt: REQUESTED_AT,
          schemaVersion: 2,
        },
        operationId: 'catalog-stuck',
        payload: test.payload,
      }),
    ).rejects.toThrow(/pagination did not advance/i)
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })

  it('fails a durable local catalog scan before creating an over-limit continuation', async () => {
    const find = vi.fn(() => Promise.resolve({ docs: [{ id: 1 }] })) as unknown as Payload['find']
    const test = build({ batchSize: 1, find, maxCatalogPages: 1 })

    await expect(
      test.execute({
        command: {
          type: 'catalog.publish',
          cause: 'manual',
          requestedAt: REQUESTED_AT,
          schemaVersion: 2,
        },
        operationId: 'catalog-bounded',
        payload: test.payload,
      }),
    ).rejects.toThrow(/page safety limit/i)
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })

  it('applies the local scan ceiling to reconciliation before desired-state fan-out', async () => {
    const find = vi.fn(() => Promise.resolve({ docs: [{ id: 1 }] })) as unknown as Payload['find']
    const test = build({ batchSize: 1, find, maxCatalogPages: 1 })

    await expect(
      test.execute({
        command: {
          type: 'catalog.reconcile',
          requestedAt: REQUESTED_AT,
          schemaVersion: 2,
        },
        operationId: 'reconcile-local-bounded',
        payload: test.payload,
      }),
    ).rejects.toThrow(/local page safety limit/i)
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })

  it('preserves a remote offer claimed after reconciliation began', async () => {
    const test = build()
    await seedPublished(test, { desiredAt: '2026-08-29T12:00:01.000Z', identity: oldIdentity })
    vi.mocked(test.transport.listProcessedProducts).mockResolvedValueOnce({
      products: [
        {
          name: 'accounts/123456/products/encoded',
          dataSourceName: DATA_SOURCE,
          identity: oldIdentity,
        },
      ],
    })

    const result = await test.execute({
      command: {
        type: 'catalog.reconcile',
        phase: 'remote',
        requestedAt: REQUESTED_AT,
        schemaVersion: 2,
        startedAt: REQUESTED_AT,
      },
      operationId: 'reconcile-1',
      payload: test.payload,
    })

    expect(result).toMatchObject({ orphanCount: 0, remoteCount: 1 })
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
    expect(test.stateStore.markObserved).toHaveBeenCalledOnce()
  })

  it('deletes every identity of a legacy product.delete that carries no productId', async () => {
    const test = build()
    const command: Extract<GmcCommand, { type: 'product.delete' }> = {
      type: 'product.delete',
      cause: 'delete',
      identities: [oldIdentity, newIdentity],
      requestedAt: REQUESTED_AT,
      schemaVersion: 2,
    }

    const result = await test.execute({
      command,
      operationId: 'legacy-delete',
      payload: test.payload,
    })
    const children = dispatchedCommands(test)

    expect(result).toMatchObject({ commandType: 'product.delete', outcome: 'completed' })
    expect(children.map((child) => child.type)).toEqual(['offer.delete', 'offer.delete'])
    expect(children.map((child) => (child as { identity: unknown }).identity)).toEqual([
      oldIdentity,
      newIdentity,
    ])
    for (const child of children) {
      expect(child).not.toHaveProperty('expectedProductId', expect.anything())
      expect((child as { expectedProductId?: unknown }).expectedProductId).toBeUndefined()
    }

    for (const [index, child] of children.entries()) {
      await test.execute({
        command: child,
        operationId: `legacy-delete-child-${index}`,
        payload: test.payload,
      })
    }
    expect(test.transport.deleteProductInput).toHaveBeenCalledTimes(2)
  })

  it('refreshes read-only processed status without writing Google data back to products', async () => {
    const test = build()
    await seedPublished(test, { identity: oldIdentity })
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce({
      name: 'accounts/123456/products/encoded',
      dataSourceName: DATA_SOURCE,
      identity: oldIdentity,
      productStatus: { itemLevelIssues: [{ code: 'image_too_small' }] },
      versionNumber: '100',
    })

    const result = await test.execute({
      command: {
        type: 'status.refresh',
        productId: 'product-1',
        requestedAt: REQUESTED_AT,
        schemaVersion: 2,
      },
      operationId: 'status-1',
      payload: test.payload,
    })

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
    await seedPublished(test, { identity: oldIdentity })
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce({
      name: 'accounts/123456/products/encoded',
      dataSourceName: 'accounts/123456/dataSources/111111',
      identity: oldIdentity,
      versionNumber: '100',
    })

    await expect(
      test.execute({
        command: {
          type: 'status.refresh',
          productId: 'product-1',
          requestedAt: REQUESTED_AT,
          schemaVersion: 2,
        },
        operationId: 'status-2',
        payload: test.payload,
      }),
    ).rejects.toMatchObject({ code: 'GMC_PRODUCT_DATA_SOURCE_CONFLICT' })
    expect(test.stateStore.markObserved).not.toHaveBeenCalled()
  })

  it('refreshes every owned identity inline instead of fanning out one child per offer', async () => {
    const test = build()
    const secondIdentity = { ...oldIdentity, offerId: 'offer-2' }
    await seedPublished(test, { identity: oldIdentity })
    await seedPublished(test, { identity: secondIdentity })

    const result = await test.execute({
      command: {
        type: 'status.refresh',
        productId: 'product-1',
        requestedAt: REQUESTED_AT,
        schemaVersion: 2,
      },
      operationId: 'status-many',
      payload: test.payload,
    })

    expect(result).toMatchObject({ productCount: 2, remoteCount: 0 })
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
    expect(test.transport.getProcessedProduct).toHaveBeenCalledTimes(2)
    expect(test.stateStore.markObserved).toHaveBeenCalledTimes(2)
  })

  it('fans an all-store local inventory request into bounded store-scoped coordinators', async () => {
    const test = build({ localInventory: true })

    await test.execute({
      command: {
        type: 'localInventory.reconcile',
        productId: 'product-1',
        requestedAt: REQUESTED_AT,
        schemaVersion: 2,
      },
      operationId: 'inventory-1',
      payload: test.payload,
    })
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

    await test.execute({
      command: {
        type: 'localInventory.reconcile',
        productId: 'product-1',
        requestedAt: REQUESTED_AT,
        schemaVersion: 2,
      },
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

    const result = await test.execute({
      command: createProductPublishCommand({ cause: 'update', productId: 'product-1' }),
      operationId: 'inventory-absent-offer',
      payload: test.payload,
    })

    expect(result).toMatchObject({ outcome: 'completed', productCount: 0 })
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
    expect(test.localInventoryProject).not.toHaveBeenCalled()
  })

  it('projects one store-scoped inventory command into bounded offer children', async () => {
    const test = build({ localInventory: true })

    await test.execute({
      command: {
        type: 'localInventory.reconcile',
        productId: 'product-1',
        requestedAt: REQUESTED_AT,
        schemaVersion: 2,
        storeCode: 'store-1',
      },
      operationId: 'inventory-store-1',
      payload: test.payload,
    })

    expect(dispatchedCommands(test)).toEqual([
      expect.objectContaining({
        type: 'localInventory.apply',
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
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

    await test.execute({
      command: {
        type: 'localInventory.reconcile',
        productId: 'product-1',
        requestedAt: REQUESTED_AT,
        schemaVersion: 2,
        storeCode: 'old-store',
      },
      operationId: 'inventory-retired-store',
      payload: test.payload,
    })

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

    await expect(
      test.execute({
        command: {
          type: 'localInventory.reconcile',
          requestedAt: REQUESTED_AT,
          schemaVersion: 2,
          storeCode: 'store-1',
        },
        operationId: 'inventory-bounded',
        payload: test.payload,
      }),
    ).rejects.toThrow(/page safety limit/i)
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })

  it('executes a local inventory child with the current Inventories v1 wrapper shape', async () => {
    const test = build({ localInventory: true })
    await seedPublished(test, { identity: newIdentity })

    await test.execute({
      command: localApply(),
      operationId: 'inventory-apply-1',
      payload: test.payload,
    })

    expect(test.transport.getProcessedProduct).not.toHaveBeenCalled()
    expect(test.transport.insertLocalInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        inventory: {
          localInventoryAttributes: { availability: 'IN_STOCK' },
          storeCode: 'store-1',
        },
      }),
    )
    expect(test.stateStore.markLocalInventoryPublished).toHaveBeenCalledOnce()
  })

  it('skips a local inventory replacement whose base offer moved to another product', async () => {
    const test = build({ localInventory: true })
    await seedPublished(test, { identity: newIdentity, productId: 'product-2' })

    await expect(
      test.execute({
        command: localApply(),
        operationId: 'inventory-moved-owner',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ outcome: 'skipped' })

    expect(test.stateStore.claimLocalInventory).not.toHaveBeenCalled()
    expect(test.transport.getApiPrimaryDataSource).not.toHaveBeenCalled()
    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
    expect(test.transport.deleteLocalInventory).not.toHaveBeenCalled()
  })

  it('skips local inventory entirely when the base offer has no publication row', async () => {
    const test = build({ localInventory: true })

    await expect(
      test.execute({
        command: localApply(),
        operationId: 'inventory-no-base-row',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ outcome: 'skipped' })
    expect(test.stateStore.claimLocalInventory).not.toHaveBeenCalled()
    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
  })

  it('does not attach local inventory after the base offer publication failed', async () => {
    const test = build({ localInventory: true })
    await seedPublished(test, { identity: newIdentity, status: 'failed' })

    await expect(
      test.execute({
        command: localApply(),
        operationId: 'inventory-base-failed',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ outcome: 'skipped' })

    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
  })

  it('retries local inventory until the base ProductInput has landed', async () => {
    const test = build({ localInventory: true })
    await seedPublished(test, { identity: newIdentity, status: 'publish-pending' })

    await expect(
      test.execute({
        command: localApply(),
        operationId: 'inventory-processing-lag',
        payload: test.payload,
      }),
    ).rejects.toMatchObject({ code: 'GMC_PROCESSED_PRODUCT_NOT_READY' })

    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
    expect(test.transport.deleteLocalInventory).not.toHaveBeenCalled()
  })

  it('skips an older independent local workflow after a newer per-store claim', async () => {
    const test = build({ localInventory: true })
    await seedPublished(test, { identity: newIdentity })
    await test.stateStore.claimLocalInventory({
      desiredAt: '2026-08-29T12:05:00.000Z',
      desiredDigest: 'b'.repeat(64),
      identity: newIdentity,
      operationId: 'newer-local-operation',
      payload: test.payload,
      productId: 'product-1',
      storeCode: 'store-1',
    })

    await expect(
      test.execute({
        command: localApply(),
        operationId: 'older-local-operation',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ outcome: 'skipped' })

    expect(test.transport.getApiPrimaryDataSource).not.toHaveBeenCalled()
    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
  })

  it('skips a local inventory redelivery whose digest is already published', async () => {
    const test = build({ localInventory: true })
    await seedPublished(test, { identity: newIdentity })
    await test.execute({
      command: localApply(),
      operationId: 'inventory-first',
      payload: test.payload,
    })
    vi.mocked(test.transport.insertLocalInventory).mockClear()

    await expect(
      test.execute({
        command: localApply(),
        operationId: 'inventory-redelivery',
        payload: test.payload,
      }),
    ).resolves.toMatchObject({ outcome: 'skipped' })
    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
  })

  it('fails closed when a custom local-inventory store returns another resource', async () => {
    const test = build({ localInventory: true })
    await seedPublished(test, { identity: newIdentity })
    vi.mocked(test.stateStore.claimLocalInventory).mockResolvedValueOnce({
      desiredAt: REQUESTED_AT,
      desiredDigest: 'a'.repeat(64),
      identity: newIdentity,
      operationId: 'wrong-local-resource',
      productId: 'product-1',
      revision: 0,
      status: 'publish-pending',
      storeCode: 'different-store',
      updatedAt: REQUESTED_AT,
    })

    await expect(
      test.execute({
        command: localApply({ inventory: null }),
        operationId: 'wrong-local-resource',
        payload: test.payload,
      }),
    ).rejects.toThrow(/wrong resource/i)

    expect(test.transport.deleteLocalInventory).not.toHaveBeenCalled()
  })

  it('turns a queued insert into a delete when the store has since retired', async () => {
    const test = build({ localInventory: true, retiredStoreCodes: ['old-store'] })
    await seedPublished(test, { identity: newIdentity })

    await test.execute({
      command: localApply({ storeCode: 'old-store' }),
      operationId: 'inventory-retired-race',
      payload: test.payload,
    })

    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
    expect(test.transport.deleteLocalInventory).toHaveBeenCalledWith(
      expect.objectContaining({ storeCode: 'old-store' }),
    )
  })

  it('refuses local inventory mutation after another data source takes ownership', async () => {
    const test = build({ additionalDataSourceIds: ['222222222'], localInventory: true })
    scopedMultiSource(test)
    await seedPublished(test, { identity: newIdentity })
    vi.mocked(test.transport.getProcessedProduct).mockResolvedValueOnce(
      remoteProduct({ dataSourceName: 'accounts/123456/dataSources/111111' }),
    )

    await expect(
      test.execute({
        command: localApply({ inventory: null }),
        operationId: 'inventory-source-conflict',
        payload: test.payload,
      }),
    ).rejects.toMatchObject({ code: 'GMC_PRODUCT_DATA_SOURCE_CONFLICT' })

    expect(test.transport.insertLocalInventory).not.toHaveBeenCalled()
    expect(test.transport.deleteLocalInventory).not.toHaveBeenCalled()
    expect(test.stateStore.markLocalInventoryFailed).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'inventory-source-conflict', storeCode: 'store-1' }),
    )
  })

  it('rejects a stale local-inventory command after its store is fully removed', async () => {
    const test = build({ localInventory: true })

    await expect(
      test.execute({
        command: localApply({ inventory: null, storeCode: 'removed-store' }),
        operationId: 'inventory-removed-store',
        payload: test.payload,
      }),
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

    await expect(
      test.execute({
        command: {
          type: 'localInventory.reconcile',
          productId: 'product-1',
          requestedAt: REQUESTED_AT,
          schemaVersion: 2,
          storeCode: 'store-1',
        },
        operationId: 'inventory-price-check',
        payload: test.payload,
      }),
    ).rejects.toThrow(/must not exceed regular price/i)
    expect(test.asyncAdapter.dispatch).not.toHaveBeenCalled()
  })
})
