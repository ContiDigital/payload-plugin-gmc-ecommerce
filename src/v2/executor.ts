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
  GmcPublicationStateStore,
  NormalizedGmcV2Options,
} from './types.js'

import { GoogleApiError } from '../server/services/sub-services/googleApiClient.js'
import { createRateLimiterService } from '../server/services/sub-services/rateLimiterService.js'
import { createRetryService } from '../server/services/sub-services/retryService.js'
import { assertGmcDispatchReceipt } from './async.js'
import {
  canonicalizeProductInput,
  canonicalizeProjection,
  canonicalJson,
  getIdentityKey,
} from './canonical.js'
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
  publishFeedArtifact,
} from './feed/buildFeed.js'
import { normalizeGmcIdentityRoute, resolveGmcDataSourceName } from './identity.js'
import {
  assertLocalInventoryMatchesProductPrice,
  canonicalizeLocalInventoryInput,
} from './localInventory.js'
import { isGmcNonNegativeInt64String } from './merchantWire.js'
import { createPayloadPublicationStateStore } from './state/payloadStateStore.js'
import { createGoogleMerchantTransport } from './transport/googleTransport.js'

export type GmcCommandExecutorDependencies = {
  stateStore?: GmcPublicationStateStore
  transport?: GmcMerchantTransport
}

/**
 * Internal execution context used once the entry point has normalized a
 * possibly-absent `sourceVersion` (see GmcCommandExecutionContext.sourceVersion,
 * @deprecated since 2.0.0). Every sub-executor sees a resolved string.
 */
type GmcExecutionContext = {
  sourceVersion: string
} & Omit<GmcCommandExecutionContext, 'sourceVersion'>

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

const compareSourceVersions = (left: string, right: string): number => {
  if (!isGmcNonNegativeInt64String(left) || !isGmcNonNegativeInt64String(right)) {
    throw new TypeError('GMC publication state contains an invalid signed-int64 source version')
  }
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

const isSameLocalInventoryResource = (
  state: { identity: MCProductIdentity; storeCode?: string },
  identity: MCProductIdentity,
  storeCode: string,
): boolean =>
  state.storeCode === storeCode && getIdentityKey(state.identity) === getIdentityKey(identity)

/**
 * LocalInventory has no Merchant-side versionNumber or conditional write.
 * Descendants from a slower catalog root can therefore reach the offer FIFO
 * after a causally newer product root even though their inherited source
 * version is older. Refuse the mutation whenever publication state proves the
 * base offer is newer, deleting, deleted, or failed. A missing state remains
 * admissible for an explicitly reconciled, already-owned migration offer.
 */
const isLocalInventoryMutationFenced = async (args: {
  identity: MCProductIdentity
  payload: Payload
  productId: GmcDocumentID
  sourceVersion: string
  stateStore: GmcPublicationStateStore
}): Promise<boolean> => {
  const state = await args.stateStore.get({ identity: args.identity, payload: args.payload })
  if (!state) {
    return false
  }
  if (state.productId !== undefined && String(state.productId) !== String(args.productId)) {
    return true
  }
  if (state.status !== 'published') {
    return true
  }
  return false
}

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
    productId: GmcDocumentID
    rootOperationId?: string
    sourceVersion: string
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
        sourceVersion: args.sourceVersion,
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
      projectionTime?: string
    } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    const { command, operationId, payload } = context
    const doc = await findPublishedDocument({ options, payload, productId: command.productId })
    const oldStates = await listActiveProductStates({ payload, productId: command.productId })
    const previousIdentities = [
      ...(command.previousIdentities ?? []),
      ...oldStates.filter((state) => state.status !== 'deleted').map((state) => state.identity),
    ]

    if (!doc) {
      const dispatched = await dispatchDeletes({
        command,
        identities: previousIdentities,
        operationId,
        payload,
        productId: command.productId,
        rootOperationId: context.rootOperationId,
        sourceVersion: context.sourceVersion,
      })
      return {
        commandType: command.type,
        dispatched,
        operationId,
        outcome: dispatched.length > 0 ? 'completed' : 'skipped',
        productCount: 0,
      }
    }

    const rawProjection = await options.products.project({
      doc,
      payload,
      projectionTime: context.projectionTime ?? command.requestedAt,
    })
    const projection =
      context.sourceVersion === undefined
        ? rawProjection
        : { ...rawProjection, sourceVersion: context.sourceVersion }
    const projected = canonicalizeProjection(projection)
    const desiredAt = context.projectionTime ?? command.requestedAt
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
      sourceVersion: projection.sourceVersion,
    })

    for (const product of projected.products) {
      const identity = normalizeGmcIdentityRoute(product.identity, options)
      const child = createOfferPublishCommand({
        input: {
          ...product.input,
          dataSourceOverride: identity.dataSourceOverride,
        },
        productId: command.productId,
        requestedAt: command.requestedAt,
        sourceVersion: product.sourceVersion,
        verifyRemote: command.cause === 'reconcile',
      })
      const desiredClaim = {
        desiredAt,
        desiredDigest: product.digest,
        identity,
        operationId,
        payload,
        productId: command.productId,
      }
      const desiredState = await stateStore.claimPublication(desiredClaim)
      if (
        command.cause !== 'reconcile' &&
        desiredState.status === 'published' &&
        desiredState.publishedDigest === product.digest
      ) {
        continue
      }
      const receipt = await dispatch(
        {
          command: child,
          idempotencyKey: createIdempotencyKey([
            operationId,
            child.type,
            getIdentityKey(identity),
            product.sourceVersion,
            product.digest,
          ]),
          subject: getGmcCommandSubject(child),
        },
        context,
      )
      dispatched.push(receipt)
      // Register desired ownership before the catalog coordinator advances to
      // the remote sweep. The child remains authoritative for the actual write.
      await stateStore.claimPublication({
        ...desiredClaim,
        operationId: receipt.operationId,
      })
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
                projected.products[0]?.sourceVersion,
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

  const executeProductDelete = async (
    context: { command: GmcProductDeleteCommand } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    const productId = context.command.productId ?? `deleted:${context.operationId}`
    const oldStates =
      context.command.productId === undefined
        ? []
        : await listActiveProductStates({
            payload: context.payload,
            productId: context.command.productId,
          })
    const dispatched = await dispatchDeletes({
      command: context.command,
      identities: [
        ...context.command.identities,
        ...oldStates.filter((state) => state.status !== 'deleted').map((state) => state.identity),
      ],
      operationId: context.operationId,
      payload: context.payload,
      productId,
      rootOperationId: context.rootOperationId,
      sourceVersion: context.sourceVersion,
    })
    return {
      commandType: context.command.type,
      dispatched,
      operationId: context.operationId,
      outcome: 'completed',
      productCount: 0,
    }
  }

  const executeOfferPublish = async (
    context: {
      command: Extract<GmcCommand, { type: 'offer.publish' }>
    } & GmcExecutionContext,
  ): Promise<GmcCommandExecutionResult> => {
    const product = canonicalizeProductInput({
      input: context.command.input,
      sourceVersion: context.command.sourceVersion,
    })
    product.identity = normalizeGmcIdentityRoute(product.identity, options)
    const claim = {
      desiredAt: context.command.requestedAt,
      desiredDigest: product.digest,
      identity: product.identity,
      operationId: context.operationId,
      payload: context.payload,
      productId: context.command.productId,
    }
    const state = await stateStore.claimPublication(claim)
    const alreadyPublished =
      state.status === 'published' && state.publishedDigest === product.digest

    if (alreadyPublished && !context.command.verifyRemote) {
      return {
        commandType: context.command.type,
        operationId: context.operationId,
        outcome: 'skipped',
        productCount: 1,
      }
    }

    try {
      const dataSourceName = resolveGmcDataSourceName(product.identity, options)
      await requireApiPrimaryDataSource({
        dataSourceName,
        identity: product.identity,
        payload: context.payload,
      })
      // ProductInput.insert is not a harmless upsert across sources: Google
      // moves an existing processed identity to the supplied source. Always
      // inspect ownership immediately before a write and make source migration
      // an explicit operator workflow rather than an accidental side effect.
      const remote = await getOwnedProcessedProduct({
        dataSourceName,
        identity: product.identity,
        payload: context.payload,
      })
      if (alreadyPublished && context.command.verifyRemote && remote) {
        await stateStore.markObserved({
          identity: product.identity,
          observedAt: new Date().toISOString(),
          payload: context.payload,
          remoteMissing: false,
          remoteStatus: remote.productStatus,
          remoteVersion: remote.versionNumber,
        })
        return {
          commandType: context.command.type,
          operationId: context.operationId,
          outcome: 'skipped',
          productCount: 1,
          remoteCount: 1,
        }
      }
      await merchantCall('productInputs.insert', () =>
        transport.insertProductInput({
          dataSourceName,
          input: { ...product.input, versionNumber: context.command.sourceVersion },
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
      identity,
      onlyIfDesiredBefore: context.command.deleteIfDesiredBefore,
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
    const startedVersion = context.command.startedVersion ?? context.sourceVersion
    const dispatched: GmcDispatchReceipt[] = []

    if (phase === 'desired') {
      const projectionTime = startedAt
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
      for (const doc of docs) {
        const child = createProductPublishCommand({
          cause: 'reconcile',
          productId: doc.id,
          requestedAt: context.command.requestedAt,
        })
        const coordinated = await executeProductPublish({
          command: child,
          operationId: context.operationId,
          payload: context.payload,
          projectionTime,
          rootOperationId: context.rootOperationId,
          sourceVersion: context.sourceVersion,
        })
        dispatched.push(...(coordinated.dispatched ?? []))
      }

      const continuation: Extract<GmcCommand, { type: 'catalog.reconcile' }> = {
        type: 'catalog.reconcile',
        cursor,
        pageIndex: cursor === undefined ? 0 : pageIndex + 1,
        phase: cursor === undefined ? 'remote' : 'desired',
        requestedAt: context.command.requestedAt,
        schemaVersion: context.command.schemaVersion,
        startedAt,
        startedVersion,
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
      if (
        state &&
        state.status !== 'deleted' &&
        state.desiredAt !== undefined &&
        state.desiredAt >= startedAt
      ) {
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
        deleteIfDesiredBefore: startedAt,
        deleteIfDesiredVersionBefore: startedVersion,
        identity: remote.identity,
        requestedAt: context.command.requestedAt,
        sourceVersion: context.sourceVersion,
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
        startedVersion,
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
      const comparison = compareSourceVersions(
        currentDescriptor.sourceVersion,
        context.sourceVersion,
      )
      if (comparison > 0) {
        return {
          commandType: context.command.type,
          operationId: context.operationId,
          outcome: 'skipped',
        }
      }
      if (comparison === 0) {
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
        for (const field of [
          'byteLength',
          'checksum',
          'contentType',
          'createdAt',
          'key',
          'sourceVersion',
        ] as const) {
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
      sourceVersion: context.sourceVersion,
    })
    const published = await publishFeedArtifact({
      feed,
      generatedAt: context.command.requestedAt,
      instanceId: options.instanceId,
      products,
      sourceVersion: context.sourceVersion,
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
      [
        ...(context.command.identities ?? []),
        ...states.filter((state) => state.status !== 'deleted').map((state) => state.identity),
      ].map((identity) => normalizeGmcIdentityRoute(identity, options)),
    )
    if (identities.length > 1) {
      const dispatched: GmcDispatchReceipt[] = []
      for (const identity of identities) {
        const child: Extract<GmcCommand, { type: 'status.refresh' }> = {
          type: 'status.refresh',
          identities: [identity],
          requestedAt: context.command.requestedAt,
          schemaVersion: context.command.schemaVersion,
        }
        dispatched.push(
          await dispatch(
            {
              command: child,
              idempotencyKey: createIdempotencyKey([
                context.operationId,
                child.type,
                getIdentityKey(identity),
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
        productCount: identities.length,
      }
    }
    const observedAt = new Date().toISOString()
    let remoteCount = 0
    for (const identity of identities) {
      await requireApiPrimaryDataSource({
        dataSourceName: resolveGmcDataSourceName(identity, options),
        identity,
        payload: context.payload,
      })
      const expectedDataSource = resolveGmcDataSourceName(identity, options)
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
    const activeStore = options.localInventory.storeCodes.includes(context.command.storeCode)
    const retiredStore = (options.localInventory.retiredStoreCodes ?? []).includes(
      context.command.storeCode,
    )
    if (!activeStore && !retiredStore) {
      throw new TypeError(`Unknown local inventory store code ${context.command.storeCode}`)
    }
    const identity = normalizeGmcIdentityRoute(context.command.identity, options)
    const mutationIsFenced = (): Promise<boolean> =>
      isLocalInventoryMutationFenced({
        identity,
        payload: context.payload,
        productId: context.command.productId,
        sourceVersion: context.sourceVersion,
        stateStore,
      })
    if (await mutationIsFenced()) {
      return {
        commandType: context.command.type,
        operationId: context.operationId,
        outcome: 'skipped',
        productCount: 1,
      }
    }
    // A command can outlive a deployment which retires its store. Current
    // ownership wins: never let a previously queued insert resurrect retired
    // inventory after the configuration changed.
    const deleting = retiredStore || context.command.inventory === null
    const inventory = deleting
      ? null
      : canonicalizeLocalInventoryInput(
          context.command.inventory as NonNullable<typeof context.command.inventory>,
        )
    if (inventory && inventory.storeCode !== context.command.storeCode) {
      throw new TypeError('Local inventory command storeCode does not match its input')
    }
    const desiredDigest = createHash('sha256')
      .update(
        canonicalJson({
          identity,
          inventory,
          productId: context.command.productId,
          storeCode: context.command.storeCode,
        }),
      )
      .digest('hex')
    const claim = {
      desiredAt: context.command.requestedAt,
      desiredDigest,
      identity,
      operationId: context.operationId,
      payload: context.payload,
      productId: context.command.productId,
      storeCode: context.command.storeCode,
    }
    const claimed = await stateStore.claimLocalInventory(claim)
    if (!isSameLocalInventoryResource(claimed, identity, context.command.storeCode)) {
      throw new TypeError('Local-inventory publication store returned the wrong resource')
    }
    // The store applies the same claim rules as the base offer row: the
    // returned operationId only matches this command's when the claim won
    // (a newer or already-completed claim from elsewhere is reported back
    // unchanged, with a foreign operationId).
    if (claimed.operationId !== context.operationId) {
      return {
        commandType: context.command.type,
        operationId: context.operationId,
        outcome: 'skipped',
        productCount: 1,
      }
    }
    const alreadyPublished =
      claimed.status === 'published' && claimed.publishedDigest === desiredDigest
    if (alreadyPublished) {
      return {
        commandType: context.command.type,
        operationId: context.operationId,
        outcome: 'skipped',
        productCount: 1,
      }
    }

    const markPublished = async (): Promise<void> => {
      const published = await stateStore.markLocalInventoryPublished({
        ...claim,
        publishedAt: new Date().toISOString(),
      })
      if (!isSameLocalInventoryResource(published, identity, context.command.storeCode)) {
        throw new TypeError('Local-inventory publication store published the wrong resource')
      }
      if (
        published.operationId !== context.operationId ||
        published.desiredDigest !== desiredDigest ||
        published.publishedDigest !== desiredDigest ||
        published.status !== 'published'
      ) {
        throw new TypeError('Local-inventory publication store did not retain the applied state')
      }
    }

    try {
      const dataSourceName = resolveGmcDataSourceName(identity, options)
      await requireApiPrimaryDataSource({
        dataSourceName,
        identity,
        payload: context.payload,
      })
      const remote = await getOwnedProcessedProduct({
        dataSourceName,
        identity,
        payload: context.payload,
      })
      if (!remote) {
        if (deleting) {
          await markPublished()
          return {
            commandType: context.command.type,
            operationId: context.operationId,
            outcome: 'skipped',
            productCount: 1,
          }
        }
        throw new GmcProcessedProductNotReadyError(identity)
      }
      // The control-plane and ownership reads above are remote calls. Recheck
      // both base-offer causality and the per-store claim immediately before
      // the whole-resource mutation.
      if (await mutationIsFenced()) {
        return {
          commandType: context.command.type,
          operationId: context.operationId,
          outcome: 'skipped',
          productCount: 1,
        }
      }
      const retained = await stateStore.getLocalInventory({
        identity,
        payload: context.payload,
        storeCode: context.command.storeCode,
      })
      if (!retained) {
        throw new TypeError('Local-inventory publication claim disappeared before mutation')
      }
      if (!isSameLocalInventoryResource(retained, identity, context.command.storeCode)) {
        throw new TypeError('Local-inventory publication store returned the wrong resource')
      }
      if (retained.operationId !== context.operationId || retained.desiredDigest !== desiredDigest) {
        // A newer per-store claim raced ahead of this command; stand down.
        return {
          commandType: context.command.type,
          operationId: context.operationId,
          outcome: 'skipped',
          productCount: 1,
        }
      }

      if (deleting) {
        await merchantCall('localInventories.delete', () =>
          transport.deleteLocalInventory({
            identity,
            payload: context.payload,
            storeCode: context.command.storeCode,
          }),
        )
      } else {
        if (!inventory) {
          throw new TypeError('Active local inventory command is missing its input')
        }
        if (inventory.storeCode !== context.command.storeCode) {
          throw new TypeError('Local inventory command storeCode does not match its input')
        }
        await merchantCall('localInventories.insert', () =>
          transport.insertLocalInventory({
            identity,
            inventory,
            payload: context.payload,
          }),
        )
      }
      await markPublished()
    } catch (error) {
      try {
        await stateStore.markLocalInventoryFailed({
          error: getErrorState(error),
          identity,
          operationId: context.operationId,
          payload: context.payload,
          storeCode: context.command.storeCode,
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
      commandType: context.command.type,
      operationId: context.operationId,
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

    const rawProjection = await options.products.project({
      doc,
      payload: context.payload,
      projectionTime: context.command.requestedAt,
    })
    const baseProducts = canonicalizeProjection(
      context.sourceVersion === undefined
        ? rawProjection
        : { ...rawProjection, sourceVersion: context.sourceVersion },
    ).products
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
              baseProducts[0]?.sourceVersion,
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
    // sourceVersion is @deprecated and optional; when a host still supplies one
    // it must be well-formed. Absent, it defaults to '0' for now (Task 7 drops
    // versioning entirely).
    if (
      rawContext.sourceVersion !== undefined &&
      !isGmcNonNegativeInt64String(rawContext.sourceVersion)
    ) {
      throw new TypeError(
        'GMC execution sourceVersion must be a non-negative signed int64 string when provided',
      )
    }
    const context: GmcExecutionContext = {
      ...rawContext,
      sourceVersion: rawContext.sourceVersion ?? '0',
    }

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
