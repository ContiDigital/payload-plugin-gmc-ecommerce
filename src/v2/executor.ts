import type { Payload } from 'payload'

import { createHash } from 'node:crypto'

import type { MCProductIdentity } from '../types/index.js'
import type {
  GmcApiPrimaryDataSource,
  GmcAsyncDispatchArgs,
  GmcCommand,
  GmcCommandExecutionContext,
  GmcCommandExecutionResult,
  GmcDispatchReceipt,
  GmcDocumentID,
  GmcMerchantTransport,
  GmcProductDeleteCommand,
  GmcProductPublishCommand,
  GmcPublicationState,
  GmcPublicationStateStore,
  NormalizedGmcV2Options,
} from './types.js'

import { GoogleApiError } from '../server/services/sub-services/googleApiClient.js'
import { createRateLimiterService } from '../server/services/sub-services/rateLimiterService.js'
import { createRetryService } from '../server/services/sub-services/retryService.js'
import { assertGmcDispatchReceipt } from './async.js'
import { canonicalizeProductInput, canonicalizeProjection, getIdentityKey } from './canonical.js'
import { collectCanonicalProducts, mergeGmcCursorWhere } from './catalog.js'
import {
  assertGmcCommand,
  createLocalInventoryApplyCommand,
  createOfferDeleteCommand,
  createOfferPublishCommand,
  createProductPublishCommand,
  getGmcCommandSubject as getRawGmcCommandSubject,
} from './commands.js'
import {
  assertGmcApiDataSourceAcceptsIdentity,
  assertGmcApiPrimaryDataSource,
  assertGmcApiPrimaryDataSourceTopology,
  GmcProcessedProductNotReadyError,
  GmcProductDataSourceConflictError,
} from './dataSource.js'
import { classifyGmcCommandError } from './errors.js'
import {
  assertFeedArtifactDescriptor,
  assertFeedArtifactIntegrity,
  GMC_ARTIFACT_DESCRIPTOR_FIELDS,
  publishFeedArtifact,
} from './feed/buildFeed.js'
import { normalizeGmcIdentityRoute, resolveGmcDataSourceName } from './identity.js'
import {
  assertLocalInventoryMatchesProductPrice,
  canonicalizeLocalInventoryInput,
} from './localInventory.js'
import { createPayloadPublicationStateStore } from './state/payloadStateStore.js'
import { createGoogleMerchantTransport } from './transport/googleTransport.js'

export type GmcCommandExecutorDependencies = {
  stateStore?: GmcPublicationStateStore
  transport?: GmcMerchantTransport
}

/**
 * Every sub-executor sees the host context verbatim. `sourceVersion` on it is
 * deprecated and ignored: ordering comes from each command's `requestedAt` and
 * skipping from its canonical content digest.
 */
type GmcExecutionContext = GmcCommandExecutionContext

const DATA_SOURCE_VALIDATION_TTL_MS = 5 * 60_000

const isNotFound = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false
  }
  const candidate = error as { name?: unknown; status?: unknown; statusCode?: unknown }
  return candidate.status === 404 || candidate.statusCode === 404 || candidate.name === 'NotFound'
}

const getErrorState = classifyGmcCommandError

const hashIdempotencyKey = (
  instanceId: string,
  parts: Array<number | string | undefined>,
): string => {
  const digest = createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u0000'))
    .digest('hex')
  return `gmc-v2:${instanceId}:${digest}`
}

const findPublishedDocument = async (args: {
  options: NormalizedGmcV2Options
  payload: Payload
  productId: GmcDocumentID
}): Promise<null | Record<string, unknown>> => {
  try {
    const candidate = await args.payload.findByID({
      id: args.productId,
      collection: args.options.products.collection,
      depth: args.options.products.fetchDepth,
      draft: false,
      overrideAccess: true,
    })
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return null
    }
    const document = candidate as unknown as Record<string, unknown>
    // Payload's draft-aware Local API can return a draft-shaped document for
    // some single-document lifecycle paths even with `draft: false`. Treat an
    // explicit status as authoritative: only published content may reach the
    // canonical projector. Collections without drafts have no `_status` and
    // continue through unchanged.
    if (typeof document._status === 'string' && document._status !== 'published') {
      return null
    }
    if (!args.options.products.where) {
      return document
    }
    const eligible = await args.payload.find({
      collection: args.options.products.collection,
      depth: 0,
      draft: false,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      select: { id: true } as never,
      where: {
        and: [args.options.products.where, { id: { equals: args.productId } }],
      },
    })
    return eligible.docs.length > 0 ? document : null
  } catch (error) {
    if (isNotFound(error)) {
      return null
    }
    throw error
  }
}

const uniqueIdentities = (
  identities: GmcProductDeleteCommand['identities'],
): GmcProductDeleteCommand['identities'] => {
  const values = new Map<string, GmcProductDeleteCommand['identities'][number]>()
  for (const identity of identities) {
    values.set(getIdentityKey(identity), identity)
  }
  return [...values.values()]
}

const MAX_ACTIVE_STATES_PER_PRODUCT = 1_000

const isSameLocalInventoryResource = (
  state: { identity: MCProductIdentity; storeCode?: string },
  identity: MCProductIdentity,
  storeCode: string,
): boolean =>
  state.storeCode === storeCode && getIdentityKey(state.identity) === getIdentityKey(identity)

/**
 * A claim the store reported back unchanged is not this worker's to act on:
 * either a newer desired instant already won, or the identity has since been
 * deleted at or after this instant.
 */
const claimWasRefused = (state: GmcPublicationState, desiredAt: string): boolean =>
  state.status === 'deleted' || (state.desiredAt !== undefined && state.desiredAt > desiredAt)

const nextPayloadCursor = (args: {
  batchSize: number
  current?: GmcDocumentID
  docs: Array<{ id: GmcDocumentID }>
  operation: string
}): GmcDocumentID | undefined => {
  if (args.docs.length > args.batchSize) {
    throw new TypeError(`${args.operation} received an oversized Payload page`)
  }
  for (const doc of args.docs) {
    if (
      !doc ||
      !(
        (typeof doc.id === 'string' && doc.id.trim().length > 0) ||
        (typeof doc.id === 'number' && Number.isSafeInteger(doc.id))
      )
    ) {
      throw new TypeError(`${args.operation} received a Payload row without a valid ID`)
    }
  }
  if (args.docs.length !== args.batchSize) {
    return undefined
  }
  const next = args.docs.at(-1)?.id
  if (next === undefined || next === args.current) {
    throw new TypeError(`${args.operation} keyset pagination did not advance`)
  }
  return next
}

export const createGmcCommandExecutor = (
  options: NormalizedGmcV2Options,
  dependencies: GmcCommandExecutorDependencies = {},
) => {
  const createIdempotencyKey = (parts: Array<number | string | undefined>): string => {
    return hashIdempotencyKey(options.instanceId, parts)
  }
  const getGmcCommandSubject = (command: GmcCommand): string => {
    return getRawGmcCommandSubject(command, options.instanceId)
  }
  const stateStore =
    dependencies.stateStore ??
    createPayloadPublicationStateStore({
      collectionSlug: options.publicationState.collectionSlug,
      dataSourceName: options.dataSourceName,
      merchantId: options.merchantId,
    })
  const transport = dependencies.transport ?? createGoogleMerchantTransport(options)
  const listActiveProductStates = async (args: { payload: Payload; productId: GmcDocumentID }) => {
    const states = await stateStore.listByProduct(args)
    if (!Array.isArray(states)) {
      throw new TypeError('GMC publication state store listByProduct must return an array')
    }
    const active = states.filter((state) => state.status !== 'deleted')
    if (active.length > MAX_ACTIVE_STATES_PER_PRODUCT) {
      throw new TypeError(
        `GMC product ${String(args.productId)} exceeds ${MAX_ACTIVE_STATES_PER_PRODUCT} active publication identities`,
      )
    }
    return active
  }
  const rateLimiter = createRateLimiterService({
    enabled: options.rateLimit.enabled,
    maxConcurrency: options.rateLimit.maxConcurrency,
    maxQueueSize: options.rateLimit.maxQueueSize,
    maxRequestsPerMinute: options.rateLimit.maxRequestsPerMinute,
    scopeKey: `merchant:${options.merchantId}`,
    store: options.rateLimit.store,
  })
  const retry = createRetryService({
    baseRetryDelayMs: options.rateLimit.baseRetryDelayMs,
    jitterFactor: options.rateLimit.jitterFactor,
    maxRetries: options.rateLimit.maxRetries,
    maxRetryDelayMs: options.rateLimit.maxRetryDelayMs,
  })

  const merchantCall = <T>(operation: string, call: () => Promise<T>): Promise<T> => {
    // Every physical HTTP attempt must reserve its own local/distributed quota
    // slot. Wrapping retry inside the limiter would count an entire retry storm
    // as one request and could amplify the very 429 response being retried.
    let retriedUnauthorized = false
    return retry.execute(
      async () => {
        try {
          return await rateLimiter.execute(call)
        } catch (error) {
          // GoogleApiClient invalidates the rejected cached token before it
          // surfaces a 401. Retry that authentication transition once, but re-enter
          // the limiter so the second physical Merchant request consumes its own
          // local/distributed quota slot. A second 401 is terminal for this durable
          // attempt and avoids hammering invalid credentials.
          if (!retriedUnauthorized && error instanceof GoogleApiError && error.statusCode === 401) {
            retriedUnauthorized = true
            return rateLimiter.execute(call)
          }
          throw error
        }
      },
      { operation },
    )
  }

  const dataSourceCache = new Map<
    string,
    { dataSource: GmcApiPrimaryDataSource; expiresAt: number }
  >()
  const dataSourceReads = new Map<string, Promise<GmcApiPrimaryDataSource>>()
  const getApiPrimaryDataSource = async (args: {
    dataSourceName: string
    payload: Payload
  }): Promise<GmcApiPrimaryDataSource> => {
    let dataSource = dataSourceCache.get(args.dataSourceName)
    if (!dataSource || dataSource.expiresAt <= Date.now()) {
      let read = dataSourceReads.get(args.dataSourceName)
      if (!read) {
        read = merchantCall('dataSources.get', async () =>
          assertGmcApiPrimaryDataSource(
            await transport.getApiPrimaryDataSource({
              dataSourceName: args.dataSourceName,
              payload: args.payload,
            }),
            args.dataSourceName,
          ),
        )
        dataSourceReads.set(args.dataSourceName, read)
      }
      try {
        const resolved = await read
        dataSource = {
          dataSource: resolved,
          expiresAt: Date.now() + DATA_SOURCE_VALIDATION_TTL_MS,
        }
        dataSourceCache.set(args.dataSourceName, dataSource)
      } finally {
        if (dataSourceReads.get(args.dataSourceName) === read) {
          dataSourceReads.delete(args.dataSourceName)
        }
      }
    }
    return dataSource.dataSource
  }
  const requireApiPrimaryDataSource = async (args: {
    dataSourceName: string
    identity?: MCProductIdentity
    payload: Payload
  }): Promise<void> => {
    const dataSources = await Promise.all(
      options.dataSourceNames.map((dataSourceName) =>
        getApiPrimaryDataSource({ dataSourceName, payload: args.payload }),
      ),
    )
    assertGmcApiPrimaryDataSourceTopology(dataSources)
    const dataSource = dataSources.find((candidate) => candidate.name === args.dataSourceName)
    if (!dataSource) {
      throw new TypeError(`Merchant data source ${args.dataSourceName} is not configured`)
    }
    if (args.identity) {
      assertGmcApiDataSourceAcceptsIdentity(dataSource, args.identity)
    }
  }
  const getOwnedProcessedProduct = async (args: {
    dataSourceName: string
    identity: MCProductIdentity
    payload: Payload
  }) => {
    const remote = await merchantCall('products.get', () =>
      transport.getProcessedProduct({
        identity: args.identity,
        payload: args.payload,
      }),
    )
    if (remote && remote.dataSourceName !== args.dataSourceName) {
      throw new GmcProductDataSourceConflictError({
        actualDataSourceName: remote.dataSourceName,
        expectedDataSourceName: args.dataSourceName,
      })
    }
    return remote
  }

  const dispatch = async (
    request: Omit<GmcAsyncDispatchArgs, 'parentOperationId' | 'payload' | 'req'>,
    context: Pick<GmcExecutionContext, 'operationId' | 'payload' | 'rootOperationId'>,
  ): Promise<GmcDispatchReceipt> => {
    assertGmcCommand(request.command)
    return assertGmcDispatchReceipt(
      await options.async.dispatch({
        ...request,
        parentOperationId: context.operationId,
        payload: context.payload,
        rootOperationId: context.rootOperationId ?? context.operationId,
      }),
    )
  }

  const executeDataSourcesValidate = async (
    context: {
      command: Extract<GmcCommand, { type: 'dataSources.validate' }>
    } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    for (const dataSourceName of options.dataSourceNames) {
      await requireApiPrimaryDataSource({ dataSourceName, payload: context.payload })
    }
    for (const feed of options.feeds) {
      const identity: MCProductIdentity = {
        contentLanguage: feed.selector.contentLanguage,
        dataSourceOverride: feed.selector.dataSourceOverride,
        feedLabel: feed.selector.feedLabel,
        offerId: '__gmc_v2_preflight__',
      }
      await requireApiPrimaryDataSource({
        dataSourceName: resolveGmcDataSourceName(identity, options),
        identity,
        payload: context.payload,
      })
    }
    return {
      commandType: context.command.type,
      operationId: context.operationId,
      outcome: 'completed',
      remoteCount: options.dataSourceNames.length,
    }
  }

  const dispatchDeletes = async (args: {
    command: GmcProductDeleteCommand | GmcProductPublishCommand
    identities: GmcProductDeleteCommand['identities']
    operationId: string
    payload: Payload
    /**
     * Omitted for a legacy `product.delete` that never carried an owner. The
     * child then leaves `expectedProductId` unset so the store's ownership
     * guard cannot refuse a delete no one can attribute.
     */
    productId?: GmcDocumentID
    rootOperationId?: string
  }): Promise<GmcDispatchReceipt[]> => {
    const receipts: GmcDispatchReceipt[] = []
    const identities = uniqueIdentities(
      args.identities.map((identity) => normalizeGmcIdentityRoute(identity, options)),
    )
    for (const identity of identities) {
      const child = createOfferDeleteCommand({
        expectedProductId: args.productId,
        identity,
        requestedAt: args.command.requestedAt,
      })
      receipts.push(
        await dispatch(
          {
            command: child,
            idempotencyKey: createIdempotencyKey([
              args.operationId,
              child.type,
              getIdentityKey(identity),
            ]),
            subject: getGmcCommandSubject(child),
          },
          args,
        ),
      )
    }
    return receipts
  }

  const executeProductPublish = async (
    context: {
      command: GmcProductPublishCommand
    } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    const { command, operationId, payload } = context
    const desiredAt = command.requestedAt
    const doc = await findPublishedDocument({ options, payload, productId: command.productId })
    const oldStates = await listActiveProductStates({ payload, productId: command.productId })
    const previousIdentities = [
      ...(command.previousIdentities ?? []),
      ...oldStates.map((state) => state.identity),
    ]

    if (!doc) {
      const dispatched = await dispatchDeletes({
        command,
        identities: previousIdentities,
        operationId,
        payload,
        productId: command.productId,
        rootOperationId: context.rootOperationId,
      })
      return {
        commandType: command.type,
        dispatched,
        operationId,
        outcome: dispatched.length > 0 ? 'completed' : 'skipped',
        productCount: 0,
      }
    }

    const projection = await options.products.project({
      doc,
      payload,
      projectionTime: desiredAt,
    })
    const projected = canonicalizeProjection(projection)
    const currentIdentities = new Set(
      projected.products.map((product) =>
        getIdentityKey(normalizeGmcIdentityRoute(product.identity, options)),
      ),
    )
    const staleIdentities = previousIdentities.filter(
      (identity) =>
        !currentIdentities.has(getIdentityKey(normalizeGmcIdentityRoute(identity, options))),
    )
    const dispatched = await dispatchDeletes({
      command,
      identities: staleIdentities,
      operationId,
      payload,
      productId: command.productId,
      rootOperationId: context.rootOperationId,
    })

    for (const product of projected.products) {
      const identity = normalizeGmcIdentityRoute(product.identity, options)
      // A single claim: it registers desired ownership before a reconciliation
      // sweep can see the identity, and it is the authority on whether this
      // command still describes the newest desired content.
      const desiredState = await stateStore.claimPublication({
        desiredAt,
        desiredDigest: product.digest,
        identity,
        operationId,
        payload,
        productId: command.productId,
      })
      if (claimWasRefused(desiredState, desiredAt)) {
        continue
      }
      if (
        command.cause !== 'reconcile' &&
        desiredState.status === 'published' &&
        desiredState.publishedDigest === product.digest
      ) {
        continue
      }
      const child = createOfferPublishCommand({
        digest: product.digest,
        input: {
          ...product.input,
          dataSourceOverride: identity.dataSourceOverride,
        },
        productId: command.productId,
        requestedAt: command.requestedAt,
        verifyRemote: command.cause === 'reconcile',
        versionNumber: projection.sourceVersion,
      })
      dispatched.push(
        await dispatch(
          {
            command: child,
            idempotencyKey: createIdempotencyKey([
              operationId,
              child.type,
              getIdentityKey(identity),
              product.digest,
            ]),
            subject: getGmcCommandSubject(child),
          },
          context,
        ),
      )
    }

    if (options.localInventory && projected.products.length > 0) {
      for (const storeCode of [
        ...options.localInventory.storeCodes,
        ...(options.localInventory.retiredStoreCodes ?? []),
      ]) {
        const localCommand: Extract<GmcCommand, { type: 'localInventory.reconcile' }> = {
          type: 'localInventory.reconcile',
          productId: command.productId,
          requestedAt: command.requestedAt,
          schemaVersion: command.schemaVersion,
          storeCode,
        }
        dispatched.push(
          await dispatch(
            {
              command: localCommand,
              idempotencyKey: createIdempotencyKey([
                operationId,
                localCommand.type,
                command.productId,
                storeCode,
                projected.products[0]?.digest,
              ]),
              subject: getGmcCommandSubject(localCommand),
            },
            context,
          ),
        )
      }
    }

    return {
      commandType: command.type,
      dispatched,
      operationId,
      outcome: 'completed',
      productCount: projected.products.length,
    }
  }

  /**
   * `product.delete` is no longer emitted, but rc.35 rows and a host
   * `afterDelete` hook still produce it. It executes with `product.publish`
   * semantics, its identities standing in for the previously owned set. A
   * command without a `productId` — the document is already gone and was never
   * attributed — unconditionally deletes every identity it lists.
   */
  const executeProductDelete = async (
    context: { command: GmcProductDeleteCommand } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    const { command, operationId, payload } = context
    if (command.productId === undefined) {
      const dispatched = await dispatchDeletes({
        command,
        identities: command.identities,
        operationId,
        payload,
        rootOperationId: context.rootOperationId,
      })
      return {
        commandType: command.type,
        dispatched,
        operationId,
        outcome: dispatched.length > 0 ? 'completed' : 'skipped',
        productCount: 0,
      }
    }
    const result = await executeProductPublish({
      ...context,
      command: {
        type: 'product.publish',
        cause: command.cause,
        previousIdentities: command.identities,
        productId: command.productId,
        requestedAt: command.requestedAt,
        schemaVersion: command.schemaVersion,
      },
    })
    return { ...result, commandType: command.type }
  }

  const executeOfferPublish = async (
    context: {
      command: Extract<GmcCommand, { type: 'offer.publish' }>
    } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    const product = canonicalizeProductInput({ input: context.command.input })
    product.identity = normalizeGmcIdentityRoute(product.identity, options)
    // The digest is the durable ordering and idempotency key, so a row whose
    // digest no longer describes its own input is corrupt, not merely stale.
    if (product.digest !== context.command.digest) {
      throw new TypeError('offer.publish digest does not match its canonical input')
    }
    const claim = {
      desiredAt: context.command.requestedAt,
      desiredDigest: product.digest,
      identity: product.identity,
      operationId: context.operationId,
      payload: context.payload,
      productId: context.command.productId,
    }
    const state = await stateStore.claimPublication(claim)
    const skipped = (remoteCount?: number): GmcCommandExecutionResult => ({
      commandType: context.command.type,
      operationId: context.operationId,
      outcome: 'skipped',
      productCount: 1,
      ...(remoteCount === undefined ? {} : { remoteCount }),
    })
    if (claimWasRefused(state, claim.desiredAt)) {
      return skipped()
    }
    const alreadyPublished =
      state.status === 'published' && state.publishedDigest === product.digest

    if (alreadyPublished && !context.command.verifyRemote) {
      return skipped()
    }

    try {
      const dataSourceName = resolveGmcDataSourceName(product.identity, options)
      await requireApiPrimaryDataSource({
        dataSourceName,
        identity: product.identity,
        payload: context.payload,
      })
      // ProductInput.insert is not a harmless upsert across sources: Google
      // moves an existing processed identity to the supplied source. That is
      // only reachable when more than one source is configured, so a
      // single-source deployment spends no request on the ownership read.
      // Reconciliation asks for it explicitly to prove the offer is still
      // present remotely before trusting the local idempotency shortcut.
      const needsOwnershipRead =
        options.dataSourceNames.length > 1 || context.command.verifyRemote === true
      const remote = needsOwnershipRead
        ? await getOwnedProcessedProduct({
            dataSourceName,
            identity: product.identity,
            payload: context.payload,
          })
        : null
      if (alreadyPublished && context.command.verifyRemote && remote) {
        await stateStore.markObserved({
          identity: product.identity,
          observedAt: new Date().toISOString(),
          payload: context.payload,
          remoteMissing: false,
          remoteStatus: remote.productStatus,
          remoteVersion: remote.versionNumber,
        })
        return skipped(1)
      }
      await merchantCall('productInputs.insert', () =>
        transport.insertProductInput({
          dataSourceName,
          input: {
            ...product.input,
            ...(context.command.versionNumber === undefined
              ? {}
              : { versionNumber: context.command.versionNumber }),
          },
          payload: context.payload,
        }),
      )
    } catch (error) {
      try {
        await stateStore.markFailed({
          error: getErrorState(error),
          identity: product.identity,
          operationId: context.operationId,
          payload: context.payload,
        })
      } catch (stateError) {
        throw new AggregateError(
          [error, stateError],
          'Merchant publish and failure-state persistence both failed',
        )
      }
      throw error
    }

    await stateStore.markPublished({
      ...claim,
      publishedAt: new Date().toISOString(),
    })
    return {
      commandType: context.command.type,
      operationId: context.operationId,
      outcome: 'completed',
      productCount: 1,
    }
  }

  const executeOfferDelete = async (
    context: {
      command: Extract<GmcCommand, { type: 'offer.delete' }>
    } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    const identity = normalizeGmcIdentityRoute(context.command.identity, options)
    const pending = await stateStore.markDeletePending({
      deletedAt: context.command.requestedAt,
      identity,
      onlyIfDesiredBefore: context.command.onlyIfDesiredBefore,
      operationId: context.operationId,
      payload: context.payload,
      productId: context.command.expectedProductId,
    })
    if (!pending || pending.status === 'deleted') {
      return {
        commandType: context.command.type,
        operationId: context.operationId,
        outcome: 'skipped',
        productCount: 0,
      }
    }

    try {
      const dataSourceName = resolveGmcDataSourceName(identity, options)
      await requireApiPrimaryDataSource({
        dataSourceName,
        identity,
        payload: context.payload,
      })
      await merchantCall('productInputs.delete', () =>
        transport.deleteProductInput({
          dataSourceName,
          identity,
          payload: context.payload,
        }),
      )
    } catch (error) {
      try {
        await stateStore.markFailed({
          error: getErrorState(error),
          identity,
          operationId: context.operationId,
          payload: context.payload,
        })
      } catch (stateError) {
        throw new AggregateError(
          [error, stateError],
          'Merchant delete and failure-state persistence both failed',
        )
      }
      throw error
    }

    await stateStore.markDeleted({
      deletedAt: context.command.requestedAt,
      identity,
      operationId: context.operationId,
      payload: context.payload,
      productId: context.command.expectedProductId,
    })
    return {
      commandType: context.command.type,
      operationId: context.operationId,
      outcome: 'completed',
      productCount: 0,
    }
  }

  const executeCatalogPublish = async (
    context: {
      command: Extract<GmcCommand, { type: 'catalog.publish' }>
    } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    const result = await context.payload.find({
      collection: options.products.collection,
      depth: 0,
      draft: false,
      limit: options.products.batchSize,
      overrideAccess: true,
      pagination: false,
      select: { id: true } as never,
      sort: 'id',
      where: mergeGmcCursorWhere(
        options.products.where,
        context.command.cursor,
        context.command.productIds,
      ),
    })
    const docs = result.docs as unknown as Array<{ id: GmcDocumentID }>
    const cursor = nextPayloadCursor({
      batchSize: options.products.batchSize,
      current: context.command.cursor,
      docs,
      operation: 'Catalog publication',
    })
    const pageIndex = context.command.pageIndex ?? 0
    if (cursor !== undefined && pageIndex + 1 >= options.products.maxCatalogPages) {
      throw new TypeError(
        `Catalog publication exceeded its ${options.products.maxCatalogPages} page safety limit`,
      )
    }
    const dispatched: GmcDispatchReceipt[] = []
    for (const doc of docs) {
      const child = createProductPublishCommand({
        cause: context.command.cause,
        productId: doc.id,
        requestedAt: context.command.requestedAt,
      })
      dispatched.push(
        await dispatch(
          {
            command: child,
            idempotencyKey: createIdempotencyKey([context.operationId, child.type, doc.id]),
            subject: getGmcCommandSubject(child),
          },
          context,
        ),
      )
    }

    if (cursor !== undefined) {
      const continuation: Extract<GmcCommand, { type: 'catalog.publish' }> = {
        type: 'catalog.publish',
        cause: context.command.cause,
        cursor,
        pageIndex: pageIndex + 1,
        productIds: context.command.productIds,
        requestedAt: context.command.requestedAt,
        schemaVersion: context.command.schemaVersion,
      }
      dispatched.push(
        await dispatch(
          {
            command: continuation,
            idempotencyKey: createIdempotencyKey([context.operationId, continuation.type, cursor]),
            subject: getGmcCommandSubject(continuation),
          },
          context,
        ),
      )
    }

    return {
      commandType: context.command.type,
      dispatched,
      operationId: context.operationId,
      outcome: 'completed',
      productCount: docs.length,
    }
  }

  const executeCatalogReconcile = async (
    context: {
      command: Extract<GmcCommand, { type: 'catalog.reconcile' }>
    } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    const phase = context.command.phase ?? 'desired'
    const startedAt = context.command.startedAt ?? context.command.requestedAt
    const dispatched: GmcDispatchReceipt[] = []

    if (phase === 'desired') {
      const result = await context.payload.find({
        collection: options.products.collection,
        depth: 0,
        draft: false,
        limit: options.products.batchSize,
        overrideAccess: true,
        pagination: false,
        select: { id: true } as never,
        sort: 'id',
        where: mergeGmcCursorWhere(options.products.where, context.command.cursor),
      })
      const docs = result.docs as unknown as Array<{ id: GmcDocumentID }>
      const cursor = nextPayloadCursor({
        batchSize: options.products.batchSize,
        current: context.command.cursor,
        docs,
        operation: 'Catalog reconciliation',
      })
      const pageIndex = context.command.pageIndex ?? 0
      if (cursor !== undefined && pageIndex + 1 >= options.products.maxCatalogPages) {
        throw new TypeError(
          `Catalog reconciliation exceeded its ${options.products.maxCatalogPages} local page safety limit`,
        )
      }
      // Reconciliation pages the catalog exactly like `catalog.publish`: one
      // durable child per product, never an inline republish. A product whose
      // desired content is unchanged therefore costs one remote verification
      // and no ProductInput write.
      for (const doc of docs) {
        const child = createProductPublishCommand({
          cause: 'reconcile',
          productId: doc.id,
          requestedAt: context.command.requestedAt,
        })
        dispatched.push(
          await dispatch(
            {
              command: child,
              idempotencyKey: createIdempotencyKey([context.operationId, child.type, doc.id]),
              subject: getGmcCommandSubject(child),
            },
            context,
          ),
        )
      }

      const continuation: Extract<GmcCommand, { type: 'catalog.reconcile' }> = {
        type: 'catalog.reconcile',
        cursor,
        pageIndex: cursor === undefined ? 0 : pageIndex + 1,
        phase: cursor === undefined ? 'remote' : 'desired',
        requestedAt: context.command.requestedAt,
        schemaVersion: context.command.schemaVersion,
        startedAt,
      }
      dispatched.push(
        await dispatch(
          {
            command: continuation,
            idempotencyKey: createIdempotencyKey([
              context.operationId,
              continuation.type,
              continuation.phase,
              cursor,
            ]),
            subject: getGmcCommandSubject(continuation),
          },
          context,
        ),
      )

      return {
        commandType: context.command.type,
        dispatched,
        operationId: context.operationId,
        outcome: 'completed',
        productCount: docs.length,
      }
    }

    for (const dataSourceName of options.dataSourceNames) {
      await requireApiPrimaryDataSource({ dataSourceName, payload: context.payload })
    }
    const page = await merchantCall('products.list', () =>
      transport.listProcessedProducts({
        pageSize: 1_000,
        pageToken: context.command.pageToken,
        payload: context.payload,
      }),
    )
    const ownedProducts = page.products.filter((product) =>
      options.dataSourceNames.includes(product.dataSourceName),
    )
    let orphanCount = 0
    let orphanDeleteCount = 0
    const observedAt = new Date().toISOString()
    for (const remote of ownedProducts) {
      const state = await stateStore.get({ identity: remote.identity, payload: context.payload })
      // Anything this sweep's own desired phase re-claimed at or after
      // `startedAt` is still wanted. Everything else — no row at all, a row the
      // deletion path already retired, or a claim older than the sweep — is a
      // remote orphan.
      const isOrphan =
        !state ||
        state.status === 'deleted' ||
        state.desiredAt === undefined ||
        state.desiredAt < startedAt
      if (!isOrphan) {
        await stateStore.markObserved({
          identity: remote.identity,
          observedAt,
          payload: context.payload,
          remoteMissing: false,
          remoteStatus: remote.productStatus,
          remoteVersion: remote.versionNumber,
        })
        continue
      }

      orphanCount++
      if (options.reconciliation.orphanDeletion !== 'exclusive-data-sources') {
        continue
      }
      const child = createOfferDeleteCommand({
        identity: remote.identity,
        onlyIfDesiredBefore: startedAt,
        requestedAt: context.command.requestedAt,
      })
      dispatched.push(
        await dispatch(
          {
            command: child,
            idempotencyKey: createIdempotencyKey([
              context.operationId,
              context.command.type,
              child.type,
              getIdentityKey(remote.identity),
            ]),
            subject: getGmcCommandSubject(child),
          },
          context,
        ),
      )
      orphanDeleteCount++
    }

    const pageIndex = context.command.pageIndex ?? 0
    if (page.nextPageToken) {
      if (page.nextPageToken === context.command.pageToken) {
        throw new TypeError('Merchant reconciliation pagination token did not advance')
      }
      if (pageIndex + 1 >= options.products.maxRemoteReconcilePages) {
        throw new TypeError(
          `Merchant reconciliation exceeded its ${options.products.maxRemoteReconcilePages} page safety limit`,
        )
      }
      const continuation: Extract<GmcCommand, { type: 'catalog.reconcile' }> = {
        type: 'catalog.reconcile',
        pageIndex: pageIndex + 1,
        pageToken: page.nextPageToken,
        phase: 'remote',
        requestedAt: context.command.requestedAt,
        schemaVersion: context.command.schemaVersion,
        startedAt,
      }
      dispatched.push(
        await dispatch(
          {
            command: continuation,
            idempotencyKey: createIdempotencyKey([
              context.operationId,
              continuation.type,
              continuation.phase,
              continuation.pageToken,
            ]),
            subject: getGmcCommandSubject(continuation),
          },
          context,
        ),
      )
    }

    return {
      commandType: context.command.type,
      dispatched,
      operationId: context.operationId,
      orphanCount,
      orphanDeleteCount,
      outcome: 'completed',
      remoteCount: ownedProducts.length,
    }
  }

  const executeFeedBuild = async (
    context: { command: Extract<GmcCommand, { type: 'feed.build' }> } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    const feed = options.feeds.find((candidate) => candidate.id === context.command.feedId)
    if (!feed) {
      throw new TypeError(`Unknown GMC feed ${context.command.feedId}`)
    }
    if (feed.delivery !== 'artifact') {
      throw new TypeError(
        `Feed ${feed.id} uses dynamic delivery and cannot be promoted as an artifact`,
      )
    }
    const currentDescriptor = await feed.artifactStore.readCurrentDescriptor({
      feedId: feed.id,
      instanceId: options.instanceId,
    })
    if (currentDescriptor) {
      assertFeedArtifactDescriptor({
        descriptor: currentDescriptor,
        feedId: feed.id,
        instanceId: options.instanceId,
      })
      if (currentDescriptor.generatedAt > context.command.requestedAt) {
        return {
          commandType: context.command.type,
          operationId: context.operationId,
          outcome: 'skipped',
        }
      }
      if (currentDescriptor.generatedAt === context.command.requestedAt) {
        // An at-least-once replay of the build that already won still has to
        // prove the promoted object is intact before reporting success.
        const current = await feed.artifactStore.readCurrent({
          feedId: feed.id,
          instanceId: options.instanceId,
        })
        if (!current) {
          throw new TypeError(`Feed ${feed.id} current artifact disappeared during replay`)
        }
        assertFeedArtifactIntegrity({
          ...current,
          feedId: feed.id,
          instanceId: options.instanceId,
          maxSerializedBytes: feed.limits?.maxSerializedBytes,
        })
        for (const field of GMC_ARTIFACT_DESCRIPTOR_FIELDS) {
          if (current.descriptor[field] !== currentDescriptor[field]) {
            throw new TypeError(
              `Feed ${feed.id} current artifact ${field} does not match its pointer descriptor`,
            )
          }
        }
        return {
          commandType: context.command.type,
          operationId: context.operationId,
          outcome: 'skipped',
        }
      }
    }
    const products = await collectCanonicalProducts({
      maxProducts: feed.limits?.maxProducts,
      maxProjectedBytes: feed.limits?.maxSerializedBytes,
      options,
      payload: context.payload,
      projectionTime: context.command.requestedAt,
      selector: feed.selector,
    })
    const published = await publishFeedArtifact({
      feed,
      generatedAt: context.command.requestedAt,
      instanceId: options.instanceId,
      products,
    })
    return {
      commandType: context.command.type,
      operationId: context.operationId,
      outcome: published.promotion === 'promoted' ? 'completed' : 'skipped',
      productCount: products.length,
    }
  }

  const executeStatusRefresh = async (
    context: {
      command: Extract<GmcCommand, { type: 'status.refresh' }>
    } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    const states =
      context.command.productId === undefined
        ? []
        : await listActiveProductStates({
            payload: context.payload,
            productId: context.command.productId,
          })
    const identities = uniqueIdentities(
      [...(context.command.identities ?? []), ...states.map((state) => state.identity)].map(
        (identity) => normalizeGmcIdentityRoute(identity, options),
      ),
    )
    // Status refresh is a read. Both inputs are already capped at 1,000
    // identities, so the union is verified rather than fanned out into one
    // durable child per offer.
    if (identities.length > MAX_ACTIVE_STATES_PER_PRODUCT) {
      throw new TypeError(
        `status.refresh cannot observe more than ${MAX_ACTIVE_STATES_PER_PRODUCT} identities in one command`,
      )
    }
    const observedAt = new Date().toISOString()
    let remoteCount = 0
    for (const identity of identities) {
      const expectedDataSource = resolveGmcDataSourceName(identity, options)
      await requireApiPrimaryDataSource({
        dataSourceName: expectedDataSource,
        identity,
        payload: context.payload,
      })
      const remote = await getOwnedProcessedProduct({
        dataSourceName: expectedDataSource,
        identity,
        payload: context.payload,
      })
      if (remote) {
        remoteCount++
      }
      await stateStore.markObserved({
        identity,
        observedAt,
        payload: context.payload,
        remoteMissing: remote === null,
        remoteStatus: remote?.productStatus,
        remoteVersion: remote?.versionNumber,
      })
    }
    return {
      commandType: context.command.type,
      operationId: context.operationId,
      outcome: identities.length === 0 ? 'skipped' : 'completed',
      productCount: identities.length,
      remoteCount,
    }
  }

  const executeLocalInventoryApply = async (
    context: {
      command: Extract<GmcCommand, { type: 'localInventory.apply' }>
    } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    if (!options.localInventory) {
      throw new TypeError('Local inventory is no longer configured')
    }
    const { command, operationId, payload } = context
    const activeStore = options.localInventory.storeCodes.includes(command.storeCode)
    const retiredStore = (options.localInventory.retiredStoreCodes ?? []).includes(
      command.storeCode,
    )
    if (!activeStore && !retiredStore) {
      throw new TypeError(`Unknown local inventory store code ${command.storeCode}`)
    }
    const identity = normalizeGmcIdentityRoute(command.identity, options)
    const skipped = (): GmcCommandExecutionResult => ({
      commandType: command.type,
      operationId,
      outcome: 'skipped',
      productCount: 1,
    })

    // Local inventory attaches to the processed product, so the base offer row
    // is the fence: it must still be owned by this product and its ProductInput
    // must already have landed.
    const base = await stateStore.get({ identity, payload })
    if (
      !base ||
      base.productId === undefined ||
      String(base.productId) !== String(command.productId)
    ) {
      return skipped()
    }
    if (base.status === 'publish-pending') {
      // ProductInput processing is asynchronous. Converge through durable
      // retry rather than discarding the store's inventory.
      throw new GmcProcessedProductNotReadyError(identity)
    }
    if (base.status !== 'published') {
      return skipped()
    }

    // A command can outlive a deployment which retires its store. Current
    // ownership wins: never let a previously queued insert resurrect retired
    // inventory after the configuration changed.
    const deleting = retiredStore || command.inventory === null
    const inventory = deleting
      ? null
      : canonicalizeLocalInventoryInput(command.inventory as NonNullable<typeof command.inventory>)
    if (inventory && inventory.storeCode !== command.storeCode) {
      throw new TypeError('Local inventory command storeCode does not match its input')
    }
    const claim = {
      desiredAt: command.requestedAt,
      desiredDigest: command.digest,
      identity,
      operationId,
      payload,
      productId: command.productId,
      storeCode: command.storeCode,
    }
    const claimed = await stateStore.claimLocalInventory(claim)
    if (!isSameLocalInventoryResource(claimed, identity, command.storeCode)) {
      throw new TypeError('Local-inventory publication store returned the wrong resource')
    }
    // The store applies the same claim rules as the base offer row: the
    // returned operationId only matches this command's when the claim won
    // (a newer or already-completed claim from elsewhere is reported back
    // unchanged, with a foreign operationId).
    if (claimed.operationId !== operationId) {
      return skipped()
    }
    if (claimed.status === 'published' && claimed.publishedDigest === command.digest) {
      return skipped()
    }

    try {
      const dataSourceName = resolveGmcDataSourceName(identity, options)
      await requireApiPrimaryDataSource({ dataSourceName, identity, payload })
      // Inventories are written against the processed product, which a second
      // data source could own. With a single configured source that transfer
      // is unreachable, so the ownership read is skipped.
      if (options.dataSourceNames.length > 1) {
        await getOwnedProcessedProduct({ dataSourceName, identity, payload })
      }

      if (deleting) {
        await merchantCall('localInventories.delete', () =>
          transport.deleteLocalInventory({
            identity,
            payload,
            storeCode: command.storeCode,
          }),
        )
      } else {
        if (!inventory) {
          throw new TypeError('Active local inventory command is missing its input')
        }
        await merchantCall('localInventories.insert', () =>
          transport.insertLocalInventory({ identity, inventory, payload }),
        )
      }
      const published = await stateStore.markLocalInventoryPublished({
        ...claim,
        publishedAt: new Date().toISOString(),
      })
      if (!isSameLocalInventoryResource(published, identity, command.storeCode)) {
        throw new TypeError('Local-inventory publication store published the wrong resource')
      }
      if (
        published.operationId !== operationId ||
        published.desiredDigest !== command.digest ||
        published.publishedDigest !== command.digest ||
        published.status !== 'published'
      ) {
        throw new TypeError('Local-inventory publication store did not retain the applied state')
      }
    } catch (error) {
      try {
        await stateStore.markLocalInventoryFailed({
          error: getErrorState(error),
          identity,
          operationId,
          payload,
          storeCode: command.storeCode,
        })
      } catch (stateError) {
        throw new AggregateError(
          [error, stateError],
          'Local-inventory mutation and failure-state persistence both failed',
        )
      }
      throw error
    }
    return {
      commandType: command.type,
      operationId,
      outcome: 'completed',
      productCount: 1,
    }
  }

  const executeLocalInventoryReconcile = async (
    context: {
      command: Extract<GmcCommand, { type: 'localInventory.reconcile' }>
    } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    if (!options.localInventory) {
      return {
        commandType: context.command.type,
        operationId: context.operationId,
        outcome: 'skipped',
        productCount: 0,
      }
    }

    if (context.command.storeCode === undefined) {
      const dispatched: GmcDispatchReceipt[] = []
      for (const storeCode of [
        ...options.localInventory.storeCodes,
        ...(options.localInventory.retiredStoreCodes ?? []),
      ]) {
        const child: Extract<GmcCommand, { type: 'localInventory.reconcile' }> = {
          type: 'localInventory.reconcile',
          productId: context.command.productId,
          requestedAt: context.command.requestedAt,
          schemaVersion: context.command.schemaVersion,
          storeCode,
        }
        dispatched.push(
          await dispatch(
            {
              command: child,
              idempotencyKey: createIdempotencyKey([
                context.operationId,
                child.type,
                child.productId,
                storeCode,
              ]),
              subject: getGmcCommandSubject(child),
            },
            context,
          ),
        )
      }
      return {
        commandType: context.command.type,
        dispatched,
        operationId: context.operationId,
        outcome: 'completed',
        productCount: 0,
      }
    }

    const storeCode = context.command.storeCode
    const retiredStore = (options.localInventory.retiredStoreCodes ?? []).includes(storeCode)
    if (!options.localInventory.storeCodes.includes(storeCode) && !retiredStore) {
      throw new TypeError(`Unknown local inventory store code ${context.command.storeCode}`)
    }

    if (context.command.productId === undefined) {
      const result = await context.payload.find({
        collection: options.products.collection,
        depth: 0,
        draft: false,
        limit: options.products.batchSize,
        overrideAccess: true,
        pagination: false,
        select: { id: true } as never,
        sort: 'id',
        where: mergeGmcCursorWhere(options.products.where, context.command.cursor),
      })
      const docs = result.docs as unknown as Array<{ id: GmcDocumentID }>
      const cursor = nextPayloadCursor({
        batchSize: options.products.batchSize,
        current: context.command.cursor,
        docs,
        operation: 'Local inventory reconciliation',
      })
      const pageIndex = context.command.pageIndex ?? 0
      if (cursor !== undefined && pageIndex + 1 >= options.products.maxCatalogPages) {
        throw new TypeError(
          `Local inventory reconciliation exceeded its ${options.products.maxCatalogPages} page safety limit`,
        )
      }
      const dispatched: GmcDispatchReceipt[] = []
      for (const doc of docs) {
        const child: Extract<GmcCommand, { type: 'localInventory.reconcile' }> = {
          type: 'localInventory.reconcile',
          productId: doc.id,
          requestedAt: context.command.requestedAt,
          schemaVersion: context.command.schemaVersion,
          storeCode,
        }
        dispatched.push(
          await dispatch(
            {
              command: child,
              idempotencyKey: createIdempotencyKey([
                context.operationId,
                child.type,
                doc.id,
                storeCode,
              ]),
              subject: getGmcCommandSubject(child),
            },
            context,
          ),
        )
      }
      if (cursor !== undefined) {
        const continuation: Extract<GmcCommand, { type: 'localInventory.reconcile' }> = {
          type: 'localInventory.reconcile',
          cursor,
          pageIndex: pageIndex + 1,
          requestedAt: context.command.requestedAt,
          schemaVersion: context.command.schemaVersion,
          storeCode,
        }
        dispatched.push(
          await dispatch(
            {
              command: continuation,
              idempotencyKey: createIdempotencyKey([
                context.operationId,
                continuation.type,
                cursor,
                storeCode,
              ]),
              subject: getGmcCommandSubject(continuation),
            },
            context,
          ),
        )
      }
      return {
        commandType: context.command.type,
        dispatched,
        operationId: context.operationId,
        outcome: 'completed',
        productCount: docs.length,
      }
    }

    const doc = await findPublishedDocument({
      options,
      payload: context.payload,
      productId: context.command.productId,
    })
    if (!doc) {
      return {
        commandType: context.command.type,
        operationId: context.operationId,
        outcome: 'skipped',
        productCount: 0,
      }
    }

    const projection = await options.products.project({
      doc,
      payload: context.payload,
      projectionTime: context.command.requestedAt,
    })
    const baseProducts = canonicalizeProjection(projection).products
    const baseOffers = new Map(
      baseProducts.map((product) => {
        const identity = normalizeGmcIdentityRoute(product.identity, options)
        return [
          getIdentityKey(identity),
          { identity, price: product.input.productAttributes?.price },
        ] as const
      }),
    )
    const projected = retiredStore
      ? []
      : await options.localInventory.project({
          doc,
          payload: context.payload,
          projectionTime: context.command.requestedAt,
          storeCode,
        })
    if (!Array.isArray(projected) || projected.length > baseOffers.size) {
      throw new TypeError(
        `Local inventory projection for ${storeCode} must return at most one entry per canonical offer`,
      )
    }
    const desired = new Map<string, null | ReturnType<typeof canonicalizeLocalInventoryInput>>()
    for (const entry of projected) {
      if (!entry || typeof entry !== 'object' || typeof entry.storeCode !== 'string') {
        throw new TypeError(`Local inventory projection for ${storeCode} returned an invalid entry`)
      }
      const normalizedIdentity = normalizeGmcIdentityRoute(entry.identity, options)
      const identityKey = getIdentityKey(normalizedIdentity)
      const baseOffer = baseOffers.get(identityKey)
      if (!baseOffer) {
        throw new TypeError(
          `Local inventory projection references a non-canonical offer ${identityKey}`,
        )
      }
      const entryStoreCode = entry.storeCode.trim()
      if (entryStoreCode !== context.command.storeCode) {
        throw new TypeError(
          `Local inventory projection for ${context.command.storeCode} returned entry for ${entryStoreCode || 'an empty store'}`,
        )
      }
      const key = `${identityKey}|${entryStoreCode}`
      if (desired.has(key)) {
        throw new TypeError(`Local inventory projection contains duplicate offer/store ${key}`)
      }
      const inventory =
        entry.inventory === null ? null : canonicalizeLocalInventoryInput(entry.inventory)
      if (inventory) {
        if (!baseOffer.price) {
          throw new TypeError(`Canonical offer ${identityKey} is missing its validated price`)
        }
        assertLocalInventoryMatchesProductPrice(inventory, baseOffer.price)
      }
      if (inventory && inventory.storeCode !== entryStoreCode) {
        throw new TypeError(
          `Local inventory entry storeCode does not match inventory.storeCode for ${key}`,
        )
      }
      desired.set(key, inventory)
    }

    const dispatched: GmcDispatchReceipt[] = []
    for (const { identity } of baseOffers.values()) {
      const key = `${getIdentityKey(identity)}|${storeCode}`
      const child = createLocalInventoryApplyCommand({
        identity,
        inventory: desired.get(key) ?? null,
        productId: context.command.productId,
        requestedAt: context.command.requestedAt,
        storeCode,
      })
      dispatched.push(
        await dispatch(
          {
            command: child,
            idempotencyKey: createIdempotencyKey([
              context.operationId,
              child.type,
              key,
              child.digest,
            ]),
            subject: getGmcCommandSubject(child),
          },
          context,
        ),
      )
    }
    return {
      commandType: context.command.type,
      dispatched,
      operationId: context.operationId,
      outcome: 'completed',
      productCount: baseProducts.length,
    }
  }

  return async (rawContext: GmcCommandExecutionContext): Promise<GmcCommandExecutionResult> => {
    assertGmcCommand(rawContext.command)
    if (!rawContext.operationId.trim()) {
      throw new TypeError('GMC command execution requires a durable operationId')
    }
    // `rawContext.sourceVersion` is @deprecated and ignored entirely: an rc.35
    // worker may still send one, and nothing in execution consults it.
    const context: GmcExecutionContext = rawContext

    switch (context.command.type) {
      case 'catalog.publish':
        return executeCatalogPublish({ ...context, command: context.command })
      case 'catalog.reconcile':
        return executeCatalogReconcile({ ...context, command: context.command })
      case 'dataSources.validate':
        return executeDataSourcesValidate({ ...context, command: context.command })
      case 'feed.build':
        return executeFeedBuild({ ...context, command: context.command })
      case 'localInventory.apply':
        return executeLocalInventoryApply({ ...context, command: context.command })
      case 'localInventory.reconcile':
        return executeLocalInventoryReconcile({ ...context, command: context.command })
      case 'offer.delete':
        return executeOfferDelete({ ...context, command: context.command })
      case 'offer.publish':
        return executeOfferPublish({ ...context, command: context.command })
      case 'product.delete':
        return executeProductDelete({ ...context, command: context.command })
      case 'product.publish':
        return executeProductPublish({ ...context, command: context.command })
      case 'status.refresh':
        return executeStatusRefresh({ ...context, command: context.command })
      default: {
        const unsupported: never = context.command
        throw new TypeError(`Unsupported GMC command: ${JSON.stringify(unsupported)}`)
      }
    }
  }
}
