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

  it('allows a user with no role or roles field', () => {
    expect(call({ id: '1' })).toBe(true)
  })

  it('allows role === admin', () => {
    expect(call({ id: '1', role: 'admin' })).toBe(true)
  })

  it('denies a non-admin role', () => {
    expect(call({ id: '1', role: 'editor' })).toBe(false)
  })

  it('allows roles including admin', () => {
    expect(call({ id: '1', roles: ['editor', 'admin'] })).toBe(true)
  })

  it('denies roles not including admin', () => {
    expect(call({ id: '1', roles: ['editor'] })).toBe(false)
  })
})
