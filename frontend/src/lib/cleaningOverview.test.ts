import { describe, expect, it } from 'vitest'
import { computePeak, flattenOrdersByPlatform, normalizePlatform, type Platform } from './cleaningOverview'

describe('normalizePlatform', () => {
  it('maps airbnb/booking prefixes', () => {
    expect(normalizePlatform('airbnb')).toBe('airbnb')
    expect(normalizePlatform('airbnb_us')).toBe('airbnb')
    expect(normalizePlatform('booking')).toBe('booking')
    expect(normalizePlatform('booking.com')).toBe('booking')
  })

  it('maps offline/direct to direct', () => {
    expect(normalizePlatform('offline')).toBe('direct')
    expect(normalizePlatform('direct')).toBe('direct')
  })

  it('falls back to other', () => {
    expect(normalizePlatform('')).toBe('other')
    expect(normalizePlatform(null)).toBe('other')
    expect(normalizePlatform(undefined)).toBe('other')
    expect(normalizePlatform('wechat')).toBe('other')
  })
})

describe('flattenOrdersByPlatform', () => {
  it('returns empty array for missing map', () => {
    expect(flattenOrdersByPlatform(undefined)).toEqual([])
    expect(flattenOrdersByPlatform(null)).toEqual([])
  })

  it('keeps stable platform order airbnb/booking/direct/other', () => {
    const mk = (id: string) => ({ id, property_id: '', property_code: '', guest_name: '', checkin: '', checkout: '', source: '', status: '' })
    const platforms: Platform[] = ['airbnb', 'booking', 'direct', 'other']
    const m = Object.fromEntries(platforms.map((p) => [p, []])) as any
    m.other = [mk('o1')]
    m.direct = [mk('d1'), mk('d2')]
    m.airbnb = [mk('a1')]
    const out = flattenOrdersByPlatform(m)
    expect(out.map((x) => x.id)).toEqual(['a1', 'd1', 'd2', 'o1'])
  })
})

describe('computePeak', () => {
  it('returns null for empty input', () => {
    expect(computePeak(undefined)).toBeNull()
    expect(computePeak([])).toBeNull()
  })

  it('returns max total (checkin+checkout)', () => {
    const rows = [
      { date: '2026-02-01', checkin_count: 1, checkout_count: 2 },
      { date: '2026-02-02', checkin_count: 0, checkout_count: 10 },
      { date: '2026-02-03', checkin_count: 6, checkout_count: 1 },
    ]
    expect(computePeak(rows)).toEqual({ date: '2026-02-02', total: 10 })
  })

  it('treats missing counts as 0', () => {
    const rows: any = [
      { date: '2026-02-01' },
      { date: '2026-02-02', checkin_count: 1, checkout_count: 0 },
    ]
    expect(computePeak(rows)).toEqual({ date: '2026-02-02', total: 1 })
  })
})

