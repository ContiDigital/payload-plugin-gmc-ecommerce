import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  GlobalAfterChangeHook,
  GlobalBeforeChangeHook,
  PayloadRequest,
} from 'payload'

import { createHash } from 'node:crypto'

import type {
  GmcCatalogDependencyConfig,
  GmcCatalogGlobalDependencyConfig,
  GmcDocumentID,
  NormalizedGmcV2Options,
} from './types.js'

import { assertGmcDispatchReceipt } from './async.js'
import { canonicalJson } from './canonical.js'
import {
  assertGmcCommand,
  canonicalizeGmcTargetProductIds,
  createCatalogPublishCommand,
  createProductDeleteCommand,
  createProductPublishCommand,
  getGmcCommandSubject,
} from './commands.js'
import { parseGmcRfc3339Timestamp } from './merchantWire.js'
import { GMC_V2_MAX_TARGETED_PRODUCT_IDS } from './types.js'

const MAX_HOOK_FINGERPRINT_BYTES = 16 * 1024 * 1024

type CatalogDependency = GmcCatalogDependencyConfig | GmcCatalogGlobalDependencyConfig

export class GmcTransactionalHookRequiredError extends TypeError {
  readonly code = 'GMC_TRANSACTION_REQUIRED'

  constructor() {
    super(
      'payload-plugin-gmc-ecommerce/v2: automatic Merchant hooks require an ambient Payload database transaction; enable database transactions and do not call this write with disableTransaction',
    )
    this.name = 'GmcTransactionalHookRequiredError'
  }
}

const assertTransactionalHookRequest = async (req: PayloadRequest): Promise<void> => {
  // Payload assigns the promise returned by beginTransaction before awaiting
  // it. When an adapter has transactions disabled, that promise resolves to
  // null but remains on req.transactionID. Checking only the property would
  // therefore mistake Promise<null> for a live transaction and let the
  // canonical write commit independently of its outbox operation.
  const transactionID = await req.transactionID
  if (transactionID === undefined || transactionID === null) {
    throw new GmcTransactionalHookRequiredError()
  }
}

// Keyed by instanceId so multiple installations in one process each warn
// exactly once, rather than one installation's warning silencing another's.
const warnedNoTransactionInstanceIds = new Set<string>()

/**
 * Test-only: clears the once-per-process warning dedup so unit tests can
 * assert warning behavior across multiple hook invocations in isolation.
 */
export const __resetTransactionWarningsForTests = (): void => {
  warnedNoTransactionInstanceIds.clear()
}

/**
 * Fail closed when `requireTransaction` is set; otherwise dispatch anyway and
 * warn once per process per instance, since a crash between the canonical
 * commit and dispatch is repaired by catalog.reconcile.
 */
const warnOnceWithoutTransaction = async (
  req: PayloadRequest,
  options: NormalizedGmcV2Options,
): Promise<void> => {
  const transactionID = await req.transactionID
  if (transactionID !== undefined && transactionID !== null) {
    return
  }
  if (options.requireTransaction) {
    throw new GmcTransactionalHookRequiredError()
  }
  if (warnedNoTransactionInstanceIds.has(options.instanceId)) {
    return
  }
  warnedNoTransactionInstanceIds.add(options.instanceId)
  req.payload.logger.warn(
    'payload-plugin-gmc-ecommerce: dispatching Merchant command outside a database transaction; a crash between commit and dispatch is repaired by catalog.reconcile. Set requireTransaction: true to fail closed.',
  )
}

/** Reject before the canonical collection row is written when transactions are required. */
export const createGmcV2TransactionBeforeChangeHook = (
  options: NormalizedGmcV2Options,
): CollectionBeforeChangeHook => {
  return async ({ data, req }) => {
    if (options.requireTransaction) {
      await assertTransactionalHookRequest(req)
    }
    return data
  }
}

/** Reject before the canonical collection row is deleted when transactions are required. */
export const createGmcV2TransactionBeforeDeleteHook = (
  options: NormalizedGmcV2Options,
): CollectionBeforeDeleteHook => {
  return async ({ req }) => {
    if (options.requireTransaction) {
      await assertTransactionalHookRequest(req)
    }
  }
}

/** Reject before the canonical Global is written when transactions are required. */
export const createGmcV2TransactionGlobalBeforeChangeHook = (
  options: NormalizedGmcV2Options,
): GlobalBeforeChangeHook => {
  return async ({ data, req }) => {
    if (options.requireTransaction) {
      await assertTransactionalHookRequest(req)
    }
    return data
  }
}

const getDocumentId = (doc: Record<string, unknown>): GmcDocumentID => {
  if (
    (typeof doc.id === 'string' && doc.id.trim().length > 0) ||
    (typeof doc.id === 'number' && Number.isSafeInteger(doc.id))
  ) {
    return doc.id
  }
  throw new TypeError('GMC hook requires a string or numeric document id')
}

const stableJson = (value: unknown): string => {
  let serialized: string
  try {
    // Keep an explicit root tag because JSON.stringify(undefined) has no
    // string result and must not collide with JSON null or a string value.
    serialized = value === undefined ? 'undefined:' : `json:${canonicalJson(value)}`
  } catch (error) {
    throw new TypeError('GMC hook fingerprint input must contain finite, acyclic JSON', {
      cause: error,
    })
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_HOOK_FINGERPRINT_BYTES) {
    throw new TypeError(
      `GMC hook fingerprint input must not exceed ${MAX_HOOK_FINGERPRINT_BYTES} serialized bytes`,
    )
  }
  return serialized
}

const stableDigest = (value: unknown): string =>
  createHash('sha256').update(stableJson(value)).digest('hex')

const hookIdempotencyKey = (args: {
  event: string
  instanceId: string
  productId: GmcDocumentID
  version: unknown
}): string => {
  const stableVersion =
    typeof args.version === 'string' || typeof args.version === 'number'
      ? String(args.version)
      : stableJson(args.version)
  const digest = createHash('sha256')
    .update([args.instanceId, args.event, String(args.productId), stableVersion].join('\u0000'))
    .digest('hex')
  return `gmc-v2:hook:${digest}`
}

const dependencySelection = (args: {
  dependency: CatalogDependency
  doc: Record<string, unknown>
  req: PayloadRequest
}): Promise<unknown> =>
  Promise.resolve(
    args.dependency.select({
      doc: args.doc,
      payload: args.req.payload,
      req: args.req,
    }),
  )

const dependencySchedule = async (args: {
  dependency: CatalogDependency
  doc: Record<string, unknown>
  req: PayloadRequest
}): Promise<string[]> => {
  if (!args.dependency.scheduleAt) {
    return []
  }
  const value = await args.dependency.scheduleAt({
    doc: args.doc,
    payload: args.req.payload,
    req: args.req,
  })
  if (!Array.isArray(value) || value.length > 20) {
    throw new TypeError('GMC catalog dependency scheduleAt must return at most 20 ISO dates')
  }
  const normalized = value.map((scheduledFor) => {
    if (parseGmcRfc3339Timestamp(scheduledFor) === null) {
      throw new TypeError('GMC catalog dependency scheduleAt must return valid ISO dates')
    }
    return new Date(scheduledFor).toISOString()
  })
  return [...new Set(normalized)].sort()
}

const dependencyProductIds = async (args: {
  cause: 'delete' | 'update'
  dependency: CatalogDependency
  doc: Record<string, unknown>
  previousDoc?: Record<string, unknown>
  previousSelection?: unknown
  req: PayloadRequest
  selection: unknown
}): Promise<GmcDocumentID[] | undefined> => {
  if (!args.dependency.resolveProductIds) {
    return undefined
  }
  const resolved = await args.dependency.resolveProductIds({
    cause: args.cause,
    doc: args.doc,
    payload: args.req.payload,
    previousDoc: args.previousDoc,
    previousSelection: args.previousSelection,
    req: args.req,
    selection: args.selection,
  })
  if (resolved === null) {
    return undefined
  }
  const productIds = canonicalizeGmcTargetProductIds(resolved)
  if (productIds.length > GMC_V2_MAX_TARGETED_PRODUCT_IDS) {
    args.req.payload.logger.warn(
      `GMC targeted dependency invalidation resolved ${productIds.length} products; falling back to a full catalog root`,
    )
    return undefined
  }
  return productIds
}

const dispatchDependencyCatalog = async (args: {
  cause: 'delete' | 'schedule' | 'update'
  dependencyKey: string
  documentId: GmcDocumentID
  options: NormalizedGmcV2Options
  productIds?: GmcDocumentID[]
  req: PayloadRequest
  scheduledFor?: string
  version: unknown
}): Promise<void> => {
  if (args.productIds?.length === 0) {
    return
  }
  const command = createCatalogPublishCommand({
    cause: args.cause,
    productIds: args.productIds,
    requestedAt: args.scheduledFor,
  })
  assertGmcCommand(command)
  assertGmcDispatchReceipt(
    await args.options.async.dispatch({
      command,
      idempotencyKey: hookIdempotencyKey({
        event: `dependency:${args.dependencyKey}:${args.cause}`,
        instanceId: args.options.instanceId,
        productId: args.documentId,
        version: {
          event: args.version,
          scope: args.productIds === undefined ? 'full' : args.productIds,
        },
      }),
      payload: args.req.payload,
      req: args.req,
      scheduledFor: args.scheduledFor,
      subject: getGmcCommandSubject(command, args.options.instanceId),
    }),
  )
}

export const createGmcV2DependencyAfterChangeHook = (
  options: NormalizedGmcV2Options,
  dependency: GmcCatalogDependencyConfig,
): CollectionAfterChangeHook => {
  return async ({ doc, operation, previousDoc, req }) => {
    await warnOnceWithoutTransaction(req, options)
    const current = doc as Record<string, unknown>
    const previous = previousDoc as Record<string, unknown> | undefined
    const documentId = getDocumentId(current)
    const currentSelection = await dependencySelection({ dependency, doc: current, req })
    const previousSelection = previous
      ? await dependencySelection({ dependency, doc: previous, req })
      : undefined
    if (operation === 'create' || stableJson(currentSelection) !== stableJson(previousSelection)) {
      const productIds = await dependencyProductIds({
        cause: 'update',
        dependency,
        doc: current,
        previousDoc: previous,
        previousSelection,
        req,
        selection: currentSelection,
      })
      await dispatchDependencyCatalog({
        cause: 'update',
        dependencyKey: `collection:${dependency.collection}`,
        documentId,
        options,
        productIds,
        req,
        // A final-state-only key is unsafe for cyclic transitions: a later
        // A -> B event must not reuse the first A -> B operation after B -> A.
        // Payload timestamps plus the full before/after envelope distinguish
        // committed events while still deduplicating a replay of one event.
        version: {
          current,
          currentSelection,
          operation,
          previous,
          previousSelection,
        },
      })
    }

    const currentSchedule = await dependencySchedule({ dependency, doc: current, req })
    const previousSchedule = previous
      ? await dependencySchedule({ dependency, doc: previous, req })
      : []
    const previousTimes = new Set(previousSchedule)
    const now = Date.now()
    for (const scheduledFor of currentSchedule) {
      if (previousTimes.has(scheduledFor)) {
        continue
      }
      if (Date.parse(scheduledFor) <= now) {
        continue
      }
      await dispatchDependencyCatalog({
        cause: 'schedule',
        dependencyKey: `collection:${dependency.collection}`,
        documentId,
        options,
        req,
        scheduledFor,
        // The immutable schedule belongs to this dependency boundary, not to
        // every edit of projection content around the same boundary.
        version: scheduledFor,
      })
    }
    return doc
  }
}

export const createGmcV2DependencyAfterDeleteHook = (
  options: NormalizedGmcV2Options,
  dependency: GmcCatalogDependencyConfig,
): CollectionAfterDeleteHook => {
  return async ({ doc, req }) => {
    await warnOnceWithoutTransaction(req, options)
    const deleted = doc as Record<string, unknown>
    const documentId = getDocumentId(deleted)
    const selection = await dependencySelection({ dependency, doc: deleted, req })
    const productIds = await dependencyProductIds({
      cause: 'delete',
      dependency,
      doc: deleted,
      req,
      selection,
    })
    await dispatchDependencyCatalog({
      cause: 'delete',
      dependencyKey: `collection:${dependency.collection}`,
      documentId,
      options,
      productIds,
      req,
      version: { deleted, selection },
    })
  }
}

export const createGmcV2GlobalDependencyAfterChangeHook = (
  options: NormalizedGmcV2Options,
  dependency: GmcCatalogGlobalDependencyConfig,
): GlobalAfterChangeHook => {
  return async ({ doc, previousDoc, req }) => {
    await warnOnceWithoutTransaction(req, options)
    const current = doc as Record<string, unknown>
    const previous = previousDoc as Record<string, unknown> | undefined
    const currentSelection = await dependencySelection({ dependency, doc: current, req })
    const previousSelection = previous
      ? await dependencySelection({ dependency, doc: previous, req })
      : undefined

    if (stableJson(currentSelection) !== stableJson(previousSelection)) {
      const productIds = await dependencyProductIds({
        cause: 'update',
        dependency,
        doc: current,
        previousDoc: previous,
        previousSelection,
        req,
        selection: currentSelection,
      })
      await dispatchDependencyCatalog({
        cause: 'update',
        dependencyKey: `global:${dependency.global}`,
        documentId: `global:${dependency.global}`,
        options,
        productIds,
        req,
        version: { current, currentSelection, previous, previousSelection },
      })
    }

    const currentSchedule = await dependencySchedule({ dependency, doc: current, req })
    const previousSchedule = previous
      ? await dependencySchedule({ dependency, doc: previous, req })
      : []
    const previousTimes = new Set(previousSchedule)
    const now = Date.now()
    for (const scheduledFor of currentSchedule) {
      if (previousTimes.has(scheduledFor) || Date.parse(scheduledFor) <= now) {
        continue
      }
      await dispatchDependencyCatalog({
        cause: 'schedule',
        dependencyKey: `global:${dependency.global}`,
        documentId: `global:${dependency.global}`,
        options,
        req,
        scheduledFor,
        version: scheduledFor,
      })
    }
    return doc
  }
}

export const createGmcV2AfterChangeHook = (
  options: NormalizedGmcV2Options,
): CollectionAfterChangeHook => {
  return async ({ doc, operation, previousDoc, req }) => {
    const current = doc as Record<string, unknown>
    const previous = previousDoc as Record<string, unknown> | undefined
    // A draft autosave over a document that was already draft-only never
    // changes what is (or should be) live at Merchant Center; dispatching for
    // it only churns the outbox with no observable catalog effect. Check this
    // before the transaction gate: a save that dispatches nothing has no
    // commit-then-crash-before-dispatch exposure, so it should not warn or
    // fail closed on a missing ambient transaction either.
    if (
      operation === 'update' &&
      typeof current._status === 'string' &&
      current._status === 'draft' &&
      previous?._status === 'draft'
    ) {
      return doc
    }
    await warnOnceWithoutTransaction(req, options)
    const productId = getDocumentId(current)
    // Payload may provide a synthetic/partial previousDoc during create. It is
    // not an owned historical product and must never be interpreted as one.
    const previousIdentities =
      operation === 'update' && previous
        ? await options.products.resolveIdentities({ doc: previous, payload: req.payload, req })
        : []
    const command = createProductPublishCommand({
      cause: current._status === 'published' ? 'publish' : 'update',
      previousIdentities,
      productId,
      requestedAt: typeof current.updatedAt === 'string' ? current.updatedAt : undefined,
    })
    assertGmcCommand(command)

    assertGmcDispatchReceipt(
      await options.async.dispatch({
        command,
        idempotencyKey: hookIdempotencyKey({
          event: `afterChange:${operation}:${typeof current._status === 'string' ? current._status : ''}`,
          instanceId: options.instanceId,
          productId,
          // Database timestamps may collide at millisecond precision. Hash the
          // actual event state, prior-state digest, and cleanup identities so
          // divergent saves and A -> B -> A cycles can never collapse onto an
          // older immutable operation. Digesting previous separately preserves
          // the hook's bounded fingerprint envelope for large Payload documents.
          version: { current, previousDigest: stableDigest(previous), previousIdentities },
        }),
        payload: req.payload,
        req,
        subject: getGmcCommandSubject(command, options.instanceId),
      }),
    )
    return doc
  }
}

export const createGmcV2AfterDeleteHook = (
  options: NormalizedGmcV2Options,
): CollectionAfterDeleteHook => {
  return async ({ doc, req }) => {
    await warnOnceWithoutTransaction(req, options)
    const deleted = doc as Record<string, unknown>
    const productId = getDocumentId(deleted)
    const identities = await options.products.resolveIdentities({
      doc: deleted,
      payload: req.payload,
      req,
    })
    const command = createProductDeleteCommand({
      cause: 'delete',
      identities,
      productId,
      requestedAt: typeof deleted.updatedAt === 'string' ? deleted.updatedAt : undefined,
    })
    assertGmcCommand(command)

    assertGmcDispatchReceipt(
      await options.async.dispatch({
        command,
        idempotencyKey: hookIdempotencyKey({
          event: 'afterDelete',
          instanceId: options.instanceId,
          productId,
          version: { deleted, identities },
        }),
        payload: req.payload,
        req,
        subject: getGmcCommandSubject(command, options.instanceId),
      }),
    )
  }
}
