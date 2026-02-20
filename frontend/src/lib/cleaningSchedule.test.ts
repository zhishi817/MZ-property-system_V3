import { describe, expect, test } from 'vitest'
import { missionTitle, type ScheduleMission } from './cleaningSchedule'

function baseMission(patch: Partial<ScheduleMission>): ScheduleMission {
  return {
    key: 'p|2026-02-17',
    date: '2026-02-17',
    order_id: 'o1',
    property_id: 'p1',
    property_code: 'MSQ402',
    nights: 5,
    checkout: null,
    checkin: null,
    ...patch,
  }
}

describe('cleaningSchedule', () => {
  test('missionTitle checkout only', () => {
    const m = baseMission({
      checkout: { task_id: 't1', status: 'pending', assignee_id: null, assignee_name: null, time: '11:30', code: '5120', note: null },
    })
    expect(missionTitle(m)).toBe('MSQ402 11:30退房')
  })

  test('missionTitle checkin only', () => {
    const m = baseMission({
      checkin: { task_id: 't2', status: 'pending', assignee_id: null, assignee_name: null, time: '15:00', code: '5554', note: null },
    })
    expect(missionTitle(m)).toBe('MSQ402 15:00入住')
  })

  test('missionTitle combined', () => {
    const m = baseMission({
      checkout: { task_id: 't1', status: 'pending', assignee_id: null, assignee_name: null, time: '11:30', code: '5120', note: null },
      checkin: { task_id: 't2', status: 'pending', assignee_id: null, assignee_name: null, time: '15:00', code: '5554', note: null },
    })
    expect(missionTitle(m)).toBe('MSQ402 11:30退房 15:00入住')
  })
})

