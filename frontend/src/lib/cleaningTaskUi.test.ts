import { describe, expect, it } from 'vitest'
import {
  formatTaskTime,
  inspectionScopeLabel,
  isCompletedTaskStatus,
  isResolvedTaskStatus,
  isTaskCompletionToggleStatus,
  isTaskLocked,
  normalizeInspectionScope,
  normalizeKeysHungInspectionMode,
  propertyFollowupKindMeta,
  resolveTaskDetailCompletionStatus,
  taskInspectionModeMeta,
  taskInspectionScopeMeta,
  taskStatusMeta,
  taskTimingTone,
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

  it('normalizes inspection scope for password-only check-in tasks', () => {
    expect(normalizeInspectionScope('password_only')).toBe('password_only')
    expect(normalizeInspectionScope('')).toBe('inspect_and_hang')
    expect(inspectionScopeLabel('password_only')).toBe('仅改密码')
    expect(inspectionScopeLabel(null)).toBe('检查后挂钥匙')
    expect(taskInspectionScopeMeta('password_only')).toEqual({ label: '仅改密码', tone: 'pending' })
    expect(taskInspectionScopeMeta(null)).toEqual({ label: '检查后挂钥匙', tone: 'success' })
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

  it('maps web task statuses and inspection modes to semantic tones', () => {
    expect(taskStatusMeta('todo')).toEqual({ label: '待处理', tone: 'pending' })
    expect(taskStatusMeta('in_progress')).toEqual({ label: '进行中', tone: 'normal' })
    expect(taskStatusMeta('keys_hung')).toEqual({ label: '已挂钥匙', tone: 'success' })
    expect(taskStatusMeta('cancelled')).toEqual({ label: '已取消', tone: 'neutral' })
    expect(taskInspectionModeMeta('same_day')).toEqual({ label: '同日检查', tone: 'normal' })
    expect(taskInspectionModeMeta('self_complete')).toEqual({ label: '已检查', tone: 'special' })
    expect(taskInspectionModeMeta('deferred')).toEqual({ label: '延后检查', tone: 'pending' })
    expect(taskInspectionModeMeta(null)).toEqual({ label: '待确认检查安排', tone: 'pending' })
  })

  it('keeps timing and property-followup tags on the semantic palette', () => {
    expect(taskTimingTone('晚退房')).toBe('danger')
    expect(taskTimingTone('早退房')).toBe('success')
    expect(taskTimingTone('早入住')).toBe('info')
    expect(taskTimingTone('晚入住')).toBe('info')
    expect(propertyFollowupKindMeta('maintenance')).toEqual({ label: '维修', tone: 'special' })
    expect(propertyFollowupKindMeta('deep_cleaning')).toEqual({ label: '深度清洁', tone: 'special' })
    expect(propertyFollowupKindMeta('daily_necessities')).toEqual({ label: '日用品更换', tone: 'special' })
  })
})
