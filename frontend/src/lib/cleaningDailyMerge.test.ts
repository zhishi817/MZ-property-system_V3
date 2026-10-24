import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { manualCheckinCheckoutCandidates, reconcileManualCheckinLinkSelection, splitTurnoverMerge, type CleaningTurnoverMergeItem, type ManualCheckinLinkSelection } from './cleaningDailyMerge'

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

  test('offers only unoccupied checkout sources for a new manual check-in', () => {
    const available: Item = { id: 'checkout-available', entity_id: 'checkout-available', source: 'cleaning_tasks', task_type: 'checkout_clean', property_id: 'p1', task_date: '2026-10-22', status: 'assigned', execution_state: 'active' }
    const linked: Item = { id: 'checkout-linked', entity_id: 'checkout-linked', source: 'cleaning_tasks', task_type: 'checkout_clean', property_id: 'p1', task_date: '2026-10-22', status: 'assigned', execution_state: 'active' }
    const linkedCheckin: Item = { id: 'checkin-linked', entity_id: 'checkin-linked', source: 'cleaning_tasks', task_type: 'checkin_clean', property_id: 'p1', task_date: '2026-10-22', linked_checkout_task_id: 'checkout-linked', status: 'assigned', execution_state: 'active' }
    const orderPaired: Item = { id: 'checkout-order', entity_id: 'checkout-order', source: 'cleaning_tasks', task_type: 'checkout_clean', property_id: 'p1', task_date: '2026-10-22', order_id: 'order-out', order_checkout: '2026-10-22', status: 'assigned', execution_state: 'active' }
    const orderCheckin: Item = { id: 'checkin-order', entity_id: 'checkin-order', source: 'cleaning_tasks', task_type: 'checkin_clean', property_id: 'p1', task_date: '2026-10-22', order_id: 'order-in', order_checkin: '2026-10-22', status: 'assigned', execution_state: 'active' }
    const mergedCard: Item = { id: 'merged', entity_id: 'checkout-merged', entity_ids: ['checkout-merged', 'checkin-merged'], source: 'cleaning_tasks', task_type: 'checkout_clean', property_id: 'p1', task_date: '2026-10-22' }

    expect(manualCheckinCheckoutCandidates(
      [available, linked, linkedCheckin, orderPaired, orderCheckin, mergedCard],
      'p1',
      '2026-10-22',
    ).map((item) => item.id)).toEqual(['checkout-available'])
  })

  test('fails closed when one checkout already has multiple valid incoming bookings', () => {
    const checkout: Item = { id: 'checkout', entity_id: 'checkout', source: 'cleaning_tasks', task_type: 'checkout_clean', property_id: 'p1', task_date: '2026-10-22', order_id: 'order-out', order_checkout: '2026-10-22', status: 'assigned', execution_state: 'active' }
    const incomingA: Item = { id: 'incoming-a', entity_id: 'incoming-a', source: 'cleaning_tasks', task_type: 'checkin_clean', property_id: 'p1', task_date: '2026-10-22', order_id: 'order-a', order_checkin: '2026-10-22', status: 'assigned', execution_state: 'active' }
    const incomingB: Item = { id: 'incoming-b', entity_id: 'incoming-b', source: 'cleaning_tasks', task_type: 'checkin_clean', property_id: 'p1', task_date: '2026-10-22', order_id: 'order-b', order_checkin: '2026-10-22', status: 'assigned', execution_state: 'active' }

    expect(manualCheckinCheckoutCandidates([checkout, incomingA, incomingB], 'p1', '2026-10-22')).toEqual([])
  })

  test('keeps candidate state unknown across a failed load and selects the unique checkout only after retry succeeds', () => {
    const empty: ManualCheckinLinkSelection = {
      linked_checkout_task_id: null,
      checkin_link_decision: null,
      checkin_link_decision_user_selected: false,
      checkin_inspection_scope: 'password_only',
    }
    expect(reconcileManualCheckinLinkSelection(empty, [], 'loading')).toEqual(empty)
    expect(reconcileManualCheckinLinkSelection(empty, [], 'error')).toEqual(empty)
    expect(reconcileManualCheckinLinkSelection(empty, ['checkout-1'], 'ready')).toEqual({
      linked_checkout_task_id: 'checkout-1',
      checkin_link_decision: 'link',
      checkin_link_decision_user_selected: false,
      checkin_inspection_scope: 'inspect_and_hang',
    })
  })

  test('preserves a deliberate independent choice after a successful candidate refresh', () => {
    const explicitIndependent: ManualCheckinLinkSelection = {
      linked_checkout_task_id: null,
      checkin_link_decision: 'independent',
      checkin_link_decision_user_selected: true,
      checkin_inspection_scope: 'password_only',
    }
    expect(reconcileManualCheckinLinkSelection(explicitIndependent, ['checkout-1'], 'ready')).toEqual(explicitIndependent)
  })

  test('keeps the manual check-in page closed while candidate hydration is unknown or failed', () => {
    const pageSource = readFileSync(fileURLToPath(new URL('../app/cleaning/page.tsx', import.meta.url)), 'utf8')
    expect(pageSource).toMatch(/setCalendarRangeLoadState\('loading'\)[\s\S]*?setCalendarRangeLoadState\('ready'\)[\s\S]*?setCalendarRangeLoadState\('error'\)/)
    expect(pageSource).toMatch(/manualCreateForm\.create_mode === 'checkin' && calendarRangeLoadState !== 'ready'/)
    expect(pageSource).toMatch(/okButtonProps=\{\{ disabled: manualCreateSaving \|\| \(manualCreateForm\?\.create_mode === 'checkin' && calendarRangeLoadState !== 'ready'\) \}\}/)
    expect(pageSource).toMatch(/任务关系加载失败，不能把未知候选当作独立任务。[\s\S]*?loadRangeItems\(\)/)
  })
})
