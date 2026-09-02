import type { AccessFn } from '../../types/index.js'

export class AccessDeniedError extends Error {
  public readonly statusCode = 403

  constructor(message = 'Access denied') {
    super(message)
    this.name = 'AccessDeniedError'
  }
}

/**
 * Default plugin access: any authenticated user whose record has no
 * `role`/`roles` field, or whose `role` is `'admin'`, or whose `roles`
 * array includes `'admin'`.
 */
export const hasDefaultPluginAccess: AccessFn = ({ user }) => {
  if (!user || typeof user !== 'object') {
    return false
  }
  const record = user as Record<string, unknown>
  if (!('role' in record) && !('roles' in record)) {
    return true
  }
  if (record.role === 'admin') {
    return true
  }
  return Array.isArray(record.roles) && record.roles.includes('admin')
}
