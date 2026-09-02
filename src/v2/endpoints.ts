import type { Endpoint, PayloadRequest } from 'payload'

import { createHash } from 'node:crypto'

import type {
  GmcCommand,
  GmcDispatchReceipt,
  GmcDocumentID,
  GmcFeedConfig,
  NormalizedGmcV2Options,
} from './types.js'

import { AccessDeniedError } from '../server/utilities/access.js'
import { errorResponse, jsonResponse, parseRequestBody } from '../server/utilities/http.js'
import { assertGmcAsyncHealth, assertGmcAsyncOperation, assertGmcDispatchReceipt } from './async.js'
import { canonicalJson } from './canonical.js'
import { collectCanonicalProducts } from './catalog.js'
import {
  assertGmcCommand,
  createDataSourcesValidateCommand,
  createProductPublishCommand,
  getGmcCommandSubject,
} from './commands.js'
import { classifyGmcCommandError } from './errors.js'
import { createGmcCommandExecutor } from './executor.js'
import { assertFeedArtifactIntegrity, buildCanonicalFeed } from './feed/buildFeed.js'
import { isGmcNonNegativeInt64String } from './merchantWire.js'
import { GMC_V2_COMMAND_SCHEMA_VERSION } from './types.js'

const MAX_JSON_BODY_BYTES = 1_048_576

class GmcHttpError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'GmcHttpError'
    this.statusCode = statusCode
  }
}

const handled = (
  endpoint: {
    handler: (req: PayloadRequest) => Promise<Response>
  } & Omit<Endpoint, 'handler'>,
): Endpoint => ({
  ...endpoint,
  handler: async (req) => {
    let response: Response
    try {
      response = await endpoint.handler(req)
    } catch (error) {
      response = errorResponse(req, error)
    }
    if (response.headers.get('content-type')?.includes('application/json')) {
      response.headers.set('Cache-Control', 'private, no-store, max-age=0')
      response.headers.set('X-Content-Type-Options', 'nosniff')
    }
    return response
  },
})

const assertUserAccess = async (
  options: NormalizedGmcV2Options,
  req: PayloadRequest,
): Promise<void> => {
  if (!req.user) {
    throw new AccessDeniedError('Authentication required')
  }
  if (!(await options.access({ payload: req.payload, req, user: req.user }))) {
    throw new AccessDeniedError()
  }
}

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })

const requireIdempotencyKey = (req: PayloadRequest): string => {
  const value = req.headers.get('idempotency-key')?.trim()
  if (!value) {
    throw new GmcHttpError(400, 'Idempotency-Key header is required')
  }
  if (
    value.length > 200 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  ) {
    throw new GmcHttpError(400, 'Idempotency-Key header must contain 1-200 safe characters')
  }
  return value
}

const requireDocumentId = (value: unknown): GmcDocumentID => {
  if (
    (typeof value === 'string' &&
      value === value.trim() &&
      value.length > 0 &&
      value.length <= 512 &&
      !hasControlCharacters(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  ) {
    return value
  }
  throw new GmcHttpError(400, 'productId must be a canonical safe string or safe integer')
}

const requireOperationId = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > 200 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  ) {
    throw new GmcHttpError(400, 'operationId must contain 1-200 characters')
  }
  return value
}

const assertExactRequestFields = (
  body: Record<string, unknown>,
  allowedFields: readonly string[],
): void => {
  const allowed = new Set(allowedFields)
  if (Object.keys(body).some((field) => !allowed.has(field))) {
    throw new GmcHttpError(400, 'Request body contains unsupported fields')
  }
}

const assertNoRequestBody = (req: PayloadRequest): void => {
  const rawLength = req.headers.get('content-length')
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength)) {
      throw new GmcHttpError(400, 'Content-Length must be a non-negative integer')
    }
    if (!/^0+$/.test(rawLength)) {
      throw new GmcHttpError(400, 'Request body is not supported for this operation')
    }
  }
  const request = req as unknown as Request
  if (req.data !== undefined || (request.body !== null && request.body !== undefined)) {
    throw new GmcHttpError(400, 'Request body is not supported for this operation')
  }
}

/**
 * `sourceVersion` is @deprecated and ignored by the executor. An rc.35 worker
 * may still send one, so it is accepted when well-formed and rejected when
 * malformed rather than being silently reinterpreted.
 */
const parseLegacySourceVersion = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (!isGmcNonNegativeInt64String(value)) {
    throw new GmcHttpError(400, 'sourceVersion must be a non-negative signed int64 string')
  }
  return value
}

const dispatchCommand = async (args: {
  command: GmcCommand
  idempotencyKey: string
  options: NormalizedGmcV2Options
  req: PayloadRequest
}): Promise<GmcDispatchReceipt> => {
  // The reusable header limit is intentionally independent of any host ledger
  // column. Hash the complete namespace so even a 100-character instance ID
  // plus the longest command type remains a fixed, non-secret 76-character
  // immutable key (and therefore fits Fine's 200-character ECS ledger bound).
  const durableIdempotencyKey = `gmc-v2:http:${createHash('sha256')
    .update(
      [args.options.instanceId, args.command.type, args.idempotencyKey].join('\u0000'),
      'utf8',
    )
    .digest('hex')}`
  return assertGmcDispatchReceipt(
    await args.options.async.dispatch({
      command: args.command,
      idempotencyKey: durableIdempotencyKey,
      payload: args.req.payload,
      req: args.req,
      subject: getGmcCommandSubject(args.command, args.options.instanceId),
    }),
  )
}

const readJsonBody = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  const rawLength = req.headers.get('content-length')
  if (rawLength) {
    if (!/^\d+$/.test(rawLength)) {
      throw new GmcHttpError(400, 'Content-Length must be a non-negative integer')
    }
    const maxLength = String(MAX_JSON_BODY_BYTES)
    if (
      rawLength.length > maxLength.length ||
      (rawLength.length === maxLength.length && rawLength > maxLength)
    ) {
      throw new GmcHttpError(413, 'Request body exceeds 1 MiB')
    }
  }

  let parsed: Record<string, unknown>
  const request = req as unknown as Request
  if (!req.data && request.body && !request.bodyUsed) {
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let byteLength = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        byteLength += value.byteLength
        if (byteLength > MAX_JSON_BODY_BYTES) {
          await reader.cancel()
          throw new GmcHttpError(413, 'Request body exceeds 1 MiB')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(byteLength)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new GmcHttpError(400, 'Request body must be a JSON object')
      }
      parsed = value as Record<string, unknown>
    } catch (error) {
      if (error instanceof GmcHttpError) {
        throw error
      }
      throw new GmcHttpError(400, 'Request body contains malformed JSON')
    }
  } else {
    parsed = await parseRequestBody(req)
  }
  let normalizedLength: number
  try {
    normalizedLength = Buffer.byteLength(canonicalJson(parsed), 'utf8')
  } catch (error) {
    throw new GmcHttpError(
      400,
      error instanceof Error
        ? `Request body is not safe JSON: ${error.message}`
        : 'Request body is not safe JSON',
    )
  }
  if (normalizedLength > MAX_JSON_BODY_BYTES) {
    throw new GmcHttpError(413, 'Request body exceeds 1 MiB')
  }
  return parsed
}

const createDispatchEndpoints = (options: NormalizedGmcV2Options): Endpoint[] => {
  const basePath = options.api.basePath
  return [
    handled({
      handler: async (req) => {
        await assertUserAccess(options, req)
        const idempotencyKey = requireIdempotencyKey(req)
        assertNoRequestBody(req)
        const command = createDataSourcesValidateCommand()
        const receipt = await dispatchCommand({ command, idempotencyKey, options, req })
        return jsonResponse({ command: command.type, ...receipt }, 202)
      },
      method: 'post',
      path: `${basePath}/data-sources/validate`,
    }),
    handled({
      handler: async (req) => {
        await assertUserAccess(options, req)
        const idempotencyKey = requireIdempotencyKey(req)
        const body = await readJsonBody(req)
        assertExactRequestFields(body, ['productId'])
        const command = createProductPublishCommand({
          cause: 'api',
          productId: requireDocumentId(body.productId),
        })
        const receipt = await dispatchCommand({ command, idempotencyKey, options, req })
        return jsonResponse({ command: command.type, ...receipt }, 202)
      },
      method: 'post',
      path: `${basePath}/products/publish`,
    }),
    handled({
      handler: async (req) => {
        await assertUserAccess(options, req)
        const idempotencyKey = requireIdempotencyKey(req)
        const body = await readJsonBody(req)
        assertExactRequestFields(body, ['productId'])
        const command: Extract<GmcCommand, { type: 'status.refresh' }> = {
          type: 'status.refresh',
          productId: requireDocumentId(body.productId),
          requestedAt: new Date().toISOString(),
          schemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
        }
        const receipt = await dispatchCommand({ command, idempotencyKey, options, req })
        return jsonResponse({ command: command.type, ...receipt }, 202)
      },
      method: 'post',
      path: `${basePath}/products/status/refresh`,
    }),
    handled({
      handler: async (req) => {
        await assertUserAccess(options, req)
        const idempotencyKey = requireIdempotencyKey(req)
        assertNoRequestBody(req)
        const command: Extract<GmcCommand, { type: 'catalog.publish' }> = {
          type: 'catalog.publish',
          cause: 'api',
          requestedAt: new Date().toISOString(),
          schemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
        }
        const receipt = await dispatchCommand({ command, idempotencyKey, options, req })
        return jsonResponse({ command: command.type, ...receipt }, 202)
      },
      method: 'post',
      path: `${basePath}/catalog/publish`,
    }),
    handled({
      handler: async (req) => {
        await assertUserAccess(options, req)
        const idempotencyKey = requireIdempotencyKey(req)
        assertNoRequestBody(req)
        const command: Extract<GmcCommand, { type: 'catalog.reconcile' }> = {
          type: 'catalog.reconcile',
          requestedAt: new Date().toISOString(),
          schemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
        }
        const receipt = await dispatchCommand({ command, idempotencyKey, options, req })
        return jsonResponse({ command: command.type, ...receipt }, 202)
      },
      method: 'post',
      path: `${basePath}/catalog/reconcile`,
    }),
    handled({
      handler: async (req) => {
        await assertUserAccess(options, req)
        const idempotencyKey = requireIdempotencyKey(req)
        assertNoRequestBody(req)
        const feedId = req.routeParams?.feedId
        const feed =
          typeof feedId === 'string'
            ? options.feeds.find((candidate) => candidate.id === feedId)
            : undefined
        if (!feed) {
          throw new GmcHttpError(404, 'Unknown GMC feed')
        }
        if (feed.delivery !== 'artifact') {
          throw new GmcHttpError(
            409,
            `Feed ${feed.id} uses dynamic delivery and has no artifact to build`,
          )
        }
        const command: Extract<GmcCommand, { type: 'feed.build' }> = {
          type: 'feed.build',
          feedId: feed.id,
          requestedAt: new Date().toISOString(),
          schemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
        }
        const receipt = await dispatchCommand({ command, idempotencyKey, options, req })
        return jsonResponse({ command: command.type, ...receipt }, 202)
      },
      method: 'post',
      path: `${basePath}/feeds/:feedId/build`,
    }),
    handled({
      handler: async (req) => {
        await assertUserAccess(options, req)
        const idempotencyKey = requireIdempotencyKey(req)
        assertNoRequestBody(req)
        if (!options.localInventory) {
          throw new GmcHttpError(409, 'Local inventory is not configured')
        }
        const command: Extract<GmcCommand, { type: 'localInventory.reconcile' }> = {
          type: 'localInventory.reconcile',
          requestedAt: new Date().toISOString(),
          schemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
        }
        const receipt = await dispatchCommand({ command, idempotencyKey, options, req })
        return jsonResponse({ command: command.type, ...receipt }, 202)
      },
      method: 'post',
      path: `${basePath}/local-inventory/reconcile`,
    }),
    handled({
      handler: async (req) => {
        await assertUserAccess(options, req)
        const operationId = requireOperationId(req.routeParams?.operationId)
        const operation = await options.async.getOperation({
          instanceId: options.instanceId,
          operationId,
          payload: req.payload,
          req,
        })
        if (!operation) {
          throw new GmcHttpError(404, 'Unknown GMC async operation')
        }
        return jsonResponse(assertGmcAsyncOperation(operation))
      },
      method: 'get',
      path: `${basePath}/operations/:operationId`,
    }),
    handled({
      handler: async (req) => {
        await assertUserAccess(options, req)
        const asyncHealth = assertGmcAsyncHealth(
          await options.async.health({
            instanceId: options.instanceId,
            payload: req.payload,
            req,
          }),
        )
        return jsonResponse(
          {
            asyncAdapter: {
              name: options.async.name,
              ...options.async.capabilities,
              health: asyncHealth,
            },
            commandSchemaVersion: GMC_V2_COMMAND_SCHEMA_VERSION,
            dataSourceName: options.dataSourceName,
            disabled: options.disabled,
            instanceId: options.instanceId,
            merchantId: options.merchantId,
            status: asyncHealth.status,
          },
          asyncHealth.status === 'error' ? 503 : 200,
        )
      },
      method: 'get',
      path: `${basePath}/health`,
    }),
  ]
}

const feedResponse = (args: {
  body: Uint8Array
  checksum: string
  contentType: string
  publiclyCacheable: boolean
  req: PayloadRequest
}): Response => {
  const etag = `"${args.checksum}"`
  const cacheControl = args.publiclyCacheable
    ? 'public, max-age=300, stale-if-error=86400'
    : 'private, no-store'
  if (args.req.headers.get('if-none-match') === etag) {
    return new Response(null, {
      headers: {
        'Cache-Control': cacheControl,
        'Content-Type': args.contentType,
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
      },
      status: 304,
    })
  }
  return new Response(args.body as BodyInit, {
    headers: {
      'Cache-Control': cacheControl,
      'Content-Length': String(args.body.byteLength),
      'Content-Type': args.contentType,
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    },
    status: 200,
  })
}

const assertFeedAccess = async (feed: GmcFeedConfig, req: PayloadRequest): Promise<void> => {
  if (feed.access === 'public') {
    return
  }
  if (!(await feed.access({ feedId: feed.id, req }))) {
    throw new AccessDeniedError()
  }
}

const createFeedEndpoint = (feed: GmcFeedConfig, options: NormalizedGmcV2Options): Endpoint =>
  handled({
    handler: async (req) => {
      await assertFeedAccess(feed, req)
      if (feed.delivery === 'artifact') {
        const current = await feed.artifactStore.readCurrent({
          feedId: feed.id,
          instanceId: options.instanceId,
        })
        if (!current) {
          throw new GmcHttpError(503, `Feed ${feed.id} has no successfully published artifact`)
        }
        assertFeedArtifactIntegrity({
          ...current,
          feedId: feed.id,
          instanceId: options.instanceId,
          maxSerializedBytes: feed.limits?.maxSerializedBytes,
        })
        return feedResponse({
          body: current.body,
          checksum: current.descriptor.checksum,
          contentType: current.descriptor.contentType,
          publiclyCacheable: feed.access === 'public',
          req,
        })
      }

      const products = await collectCanonicalProducts({
        maxProducts: feed.limits?.maxProducts,
        maxProjectedBytes: feed.limits?.maxSerializedBytes,
        options,
        payload: req.payload,
        projectionTime: new Date().toISOString(),
        selector: feed.selector,
      })
      const built = await buildCanonicalFeed({ feed, products })
      return feedResponse({
        body: built.body,
        checksum: built.checksum,
        contentType: built.contentType,
        publiclyCacheable: feed.access === 'public',
        req,
      })
    },
    method: 'get',
    path: feed.path,
  })

const createWorkerEndpoint = (options: NormalizedGmcV2Options): Endpoint => {
  const execute = createGmcCommandExecutor(options)
  const workerAccess = options.workerAccess
  if (!workerAccess) {
    throw new TypeError(
      'payload-plugin-gmc-ecommerce/v2: workerAccess is required when api.exposeWorkerEndpoint is true',
    )
  }
  return handled({
    handler: async (req) => {
      // Authorize before spending any work on the request body: an untrusted
      // caller must not be able to make the plugin parse, validate, or size
      // any part of a body it hasn't earned the right to submit.
      if (!(await workerAccess({ payload: req.payload, req }))) {
        throw new AccessDeniedError()
      }
      const body = await readJsonBody(req)
      assertExactRequestFields(body, ['command', 'operationId', 'rootOperationId', 'sourceVersion'])
      try {
        assertGmcCommand(body.command)
      } catch (error) {
        throw new GmcHttpError(400, error instanceof Error ? error.message : 'Invalid GMC command')
      }
      const operationId = requireOperationId(body.operationId)
      const rootOperationId =
        body.rootOperationId === undefined ? undefined : requireOperationId(body.rootOperationId)
      const sourceVersion = parseLegacySourceVersion(body.sourceVersion)
      try {
        return jsonResponse(
          await execute({
            command: body.command,
            operationId,
            payload: req.payload,
            rootOperationId,
            sourceVersion,
          }),
        )
      } catch (error) {
        // Never let an executor failure fall through to the generic error
        // handler: a GoogleApiError's message could describe the *caller's*
        // request in terms that leak Google's own wording as if it were this
        // endpoint's validation response. Always answer with the durable
        // classification's own bounded shape instead.
        const classification = classifyGmcCommandError(error)
        return jsonResponse(
          {
            code: classification.code,
            message: classification.message,
            retryable: classification.retryable,
          },
          classification.retryable ? 500 : 422,
        )
      }
    },
    method: 'post',
    path: `${options.api.basePath}/worker/execute`,
  })
}

export const buildGmcV2Endpoints = (options: NormalizedGmcV2Options): Endpoint[] => {
  const endpoints = [
    ...createDispatchEndpoints(options),
    ...options.feeds.map((feed) => createFeedEndpoint(feed, options)),
  ]
  if (options.api.exposeWorkerEndpoint) {
    endpoints.push(createWorkerEndpoint(options))
  }
  return endpoints
}
