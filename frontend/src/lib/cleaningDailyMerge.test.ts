import { describe, expect, test } from 'vitest'
import { splitTurnoverMerge, type CleaningTurnoverMergeItem } from './cleaningDailyMerge'

type Item = CleaningTurnoverMergeItem & {
  id: string
  task_type: 'checkout_clean' | 'checkin_clean'
}

describe('cleaningDailyMerge', () => {
  test('keeps extra active manual checkin outside the turnover merge', () => {
    const checkout: Item = { id: 'auto-checkout', task_type: 'checkout_clean', property_id: 'p1', task_date: '2026-10-22', order_id: 'order-out', order_code: 'OUT', order_checkout: '2026-10-22' }
    const autoCheckin: Item = { id: 'auto-checkin', task_type: 'checkin_clean', property_id: 'p1', task_date: '2026-10-22', order_id: 'order-in', order_code: 'IN', order_checkin: '2026-10-22' }
    const manualCheckin: Item = { id: 'manual-checkin', task_type: 'checkin_clean', order_id: null, order_code: null }

    const result = splitTurnoverMerge(
      [checkout, autoCheckin, manualCheckin],
      [checkout],
      [manualCheckin, autoCheckin],
    )

    expect(result?.turnoverItems.map((item) => item.id)).toEqual(['auto-checkout', 'auto-checkin'])
    expect(result?.restItems.map((item) => item.id)).toEqual(['manual-checkin'])
  })

  test('merges one explicit manual check-in link but never infers from room/date', () => {
    const checkout: Item = { id: 'checkout', task_type: 'checkout_clean', property_id: 'p1', task_date: '2026-10-22', order_id: 'order-out', order_checkout: '2026-10-22' }
    const linked: Item = { id: 'manual-checkin', task_type: 'checkin_clean', property_id: 'p1', task_date: '2026-10-22', order_id: null, linked_checkout_task_id: 'checkout' }
    const unlinked: Item = { id: 'independent-checkin', task_type: 'checkin_clean', property_id: 'p1', task_date: '2026-10-22', order_id: null }
    expect(splitTurnoverMerge([checkout, linked, unlinked], [checkout], [linked, unlinked])?.turnoverItems.map((item) => item.id)).toEqual(['checkout', 'manual-checkin'])
    expect(splitTurnoverMerge([checkout, unlinked], [checkout], [unlinked])).toBeNull()
    expect(splitTurnoverMerge([checkout, { ...linked, property_id: 'p2' }], [checkout], [{ ...linked, property_id: 'p2' }])).toBeNull()
    expect(splitTurnoverMerge([checkout, { ...linked, task_date: '2026-10-23' }], [checkout], [{ ...linked, task_date: '2026-10-23' }])).toBeNull()
  })

  test('does not invent a turnover merge when one side is missing', () => {
    const checkout: Item = { id: 'auto-checkout', task_type: 'checkout_clean', order_id: 'order-out', order_code: 'OUT' }

    expect(splitTurnoverMerge([checkout], [checkout], [])).toBeNull()
  })
})
