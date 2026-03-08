import { beforeEach, describe, expect, test, vi } from 'vitest'

import { relativeTime } from '../utils.js'

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-07T12:00:00Z'))
  })

  test('formats seconds and minutes', () => {
    expect(relativeTime('2026-03-07T11:59:45Z')).toBe('15s ago')
    expect(relativeTime('2026-03-07T11:45:00Z')).toBe('15m ago')
  })

  test('formats hours and days', () => {
    expect(relativeTime('2026-03-07T09:00:00Z')).toBe('3h ago')
    expect(relativeTime('2026-03-04T12:00:00Z')).toBe('3d ago')
  })
})
