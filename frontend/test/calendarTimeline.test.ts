import { describe, it, expect } from 'vitest'
import dayjs from 'dayjs'
import { buildSegments, placeIntoLanes } from '../src/lib/calendarTimeline'

describe('calendar timeline', () => {
  it('builds segments within month', () => {
    const ms = dayjs('2025-01-01')
    const me = ms.endOf('month')
    const orders = [
      { id: 'a', checkin: '2025-01-03T12:00:00', checkout: '2025-01-06T11:59:59' },
      { id: 'b', checkin: '2024-12-30T12:00:00', checkout: '2025-01-02T11:59:59' },
      { id: 'c', checkin: '2025-01-05T12:00:00', checkout: '2025-01-10T11:59:59' },
    ]
    const segs = buildSegments(orders, ms, me)
    expect(segs.length).toBe(3)
    const a = segs.find(s => s.id === 'a')!
    const b = segs.find(s => s.id === 'b')!
    const c = segs.find(s => s.id === 'c')!
    expect(a.startIdx).toBe(2)
    expect(a.endIdx).toBe(5)
    expect(b.endIdx).toBeGreaterThan(0)
    expect(c.endIdx).toBeGreaterThan(a.endIdx)
  })

  it('places segments into lanes without overlap', () => {
    const ms = dayjs('2025-01-01')
    const me = ms.endOf('month')
    const orders = [
      { id: 'a', checkin: '2025-01-01T12:00:00', checkout: '2025-01-04T11:59:59' },
      { id: 'b', checkin: '2025-01-03T12:00:00', checkout: '2025-01-05T11:59:59' },
      { id: 'c', checkin: '2025-01-05T12:00:00', checkout: '2025-01-07T11:59:59' },
    ]
    const segs = buildSegments(orders, ms, me)
    const lanes = placeIntoLanes(segs)
    expect(lanes['a']).toBe(0)
    expect(lanes['b']).toBe(1)
    expect(lanes['c']).toBe(0)
  })
})
