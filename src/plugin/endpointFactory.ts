import type { Endpoint, PayloadRequest } from 'payload'

import type { MerchantService } from '../server/services/merchantService.js'
import type { NormalizedPluginOptions } from '../types/index.js'

import { assertAccess } from '../server/utilities/access.js'
import { errorResponse, jsonResponse, parseRequestBody } from '../server/utilities/http.js'
import { assertInboundRateLimit } from '../server/utilities/inboundRateLimit.js'
import { assertWorkerAccess, getService } from './endpointSupport.js'

type AccessMode = 'user' | 'worker'

type ProtectedEndpointArgs<TBody> = {
  access: AccessMode
  method: Endpoint['method']
  options: NormalizedPluginOptions
  parseBody?: (body: Record<string, unknown>) => TBody
  path: string
  rateLimitKey?: string
  requiresService?: boolean
  run: (args: {
    body: TBody
    req: PayloadRequest
    service: MerchantService
  }) => Promise<unknown>
}

const toResponse = (result: unknown): Response => {
  return result instanceof Response ? result : jsonResponse(result)
}

export const createHandledEndpoint = (args: {
  method: Endpoint['method']
  path: string
  run: (req: PayloadRequest) => Promise<unknown>
}): Endpoint => ({
  handler: async (req) => {
    try {
      return toResponse(await args.run(req))
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: args.method,
  path: args.path,
})

const createProtectedEndpoint = <TBody>(
  args: ProtectedEndpointArgs<TBody>,
): Endpoint => createHandledEndpoint({
  method: args.method,
  path: args.path,
  run: async (req) => {
    if (args.rateLimitKey) {
      await assertInboundRateLimit(req, args.options, args.rateLimitKey)
    }

    if (args.access === 'user') {
      await assertAccess(req, args.options)
    } else {
      assertWorkerAccess(req, args.options)
    }

    const body = args.parseBody
      ? args.parseBody(await parseRequestBody(req))
      : undefined as TBody
    const service = args.requiresService === false
      ? undefined
      : getService(args.options)

    return args.run({
      body,
      req,
      service: service as MerchantService,
    })
  },
})

export const createUserEndpoint = <TBody>(
  args: Omit<ProtectedEndpointArgs<TBody>, 'access'>,
): Endpoint => createProtectedEndpoint({
  ...args,
  access: 'user',
})

export const createWorkerEndpoint = <TBody>(
  args: Omit<ProtectedEndpointArgs<TBody>, 'access'>,
): Endpoint => createProtectedEndpoint({
  ...args,
  access: 'worker',
})
