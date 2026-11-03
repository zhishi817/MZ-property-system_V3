import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { clearManualCheckinLinkSelection, clearManualCheckinLinkSelectionForScopeChange, manualCheckinCheckoutCandidates, manualCheckinLinkErrorNeedsCandidateRefresh, normalizeManualCheckinCheckoutCandidates, reconcileManualCheckinLinkSelection, sameManualCheckinCandidateScope, splitTurnoverMerge, type CleaningTurnoverMergeItem, type ManualCheckinLinkSelection } from './cleaningDailyMerge'

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
    expect(reconcileManualCheckinLinkSelection(empty, [], 'ready')).toEqual({
      ...empty,
      checkin_link_decision: 'independent',
    })
    expect(reconcileManualCheckinLinkSelection(empty, ['checkout-1', 'checkout-2'], 'ready')).toEqual(empty)
    expect(reconcileManualCheckinLinkSelection(empty, ['checkout-1'], 'ready')).toEqual({
      linked_checkout_task_id: 'checkout-1',
      checkin_link_decision: 'link',
      checkin_link_decision_user_selected: false,
      checkin_inspection_scope: 'inspect_and_hang',
    })
  })

  test('keeps completed checkout states from the Root candidate DTO while stripping non-contract fields', () => {
    expect(normalizeManualCheckinCheckoutCandidates({
      items: [
        { id: 'completed', property_id: 'p1', property_code: 'P1', task_date: '2026-11-03', checkout_time: '10am', status: 'completed', old_code: 'never-copy', guest_name: 'never-copy', order_id: 'never-copy' },
        { id: 'keys-hung', property_id: 'p1', property_code: 'P1', task_date: '2026-11-03', checkout_time: null, status: 'keys_hung', old_code: 'never-copy' },
        { id: 'completed', property_id: 'p1', task_date: '2026-11-03', status: 'completed' },
      ],
    }, 'p1', '2026-11-03')).toEqual([
      { id: 'completed', property_id: 'p1', property_code: 'P1', task_date: '2026-11-03', checkout_time: '10am', status: 'completed' },
      { id: 'keys-hung', property_id: 'p1', property_code: 'P1', task_date: '2026-11-03', checkout_time: null, status: 'keys_hung' },
    ])
    expect(normalizeManualCheckinCheckoutCandidates({ items: [] }, 'p1', '2026-11-03')).toEqual([])
    expect(() => normalizeManualCheckinCheckoutCandidates({ items: null }, 'p1', '2026-11-03')).toThrow('invalid_checkin_link_candidates_response')
    expect(() => normalizeManualCheckinCheckoutCandidates({
      items: [{ id: 'wrong-property', property_id: 'p2', property_code: 'P2', task_date: '2026-11-03', status: 'completed' }],
    }, 'p1', '2026-11-03')).toThrow('invalid_checkin_link_candidate_context')
    expect(() => normalizeManualCheckinCheckoutCandidates({
      items: [{ id: '', property_id: 'p1', property_code: 'P1', task_date: '2026-11-03', status: 'completed' }],
    }, 'p1', '2026-11-03')).toThrow('invalid_checkin_link_candidate')
  })

  test('preserves a deliberate independent choice after a successful candidate refresh', () => {
    const explicitIndependent: ManualCheckinLinkSelection = {
      linked_checkout_task_id: null,
      checkin_link_decision: 'independent',
      checkin_link_decision_user_selected: true,
      checkin_inspection_scope: 'password_only',
    }
    expect(reconcileManualCheckinLinkSelection(explicitIndependent, ['checkout-1'], 'ready')).toEqual(explicitIndependent)
    expect(clearManualCheckinLinkSelectionForScopeChange(
      explicitIndependent,
      { property_id: 'p1', task_date: '2026-11-03' },
      { property_id: 'p1', task_date: '2026-11-03' },
    )).toEqual(explicitIndependent)
    expect(clearManualCheckinLinkSelectionForScopeChange(
      explicitIndependent,
      { property_id: 'p1', task_date: '2026-11-03' },
      { property_id: 'p2', task_date: '2026-11-03' },
    )).toEqual({
      ...explicitIndependent,
      linked_checkout_task_id: null,
      checkin_link_decision: null,
      checkin_link_decision_user_selected: false,
    })
    expect(clearManualCheckinLinkSelectionForScopeChange(
      explicitIndependent,
      { property_id: 'p1', task_date: '2026-11-03' },
      { property_id: 'p1', task_date: '2026-11-04' },
    ).checkin_link_decision).toBeNull()
  })

  test('invalidates only the stale link selection after the server reports a concurrent linkage conflict', () => {
    const linkedSelection: ManualCheckinLinkSelection & { checkin_password: string; guest_special_request: string } = {
      linked_checkout_task_id: 'checkout-now-occupied',
      checkin_link_decision: 'link',
      checkin_link_decision_user_selected: true,
      checkin_inspection_scope: 'inspect_and_hang',
      checkin_password: 'preserve-input',
      guest_special_request: 'preserve-note',
    }
    expect(manualCheckinLinkErrorNeedsCandidateRefresh({ code: 'manual_checkin_checkout_link_conflict' })).toBe(true)
    expect(manualCheckinLinkErrorNeedsCandidateRefresh({ code: 'manual_checkin_checkout_link_decision_required' })).toBe(true)
    expect(manualCheckinLinkErrorNeedsCandidateRefresh(new Error('network failed'))).toBe(false)
    expect(sameManualCheckinCandidateScope(
      { property_id: 'p1', task_date: '2026-11-03' },
      { property_id: 'p1', task_date: '2026-11-03' },
    )).toBe(true)
    expect(sameManualCheckinCandidateScope(
      { property_id: 'p2', task_date: '2026-11-03' },
      { property_id: 'p1', task_date: '2026-11-03' },
    )).toBe(false)
    expect(clearManualCheckinLinkSelection(linkedSelection)).toEqual({
      ...linkedSelection,
      linked_checkout_task_id: null,
      checkin_link_decision: null,
      checkin_link_decision_user_selected: false,
    })
  })

  test('keeps the manual check-in page closed while candidate hydration is unknown or failed', () => {
    const pageSource = readFileSync(fileURLToPath(new URL('../app/cleaning/page.tsx', import.meta.url)), 'utf8')
    expect(pageSource).toMatch(/\/cleaning\/tasks\/checkin-link-candidates\?property_id=/)
    expect(pageSource).toMatch(/const requestId = \+\+manualCandidateRequestRef\.current[\s\S]*?requestId !== manualCandidateRequestRef\.current/)
    expect(pageSource).toMatch(/setManualCandidateLoadState\('loading'\)[\s\S]*?setManualCandidateLoadState\('ready'\)[\s\S]*?setManualCandidateLoadState\('error'\)/)
    expect(pageSource).toMatch(/manualCreateForm\.create_mode === 'checkin' && manualCandidateLoadState !== 'ready'/)
    expect(pageSource).toMatch(/okButtonProps=\{\{ disabled: manualCreateSaving \|\| \(manualCreateForm\?\.create_mode === 'checkin' && manualCandidateLoadState !== 'ready'\) \}\}/)
    expect(pageSource).toMatch(/任务关系加载失败，不能把未知候选当作独立任务。[\s\S]*?loadManualCheckoutCandidates\(/)
    expect(pageSource).toMatch(/catch \(error: any\)[\s\S]*?manualCheckinLinkErrorNeedsCandidateRefresh\(error\)[\s\S]*?sameManualCheckinCandidateScope\(manualCandidateScopeRef\.current, submittedCandidateScope\)[\s\S]*?setManualCandidateLoadState\('loading'\)[\s\S]*?clearManualCheckinLinkSelection\(current\)[\s\S]*?await loadManualCheckoutCandidates\(/)
    expect(pageSource).toMatch(/区域（area）[\s\S]*?<Select[\s\S]*?allowClear[\s\S]*?showSearch[\s\S]*?disabled=\{manualCreateSaving\}[\s\S]*?value=\{manualCreateForm\.area/)
    expect(pageSource).toMatch(/disabled=\{manualCreateSaving\}[\s\S]*?disabled=\{manualCreateSaving \|\| manualCandidateLoadState !== 'ready'\}/)
    expect(pageSource).not.toMatch(/manualCheckinCheckoutCandidates\(items,/)
  })
})
