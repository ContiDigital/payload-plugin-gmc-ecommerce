import type { PayloadRequest } from 'payload'

import crypto from 'crypto'

type HttpError = { statusCode: number } & Error

const createHttpError = (statusCode: number, message: string): HttpError => {
  return Object.assign(new Error(message), { statusCode })
}

const timingSafeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)

  if (bufA.length !== bufB.length) {
    // Hash both to fixed-length digests so we can still run a constant-time
    // comparison — prevents timing leaks that reveal expected key length.
    const hashA = crypto.createHash('sha256').update(bufA).digest()
    const hashB = crypto.createHash('sha256').update(bufB).digest()
    crypto.timingSafeEqual(hashA, hashB)
    return false
  }

  return crypto.timingSafeEqual(bufA, bufB)
}

export const getRequestApiKey = (req: PayloadRequest): string | undefined => {
  // 1. Custom header: x-gmc-api-key
  const headerKey = req.headers.get('x-gmc-api-key')
  if (headerKey) {
    return headerKey
  }

  // 3. Standard Authorization: Bearer {key}
  const authHeader = req.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim() || undefined
  }

  return undefined
}

export const assertApiKeyAccess = (
  req: PayloadRequest,
  expectedApiKey: string,
  missingConfigMessage: string,
): void => {
  if (!expectedApiKey) {
    throw createHttpError(403, missingConfigMessage)
  }

  const providedApiKey = getRequestApiKey(req)
  if (!providedApiKey || !timingSafeEqual(providedApiKey, expectedApiKey)) {
    throw createHttpError(401, 'Invalid or missing API key')
  }
}
