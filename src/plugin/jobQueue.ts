import type { Payload, PayloadRequest, Where } from 'payload'

import type { ResolvedMCIdentity } from '../types/index.js'

import {
  GMC_BATCH_PUSH_TASK_SLUG,
  GMC_DELETE_PRODUCT_TASK_SLUG,
  GMC_INITIAL_SYNC_TASK_SLUG,
  GMC_PULL_ALL_TASK_SLUG,
  GMC_PUSH_PRODUCT_TASK_SLUG,
  GMC_SYNC_DIRTY_TASK_SLUG,
  GMC_SYNC_QUEUE_NAME,
} from '../constants.js'
import { getRecordID } from '../server/utilities/recordUtils.js'
import { logAsyncOperationFailure } from './syncLogs.js'

type PushProductJobInput = {
  merchantId: string
  productId: string
}

type DeleteProductJobInput = {
  identity: ResolvedMCIdentity
  merchantId: string
  productId: string
}

type SyncDirtyJobInput = {
  jobId?: string
  logDocId?: number | string
  merchantId: string
  metadata?: Record<string, unknown>
  triggeredBy?: string
}

type BatchPushJobInput = {
  filter?: Where
  jobId?: string
  logDocId?: number | string
  merchantId: string
  metadata?: Record<string, unknown>
  productIds?: string[]
  triggeredBy?: string
}

type InitialSyncJobInput = {
  jobId?: string
  logDocId?: number | string
  merchantId: string
  metadata?: Record<string, unknown>
  overrides?: {
    batchSize?: number
    dryRun?: boolean
    limit?: number
    onlyIfRemoteMissing?: boolean
  }
  triggeredBy?: string
}

type PullAllJobInput = {
  jobId?: string
  logDocId?: number | string
  merchantId: string
  metadata?: Record<string, unknown>
  triggeredBy?: string
}

type QueueJobArgs = {
  input:
    | BatchPushJobInput
    | DeleteProductJobInput
    | InitialSyncJobInput
    | PullAllJobInput
    | PushProductJobInput
    | SyncDirtyJobInput
  payload: Payload
  req?: PayloadRequest
  task:
    | typeof GMC_BATCH_PUSH_TASK_SLUG
    | typeof GMC_DELETE_PRODUCT_TASK_SLUG
    | typeof GMC_INITIAL_SYNC_TASK_SLUG
    | typeof GMC_PULL_ALL_TASK_SLUG
    | typeof GMC_PUSH_PRODUCT_TASK_SLUG
    | typeof GMC_SYNC_DIRTY_TASK_SLUG
}

const runnerState = new WeakMap<Payload, Promise<void>>()

export const runQueuedGmcJobs = async (
  payload: Payload,
  req?: PayloadRequest,
): Promise<void> => {
  const existingRun = runnerState.get(payload)
  if (existingRun) {
    return existingRun
  }

  const runPromise = payload.jobs
    .run({
      limit: 100,
      queue: GMC_SYNC_QUEUE_NAME,
      req,
    })
    .then(() => undefined)
    .catch((error: unknown) => {
      logAsyncOperationFailure(payload, 'jobs.run', error)
    })
    .finally(() => {
      runnerState.delete(payload)
    })

  runnerState.set(payload, runPromise)
  return runPromise
}

const queueGmcTask = async (args: QueueJobArgs): Promise<number | string | undefined> => {
  const { input, payload, req, task } = args

  const job = await payload.jobs.queue({
    input,
    queue: GMC_SYNC_QUEUE_NAME,
    req,
    task,
  })

  return getRecordID(job)
}

export const queueProductPushJob = async (args: {
  merchantId: string
  payload: Payload
  productId: string
  req?: PayloadRequest
}): Promise<number | string | undefined> => {
  return queueGmcTask({
    input: { merchantId: args.merchantId, productId: args.productId },
    payload: args.payload,
    req: args.req,
    task: GMC_PUSH_PRODUCT_TASK_SLUG,
  })
}

export const queueProductDeleteJob = async (args: {
  identity: ResolvedMCIdentity
  merchantId: string
  payload: Payload
  productId: string
  req?: PayloadRequest
}): Promise<number | string | undefined> => {
  return queueGmcTask({
    input: {
      identity: args.identity,
      merchantId: args.merchantId,
      productId: args.productId,
    },
    payload: args.payload,
    req: args.req,
    task: GMC_DELETE_PRODUCT_TASK_SLUG,
  })
}

export const queueDirtySyncJob = async (args: {
  jobId?: string
  logDocId?: number | string
  merchantId: string
  metadata?: Record<string, unknown>
  payload: Payload
  req?: PayloadRequest
  triggeredBy?: string
}): Promise<number | string | undefined> => {
  return queueGmcTask({
    input: {
      jobId: args.jobId,
      logDocId: args.logDocId,
      merchantId: args.merchantId,
      metadata: args.metadata,
      triggeredBy: args.triggeredBy,
    },
    payload: args.payload,
    req: args.req,
    task: GMC_SYNC_DIRTY_TASK_SLUG,
  })
}

export const queueBatchPushJob = async (args: {
  filter?: Where
  jobId?: string
  logDocId?: number | string
  merchantId: string
  metadata?: Record<string, unknown>
  payload: Payload
  productIds?: string[]
  req?: PayloadRequest
  triggeredBy?: string
}): Promise<number | string | undefined> => {
  return queueGmcTask({
    input: {
      filter: args.filter,
      jobId: args.jobId,
      logDocId: args.logDocId,
      merchantId: args.merchantId,
      metadata: args.metadata,
      productIds: args.productIds,
      triggeredBy: args.triggeredBy,
    },
    payload: args.payload,
    req: args.req,
    task: GMC_BATCH_PUSH_TASK_SLUG,
  })
}

export const queueInitialSyncJob = async (args: {
  jobId?: string
  logDocId?: number | string
  merchantId: string
  metadata?: Record<string, unknown>
  overrides?: {
    batchSize?: number
    dryRun?: boolean
    limit?: number
    onlyIfRemoteMissing?: boolean
  }
  payload: Payload
  req?: PayloadRequest
  triggeredBy?: string
}): Promise<number | string | undefined> => {
  return queueGmcTask({
    input: {
      jobId: args.jobId,
      logDocId: args.logDocId,
      merchantId: args.merchantId,
      metadata: args.metadata,
      overrides: args.overrides,
      triggeredBy: args.triggeredBy,
    },
    payload: args.payload,
    req: args.req,
    task: GMC_INITIAL_SYNC_TASK_SLUG,
  })
}

export const queuePullAllJob = async (args: {
  jobId?: string
  logDocId?: number | string
  merchantId: string
  metadata?: Record<string, unknown>
  payload: Payload
  req?: PayloadRequest
  triggeredBy?: string
}): Promise<number | string | undefined> => {
  return queueGmcTask({
    input: {
      jobId: args.jobId,
      logDocId: args.logDocId,
      merchantId: args.merchantId,
      metadata: args.metadata,
      triggeredBy: args.triggeredBy,
    },
    payload: args.payload,
    req: args.req,
    task: GMC_PULL_ALL_TASK_SLUG,
  })
}
