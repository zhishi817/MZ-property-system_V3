import { describe, expect, test } from 'vitest'
import { splitTurnoverMerge, type CleaningTurnoverMergeItem } from './cleaningDailyMerge'

type Item = CleaningTurnoverMergeItem & {
  id: string
  task_type: 'checkout_clean' | 'checkin_clean'
}

describe('cleaningDailyMerge', () => {
  test('keeps extra active manual checkin outside the turnover merge', () => {
    const checkout: Item = { id: 'auto-checkout', task_type: 'checkout_clean', order_id: 'order-out', order_code: 'OUT' }
    const autoCheckin: Item = { id: 'auto-checkin', task_type: 'checkin_clean', order_id: 'order-in', order_code: 'IN' }
    const manualCheckin: Item = { id: 'manual-checkin', task_type: 'checkin_clean', order_id: null, order_code: null }

    const result = splitTurnoverMerge(
      [checkout, autoCheckin, manualCheckin],
      [checkout],
      [manualCheckin, autoCheckin],
    )

    expect(result?.turnoverItems.map((item) => item.id)).toEqual(['auto-checkout', 'auto-checkin'])
    expect(result?.restItems.map((item) => item.id)).toEqual(['manual-checkin'])
  })

  test('does not invent a turnover merge when one side is missing', () => {
    const checkout: Item = { id: 'auto-checkout', task_type: 'checkout_clean', order_id: 'order-out', order_code: 'OUT' }

    expect(splitTurnoverMerge([checkout], [checkout], [])).toBeNull()
  })
})
