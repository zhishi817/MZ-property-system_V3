import { describe, expect, it } from 'vitest'
import { checkinTimingLabel, checkoutTimingLabel, dailyTaskStatusMeta, mergeDailyCapabilityGate, mergedDailyDisplayBadges, mergedDailyDisplayStatus, mergedDailyTaskStatus, visibleDailyDisplayBadges } from './cleaningDailyTaskStatus'

describe('cleaningDailyTaskStatus', () => {
  it('uses mobile-style labels for unassigned daily cleaning tasks', () => {
    expect(dailyTaskStatusMeta('pending')).toEqual({ label: '未分配', tone: 'pending' })
    expect(dailyTaskStatusMeta('todo')).toEqual({ label: '未分配', tone: 'pending' })
    expect(dailyTaskStatusMeta('unassigned')).toEqual({ label: '未分配', tone: 'pending' })
  })

  it('keeps keys-hung above assigned when daily task cards are merged', () => {
    expect(mergedDailyTaskStatus([
      { status: 'assigned' },
      { status: 'keys_hung' },
    ])).toBe('keys_hung')

    expect(mergedDailyDisplayStatus([
      {
        status: 'assigned',
        display_state: { status_key: 'assigned', status_label: '已分配', status_tone: 'normal' },
      },
      {
        status: 'keys_hung',
        display_state: { status_key: 'keys_hung', status_label: '已挂钥匙', status_tone: 'success' },
      },
    ])).toEqual({
      status_key: 'keys_hung',
      status_label: '已挂钥匙',
      status_tone: 'success',
    })
  })

  it('keeps assigned above raw pending state for merged daily cards', () => {
    expect(mergedDailyDisplayStatus([
      { status: 'pending' },
      { status: 'assigned' },
    ])).toEqual({
      status_key: 'assigned',
      status_label: '已分配',
      status_tone: 'normal',
    })
  })

  it('does not promote pure-checkin badges onto checkout plus checkin merged cards', () => {
    const items = [
      {
        status: 'assigned',
        display_state: {
          badges: [
            { id: 'pure_checkin_inspection', label: '入住现场执行', tone: 'info' as const },
            { id: 'task_ended', label: '任务已结束', tone: 'success' as const },
          ],
        },
      },
    ]

    expect(mergedDailyDisplayBadges(items, 'mixed_cleaning_inspection').map((badge) => badge.label)).toEqual(['任务已结束'])
    expect(mergedDailyDisplayBadges(items, 'checkin_inspection').map((badge) => badge.label)).toEqual(['入住现场执行', '任务已结束'])
  })

  it('hides badges that duplicate the primary status or scope labels', () => {
    expect(visibleDailyDisplayBadges([
      { id: 'pure_checkin_inspection', label: '入住现场执行', tone: 'info' as const },
      { id: 'password_only_site_action', label: '仅改密码/挂钥匙', tone: 'special' as const },
      { id: 'task_ended', label: '任务已结束', tone: 'success' as const },
    ], ['入住现场执行', '已分配']).map((badge) => badge.label)).toEqual(['仅改密码/挂钥匙', '任务已结束'])
  })

  it('maps non-default checkout and checkin times to timing labels', () => {
    expect(checkoutTimingLabel('9:30am')).toBe('早退房')
    expect(checkoutTimingLabel('10am')).toBeNull()
    expect(checkoutTimingLabel('11am')).toBe('晚退房')
    expect(checkinTimingLabel('2:30pm')).toBe('早入住')
    expect(checkinTimingLabel('3pm')).toBeNull()
    expect(checkinTimingLabel('4pm')).toBe('晚入住')
  })

  it('ignores not-applicable child gates when merging daily card editability', () => {
    expect(mergeDailyCapabilityGate([
      { enabled: true },
      { enabled: false, disabled_reason: 'not_applicable' },
    ])).toEqual({ enabled: true })

    expect(mergeDailyCapabilityGate([
      { enabled: false, disabled_reason: 'not_applicable' },
    ])).toEqual({ enabled: false, disabled_reason: 'not_applicable' })

    expect(mergeDailyCapabilityGate([
      { enabled: true },
      { enabled: false, disabled_reason: 'auto_sync_locked' },
    ])).toEqual({ enabled: false, disabled_reason: 'auto_sync_locked' })
  })
})
