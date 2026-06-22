import { describe, expect, it } from 'vitest'
import {
  formatTaskTime,
  isCompletedTaskStatus,
  isResolvedTaskStatus,
  isTaskCompletionToggleStatus,
  isTaskLocked,
  normalizeKeysHungInspectionMode,
  resolveTaskDetailCompletionStatus,
} from './cleaningTaskUi'

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

  it('repairs the legacy check-in keys-hung mode without changing valid inspection plans', () => {
    expect(normalizeKeysHungInspectionMode({ inspectionMode: 'self_complete', status: 'keys_hung', isCheckinOnly: true })).toBe('same_day')
    expect(normalizeKeysHungInspectionMode({ inspectionMode: 'deferred', status: 'keys_hung', isCheckinOnly: true })).toBe('deferred')
    expect(normalizeKeysHungInspectionMode({ inspectionMode: 'self_complete', status: 'completed', isCheckinOnly: true })).toBe('self_complete')
  })

  it('keeps keys-hung distinct from the ordinary completed toggle', () => {
    expect(isTaskCompletionToggleStatus('keys_hung')).toBe(false)
    expect(isCompletedTaskStatus('keys_hung')).toBe(false)
    expect(isResolvedTaskStatus('keys_hung')).toBe(true)
    expect(isTaskCompletionToggleStatus('completed')).toBe(true)
    expect(isCompletedTaskStatus('completed')).toBe(true)
    expect(resolveTaskDetailCompletionStatus({ isCheckinOnly: true, keysHung: true, taskCompleted: true })).toBe('keys_hung')
    expect(resolveTaskDetailCompletionStatus({ isCheckinOnly: false, keysHung: false, taskCompleted: true })).toBe('completed')
  })
})
