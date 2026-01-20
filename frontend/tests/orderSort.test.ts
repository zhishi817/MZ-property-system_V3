import { describe, it, expect } from 'vitest'
import { sortOrders, SortKey, SortOrder } from '../src/lib/orderSort'

function o(id: string, emailAt?: string, checkin?: string, checkout?: string) {
  return { id, email_header_at: emailAt, checkin, checkout }
}

describe('order sorting', () => {
  it('sorts by email_header_at descending by default', () => {
    const list = [
      o('a', '2026-01-19T10:00:00Z'),
      o('b', '2026-01-20T09:00:00Z'),
      o('c', '2025-12-31T23:00:00Z')
    ]
    const sorted = sortOrders(list, 'email_header_at' as SortKey, 'descend' as SortOrder)
    expect(sorted.map(x=>x.id)).toEqual(['b','a','c'])
  })

  it('sorts by checkin ascending', () => {
    const list = [
      o('a', undefined, '2026-02-01'),
      o('b', undefined, '2026-01-15'),
      o('c', undefined, '2026-03-01')
    ]
    const sorted = sortOrders(list, 'checkin', 'ascend')
    expect(sorted.map(x=>x.id)).toEqual(['b','a','c'])
  })

  it('handles missing values safely', () => {
    const list = [
      o('a'),
      o('b', '2026-01-01T00:00:00Z'),
      o('c')
    ]
    const sorted = sortOrders(list, 'email_header_at', 'descend')
    expect(sorted.map(x=>x.id)).toEqual(['b','a','c'])
  })
})
