import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'
import { calcOrderMonthAmounts, toDayStr } from './orders'
import { execFileSync } from 'node:child_process'

describe('calcOrderMonthAmounts', () => {
  it('uses visible net (net - internal deduction) for checkout month', () => {
    const o: any = {
      id: 'o1',
      checkin: '2026-01-26T12:00:00',
      checkout: '2026-01-28T11:59:59',
      price: 302.86,
      cleaning_fee: 120,
      internal_deduction_total: 50,
      status: 'confirmed'
    }
    const r = calcOrderMonthAmounts(o, dayjs('2026-01-01'))
    expect(r.nightsMonth).toBe(2)
    expect(r.netMonth).toBeCloseTo(182.86, 2)
    expect(r.visibleNetMonth).toBeCloseTo(132.86, 2)
  })

  it('applies deduction to previous month when checkout is first day', () => {
    const o: any = {
      id: 'o2',
      checkin: '2026-01-31T12:00:00',
      checkout: '2026-02-01T11:59:59',
      price: 110,
      cleaning_fee: 0,
      internal_deduction_total: 10,
      status: 'confirmed'
    }
    const jan = calcOrderMonthAmounts(o, dayjs('2026-01-01'))
    const feb = calcOrderMonthAmounts(o, dayjs('2026-02-01'))
    expect(jan.nightsMonth).toBe(1)
    expect(jan.visibleNetMonth).toBeCloseTo(100, 2)
    expect(feb.nightsMonth).toBe(0)
    expect(feb.visibleNetMonth).toBeCloseTo(0, 2)
  })

  it('returns 0 visible net for canceled orders unless count_in_income', () => {
    const o: any = {
      id: 'o3',
      checkin: '2026-01-10T12:00:00',
      checkout: '2026-01-12T11:59:59',
      price: 200,
      cleaning_fee: 0,
      internal_deduction_total: 10,
      status: 'cancelled'
    }
    const r1 = calcOrderMonthAmounts(o, dayjs('2026-01-01'))
    expect(r1.visibleNetMonth).toBe(0)
    const r2 = calcOrderMonthAmounts({ ...o, count_in_income: true }, dayjs('2026-01-01'))
    expect(r2.visibleNetMonth).toBeCloseTo(190, 2)
  })
})

describe('toDayStr', () => {
  it('extracts YYYY-MM-DD from various ISO strings without timezone shifting', () => {
    expect(toDayStr('2026-02-12')).toBe('2026-02-12')
    expect(toDayStr('2026-02-12T00:00:00Z')).toBe('2026-02-12')
    expect(toDayStr('2026-02-12T00:00:00.000Z')).toBe('2026-02-12')
    expect(toDayStr('2026-02-12T13:00:00.000Z')).toBe('2026-02-12')
    expect(toDayStr('2026-02-12T00:00:00+11:00')).toBe('2026-02-12')
  })

  it('demonstrates why dayjs(...).format can shift dates in negative timezones', () => {
    const out = execFileSync(
      process.execPath,
      ['-e', "const dayjs=require('dayjs'); console.log(dayjs('2026-02-12T00:30:00Z').format('YYYY-MM-DD'))"],
      { env: { ...process.env, TZ: 'America/Los_Angeles' } }
    )
      .toString()
      .trim()
    expect(out).toBe('2026-02-11')
    expect(toDayStr('2026-02-12T00:30:00Z')).toBe('2026-02-12')
  })

  it('stays stable across DST transitions when input is ISO with Z', () => {
    const la = execFileSync(
      process.execPath,
      ['-e', "const dayjs=require('dayjs'); console.log(dayjs('2026-03-08T00:30:00Z').format('YYYY-MM-DD'))"],
      { env: { ...process.env, TZ: 'America/Los_Angeles' } }
    )
      .toString()
      .trim()
    expect(la).toBe('2026-03-07')
    expect(toDayStr('2026-03-08T00:30:00Z')).toBe('2026-03-08')
  })
})
