import { describe, expect, it } from 'vitest'
import {
  isPropertyPayableDueSoon,
  isPropertyPayableOverdue,
  normalizePropertyPayableTemplates,
  propertyPayableFrequencyLabel,
  propertyPayableSortBucket,
} from './propertyPayables'

describe('propertyPayables', () => {
  it('treats confirmed unpaid rows as payment overdue when backend flags payment overdue', () => {
    const row = { status: 'unpaid', amount_confirmed: true, is_overdue: true, is_due_soon: true }

    expect(isPropertyPayableOverdue(row)).toBe(true)
    expect(isPropertyPayableDueSoon(row)).toBe(true)
    expect(propertyPayableSortBucket(row)).toBe(0)
  })

  it('keeps backend overdue and due soon buckets stable', () => {
    expect(isPropertyPayableOverdue({ status: 'unpaid', amount_confirmed: false, is_overdue: true })).toBe(true)
    expect(propertyPayableSortBucket({ status: 'unpaid', amount_confirmed: false, is_overdue: true })).toBe(0)
    expect(isPropertyPayableDueSoon({ status: 'unpaid', amount_confirmed: false, is_due_soon: true })).toBe(true)
    expect(propertyPayableSortBucket({ status: 'unpaid', amount_confirmed: false, is_due_soon: true })).toBe(1)
  })

  it('keeps supported payable template billing cycles', () => {
    const rows = normalizePropertyPayableTemplates([
      { vendor: 'Sydney Water', category: 'water', frequency_months: 2, start_month_key: '2026-06' },
      { vendor: 'Council', category: 'council_rate', frequency_months: 12, start_month_key: '2026-07' },
    ])

    expect(rows.map((row) => row.frequency_months)).toEqual([2, 12])
    expect(propertyPayableFrequencyLabel(rows[0].frequency_months)).toBe('每 2 个月')
    expect(propertyPayableFrequencyLabel(rows[1].frequency_months)).toBe('每年')
  })

  it('falls unsupported payable template billing cycles back to monthly', () => {
    const rows = normalizePropertyPayableTemplates([
      { vendor: 'Unsupported', category: 'other', frequency_months: 4, start_month_key: '2026-06' },
    ])

    expect(rows[0].frequency_months).toBe(1)
    expect(propertyPayableFrequencyLabel(4)).toBe('每月')
  })
})
