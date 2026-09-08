import type { PayloadRequest } from 'payload'

import { describe, expect, it } from 'vitest'

import { hasDefaultPluginAccess } from '../access.js'

const call = (user: unknown): boolean | Promise<boolean> =>
  hasDefaultPluginAccess({
    payload: {} as never,
    req: { user } as unknown as PayloadRequest,
    user: user as PayloadRequest['user'],
  })

describe('hasDefaultPluginAccess', () => {
  it('denies when there is no user', () => {
    expect(call(undefined)).toBe(false)
  })

  it('denies a user with no role fields', () => {
    expect(call({ id: '1' })).toBe(false)
  })

  it('allows isAdmin === true', () => {
    expect(call({ id: '1', isAdmin: true })).toBe(true)
  })

  it('allows roles including admin', () => {
    expect(call({ id: '1', roles: ['admin'] })).toBe(true)
  })

  it('denies roles not including admin', () => {
    expect(call({ id: '1', roles: ['editor'] })).toBe(false)
  })
})
