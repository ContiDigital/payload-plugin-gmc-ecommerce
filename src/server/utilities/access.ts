import type { AccessFn } from '../../types/index.js'

export class AccessDeniedError extends Error {
  public readonly statusCode = 403

  constructor(message = 'Access denied') {
    super(message)
    this.name = 'AccessDeniedError'
  }
}

/**
 * Default plugin access, ported field-for-field from the 1.x helper: an
 * authenticated user whose record has `isAdmin === true`, or whose `roles`
 * array includes `'admin'`. A user with neither field is denied.
 */
export const hasDefaultPluginAccess: AccessFn = ({ user }) => {
  if (!user || typeof user !== 'object') {
    return false
  }
  const record = user as Record<string, unknown>
  return (
    record.isAdmin === true ||
    (Array.isArray(record.roles) && record.roles.includes('admin'))
  )
}
