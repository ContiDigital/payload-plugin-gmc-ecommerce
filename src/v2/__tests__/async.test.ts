import { describe, expect, it } from 'vitest'

import {
  assertGmcAsyncHealth,
  assertGmcAsyncOperation,
  assertGmcDispatchReceipt,
} from '../async.js'

describe('GMC async adapter result boundaries', () => {
  it('accepts a complete aggregate workflow result', () => {
    expect(
      assertGmcAsyncOperation({
        attempts: 2,
        childCounts: { failed: 0, queued: 2, running: 1, succeeded: 8 },
        commandType: 'catalog.publish',
        operationId: 'operation-1',
        reconciliation: {
          orphanCount: 3,
          orphanDeleteCount: 0,
          pagesCompleted: 2,
          remoteCount: 1_500,
        },
        requestedState: 'succeeded',
        rootOperationId: 'operation-1',
        startedAt: '2026-08-29T12:00:01.000Z',
        state: 'running',
        submittedAt: '2026-08-29T12:00:00.000Z',
      }),
    ).toMatchObject({ state: 'running' })
  })

  it.each([
    { attempts: -1 },
    { childCounts: { queued: -1 } },
    { childCounts: { invented: 1 } },
    { commandType: 'invented' },
    { parentOperationId: 'operation-1' },
    { reconciliation: { orphanCount: 1, orphanDeleteCount: 2, pagesCompleted: 1, remoteCount: 1 } },
    { reconciliation: { orphanCount: 1, orphanDeleteCount: 0, pagesCompleted: 0, remoteCount: 1 } },
    { requestedState: 'invented' },
    { submittedAt: 'yesterday' },
  ])('rejects malformed operation metadata %#', (override) => {
    expect(() =>
      assertGmcAsyncOperation({
        operationId: 'operation-1',
        state: 'queued',
        ...override,
      } as never),
    ).toThrow(/invalid operation result/i)
  })

  it('rejects unsafe receipts and unmeasured health responses', () => {
    expect(() =>
      assertGmcDispatchReceipt({
        operationId: 'bad\noperation',
        state: 'queued',
      }),
    ).toThrow(/invalid durable dispatch receipt/i)
    expect(() =>
      assertGmcAsyncHealth({
        checkedAt: 'today',
        status: 'ok',
      }),
    ).toThrow(/invalid health result/i)
  })

  it('bounds adapter diagnostics, validates chronology, and strips undeclared fields', () => {
    const details: Record<string, unknown> = {}
    details.self = details
    expect(() =>
      assertGmcAsyncHealth({
        checkedAt: '2026-08-29T12:00:00.000Z',
        details,
        status: 'degraded',
      }),
    ).toThrow(/unsafe health details/i)

    expect(() =>
      assertGmcAsyncOperation({
        finishedAt: '2026-08-29T12:00:00.000Z',
        operationId: 'operation-1',
        startedAt: '2026-08-29T12:00:01.000Z',
        state: 'succeeded',
      }),
    ).toThrow(/invalid operation timeline/i)

    expect(
      assertGmcDispatchReceipt({
        operationId: 'operation-1',
        secret: 'must-not-leak',
        state: 'queued',
      } as never),
    ).toEqual({ operationId: 'operation-1', state: 'queued' })
  })

  it('compares operation chronology by instant and rejects normalized invalid dates', () => {
    expect(
      assertGmcAsyncOperation({
        finishedAt: '2026-08-29T12:00:01Z',
        operationId: 'operation-offset-valid',
        startedAt: '2026-08-29T12:00:00Z',
        state: 'succeeded',
        submittedAt: '2026-08-29T13:00:00+02:00',
      }),
    ).toMatchObject({ state: 'succeeded' })

    expect(() =>
      assertGmcAsyncOperation({
        operationId: 'operation-offset-invalid',
        startedAt: '2026-08-29T13:00:00+02:00',
        state: 'running',
        submittedAt: '2026-08-29T12:00:00Z',
      }),
    ).toThrow(/invalid operation timeline/i)

    expect(() =>
      assertGmcAsyncHealth({
        checkedAt: '2026-02-30T12:00:00Z',
        status: 'ok',
      }),
    ).toThrow(/invalid health result/i)
  })
})
