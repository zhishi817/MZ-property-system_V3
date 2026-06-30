import { describe, expect, it } from 'vitest'
import { isPropertyPayableDueSoon, isPropertyPayableOverdue, propertyPayableSortBucket } from './propertyPayables'

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
})
