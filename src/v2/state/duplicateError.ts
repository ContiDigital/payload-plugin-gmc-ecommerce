import { ValidationError } from 'payload'

/**
 * Payload's official adapters do not surface a driver-level duplicate-key
 * error. `create` runs field validation first, so a unique `key` collision
 * arrives as a Payload `ValidationError` (HTTP 400), not as a Postgres 23505 or
 * a Mongo 11000. Both shapes are still accepted: a custom adapter, or a race
 * that slips past validation into the driver, can raise either one.
 */
export const isDuplicateError = (error: unknown): boolean => {
  if (error instanceof ValidationError) {
    return true
  }
  if (!error || typeof error !== 'object') {
    return false
  }
  const candidate = error as { code?: unknown; message?: unknown }
  return (
    candidate.code === 11000 ||
    (typeof candidate.message === 'string' && /duplicate|unique constraint/i.test(candidate.message))
  )
}
