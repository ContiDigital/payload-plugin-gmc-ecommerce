import type { Config, Payload, PayloadRequest, TaskConfig, Where } from 'payload'

import type {
  GmcAsyncAdapter,
  GmcAsyncChildState,
  GmcAsyncDispatchArgs,
  GmcAsyncHealth,
  GmcAsyncOperation,
  GmcCommand,
  GmcCommandExecutionResult,
  GmcDispatchReceipt,
  GmcV2CommandType,
  NormalizedGmcV2Options,
} from '../types.js'

import { GmcAsyncIdempotencyConflictError } from '../async.js'
import { getGmcCommandIdempotencyDigest } from '../commands.js'
import { classifyGmcCommandError } from '../errors.js'
import { createGmcCommandExecutor } from '../executor.js'
import { isDuplicateError } from '../state/duplicateError.js'
import { GMC_V2_COMMAND_TYPES } from '../types.js'
import { buildGmcOperationsCollection, GMC_OPERATION_STATES } from './operationsCollection.js'

export type PayloadJobsAsyncAdapterOptions = {
  /** Ledger collection slug. Default `gmc-operations`. */
  collectionSlug?: string
  /** Test seam: override how the task obtains an executor. Bypasses the cache. */
  createExecutor?: (options: NormalizedGmcV2Options) => ReturnType<typeof createGmcCommandExecutor>
  /** Payload Jobs queue name. Default `gmc`. */
  queue?: string
  /** Durable retries after the first attempt. Default 5. */
  retries?: number
  /** Payload Jobs task slug. Default `gmc-command`. */
  taskSlug?: string
}

type GmcOperationsLedgerRow = {
  attempts?: null | number
  command?: unknown
  commandDigest?: null | string
  commandType?: null | string
  createdAt?: unknown
  error?: unknown
  finishedAt?: unknown
  id: number | string
  instanceId?: null | string
  jobId?: null | string
  parentOperationId?: null | string
  result?: unknown
  rootOperationId?: null | string
  scheduledFor?: unknown
  startedAt?: unknown
  state?: null | string
  subject?: null | string
}

const DEFAULT_COLLECTION_SLUG = 'gmc-operations'
const DEFAULT_QUEUE = 'gmc'
const DEFAULT_RETRIES = 5
const DEFAULT_TASK_SLUG = 'gmc-command'
/** Base delay of the exponential Payload Jobs backoff between attempts. */
const RETRY_BACKOFF_MS = 30_000
/** A queued row older than this with no future not-before time is backlog. */
const STALE_QUEUE_MS = 15 * 60_000
/**
 * How long a committed row may hold a null `jobId` before a re-dispatch treats
 * it as a stuck outbox rather than a dispatch which is still in flight. Without
 * a host transaction the row commits before its `jobId` does, so a concurrent
 * same-key dispatch can observe that exact gap; republishing inside it would
 * put two jobs on one row.
 */
const OUTBOX_STUCK_MS = 60_000
const DEAD_LETTER_WINDOW_MS = 24 * 60 * 60_000

/**
 * One executor per normalized plugin option object, shared by every job in the
 * process. The executor owns the rate limiter and the data-source validation
 * cache, so rebuilding it per job would silently multiply the Merchant request
 * budget.
 */
const executorCache = new WeakMap<
  NormalizedGmcV2Options,
  ReturnType<typeof createGmcCommandExecutor>
>()

const toIsoString = (value: unknown): string | undefined => {
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

const isOperationState = (value: unknown): value is GmcAsyncChildState =>
  typeof value === 'string' && (GMC_OPERATION_STATES as readonly string[]).includes(value)

const isCommandType = (value: unknown): value is GmcV2CommandType =>
  typeof value === 'string' && (GMC_V2_COMMAND_TYPES as readonly string[]).includes(value)

/**
 * The plugin never sends `instanceId` with a dispatch; the namespace lives in
 * the retained subject (`gmc:<instanceId>:<subject>`). Denormalizing it keeps
 * status and health reads on an indexed equality instead of a prefix scan.
 */
const parseSubjectInstanceId = (subject: string): null | string => {
  const match = /^gmc:([\w.-]+):/.exec(subject)
  return match?.[1] ?? null
}

const toLedgerError = (value: unknown): GmcAsyncOperation['error'] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const candidate = value as { code?: unknown; message?: unknown; retryable?: unknown }
  if (typeof candidate.message !== 'string' || candidate.message.trim() === '') {
    return undefined
  }
  return {
    ...(typeof candidate.code === 'string' && candidate.code.trim() !== ''
      ? { code: candidate.code.slice(0, 128) }
      : {}),
    message: candidate.message.slice(0, 4_000),
    ...(typeof candidate.retryable === 'boolean' ? { retryable: candidate.retryable } : {}),
  }
}

/**
 * Aggregate workflow precedence from the adapter contract: a coordinator which
 * returned is not a succeeded workflow while any descendant is non-terminal.
 */
const aggregateState = (counts: Record<GmcAsyncChildState, number>): GmcAsyncChildState => {
  if (counts['dead-lettered'] > 0) {
    return 'dead-lettered'
  }
  if (counts.failed > 0) {
    return 'failed'
  }
  if (counts.running > 0) {
    return 'running'
  }
  if (counts.queued > 0) {
    return 'queued'
  }
  if (counts.succeeded > 0) {
    return 'succeeded'
  }
  return 'cancelled'
}

/**
 * Durable async adapter built on Payload's own Jobs queue.
 *
 * `install()` adds a plugin-owned ledger collection and registers one task.
 * The ledger — not `payload-jobs` — is the authority for idempotency, status,
 * lineage and audit history, because Payload deletes a job row once it
 * succeeds.
 *
 * Operational notes:
 * - Something must actually run the queue. Use `jobs.autoRun` on a long-lived
 *   host, or an external cron hitting `/api/payload-jobs/run` on serverless
 *   platforms where `autoRun` must not be used.
 * - Payload Jobs does not guarantee per-subject FIFO execution, so this
 *   adapter declares `orderedBySubject: false`. The executor's desired-state
 *   digest and `desiredAt` fencing still converge out-of-order delivery, but a
 *   deployment needing strict per-subject ordering wants a FIFO transport.
 */
export const payloadJobsAsyncAdapter = (
  adapterOptions: PayloadJobsAsyncAdapterOptions = {},
): GmcAsyncAdapter => {
  const collectionSlug = adapterOptions.collectionSlug ?? DEFAULT_COLLECTION_SLUG
  const queue = adapterOptions.queue ?? DEFAULT_QUEUE
  const taskSlug = adapterOptions.taskSlug ?? DEFAULT_TASK_SLUG
  const retries = adapterOptions.retries ?? DEFAULT_RETRIES

  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: payloadJobsAsyncAdapter retries must be a non-negative integer',
    )
  }

  const getExecutor = (
    options: NormalizedGmcV2Options,
  ): ReturnType<typeof createGmcCommandExecutor> => {
    if (adapterOptions.createExecutor) {
      return adapterOptions.createExecutor(options)
    }
    const cached = executorCache.get(options)
    if (cached) {
      return cached
    }
    const created = createGmcCommandExecutor(options)
    executorCache.set(options, created)
    return created
  }

  /**
   * `disableErrors` makes a missing row `null` while a real database failure
   * still throws, which is what the worker needs: an unreachable ledger must
   * retry the job, never look like a deleted operation.
   */
  const readRow = async (args: {
    id: string
    payload: Payload
    req?: PayloadRequest
  }): Promise<GmcOperationsLedgerRow | null> => {
    const document = await args.payload.findByID({
      id: args.id,
      collection: collectionSlug as never,
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req: args.req,
    })
    return (document as unknown as GmcOperationsLedgerRow | null) ?? null
  }

  /**
   * Status reads take an operation ID straight from an authenticated HTTP
   * route, so an ID the database cannot even parse (a word against a Postgres
   * integer key) is "not found", never a 500.
   */
  const readRowForStatus = async (args: {
    id: string
    payload: Payload
    req?: PayloadRequest
  }): Promise<GmcOperationsLedgerRow | null> => {
    try {
      return await readRow(args)
    } catch {
      return null
    }
  }

  const findByKey = async (args: {
    key: string
    payload: Payload
    req?: PayloadRequest
  }): Promise<GmcOperationsLedgerRow | null> => {
    const result = await args.payload.find({
      collection: collectionSlug as never,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      req: args.req,
      where: { key: { equals: args.key } },
    })
    return (result.docs[0] as unknown as GmcOperationsLedgerRow | undefined) ?? null
  }

  const updateRow = async (args: {
    data: Record<string, unknown>
    id: string
    payload: Payload
    req?: PayloadRequest
  }): Promise<void> => {
    await args.payload.update({
      id: args.id,
      collection: collectionSlug as never,
      data: args.data as never,
      depth: 0,
      overrideAccess: true,
      req: args.req,
    })
  }

  const countRows = async (args: {
    payload: Payload
    req?: PayloadRequest
    where: Where
  }): Promise<number> => {
    const result = await args.payload.count({
      collection: collectionSlug as never,
      overrideAccess: true,
      req: args.req,
      where: args.where,
    })
    return result.totalDocs
  }

  /**
   * Publish the queue message and promote the ledger row to owning it. Inside a
   * host transaction both writes commit with the canonical change, so a
   * rollback leaves neither a row nor a message.
   */
  const publishJob = async (args: {
    operationId: string
    payload: Payload
    req?: PayloadRequest
    scheduledFor?: null | string
  }): Promise<void> => {
    const waitUntil = args.scheduledFor ? new Date(args.scheduledFor) : undefined
    // The task slug is configured at install time, so it is never a member of a
    // host's generated `TaskSlug` union; the whole argument is widened together
    // because narrowing `task` alone forces `input` to `never`.
    const queueArgs = {
      input: { operationId: args.operationId },
      queue,
      req: args.req,
      task: taskSlug,
      ...(waitUntil === undefined || Number.isNaN(waitUntil.getTime()) ? {} : { waitUntil }),
    } as unknown as Parameters<Payload['jobs']['queue']>[0]
    const job = await args.payload.jobs.queue(queueArgs)
    const jobId = (job as { id?: number | string } | undefined)?.id
    await updateRow({
      id: args.operationId,
      data: { jobId: jobId === undefined || jobId === null ? null : String(jobId) },
      payload: args.payload,
      req: args.req,
    })
  }

  /**
   * True when Payload will never run this job again. `findByID` with
   * `disableErrors` returns null for a missing document on both 3.37.0 and
   * 3.88.0 (`collections/operations/findByID.js`), and Payload only deletes a
   * job it completed successfully, so a retained row carrying `hasError` is one
   * whose retries are exhausted — Payload writes exactly `hasError: true,
   * processing: false` at that point.
   */
  const isJobAbandoned = async (args: {
    jobId: string
    payload: Payload
    req?: PayloadRequest
  }): Promise<boolean> => {
    try {
      const job = await args.payload.findByID({
        id: args.jobId,
        collection: 'payload-jobs' as never,
        depth: 0,
        disableErrors: true,
        overrideAccess: true,
        req: args.req,
      })
      if (!job) {
        return true
      }
      const candidate = job as unknown as { hasError?: unknown; processing?: unknown }
      return candidate.hasError === true && candidate.processing !== true
    } catch {
      // An unreadable jobs collection is not evidence of abandonment. Failing
      // closed here is what keeps a transient error from double-publishing.
      return false
    }
  }

  /**
   * A re-dispatch of the same immutable key is the operator remediation for a
   * queued row nothing will ever run: an outbox which never published, or a
   * job Payload has given up on. Both are republished onto the original row, so
   * the operation ID and its lineage never change.
   */
  const needsRepublish = async (args: {
    payload: Payload
    req?: PayloadRequest
    row: GmcOperationsLedgerRow
  }): Promise<boolean> => {
    if (args.row.state !== 'queued') {
      return false
    }
    if (args.row.jobId == null) {
      const createdAt = toIsoString(args.row.createdAt)
      return (
        createdAt !== undefined && Date.now() - Date.parse(createdAt) >= OUTBOX_STUCK_MS
      )
    }
    return await isJobAbandoned({ jobId: args.row.jobId, payload: args.payload, req: args.req })
  }

  const dispatch = async (args: GmcAsyncDispatchArgs): Promise<GmcDispatchReceipt> => {
    const { command, idempotencyKey, payload, req, subject } = args
    const commandDigest = getGmcCommandIdempotencyDigest(command)

    const adopt = async (existing: GmcOperationsLedgerRow): Promise<GmcDispatchReceipt> => {
      if (existing.commandDigest !== commandDigest) {
        throw new GmcAsyncIdempotencyConflictError(idempotencyKey)
      }
      const receipt: GmcDispatchReceipt = { operationId: String(existing.id), state: 'queued' }
      if (await needsRepublish({ payload, req, row: existing })) {
        await publishJob({
          operationId: receipt.operationId,
          payload,
          req,
          scheduledFor: toIsoString(existing.scheduledFor) ?? null,
        })
      }
      return receipt
    }

    // Immutable-key replay is the common path, and reading first also keeps a
    // PostgreSQL host transaction out of a driver-level constraint abort. The
    // unique index below — not this read — is what makes the check atomic.
    const retained = await findByKey({ key: idempotencyKey, payload, req })
    if (retained) {
      return await adopt(retained)
    }

    let operationId: string
    try {
      const created = await payload.create({
        collection: collectionSlug as never,
        data: {
          attempts: 0,
          command: command as unknown as Record<string, unknown>,
          commandDigest,
          commandType: command.type,
          instanceId: parseSubjectInstanceId(subject),
          key: idempotencyKey,
          parentOperationId: args.parentOperationId ?? null,
          rootOperationId: args.rootOperationId ?? null,
          scheduledFor: args.scheduledFor ?? null,
          state: 'queued',
          subject,
        } as never,
        depth: 0,
        overrideAccess: true,
        req,
      })
      operationId = String((created as unknown as GmcOperationsLedgerRow).id)
    } catch (error) {
      if (!isDuplicateError(error)) {
        throw error
      }
      const winner = await findByKey({ key: idempotencyKey, payload, req })
      if (!winner) {
        throw error
      }
      return await adopt(winner)
    }

    await publishJob({ operationId, payload, req, scheduledFor: args.scheduledFor ?? null })
    return { operationId, state: 'queued' }
  }

  const getOperation = async (args: {
    instanceId: string
    operationId: string
    payload: Payload
    req?: PayloadRequest
  }): Promise<GmcAsyncOperation | null> => {
    const { instanceId, operationId, payload, req } = args
    const row = await readRowForStatus({ id: operationId, payload, req })
    if (!row) {
      return null
    }
    // Returning an operation owned by another plugin instance is a
    // control-plane isolation failure, so an unowned row is simply not found.
    const owned =
      row.instanceId === instanceId ||
      (typeof row.subject === 'string' && row.subject.startsWith(`gmc:${instanceId}:`))
    if (!owned) {
      return null
    }

    const id = String(row.id)
    const rootId = row.rootOperationId ?? id
    const rootRow =
      rootId === id ? row : ((await readRowForStatus({ id: rootId, payload, req })) ?? row)

    const childCounts = {} as Record<GmcAsyncChildState, number>
    for (const state of GMC_OPERATION_STATES) {
      childCounts[state] = await countRows({
        payload,
        req,
        where: { and: [{ rootOperationId: { equals: rootId } }, { state: { equals: state } }] },
      })
    }
    // A root row keeps `rootOperationId` null, so it is never in its own
    // descendant counts. Fold its state into the precedence input only.
    const rootState = isOperationState(rootRow.state) ? rootRow.state : 'queued'
    const state = aggregateState({ ...childCounts, [rootState]: childCounts[rootState] + 1 })

    const attempts = typeof row.attempts === 'number' ? row.attempts : undefined
    const error = toLedgerError(row.error)
    const submittedAt = toIsoString(row.createdAt)
    const startedAt = toIsoString(row.startedAt)
    const finishedAt = toIsoString(row.finishedAt)
    const reportedCounts = Object.fromEntries(
      Object.entries(childCounts).filter(([, count]) => count > 0),
    ) as Partial<Record<GmcAsyncChildState, number>>

    return {
      ...(attempts === undefined ? {} : { attempts }),
      childCounts: reportedCounts,
      ...(isCommandType(row.commandType) ? { commandType: row.commandType } : {}),
      ...(error === undefined ? {} : { error }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      operationId: id,
      ...(row.parentOperationId ? { parentOperationId: row.parentOperationId } : {}),
      ...(isOperationState(row.state) ? { requestedState: row.state } : {}),
      ...(row.rootOperationId ? { rootOperationId: row.rootOperationId } : {}),
      ...(startedAt === undefined ? {} : { startedAt }),
      state,
      ...(submittedAt === undefined ? {} : { submittedAt }),
    }
  }

  const health = async (args: {
    instanceId: string
    payload: Payload
    req?: PayloadRequest
  }): Promise<GmcAsyncHealth> => {
    const { instanceId, payload, req } = args
    const checkedAt = new Date().toISOString()
    const scope: Where = { instanceId: { equals: instanceId } }
    try {
      const now = Date.now()
      const nowIso = new Date(now).toISOString()
      const staleBefore = new Date(now - STALE_QUEUE_MS).toISOString()
      const deadLetterSince = new Date(now - DEAD_LETTER_WINDOW_MS).toISOString()
      const [queued, running, staleQueued, deadLettered] = await Promise.all([
        countRows({ payload, req, where: { and: [scope, { state: { equals: 'queued' } }] } }),
        countRows({ payload, req, where: { and: [scope, { state: { equals: 'running' } }] } }),
        countRows({
          payload,
          req,
          where: {
            and: [
              scope,
              { state: { equals: 'queued' } },
              { createdAt: { less_than: staleBefore } },
              {
                or: [
                  { scheduledFor: { exists: false } },
                  { scheduledFor: { less_than_equal: nowIso } },
                ],
              },
            ],
          },
        }),
        countRows({
          payload,
          req,
          where: {
            and: [
              scope,
              { state: { equals: 'dead-lettered' } },
              { finishedAt: { greater_than_equal: deadLetterSince } },
            ],
          },
        }),
      ])

      const reasons: string[] = []
      if (staleQueued > 0) {
        reasons.push('queue_backlog_stale')
      }
      if (deadLettered > 0) {
        reasons.push('dead_letters_present')
      }
      return {
        checkedAt,
        details: {
          collection: collectionSlug,
          deadLettered,
          instanceId,
          queue,
          queued,
          reasons,
          running,
          staleQueued,
          task: taskSlug,
        },
        status: reasons.length > 0 ? 'degraded' : 'ok',
      }
    } catch (error) {
      return {
        checkedAt,
        details: {
          collection: collectionSlug,
          error: error instanceof Error ? error.message.slice(0, 4_000) : String(error),
          instanceId,
          queue,
        },
        status: 'error',
      }
    }
  }

  const install = ({
    config,
    options,
  }: {
    config: Config
    options: NormalizedGmcV2Options
  }): Config => {
    if ((config.collections ?? []).some((collection) => collection.slug === collectionSlug)) {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: collection ${collectionSlug} already exists; choose a different payloadJobsAsyncAdapter collectionSlug`,
      )
    }
    const existingJobs = config.jobs
    const tasks = [...(existingJobs?.tasks ?? [])]
    if (tasks.some((task) => task.slug === taskSlug)) {
      throw new TypeError(
        `payload-plugin-gmc-ecommerce/v2: jobs task ${taskSlug} already exists; choose a different payloadJobsAsyncAdapter taskSlug`,
      )
    }

    const handler: TaskConfig<{
      input: { operationId: string }
      output: Record<string, never>
    }>['handler'] = async ({ input, req }) => {
      const payload = req.payload
      const operationId = typeof input?.operationId === 'string' ? input.operationId : ''
      if (!operationId) {
        throw new TypeError(`GMC ${taskSlug} job is missing its operationId input`)
      }
      const row = await readRow({ id: operationId, payload, req })
      if (!row) {
        payload.logger.warn(
          `GMC ${taskSlug} job ${operationId} has no ${collectionSlug} row; acknowledging`,
        )
        return { output: {} }
      }
      // At-least-once delivery: a redelivered envelope for a completed
      // operation must not run the command a second time.
      if (row.state === 'succeeded') {
        return { output: {} }
      }

      const attempts = (typeof row.attempts === 'number' ? row.attempts : 0) + 1
      const startedAt = toIsoString(row.startedAt) ?? new Date().toISOString()
      await updateRow({
        id: operationId,
        data: { attempts, startedAt, state: 'running' },
        payload,
        req,
      })

      let result: GmcCommandExecutionResult
      try {
        result = await getExecutor(options)({
          command: row.command as GmcCommand,
          operationId,
          payload,
          rootOperationId: row.rootOperationId ?? operationId,
        })
      } catch (error) {
        const classification = classifyGmcCommandError(error)
        // The durable retry budget is the ledger's, not the queue envelope's:
        // Payload stops after `retries + 1` executions, so the same boundary
        // decides between another attempt and a terminal state here.
        const terminal = !classification.retryable || attempts >= retries + 1
        await updateRow({
          id: operationId,
          data: {
            error: classification,
            finishedAt: terminal ? new Date().toISOString() : null,
            state: terminal ? (classification.retryable ? 'dead-lettered' : 'failed') : 'queued',
          },
          payload,
          req,
        })
        if (terminal) {
          // Acknowledge: the ledger already records the terminal outcome and
          // rethrowing would only burn the remaining attempts on a poison loop.
          return { output: {} }
        }
        throw error
      }

      // Deliberately outside the classifier. The command already succeeded, so
      // a failure here is the ledger being unwritable, not the command being
      // wrong: classifying it would either bury a successful result under
      // `failed` or rewrite the row `queued` with a stale error. Rethrowing
      // instead makes Payload retry the job. The retry finds the row still
      // `running`, so it re-runs the command rather than short-circuiting on
      // the `succeeded` guard — safe because every executor path is idempotent,
      // and the alternative is losing the operation's outcome entirely.
      await updateRow({
        id: operationId,
        data: {
          error: null,
          finishedAt: new Date().toISOString(),
          result: result as unknown as Record<string, unknown>,
          state: 'succeeded',
        },
        payload,
        req,
      })
      return { output: {} }
    }

    return {
      ...config,
      collections: [
        ...(config.collections ?? []),
        buildGmcOperationsCollection({ slug: collectionSlug, access: options.access }),
      ],
      jobs: {
        ...existingJobs,
        tasks: [
          ...tasks,
          {
            slug: taskSlug,
            handler,
            inputSchema: [{ name: 'operationId', type: 'text', required: true }],
            retries: { attempts: retries, backoff: { type: 'exponential', delay: RETRY_BACKOFF_MS } },
          },
        ],
      },
    }
  }

  return {
    name: 'payload-jobs',
    capabilities: {
      orderedBySubject: false,
      scheduledDelivery: true,
    },
    dispatch,
    getOperation,
    health,
    install,
  }
}
