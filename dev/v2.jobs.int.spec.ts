import type { Payload } from 'payload'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig, getPayload } from 'payload'
import {
  createProductPublishCommand,
  type GmcAsyncAdapter,
  type GmcCommandExecutionContext,
  type GmcCommandExecutionResult,
  GmcAsyncIdempotencyConflictError,
  payloadGmcEcommerceV2,
  payloadJobsAsyncAdapter,
  type PayloadGmcEcommerceV2Options,
} from 'payload-plugin-gmc-ecommerce/v2'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { testEmailAdapter } from './helpers/testEmailAdapter.js'

// @payloadcms/drizzle memoizes the last-pushed dev schema at module scope for
// the whole process. This suite builds its own Payload instance against the
// same collection names as dev/v2.int.spec.ts, so the push must not be skipped
// when both files land in one vitest worker.
process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const databaseFile = path.resolve(dirname, '.tmp', `v2-jobs-${process.pid}.db`)
const databaseKind = process.env.GMC_V2_TEST_DATABASE ?? 'sqlite'
const INSTANCE_ID = '123456'
const LEDGER = 'gmc-operations'

type LedgerRow = { id: number | string } & Record<string, unknown>

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required for the ${databaseKind} v2 jobs integration test`)
  }
  return value
}

const databaseAdapter = () => {
  if (databaseKind === 'mongodb') {
    return mongooseAdapter({ url: requiredEnvironment('GMC_V2_MONGODB_URL') })
  }
  if (databaseKind === 'postgres') {
    return postgresAdapter({
      pool: { connectionString: requiredEnvironment('GMC_V2_POSTGRES_URL') },
      push: true,
      // dev/v2.int.spec.ts owns the default schema in the sequential matrix
      // run against this same database.
      schemaName: `gmc_v2_jobs_${process.pid}`,
    })
  }
  if (databaseKind !== 'sqlite') {
    throw new Error(`Unsupported GMC_V2_TEST_DATABASE: ${databaseKind}`)
  }
  return sqliteAdapter({
    client: { url: `file:${databaseFile}` },
    // v2's automatic hooks require a real atomic canonical-write + outbox
    // boundary. Payload's SQLite adapter defaults transactions off.
    transactionOptions: {},
  })
}

let payload: Payload
let adapter: GmcAsyncAdapter
const executed: GmcCommandExecutionContext[] = []
const execute = vi.fn((context: GmcCommandExecutionContext) => {
  executed.push(context)
  return Promise.resolve<GmcCommandExecutionResult>({
    commandType: context.command.type,
    operationId: context.operationId,
    outcome: 'completed',
  })
})

const ledgerRows = async (where: Record<string, unknown> = {}): Promise<LedgerRow[]> => {
  const result = await payload.find({
    collection: LEDGER as never,
    depth: 0,
    limit: 100,
    overrideAccess: true,
    pagination: false,
    sort: 'createdAt',
    where,
  })
  return result.docs as unknown as LedgerRow[]
}

const jobRows = async (): Promise<LedgerRow[]> => {
  const result = await payload.find({
    collection: 'payload-jobs' as never,
    depth: 0,
    limit: 100,
    overrideAccess: true,
    pagination: false,
  })
  return result.docs as unknown as LedgerRow[]
}

beforeAll(async () => {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true })
  fs.rmSync(databaseFile, { force: true })

  adapter = payloadJobsAsyncAdapter({
    createExecutor: () => execute as never,
    queue: 'gmc',
    retries: 2,
  })

  const options: PayloadGmcEcommerceV2Options = {
    access: () => true,
    async: adapter,
    catalogDependencies: [
      {
        collection: 'promos',
        scheduleAt: ({ doc }) => (doc.startsAt ? [new Date(String(doc.startsAt)).toISOString()] : []),
        select: ({ doc }) => ({ title: doc.title }),
      },
    ],
    dataSourceId: '987654321',
    getCredentials: () =>
      Promise.resolve({
        type: 'json',
        credentials: { client_email: 'merchant@example.test', private_key: 'not-used' },
      }),
    merchantId: INSTANCE_ID,
    products: {
      collection: 'products',
      project: ({ doc }) => ({
        products: [
          {
            contentLanguage: 'en',
            feedLabel: 'US',
            offerId: String(doc.sku),
            productAttributes: { title: String(doc.title) },
          },
        ],
      }),
      resolveIdentities: ({ doc }) => [
        { contentLanguage: 'en', feedLabel: 'US', offerId: String(doc.sku) },
      ],
    },
    requireTransaction: true,
  }

  const config = await buildConfig({
    collections: [
      {
        slug: 'products',
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'sku', type: 'text', required: true, unique: true },
        ],
        versions: { drafts: true },
      },
      {
        slug: 'promos',
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'startsAt', type: 'date' },
        ],
      },
    ],
    db: databaseAdapter(),
    email: testEmailAdapter,
    plugins: [payloadGmcEcommerceV2(options)],
    secret: 'gmc-v2-jobs-integration-secret-123456789',
  })

  // Payload caches instances globally by key; dev/v2.int.spec.ts may already
  // hold the default one when both files share a vitest worker.
  payload = await getPayload({ config, key: `gmc-v2-jobs-${process.pid}` })
  if (databaseKind === 'mongodb') {
    // MongoDB cannot commit a transaction while a lazily initialized model is
    // concurrently changing the collection catalog, and the first product
    // write here commits a ledger row and a job row inside one.
    const models = Object.values(
      (payload.db as unknown as { collections: Record<string, { init: () => Promise<unknown> }> })
        .collections,
    )
    await Promise.all(models.map((model) => model.init()))
    // A shared Mongo database survives between matrix legs; start from empty.
    // Canonical collections go first: deleting them fires the plugin's own
    // hooks, which would otherwise dispatch into a just-cleared ledger.
    for (const collection of ['products', 'promos', LEDGER, 'payload-jobs']) {
      await payload.delete({
        collection: collection as never,
        overrideAccess: true,
        where: { id: { exists: true } },
      })
    }
  }
}, 120_000)

afterAll(async () => {
  if (typeof payload?.db?.destroy === 'function') {
    await payload.db.destroy()
  }
  fs.rmSync(databaseFile, { force: true })
})

describe(`payloadJobsAsyncAdapter against the real Payload ${databaseKind} adapter`, () => {
  it('installs a hidden ledger collection and the command task', () => {
    expect(payload.collections[LEDGER]).toBeDefined()
    expect(payload.config.jobs?.tasks?.map((task) => task.slug)).toContain('gmc-command')
    const ledger = payload.config.collections.find((collection) => collection.slug === LEDGER)
    expect(ledger?.admin?.hidden).toBe(true)
    expect(ledger?.versions).toBeFalsy()
  })

  it('commits one ledger row and one queued job with the canonical product write', async () => {
    const created = await payload.create({
      collection: 'products',
      data: { _status: 'published', sku: 'JOBS-1', title: 'Jobs product' },
    })

    const rows = await ledgerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      attempts: 0,
      commandType: 'product.publish',
      instanceId: INSTANCE_ID,
      state: 'queued',
      subject: `gmc:${INSTANCE_ID}:product:${String(created.id)}`,
    })
    expect(rows[0]?.jobId).toBeTruthy()
    expect(String((rows[0]?.command as { productId: unknown }).productId)).toBe(String(created.id))

    const jobs = await jobRows()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ queue: 'gmc', taskSlug: 'gmc-command' })
    expect(String(jobs[0]?.id)).toBe(String(rows[0]?.jobId))
  })

  it('runs the queued job through the executor and retains the result', async () => {
    executed.length = 0
    // `sequential` throughout this suite: Payload runs a queue concurrently by
    // default, and two handlers each opening their own SQLite write
    // transaction deadlock the file with SQLITE_BUSY. A SQLite host running
    // this adapter needs the same setting.
    await payload.jobs.run({ queue: 'gmc', sequential: true })

    expect(executed).toHaveLength(1)
    expect(executed[0]?.command.type).toBe('product.publish')
    const [row] = await ledgerRows({ commandType: { equals: 'product.publish' } })
    expect(row).toMatchObject({ attempts: 1, state: 'succeeded' })
    expect(row?.startedAt).toBeTruthy()
    expect(row?.finishedAt).toBeTruthy()
    expect(row?.result).toMatchObject({ commandType: 'product.publish', outcome: 'completed' })
    expect(executed[0]?.operationId).toBe(String(row?.id))
    // A root command is its own workflow root.
    expect(executed[0]?.rootOperationId).toBe(String(row?.id))
  })

  it('reports the completed operation through getOperation and scopes it to the instance', async () => {
    const [row] = await ledgerRows({ commandType: { equals: 'product.publish' } })
    const operationId = String(row?.id)

    await expect(
      adapter.getOperation({ instanceId: INSTANCE_ID, operationId, payload }),
    ).resolves.toMatchObject({
      attempts: 1,
      commandType: 'product.publish',
      operationId,
      requestedState: 'succeeded',
      state: 'succeeded',
    })
    await expect(
      adapter.getOperation({ instanceId: 'another-instance', operationId, payload }),
    ).resolves.toBeNull()
  })

  it('defers a scheduled dependency command until its not-before instant', async () => {
    const startsAt = new Date(Date.now() + 86_400_000).toISOString()
    await payload.create({ collection: 'promos', data: { title: 'Future promo', startsAt } })

    const scheduled = (await ledgerRows({ scheduledFor: { exists: true } })).filter(
      (row) => row.scheduledFor !== null && row.scheduledFor !== undefined,
    )
    expect(scheduled).toHaveLength(1)
    expect(new Date(String(scheduled[0]?.scheduledFor)).toISOString()).toBe(startsAt)

    const scheduledJob = (await jobRows()).find(
      (job) => String(job.id) === String(scheduled[0]?.jobId),
    )
    expect(new Date(String(scheduledJob?.waitUntil)).getTime()).toBeGreaterThan(Date.now())

    executed.length = 0
    await payload.jobs.run({ queue: 'gmc', sequential: true })

    // The immediate dependency invalidation runs; the scheduled root does not.
    expect(executed.some((context) => context.command.type === 'catalog.publish')).toBe(true)
    expect(executed.some((context) => context.operationId === String(scheduled[0]?.id))).toBe(false)
    const [stillQueued] = await ledgerRows({ id: { equals: scheduled[0]?.id } })
    expect(stillQueued?.state).toBe('queued')
  })

  it('returns the retained operation for an immutable key replay and rejects new intent', async () => {
    const command = createProductPublishCommand({ cause: 'manual', productId: 'idempotency-1' })
    const dispatchArgs = {
      command,
      idempotencyKey: 'gmc-jobs-idempotency-1',
      payload,
      subject: `gmc:${INSTANCE_ID}:product:idempotency-1`,
    }

    const first = await adapter.dispatch(dispatchArgs)
    const replay = await adapter.dispatch({
      ...dispatchArgs,
      // A hook redelivery rebuilds `requestedAt`; the plugin digest ignores it,
      // so this must return the original operation rather than a new one.
      command: { ...command, requestedAt: new Date(Date.now() + 1_000).toISOString() },
    })
    expect(replay).toEqual(first)
    expect(await ledgerRows({ key: { equals: 'gmc-jobs-idempotency-1' } })).toHaveLength(1)

    await expect(
      adapter.dispatch({
        ...dispatchArgs,
        command: createProductPublishCommand({ cause: 'manual', productId: 'idempotency-2' }),
      }),
    ).rejects.toBeInstanceOf(GmcAsyncIdempotencyConflictError)
  })

  it('re-drives a queued row whose job document is gone when the same key is dispatched again', async () => {
    const dispatchArgs = {
      command: createProductPublishCommand({ cause: 'manual', productId: 'abandoned-1' }),
      idempotencyKey: 'gmc-jobs-abandoned-1',
      payload,
      subject: `gmc:${INSTANCE_ID}:product:abandoned-1`,
    }
    const receipt = await adapter.dispatch(dispatchArgs)
    const [before] = await ledgerRows({ id: { equals: receipt.operationId } })
    const abandonedJobId = String(before?.jobId)
    expect(abandonedJobId).toBeTruthy()

    // Simulate the job Payload will never run again. Real job IDs are integers
    // on SQLite/Postgres and ObjectIds on Mongo, so this also proves the
    // ledger's stringified `jobId` round-trips back through `findByID`.
    await payload.delete({
      id: abandonedJobId,
      collection: 'payload-jobs' as never,
      overrideAccess: true,
    })

    // The adapter's abandonment check depends on this exact contract, so pin it
    // per database: a missing document reads as null rather than throwing.
    await expect(
      payload.findByID({
        id: abandonedJobId,
        collection: 'payload-jobs' as never,
        depth: 0,
        disableErrors: true,
        overrideAccess: true,
      }),
    ).resolves.toBeNull()

    const replay = await adapter.dispatch(dispatchArgs)
    expect(replay).toEqual(receipt)
    const [after] = await ledgerRows({ id: { equals: receipt.operationId } })
    expect(after?.jobId).toBeTruthy()
    expect(await ledgerRows({ key: { equals: 'gmc-jobs-abandoned-1' } })).toHaveLength(1)

    // SQLite reuses a deleted rowid, so recovery is proved by liveness rather
    // than by a changed ID: the retained row points at a runnable job again,
    // and that job carries this operation.
    const revived = await payload.findByID({
      id: String(after?.jobId),
      collection: 'payload-jobs' as never,
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
    })
    expect(revived).not.toBeNull()
    expect(revived).toMatchObject({
      input: { operationId: receipt.operationId },
      queue: 'gmc',
      taskSlug: 'gmc-command',
    })

    // A third dispatch now finds a live job and must not publish another.
    const before3 = (await jobRows()).length
    await adapter.dispatch(dispatchArgs)
    const [settled] = await ledgerRows({ id: { equals: receipt.operationId } })
    expect(String(settled?.jobId)).toBe(String(after?.jobId))
    expect((await jobRows()).length).toBe(before3)
  })

  it('measures live ledger health per instance', async () => {
    await payload.jobs.run({ queue: 'gmc', sequential: true })
    await expect(adapter.health({ instanceId: INSTANCE_ID, payload })).resolves.toMatchObject({
      details: { reasons: [], staleQueued: 0 },
      status: 'ok',
    })
    await expect(adapter.health({ instanceId: 'another-instance', payload })).resolves.toMatchObject(
      { details: { deadLettered: 0, queued: 0 }, status: 'ok' },
    )
  })

  it('dead-letters a retryable command once the durable retry budget is exhausted', async () => {
    const receipt = await adapter.dispatch({
      command: createProductPublishCommand({ cause: 'manual', productId: 'dead-letter-1' }),
      idempotencyKey: 'gmc-jobs-dead-letter-1',
      payload,
      subject: `gmc:${INSTANCE_ID}:product:dead-letter-1`,
    })
    // retries: 2 allows three executions; start on the last one so the durable
    // backoff schedule does not have to elapse inside the test.
    await payload.update({
      id: receipt.operationId,
      collection: LEDGER as never,
      data: { attempts: 2 } as never,
      overrideAccess: true,
    })
    execute.mockImplementation(() => Promise.reject(new Error('merchant transport unavailable')))

    await payload.jobs.run({ queue: 'gmc', sequential: true })

    const [row] = await ledgerRows({ id: { equals: receipt.operationId } })
    expect(row).toMatchObject({ attempts: 3, state: 'dead-lettered' })
    expect((row?.error as { retryable: boolean }).retryable).toBe(true)
    await expect(
      adapter.getOperation({ instanceId: INSTANCE_ID, operationId: receipt.operationId, payload }),
    ).resolves.toMatchObject({ state: 'dead-lettered' })
    await expect(adapter.health({ instanceId: INSTANCE_ID, payload })).resolves.toMatchObject({
      details: { deadLettered: 1, reasons: ['dead_letters_present'] },
      status: 'degraded',
    })
  })
})
