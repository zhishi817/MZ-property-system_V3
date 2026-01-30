import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'
import { normalizeReportCategory, shouldIncludeIncomeTxInPropertyOtherIncome, txInMonth, txMatchesProperty } from './financeTx'

describe('shouldIncludeIncomeTxInPropertyOtherIncome', () => {
  it('excludes cancel_fee for cancelled order when count_in_income is false', () => {
    const orderById = new Map([['o1', { id: 'o1', status: 'cancelled', count_in_income: false }]])
    const ok = shouldIncludeIncomeTxInPropertyOtherIncome({ category: 'cancel_fee', ref_type: 'order', ref_id: 'o1' }, orderById)
    expect(ok).toBe(false)
  })

  it('includes cancel_fee for cancelled order when count_in_income is true', () => {
    const orderById = new Map([['o1', { id: 'o1', status: 'cancelled', count_in_income: true }]])
    const ok = shouldIncludeIncomeTxInPropertyOtherIncome({ category: 'cancel_fee', ref_type: 'order', ref_id: 'o1' }, orderById)
    expect(ok).toBe(true)
  })

  it('includes cancel_fee for non-cancelled order', () => {
    const orderById = new Map([['o1', { id: 'o1', status: 'confirmed', count_in_income: false }]])
    const ok = shouldIncludeIncomeTxInPropertyOtherIncome({ category: 'cancel_fee', ref_type: 'order', ref_id: 'o1' }, orderById)
    expect(ok).toBe(true)
  })

  it('includes cancel_fee if order not found', () => {
    const orderById = new Map()
    const ok = shouldIncludeIncomeTxInPropertyOtherIncome({ category: 'cancel_fee', ref_type: 'order', ref_id: 'missing' }, orderById)
    expect(ok).toBe(true)
  })

  it('includes non-cancel_fee income categories', () => {
    const orderById = new Map([['o1', { id: 'o1', status: 'cancelled', count_in_income: false }]])
    const ok = shouldIncludeIncomeTxInPropertyOtherIncome({ category: 'late_checkout', ref_type: 'order', ref_id: 'o1' }, orderById)
    expect(ok).toBe(true)
  })
})

describe('txInMonth', () => {
  it('matches by month_key first', () => {
    const ok = txInMonth({ month_key: '2026-01', occurred_at: '2025-12-01' }, dayjs('2026-01-01'))
    expect(ok).toBe(true)
  })

  it('matches by paid_date/occurred_at/due_date/created_at', () => {
    expect(txInMonth({ paid_date: '2026-01-30' }, dayjs('2026-01-01'))).toBe(true)
    expect(txInMonth({ occurred_at: '2026-01-15T12:00:00Z' }, dayjs('2026-01-01'))).toBe(true)
    expect(txInMonth({ due_date: '2026-01-01' }, dayjs('2026-01-01'))).toBe(true)
    expect(txInMonth({ created_at: '2026-01-02T00:00:00Z' }, dayjs('2026-01-01'))).toBe(true)
    expect(txInMonth({ occurred_at: '2026-02-01' }, dayjs('2026-01-01'))).toBe(false)
  })
})

describe('txMatchesProperty', () => {
  it('matches property_id by id or code, and property_code by code', () => {
    const p = { id: 'pid-1', code: '831402' }
    expect(txMatchesProperty({ property_id: 'pid-1' }, p)).toBe(true)
    expect(txMatchesProperty({ property_id: '831402' }, p)).toBe(true)
    expect(txMatchesProperty({ property_code: '831402' }, p)).toBe(true)
    expect(txMatchesProperty({ property_id: 'other' }, p)).toBe(false)
  })
})

describe('normalizeReportCategory', () => {
  it('maps nbn/internet/网费 to internet', () => {
    expect(normalizeReportCategory('nbn')).toBe('internet')
    expect(normalizeReportCategory('internet')).toBe('internet')
    expect(normalizeReportCategory('网费')).toBe('internet')
  })
})
