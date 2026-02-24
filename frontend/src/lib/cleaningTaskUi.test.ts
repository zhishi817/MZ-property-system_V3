import { describe, expect, it } from 'vitest'
import { formatTaskTime, isTaskLocked } from './cleaningTaskUi'

describe('cleaningTaskUi', () => {
  it('formats task time as HH:mm', () => {
    expect(formatTaskTime(null)).toBe('')
    expect(formatTaskTime('')).toBe('')
    expect(formatTaskTime('invalid')).toBe('')
    expect(formatTaskTime('2026-02-20T11:30:00Z')).toMatch(/^\d{2}:\d{2}$/)
  })

  it('detects locked tasks', () => {
    expect(isTaskLocked(false)).toBe(true)
    expect(isTaskLocked(true)).toBe(false)
    expect(isTaskLocked(undefined)).toBe(false)
    expect(isTaskLocked(null)).toBe(false)
  })
})

