import { describe, expect, it } from 'vitest'
import { sortOrders } from './orderSort'

describe('sortOrders', () => {
  it('keeps a cancelled order at its original email-time position', () => {
    const rows = [
      { id: 'older', email_header_at: '2026-08-10T09:00:00Z', created_at: '2026-08-10T09:00:00Z', status: 'confirmed' },
      { id: 'target', email_header_at: '2026-08-11T09:00:00Z', created_at: '2026-08-11T09:00:00Z', status: 'confirmed' },
      { id: 'newer', email_header_at: '2026-08-12T09:00:00Z', created_at: '2026-08-12T09:00:00Z', status: 'confirmed' },
    ]

    const before = sortOrders(rows, 'email_header_at', 'descend').map((row) => row.id)
    const after = sortOrders(rows.map((row) => row.id === 'target' ? { ...row, status: 'cancelled' } : row), 'email_header_at', 'descend').map((row) => row.id)

    expect(after).toEqual(before)
  })

  it('uses creation time and id to make equal email times deterministic', () => {
    const rows = [
      { id: 'b', email_header_at: '2026-08-12T09:00:00Z', created_at: '2026-08-12T09:01:00Z' },
      { id: 'a', email_header_at: '2026-08-12T09:00:00Z', created_at: '2026-08-12T09:00:00Z' },
      { id: 'c', email_header_at: null, created_at: '2026-08-12T09:02:00Z' },
    ]

    expect(sortOrders(rows, 'email_header_at', 'descend').map((row) => row.id)).toEqual(['b', 'a', 'c'])
  })
})
