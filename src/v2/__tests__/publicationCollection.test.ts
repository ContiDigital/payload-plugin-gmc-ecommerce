import type { PayloadRequest } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import { buildGmcPublicationCollection } from '../state/collection.js'

describe('buildGmcPublicationCollection', () => {
  it('is immutable through Payload APIs and delegates authenticated reads', async () => {
    const access = vi.fn(() => Promise.resolve(true))
    const collection = buildGmcPublicationCollection({
      slug: 'gmc-publications-v2',
      access,
    })
    const create = collection.access?.create
    const remove = collection.access?.delete
    const read = collection.access?.read
    const update = collection.access?.update

    expect(typeof create).toBe('function')
    expect(typeof remove).toBe('function')
    expect(typeof read).toBe('function')
    expect(typeof update).toBe('function')
    expect((create as () => boolean)()).toBe(false)
    expect((remove as () => boolean)()).toBe(false)
    expect((update as () => boolean)()).toBe(false)

    const readAccess = read as (args: { req: PayloadRequest }) => Promise<boolean>
    const anonymousReq = { payload: {} } as PayloadRequest
    expect(await readAccess({ req: anonymousReq })).toBe(false)
    expect(access).not.toHaveBeenCalled()

    const authenticatedReq = {
      payload: {},
      user: { id: 'user-1' },
    } as unknown as PayloadRequest
    expect(await readAccess({ req: authenticatedReq })).toBe(true)
    expect(access).toHaveBeenCalledWith({
      payload: authenticatedReq.payload,
      req: authenticatedReq,
      user: authenticatedReq.user,
    })
  })
})
