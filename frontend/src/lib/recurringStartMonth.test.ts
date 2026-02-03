import { describe, expect, it } from 'vitest'
import { compareMonthKey, shouldAutoMarkPaidForMonth, shouldIncludeForMonth } from './recurringStartMonth'

describe('recurringStartMonth', () => {
  it('compareMonthKey', () => {
    expect(compareMonthKey('2026-01', '2026-01')).toBe(0)
    expect(compareMonthKey('2026-01', '2026-02')).toBe(-1)
    expect(compareMonthKey('2026-12', '2026-02')).toBe(1)
  })

  it('shouldIncludeForMonth respects start', () => {
    expect(shouldIncludeForMonth(undefined, '2026-02')).toBe(true)
    expect(shouldIncludeForMonth('2026-03', '2026-02')).toBe(false)
    expect(shouldIncludeForMonth('2026-02', '2026-02')).toBe(true)
    expect(shouldIncludeForMonth('2026-01', '2026-02')).toBe(true)
  })

  it('shouldAutoMarkPaidForMonth marks only past months within range', () => {
    const current = '2026-02'
    const start = '2026-01'
    expect(shouldAutoMarkPaidForMonth(start, '2025-12', current)).toBe(false)
    expect(shouldAutoMarkPaidForMonth(start, '2026-01', current)).toBe(true)
    expect(shouldAutoMarkPaidForMonth(start, '2026-02', current)).toBe(false)
    expect(shouldAutoMarkPaidForMonth(start, '2026-03', current)).toBe(false)
  })
})

