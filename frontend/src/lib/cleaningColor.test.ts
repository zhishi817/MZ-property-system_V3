import { describe, expect, it } from 'vitest'
import { cleaningColorKind } from './cleaningColor'

describe('cleaningColorKind', () => {
  it('forces unassigned tasks to use unassigned kind', () => {
    expect(cleaningColorKind({ source: 'cleaning_tasks', label: '退房', assignee_id: null })).toBe('unassigned')
    expect(cleaningColorKind({ source: 'cleaning_tasks', label: '入住', assignee_id: '' })).toBe('unassigned')
    expect(cleaningColorKind({ source: 'offline_tasks', label: 'todo', assignee_id: '' })).toBe('unassigned')
  })

  it('allows non-blue kinds only when assigned', () => {
    expect(cleaningColorKind({ source: 'cleaning_tasks', label: '退房', assignee_id: 'u1' })).toBe('checkout')
    expect(cleaningColorKind({ source: 'cleaning_tasks', label: '入住', assignee_id: 'u1' })).toBe('checkin')
    expect(cleaningColorKind({ source: 'cleaning_tasks', label: '退房 入住', assignee_id: 'u1', entity_ids: ['a', 'b'] })).toBe('combined')
    expect(cleaningColorKind({ source: 'offline_tasks', label: '线下', assignee_id: 'u1' })).toBe('combined')
  })

  it('uses cleaner fields for compatibility', () => {
    expect(cleaningColorKind({ source: 'cleaning_tasks', label: '退房', cleaner: '' })).toBe('unassigned')
    expect(cleaningColorKind({ source: 'cleaning_tasks', label: '退房', cleaner_id: 'c1' })).toBe('checkout')
  })
})

