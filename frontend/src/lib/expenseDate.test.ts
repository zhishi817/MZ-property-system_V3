import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'
import { getExpenseDateForDisplay } from './expenseDate'

describe('getExpenseDateForDisplay', () => {
  it('renders occurred_at for non-fixed expenses', () => {
    const now = dayjs('2026-02-04T12:00:00')
    expect(getExpenseDateForDisplay({ occurred_at: '2026-01-10' }, now)).toBe('2026-01-10')
  })

  it('renders due_date for fixed expenses in past month (same year)', () => {
    const now = dayjs('2026-02-04T12:00:00')
    expect(getExpenseDateForDisplay({
      fixed_expense_id: 'fx1',
      month_key: '2026-01',
      created_at: '2026-02-01T00:00:00Z',
      due_date: '2026-01-10'
    }, now)).toBe('2026-01-10')
  })

  it('renders created_at for fixed expenses in current month', () => {
    const now = dayjs('2026-02-04T12:00:00')
    expect(getExpenseDateForDisplay({
      fixed_expense_id: 'fx1',
      month_key: '2026-02',
      created_at: '2026-02-04T01:02:03Z',
      due_date: '2026-02-10'
    }, now)).toBe('2026-02-04T01:02:03Z')
  })

  it('renders created_at for fixed expenses in future month', () => {
    const now = dayjs('2026-02-04T12:00:00')
    expect(getExpenseDateForDisplay({
      fixed_expense_id: 'fx1',
      month_key: '2026-03',
      created_at: '2026-02-04T01:02:03Z',
      due_date: '2026-03-10'
    }, now)).toBe('2026-02-04T01:02:03Z')
  })

  it('renders due_date for fixed expenses across year boundary', () => {
    const now = dayjs('2026-01-02T08:00:00')
    expect(getExpenseDateForDisplay({
      fixed_expense_id: 'fx1',
      month_key: '2025-12',
      created_at: '2026-01-01T00:00:00Z',
      due_date: '2025-12-31'
    }, now)).toBe('2025-12-31')
  })

  it('treats previous month as past on the first day of a new month', () => {
    const now = dayjs('2026-03-01T00:00:01')
    expect(getExpenseDateForDisplay({
      fixed_expense_id: 'fx1',
      month_key: '2026-02',
      created_at: '2026-02-28T23:59:59Z',
      due_date: '2026-02-10'
    }, now)).toBe('2026-02-10')
  })

  it('treats same month as not past on the last day of the month', () => {
    const now = dayjs('2026-02-28T23:59:59')
    expect(getExpenseDateForDisplay({
      fixed_expense_id: 'fx1',
      month_key: '2026-02',
      created_at: '2026-02-04T01:02:03Z',
      due_date: '2026-02-10'
    }, now)).toBe('2026-02-04T01:02:03Z')
  })

  it('derives month from due_date when month_key is missing', () => {
    const now = dayjs('2026-01-10T00:00:00')
    expect(getExpenseDateForDisplay({
      fixed_expense_id: 'fx1',
      created_at: '2026-01-05T00:00:00Z',
      due_date: '2025-12-31'
    }, now)).toBe('2025-12-31')
  })

  it('falls back to occurred_at when due_date is missing for past fixed expenses', () => {
    const now = dayjs('2026-02-04T12:00:00')
    expect(getExpenseDateForDisplay({
      fixed_expense_id: 'fx1',
      month_key: '2026-01',
      created_at: '2026-02-01T00:00:00Z',
      occurred_at: '2026-01-15'
    }, now)).toBe('2026-01-15')
  })
})

