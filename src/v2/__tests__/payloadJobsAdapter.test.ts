import type { Config, Payload, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  GmcAsyncDispatchArgs,
  GmcCommandExecutionResult,
  NormalizedGmcV2Options,
  PayloadGmcEcommerceV2Options,
} from '../types.js'

import { buildGmcOperationsCollection } from '../adapters/operationsCollection.js'
import { payloadJobsAsyncAdapter } from '../adapters/payloadJobs.js'
import { GmcAsyncIdempotencyConflictError } from '../async.js'
import { getGmcCommandIdempotencyDigest } from '../commands.js'
import { normalizeGmcV2Options } from '../config.js'

type Document = { id: string } & Record<string, unknown>

type Where = Record<string, unknown>

const COLLECTION = 'gmc-operations'

const publishCommand = (productId = 'product-1') =>
  ({
    type: 'product.publish' as const,
    cause: 'update' as const,
    productId,
    requestedAt: '2026-09-01T12:00:00.000Z',
    schemaVersion: 2 as const,
  })

const baseOptions = (): PayloadGmcEcommerceV2Options => ({
  access: () => true,
  async: payloadJobsAsyncAdapter(),
  dataSourceId: '987654321',
  getCredentials: () =>
    Promise.resolve({
      type: 'json' as const,
      credentials: { client_email: 'merchant@example.com', private_key: 'secret' },
    }),
  merchantId: '123456',
  products: {
    collection: 'products',
    project: () => ({ products: [] }),
    resolveIdentities: () => [],
  },
})

const comparable = (value: unknown): null | string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null

/** Minimal `where` evaluation covering only the operators the adapter uses. */
const matches = (document: Document, where: undefined | Where): boolean => {
  if (!where) {
    return true
  }
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'and') {
      return (condition as Where[]).every((clause) => matches(document, clause))
    }
    if (field === 'or') {
      return (condition as Where[]).some((clause) => matches(document, clause))
    }
    const value = document[field]
    return Object.entries(condition as Record<string, unknown>).every(([operator, operand]) => {
      const left = comparable(value)
      const right = comparable(operand)
      switch (operator) {
        case 'equals':
          return value === operand
        case 'exists':
          return (value !== null && value !== undefined) === operand
        case 'greater_than_equal':
          return left !== null && right !== null && left >= right
        case 'less_than':
          return left !== null && right !== null && left < right
        case 'less_than_equal':
          return left !== null && right !== null && left <= right
        default:
          throw new Error(`unsupported test operator ${operator}`)
      }
    })
  })
}

const createPayloadDouble = (seed: Document[] = [], jobDocuments: Document[] = []) => {
  const documents: Document[] = seed.map((document) => ({ ...document }))
  const jobs: Document[] = jobDocuments.map((document) => ({ ...document }))
  let sequence = documents.length
  const queued: unknown[] = []
  const collectionDocuments = (collection: string): Document[] =>
    collection === 'payload-jobs' ? jobs : documents

  const create = vi.fn(({ data }: { data: Record<string, unknown> }) => {
    if (documents.some((document) => document.key === data.key)) {
      const duplicate = new Error('duplicate key value violates unique constraint')
      return Promise.reject(duplicate)
    }
    const document: Document = {
      ...data,
      id: `op-${++sequence}`,
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:00:00.000Z',
    }
    documents.push(document)
    return Promise.resolve({ ...document })
  })

  const find = vi.fn(({ where }: { where?: Where }) =>
    Promise.resolve({
      docs: documents.filter((document) => matches(document, where)).map((doc) => ({ ...doc })),
    }),
  )

  const findByID = vi.fn(({ id, collection }: { collection: string; id: number | string }) => {
    const document = collectionDocuments(collection).find(
      (candidate) => candidate.id === String(id),
    )
    return Promise.resolve(document ? { ...document } : null)
  })

  const update = vi.fn(({ id, data }: { data: Record<string, unknown>; id: number | string }) => {
    const document = documents.find((candidate) => candidate.id === String(id))
    if (!document) {
      return Promise.reject(new Error(`missing ${String(id)}`))
    }
    Object.assign(document, data)
    return Promise.resolve({ ...document })
  })

  const count = vi.fn(({ where }: { where?: Where }) =>
    Promise.resolve({ totalDocs: documents.filter((document) => matches(document, where)).length }),
  )

  const queue = vi.fn((args: unknown) => {
    queued.push(args)
    return Promise.resolve({ id: `job-${queued.length}` })
  })

  const payload = {
    count,
    create,
    find,
    findByID,
    jobs: { queue },
    logger: { error: vi.fn(), warn: vi.fn() },
    update,
  } as unknown as Payload

  return { count, create, documents, find, findByID, jobs, payload, queue, queued, update }
}

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString()

const dispatchArgs = (
  overrides: Partial<GmcAsyncDispatchArgs> & Pick<GmcAsyncDispatchArgs, 'payload'>,
): GmcAsyncDispatchArgs => ({
  command: publishCommand(),
  idempotencyKey: 'gmc-key-1',
  subject: 'gmc:123456:product:product-1',
  ...overrides,
})

const installed = (
  adapterOptions: Parameters<typeof payloadJobsAsyncAdapter>[0] = {},
  optionOverrides: Partial<PayloadGmcEcommerceV2Options> = {},
) => {
  const adapter = payloadJobsAsyncAdapter(adapterOptions)
  const options = normalizeGmcV2Options({ ...baseOptions(), ...optionOverrides, async: adapter })
  const config = adapter.install!({ config: { collections: [] } as unknown as Config, options })
  const task = config.jobs?.tasks?.[0]
  return { adapter, config, options, task: task! }
}

describe('buildGmcOperationsCollection', () => {
  it('is a hidden, unversioned, plugin-only ledger', () => {
    const collection = buildGmcOperationsCollection({ slug: COLLECTION, access: () => true })
    expect(collection).toMatchObject({
      slug: COLLECTION,
      admin: { hidden: true },
      timestamps: true,
      versions: false,
    })
    const key = collection.fields.find((field) => 'name' in field && field.name === 'key')
    expect(key).toMatchObject({ index: true, required: true, unique: true })
    expect(collection.access?.create?.({} as never)).toBe(false)
    expect(collection.access?.delete?.({} as never)).toBe(false)
    expect(collection.access?.update?.({} as never)).toBe(false)
  })
})

describe('payloadJobsAsyncAdapter install', () => {
  it('registers the ledger collection and the retrying command task', () => {
    const { config, task } = installed({ retries: 3 })
    expect(config.collections?.map((collection) => collection.slug)).toEqual(['gmc-operations'])
    expect(task).toMatchObject({
      slug: 'gmc-command',
      inputSchema: [{ name: 'operationId', type: 'text', required: true }],
      retries: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
    })
  })

  it('never silently overrides a host task or collection with the same slug', () => {
    const adapter = payloadJobsAsyncAdapter()
    const options = normalizeGmcV2Options({ ...baseOptions(), async: adapter })
    expect(() =>
      adapter.install!({
        config: { jobs: { tasks: [{ slug: 'gmc-command' }] } } as unknown as Config,
        options,
      }),
    ).toThrow(/gmc-command/)
    expect(() =>
      adapter.install!({
        config: { collections: [{ slug: 'gmc-operations' }] } as unknown as Config,
        options,
      }),
    ).toThrow(/gmc-operations/)
  })
})

describe('payloadJobsAsyncAdapter dispatch', () => {
  it('commits the ledger row, queues the job, and records its id in one transaction', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble()
    const req = { payload: double.payload, transactionID: 'tx-1' } as unknown as PayloadRequest
    const command = publishCommand()

    const receipt = await adapter.dispatch(
      dispatchArgs({
        command,
        payload: double.payload,
        req,
        rootOperationId: 'root-1',
        scheduledFor: '2026-09-02T12:00:00.000Z',
      }),
    )

    expect(receipt).toEqual({ operationId: 'op-1', state: 'queued' })
    expect(double.create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: COLLECTION,
        data: expect.objectContaining({
          command,
          commandDigest: getGmcCommandIdempotencyDigest(command),
          commandType: 'product.publish',
          instanceId: '123456',
          key: 'gmc-key-1',
          rootOperationId: 'root-1',
          scheduledFor: '2026-09-02T12:00:00.000Z',
          state: 'queued',
          subject: 'gmc:123456:product:product-1',
        }),
        overrideAccess: true,
        req,
      }),
    )
    expect(double.queue).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { operationId: 'op-1' },
        queue: 'gmc',
        req,
        task: 'gmc-command',
        waitUntil: new Date('2026-09-02T12:00:00.000Z'),
      }),
    )
    expect(double.documents[0]).toMatchObject({ jobId: 'job-1' })
  })

  it('omits waitUntil for an immediate command', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble()
    await adapter.dispatch(dispatchArgs({ payload: double.payload }))
    expect((double.queued[0] as { waitUntil?: Date }).waitUntil).toBeUndefined()
  })

  it('returns the original operation for an immutable key replay', async () => {
    const { adapter } = installed()
    const command = publishCommand()
    const double = createPayloadDouble([
      {
        id: 'op-9',
        commandDigest: getGmcCommandIdempotencyDigest(command),
        jobId: 'job-9',
        key: 'gmc-key-1',
        state: 'succeeded',
      },
    ])

    await expect(
      adapter.dispatch(dispatchArgs({ command, payload: double.payload })),
    ).resolves.toEqual({ operationId: 'op-9', state: 'queued' })
    expect(double.create).not.toHaveBeenCalled()
    expect(double.queue).not.toHaveBeenCalled()
  })

  it('rejects an immutable key bound to different command intent', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble([
      { id: 'op-9', commandDigest: 'a-different-digest', key: 'gmc-key-1', state: 'queued' },
    ])

    await expect(
      adapter.dispatch(dispatchArgs({ payload: double.payload })),
    ).rejects.toBeInstanceOf(GmcAsyncIdempotencyConflictError)
  })

  it('recovers the original operation when the unique index wins a concurrent insert', async () => {
    const { adapter } = installed()
    const command = publishCommand()
    // The winner already published its own job, so the loser must adopt the
    // operation without putting a second message on it.
    const double = createPayloadDouble([], [{ id: 'job-race', hasError: false }])
    const winner: Document = {
      id: 'op-race',
      commandDigest: getGmcCommandIdempotencyDigest(command),
      createdAt: new Date().toISOString(),
      jobId: 'job-race',
      key: 'gmc-key-1',
      state: 'queued',
    }
    double.find.mockImplementationOnce(() => Promise.resolve({ docs: [] }))
    double.create.mockImplementationOnce(() => {
      double.documents.push(winner)
      return Promise.reject(new Error('duplicate key value violates unique constraint'))
    })

    await expect(
      adapter.dispatch(dispatchArgs({ command, payload: double.payload })),
    ).resolves.toEqual({ operationId: 'op-race', state: 'queued' })
    expect(double.queue).not.toHaveBeenCalled()
  })

  it('re-queues a stuck outbox row whose queue publication was lost', async () => {
    const { adapter } = installed()
    const command = publishCommand()
    const double = createPayloadDouble([
      {
        id: 'op-orphan',
        commandDigest: getGmcCommandIdempotencyDigest(command),
        createdAt: minutesAgo(30),
        jobId: null,
        key: 'gmc-key-1',
        scheduledFor: null,
        state: 'queued',
      },
    ])

    await expect(
      adapter.dispatch(dispatchArgs({ command, payload: double.payload })),
    ).resolves.toEqual({ operationId: 'op-orphan', state: 'queued' })
    expect(double.queue).toHaveBeenCalledWith(
      expect.objectContaining({ input: { operationId: 'op-orphan' } }),
    )
    expect(double.documents[0]).toMatchObject({ jobId: 'job-1' })
  })

  it('never re-queues a row whose concurrent dispatch has not published yet', async () => {
    const { adapter } = installed()
    const command = publishCommand()
    // Without a host transaction the winner's row commits before its `jobId`
    // does. A same-key dispatch landing inside that window must adopt the
    // operation, not publish a second job onto it.
    const double = createPayloadDouble([
      {
        id: 'op-in-flight',
        commandDigest: getGmcCommandIdempotencyDigest(command),
        createdAt: new Date().toISOString(),
        jobId: null,
        key: 'gmc-key-1',
        scheduledFor: null,
        state: 'queued',
      },
    ])

    await expect(
      adapter.dispatch(dispatchArgs({ command, payload: double.payload })),
    ).resolves.toEqual({ operationId: 'op-in-flight', state: 'queued' })
    expect(double.queue).not.toHaveBeenCalled()
  })

  it('re-drives a queued row whose job Payload has already abandoned', async () => {
    const { adapter } = installed()
    const command = publishCommand()
    const queuedRow: Document = {
      id: 'op-abandoned',
      commandDigest: getGmcCommandIdempotencyDigest(command),
      createdAt: minutesAgo(90),
      jobId: 'job-gone',
      key: 'gmc-key-1',
      scheduledFor: null,
      state: 'queued',
    }

    // The job document is gone entirely.
    const deleted = createPayloadDouble([{ ...queuedRow }], [])
    await expect(
      adapter.dispatch(dispatchArgs({ command, payload: deleted.payload })),
    ).resolves.toEqual({ operationId: 'op-abandoned', state: 'queued' })
    expect(deleted.queue).toHaveBeenCalledTimes(1)
    expect(deleted.documents[0]).toMatchObject({ jobId: 'job-1' })

    // Payload keeps a job it gave up on; `hasError` means it never runs again.
    const exhausted = createPayloadDouble(
      [{ ...queuedRow }],
      [{ id: 'job-gone', hasError: true, processing: false }],
    )
    await expect(
      adapter.dispatch(dispatchArgs({ command, payload: exhausted.payload })),
    ).resolves.toEqual({ operationId: 'op-abandoned', state: 'queued' })
    expect(exhausted.queue).toHaveBeenCalledTimes(1)
  })

  it('never re-drives a queued row whose job is still runnable', async () => {
    const { adapter } = installed()
    const command = publishCommand()
    const double = createPayloadDouble(
      [
        {
          id: 'op-live',
          commandDigest: getGmcCommandIdempotencyDigest(command),
          createdAt: minutesAgo(90),
          jobId: 'job-live',
          key: 'gmc-key-1',
          scheduledFor: null,
          state: 'queued',
        },
      ],
      [{ id: 'job-live', hasError: false, processing: false }],
    )

    await expect(
      adapter.dispatch(dispatchArgs({ command, payload: double.payload })),
    ).resolves.toEqual({ operationId: 'op-live', state: 'queued' })
    expect(double.queue).not.toHaveBeenCalled()
  })

  it('never re-drives a terminal row, however old its job reference is', async () => {
    const { adapter } = installed()
    const command = publishCommand()
    const double = createPayloadDouble([
      {
        id: 'op-done',
        commandDigest: getGmcCommandIdempotencyDigest(command),
        createdAt: minutesAgo(90),
        jobId: null,
        key: 'gmc-key-1',
        state: 'succeeded',
      },
    ])

    await expect(
      adapter.dispatch(dispatchArgs({ command, payload: double.payload })),
    ).resolves.toEqual({ operationId: 'op-done', state: 'queued' })
    expect(double.queue).not.toHaveBeenCalled()
  })

  it('never treats an unreadable jobs collection as an abandoned job', async () => {
    const { adapter } = installed()
    const command = publishCommand()
    const double = createPayloadDouble([
      {
        id: 'op-unknown',
        commandDigest: getGmcCommandIdempotencyDigest(command),
        createdAt: minutesAgo(90),
        jobId: 'job-unknown',
        key: 'gmc-key-1',
        state: 'queued',
      },
    ])
    double.findByID.mockImplementation(() => Promise.reject(new Error('jobs read failed')))

    await expect(
      adapter.dispatch(dispatchArgs({ command, payload: double.payload })),
    ).resolves.toEqual({ operationId: 'op-unknown', state: 'queued' })
    expect(double.queue).not.toHaveBeenCalled()
  })

  it('rethrows a non-duplicate ledger failure', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble()
    double.create.mockImplementationOnce(() => Promise.reject(new Error('connection reset')))
    await expect(adapter.dispatch(dispatchArgs({ payload: double.payload }))).rejects.toThrow(
      /connection reset/,
    )
  })
})

describe('payloadJobsAsyncAdapter task handler', () => {
  const executionResult: GmcCommandExecutionResult = {
    commandType: 'product.publish',
    operationId: 'op-1',
    outcome: 'completed',
  }

  const runHandler = async (args: {
    double: ReturnType<typeof createPayloadDouble>
    execute: (context: unknown) => Promise<GmcCommandExecutionResult>
    operationId?: string
    retries?: number
  }) => {
    const { task } = installed({
      createExecutor: () => args.execute as never,
      ...(args.retries === undefined ? {} : { retries: args.retries }),
    })
    const handler = task.handler as (handlerArgs: {
      input: { operationId: string }
      req: PayloadRequest
    }) => Promise<unknown>
    return handler({
      input: { operationId: args.operationId ?? 'op-1' },
      req: { payload: args.double.payload, transactionID: 'tx-job' } as unknown as PayloadRequest,
    })
  }

  const queuedRow = (overrides: Partial<Document> = {}): Document => ({
    id: 'op-1',
    attempts: 0,
    command: publishCommand(),
    commandDigest: getGmcCommandIdempotencyDigest(publishCommand()),
    commandType: 'product.publish',
    createdAt: '2026-09-01T12:00:00.000Z',
    instanceId: '123456',
    jobId: 'job-1',
    key: 'gmc-key-1',
    rootOperationId: null,
    state: 'queued',
    subject: 'gmc:123456:product:product-1',
    ...overrides,
  })

  it('executes the retained command and persists the result', async () => {
    const double = createPayloadDouble([queuedRow()])
    const execute = vi.fn(() => Promise.resolve(executionResult))

    await expect(runHandler({ double, execute })).resolves.toEqual({ output: {} })
    expect(execute).toHaveBeenCalledWith({
      command: publishCommand(),
      operationId: 'op-1',
      payload: double.payload,
      rootOperationId: 'op-1',
    })
    expect(double.documents[0]).toMatchObject({
      attempts: 1,
      result: executionResult,
      state: 'succeeded',
    })
    expect(double.documents[0]?.finishedAt).toEqual(expect.any(String))
    expect(double.documents[0]?.startedAt).toEqual(expect.any(String))
  })

  it('inherits an existing root operation for a continuation', async () => {
    const double = createPayloadDouble([queuedRow({ rootOperationId: 'root-7' })])
    const execute = vi.fn(() => Promise.resolve(executionResult))
    await runHandler({ double, execute })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ rootOperationId: 'root-7' }))
  })

  it('never re-executes an already succeeded operation', async () => {
    const double = createPayloadDouble([queuedRow({ state: 'succeeded' })])
    const execute = vi.fn(() => Promise.resolve(executionResult))
    await expect(runHandler({ double, execute })).resolves.toEqual({ output: {} })
    expect(execute).not.toHaveBeenCalled()
    expect(double.update).not.toHaveBeenCalled()
  })

  it('acknowledges an operation whose ledger row is gone', async () => {
    const double = createPayloadDouble()
    const execute = vi.fn(() => Promise.resolve(executionResult))
    await expect(runHandler({ double, execute, operationId: 'op-missing' })).resolves.toEqual({
      output: {},
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('rethrows a ledger write that fails after success so the job retries and the idempotent command re-runs', async () => {
    const double = createPayloadDouble([queuedRow()])
    const execute = vi.fn(() => Promise.resolve(executionResult))
    const persist = double.update.getMockImplementation()!
    let writes = 0
    double.update.mockImplementation((args) => {
      writes += 1
      // 1 = the `running` claim, 2 = the success persist.
      return writes === 2
        ? Promise.reject(new Error('ledger write failed'))
        : persist(args as never)
    })

    await expect(runHandler({ double, execute })).rejects.toThrow(/ledger write failed/)
    expect(execute).toHaveBeenCalledTimes(1)
    // The command result is not reclassified as a command failure, and the row
    // is left mid-flight rather than being buried under `failed`.
    expect(double.documents[0]).toMatchObject({ attempts: 1, state: 'running' })
    expect(double.documents[0]?.error).toBeUndefined()
    expect(double.documents[0]?.result).toBeUndefined()
  })

  it('never acknowledges an operation when the ledger itself is unreachable', async () => {
    const double = createPayloadDouble([queuedRow()])
    const execute = vi.fn(() => Promise.resolve(executionResult))
    double.findByID.mockImplementation(() => Promise.reject(new Error('ledger unreachable')))

    await expect(runHandler({ double, execute })).rejects.toThrow(/ledger unreachable/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('persists a retryable failure, requeues the row, and rethrows for the queue', async () => {
    const double = createPayloadDouble([queuedRow()])
    const execute = vi.fn(() => Promise.reject(new Error('merchant transport reset')))

    await expect(runHandler({ double, execute })).rejects.toThrow(/merchant transport reset/)
    expect(double.documents[0]).toMatchObject({
      attempts: 1,
      error: { message: 'merchant transport reset', retryable: true },
      finishedAt: null,
      state: 'queued',
    })
  })

  it('fails a non-retryable command terminally and acknowledges to avoid a poison loop', async () => {
    const double = createPayloadDouble([queuedRow()])
    const execute = vi.fn(() => Promise.reject(new TypeError('invalid projection')))

    await expect(runHandler({ double, execute })).resolves.toEqual({ output: {} })
    expect(double.documents[0]).toMatchObject({
      error: { message: 'invalid projection', retryable: false },
      state: 'failed',
    })
    expect(double.documents[0]?.finishedAt).toEqual(expect.any(String))
  })

  it('dead-letters a retryable command once the durable retry budget is exhausted', async () => {
    const double = createPayloadDouble([queuedRow({ attempts: 2 })])
    const execute = vi.fn(() => Promise.reject(new Error('merchant transport reset')))

    await expect(runHandler({ double, execute, retries: 2 })).resolves.toEqual({ output: {} })
    expect(double.documents[0]).toMatchObject({ attempts: 3, state: 'dead-lettered' })
  })
})

describe('payloadJobsAsyncAdapter getOperation', () => {
  const ledger = (): Document[] => [
    {
      id: 'root-1',
      attempts: 1,
      commandType: 'catalog.publish',
      createdAt: '2026-09-01T12:00:00.000Z',
      finishedAt: '2026-09-01T12:00:05.000Z',
      instanceId: '123456',
      rootOperationId: null,
      startedAt: '2026-09-01T12:00:01.000Z',
      state: 'succeeded',
      subject: 'gmc:123456:catalog',
    },
    {
      id: 'child-1',
      instanceId: '123456',
      rootOperationId: 'root-1',
      state: 'succeeded',
      subject: 'gmc:123456:product:1',
    },
    {
      id: 'child-2',
      instanceId: '123456',
      rootOperationId: 'root-1',
      state: 'queued',
      subject: 'gmc:123456:product:2',
    },
  ]

  it('reports aggregate workflow state, not coordinator completion', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble(ledger())

    await expect(
      adapter.getOperation({
        instanceId: '123456',
        operationId: 'root-1',
        payload: double.payload,
      }),
    ).resolves.toMatchObject({
      attempts: 1,
      childCounts: { queued: 1, succeeded: 1 },
      commandType: 'catalog.publish',
      finishedAt: '2026-09-01T12:00:05.000Z',
      operationId: 'root-1',
      requestedState: 'succeeded',
      startedAt: '2026-09-01T12:00:01.000Z',
      state: 'queued',
      submittedAt: '2026-09-01T12:00:00.000Z',
    })
  })

  it('applies dead-lettered over failed over running precedence', async () => {
    const { adapter } = installed()
    const rows = ledger()
    rows[2] = { ...rows[2], state: 'running' }
    rows.push({
      id: 'child-3',
      instanceId: '123456',
      rootOperationId: 'root-1',
      state: 'failed',
      subject: 'gmc:123456:product:3',
    })
    const double = createPayloadDouble(rows)

    await expect(
      adapter.getOperation({
        instanceId: '123456',
        operationId: 'root-1',
        payload: double.payload,
      }),
    ).resolves.toMatchObject({ state: 'failed' })

    rows.push({
      id: 'child-4',
      instanceId: '123456',
      rootOperationId: 'root-1',
      state: 'dead-lettered',
      subject: 'gmc:123456:product:4',
    })
    await expect(
      adapter.getOperation({
        instanceId: '123456',
        operationId: 'root-1',
        payload: createPayloadDouble(rows).payload,
      }),
    ).resolves.toMatchObject({ state: 'dead-lettered' })
  })

  it('resolves a descendant against its retained root lineage', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble(ledger())

    await expect(
      adapter.getOperation({
        instanceId: '123456',
        operationId: 'child-1',
        payload: double.payload,
      }),
    ).resolves.toMatchObject({
      operationId: 'child-1',
      requestedState: 'succeeded',
      rootOperationId: 'root-1',
      state: 'queued',
    })
  })

  it('treats an operation ID the database cannot parse as not found', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble(ledger())
    double.findByID.mockImplementation(() =>
      Promise.reject(new Error('invalid input syntax for type integer: "not-an-id"')),
    )

    await expect(
      adapter.getOperation({
        instanceId: '123456',
        operationId: 'not-an-id',
        payload: double.payload,
      }),
    ).resolves.toBeNull()
  })

  it('never returns an operation owned by another plugin instance', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble(ledger())

    await expect(
      adapter.getOperation({
        instanceId: 'other-instance',
        operationId: 'root-1',
        payload: double.payload,
      }),
    ).resolves.toBeNull()
    await expect(
      adapter.getOperation({
        instanceId: '123456',
        operationId: 'missing',
        payload: double.payload,
      }),
    ).resolves.toBeNull()
  })
})

describe('payloadJobsAsyncAdapter health', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T13:00:00.000Z'))
  })

  const row = (overrides: Partial<Document>): Document => ({
    id: `row-${Math.random()}`,
    createdAt: '2026-09-01T12:59:30.000Z',
    instanceId: '123456',
    scheduledFor: null,
    state: 'queued',
    subject: 'gmc:123456:catalog',
    ...overrides,
  })

  it('reports ok for a live, drained ledger', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble([row({}), row({ state: 'running' })])
    await expect(
      adapter.health({ instanceId: '123456', payload: double.payload }),
    ).resolves.toMatchObject({
      details: { queued: 1, running: 1, staleQueued: 0 },
      status: 'ok',
    })
    vi.useRealTimers()
  })

  it('degrades on a stale queue backlog', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble([row({ createdAt: '2026-09-01T12:00:00.000Z' })])
    await expect(
      adapter.health({ instanceId: '123456', payload: double.payload }),
    ).resolves.toMatchObject({
      details: { reasons: ['queue_backlog_stale'], staleQueued: 1 },
      status: 'degraded',
    })
    vi.useRealTimers()
  })

  it('ignores a not-yet-due scheduled command in the backlog measurement', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble([
      row({ createdAt: '2026-09-01T12:00:00.000Z', scheduledFor: '2026-09-02T12:00:00.000Z' }),
    ])
    await expect(
      adapter.health({ instanceId: '123456', payload: double.payload }),
    ).resolves.toMatchObject({ details: { staleQueued: 0 }, status: 'ok' })
    vi.useRealTimers()
  })

  it('degrades while a recent dead letter is retained', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble([
      row({ finishedAt: '2026-09-01T12:30:00.000Z', state: 'dead-lettered' }),
    ])
    await expect(
      adapter.health({ instanceId: '123456', payload: double.payload }),
    ).resolves.toMatchObject({
      details: { deadLettered: 1, reasons: ['dead_letters_present'] },
      status: 'degraded',
    })
    vi.useRealTimers()
  })

  it('reports error when the ledger itself is unreachable', async () => {
    const { adapter } = installed()
    const double = createPayloadDouble()
    double.count.mockImplementation(() => Promise.reject(new Error('ledger unreachable')))
    await expect(
      adapter.health({ instanceId: '123456', payload: double.payload }),
    ).resolves.toMatchObject({
      details: { error: 'ledger unreachable' },
      status: 'error',
    })
    vi.useRealTimers()
  })
})

describe('payloadJobsAsyncAdapter capabilities', () => {
  it('declares durable scheduled delivery and no per-subject ordering', () => {
    const adapter = payloadJobsAsyncAdapter()
    expect(adapter.name).toBe('payload-jobs')
    expect(adapter.capabilities).toMatchObject({
      orderedBySubject: false,
      scheduledDelivery: true,
    })
  })

  it('normalizes into plugin options that accept dependency schedules', () => {
    const options: NormalizedGmcV2Options = normalizeGmcV2Options({
      ...baseOptions(),
      async: payloadJobsAsyncAdapter(),
    })
    expect(options.async.capabilities?.scheduledDelivery).toBe(true)
  })
})
