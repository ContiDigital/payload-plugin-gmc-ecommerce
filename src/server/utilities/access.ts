import type { PayloadRequest } from 'payload'

import type { NormalizedPluginOptions } from '../../types/index.js'

export class AccessDeniedError extends Error {
  public readonly statusCode = 403

  constructor(message = 'Access denied') {
    super(message)
    this.name = 'AccessDeniedError'
  }
}

export const hasDefaultPluginAccess = (user: unknown): boolean => {
  if (!user || typeof user !== 'object') {
    return false
  }

  return (
    (user as Record<string, unknown>).isAdmin === true ||
    (Array.isArray((user as Record<string, unknown>).roles) &&
      ((user as Record<string, unknown>).roles as string[]).includes('admin'))
  )
}

export const assertAccess = async (
  req: PayloadRequest,
  options: NormalizedPluginOptions,
): Promise<void> => {
  const user = req.user

  if (!user) {
    throw new AccessDeniedError('Authentication required')
  }

  if (options.access) {
    const allowed = await options.access({ payload: req.payload, req, user })
    if (!allowed) {
      throw new AccessDeniedError()
    }
    return
  }

  // Default: require admin role
  if (!hasDefaultPluginAccess(user)) {
    throw new AccessDeniedError('Admin role required')
  }
}
