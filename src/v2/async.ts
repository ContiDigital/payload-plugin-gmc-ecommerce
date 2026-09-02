import type { GmcAsyncHealth, GmcAsyncOperation, GmcDispatchReceipt } from './types.js'

import { canonicalJson } from './canonical.js'
import { parseGmcRfc3339Timestamp } from './merchantWire.js'
import { GMC_V2_COMMAND_TYPES } from './types.js'

const MAX_HEALTH_DETAILS_BYTES = 1_048_576
const MAX_ERROR_MESSAGE_LENGTH = 4_000
const MAX_ERROR_CODE_LENGTH = 128

const isIsoDate = (value: unknown): value is string => {
  return parseGmcRfc3339Timestamp(value) !== null
}

const isIdentifier = (value: unknown): value is string => {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  )
}

const operationStates = new Set([
  'cancelled',
  'dead-lettered',
  'failed',
  'queued',
  'running',
  'succeeded',
])

/** Standard adapter signal for immutable key reuse with different intent. */
export class GmcAsyncIdempotencyConflictError extends Error {
  readonly code = 'GMC_ASYNC_IDEMPOTENCY_CONFLICT'
  readonly statusCode = 409

  constructor(idempotencyKey: string) {
    super(`GMC idempotency key ${idempotencyKey} is already bound to different command intent`)
    this.name = 'GmcAsyncIdempotencyConflictError'
  }
}

/**
 * Standard adapter signal when a new reconciliation root would overlap an
 * already-active reconciliation workflow. Replaying the same immutable key
 * must return its original operation instead of throwing this error.
 */
export class GmcAsyncWorkflowConflictError extends Error {
  readonly activeOperationId: string
  readonly code = 'GMC_ASYNC_WORKFLOW_CONFLICT'
  readonly statusCode = 409
  readonly workflow = 'catalog.reconcile'

  constructor(activeOperationId: string) {
    super(
      `GMC catalog.reconcile cannot start while operation ${activeOperationId} is still active`,
    )
    this.name = 'GmcAsyncWorkflowConflictError'
    this.activeOperationId = activeOperationId
  }
}

export const assertGmcDispatchReceipt = (receipt: GmcDispatchReceipt): GmcDispatchReceipt => {
  if (
    !receipt ||
    !isIdentifier(receipt.operationId) ||
    (receipt.state !== 'pending' && receipt.state !== 'queued')
  ) {
    throw new TypeError('GMC async adapter returned an invalid durable dispatch receipt')
  }
  return { operationId: receipt.operationId, state: receipt.state }
}

export const assertGmcAsyncHealth = (health: GmcAsyncHealth): GmcAsyncHealth => {
  if (
    !health ||
    !['degraded', 'error', 'ok'].includes(health.status) ||
    !isIsoDate(health.checkedAt) ||
    (health.details !== undefined &&
      (typeof health.details !== 'object' ||
        health.details === null ||
        Array.isArray(health.details)))
  ) {
    throw new TypeError('GMC async adapter returned an invalid health result')
  }
  if (health.details !== undefined) {
    try {
      const serialized = canonicalJson(health.details)
      if (Buffer.byteLength(serialized, 'utf8') > MAX_HEALTH_DETAILS_BYTES) {
        throw new TypeError('health details are too large')
      }
    } catch (error) {
      throw new TypeError('GMC async adapter returned unsafe health details', { cause: error })
    }
  }
  return {
    checkedAt: health.checkedAt,
    ...(health.details === undefined ? {} : { details: health.details }),
    status: health.status,
  }
}

export const assertGmcAsyncOperation = (operation: GmcAsyncOperation): GmcAsyncOperation => {
  const dates = [operation?.submittedAt, operation?.startedAt, operation?.finishedAt]
  const childCounts = operation?.childCounts
  const reconciliation = operation?.reconciliation
  if (
    !operation ||
    !isIdentifier(operation.operationId) ||
    !operationStates.has(operation.state) ||
    (operation.requestedState !== undefined && !operationStates.has(operation.requestedState)) ||
    (operation.parentOperationId !== undefined && !isIdentifier(operation.parentOperationId)) ||
    (operation.rootOperationId !== undefined && !isIdentifier(operation.rootOperationId)) ||
    operation.parentOperationId === operation.operationId ||
    (operation.attempts !== undefined &&
      (!Number.isSafeInteger(operation.attempts) || operation.attempts < 0)) ||
    (operation.commandType !== undefined &&
      !GMC_V2_COMMAND_TYPES.includes(operation.commandType)) ||
    dates.some((date) => date !== undefined && !isIsoDate(date)) ||
    (operation.error !== undefined &&
      (typeof operation.error.message !== 'string' ||
        operation.error.message.trim().length === 0 ||
        operation.error.message.length > MAX_ERROR_MESSAGE_LENGTH ||
        (operation.error.code !== undefined &&
          (typeof operation.error.code !== 'string' ||
            !operation.error.code.trim() ||
            operation.error.code.length > MAX_ERROR_CODE_LENGTH)) ||
        (operation.error.retryable !== undefined &&
          typeof operation.error.retryable !== 'boolean'))) ||
    (childCounts !== undefined &&
      (typeof childCounts !== 'object' ||
        childCounts === null ||
        Object.entries(childCounts).some(
          ([state, count]) =>
            !operationStates.has(state) || !Number.isSafeInteger(count) || count < 0,
        ))) ||
    (reconciliation !== undefined &&
      (typeof reconciliation !== 'object' ||
        reconciliation === null ||
        Object.keys(reconciliation).some(
          (key) =>
            !['orphanCount', 'orphanDeleteCount', 'pagesCompleted', 'remoteCount'].includes(key),
        ) ||
        !Number.isSafeInteger(reconciliation.orphanCount) ||
        reconciliation.orphanCount < 0 ||
        !Number.isSafeInteger(reconciliation.orphanDeleteCount) ||
        reconciliation.orphanDeleteCount < 0 ||
        reconciliation.orphanDeleteCount > reconciliation.orphanCount ||
        !Number.isSafeInteger(reconciliation.pagesCompleted) ||
        reconciliation.pagesCompleted <= 0 ||
        !Number.isSafeInteger(reconciliation.remoteCount) ||
        reconciliation.remoteCount < 0))
  ) {
    throw new TypeError('GMC async adapter returned an invalid operation result')
  }
  const submittedAt = parseGmcRfc3339Timestamp(operation.submittedAt)
  const startedAt = parseGmcRfc3339Timestamp(operation.startedAt)
  const finishedAt = parseGmcRfc3339Timestamp(operation.finishedAt)
  if (
    (submittedAt !== null && startedAt !== null && submittedAt > startedAt) ||
    (startedAt !== null && finishedAt !== null && startedAt > finishedAt) ||
    (submittedAt !== null && finishedAt !== null && submittedAt > finishedAt)
  ) {
    throw new TypeError('GMC async adapter returned an invalid operation timeline')
  }
  return {
    ...(operation.attempts === undefined ? {} : { attempts: operation.attempts }),
    ...(operation.childCounts === undefined ? {} : { childCounts: operation.childCounts }),
    ...(operation.commandType === undefined ? {} : { commandType: operation.commandType }),
    ...(operation.error === undefined
      ? {}
      : {
          error: {
            ...(operation.error.code === undefined ? {} : { code: operation.error.code.trim() }),
            message: operation.error.message.trim(),
            ...(operation.error.retryable === undefined
              ? {}
              : { retryable: operation.error.retryable }),
          },
        }),
    ...(operation.finishedAt === undefined ? {} : { finishedAt: operation.finishedAt }),
    operationId: operation.operationId,
    ...(operation.parentOperationId === undefined
      ? {}
      : { parentOperationId: operation.parentOperationId }),
    ...(operation.reconciliation === undefined
      ? {}
      : {
          reconciliation: {
            orphanCount: operation.reconciliation.orphanCount,
            orphanDeleteCount: operation.reconciliation.orphanDeleteCount,
            pagesCompleted: operation.reconciliation.pagesCompleted,
            remoteCount: operation.reconciliation.remoteCount,
          },
        }),
    ...(operation.requestedState === undefined ? {} : { requestedState: operation.requestedState }),
    ...(operation.rootOperationId === undefined
      ? {}
      : { rootOperationId: operation.rootOperationId }),
    ...(operation.startedAt === undefined ? {} : { startedAt: operation.startedAt }),
    state: operation.state,
    ...(operation.submittedAt === undefined ? {} : { submittedAt: operation.submittedAt }),
  }
}
