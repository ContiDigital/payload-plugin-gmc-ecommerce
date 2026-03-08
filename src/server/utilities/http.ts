import type { PayloadRequest } from 'payload'

import { ValidationError } from './validation.js'

export const jsonResponse = (data: unknown, status = 200): Response => {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })
}

export const errorResponse = (req: PayloadRequest, error: unknown): Response => {
  const statusCode =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? (error as { statusCode: number }).statusCode
      : 500

  const message =
    error instanceof Error ? error.message : 'Internal server error'

  if (statusCode >= 500) {
    req.payload?.logger?.error(`[GMC Plugin] ${message}`, error)
  }

  // Don't leak internal details to the client for 500+ errors
  const clientMessage = statusCode >= 500 ? 'Internal server error' : message

  return jsonResponse({ error: clientMessage }, statusCode)
}

export const parseRequestBody = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  if (req.data && typeof req.data === 'object' && !Array.isArray(req.data)) {
    return req.data as Record<string, unknown>
  }

  if (typeof req.json === 'function') {
    const parsed = await req.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError('Request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  }

  if (req.json && typeof req.json === 'object' && !Array.isArray(req.json)) {
    return req.json as Record<string, unknown>
  }

  const text = typeof req.text === 'function' ? await req.text() : undefined

  if (!text || text.trim().length === 0) {
    throw new ValidationError('Request body is empty or missing')
  }

  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError('Request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error
    }
    throw new ValidationError('Request body contains malformed JSON')
  }
}
