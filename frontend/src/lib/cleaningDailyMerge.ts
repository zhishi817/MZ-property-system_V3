export type CleaningTurnoverMergeItem = {
  order_id?: string | null
  order_code?: string | null
  task_type?: string | null
  type?: string | null
  source?: string | null
  auto_sync_enabled?: boolean | null
  entity_id?: string | null
  entity_ids?: Array<string | null> | null
  id?: string | null
  property_id?: string | null
  task_date?: string | null
  order_checkin?: string | null
  order_checkout?: string | null
  linked_checkout_task_id?: string | null
  status?: string | null
  execution_state?: string | null
  lifecycle_state?: string | null
}

export type ManualCheckinLinkSelection = {
  linked_checkout_task_id: string | null
  checkin_link_decision: 'link' | 'independent' | null
  checkin_link_decision_user_selected: boolean
  checkin_inspection_scope: 'inspect_and_hang' | 'password_only'
}

export type ManualCheckinCandidateLoadState = 'loading' | 'ready' | 'error'

export function reconcileManualCheckinLinkSelection<T extends ManualCheckinLinkSelection>(
  current: T,
  candidateIds0: string[],
  loadState: ManualCheckinCandidateLoadState,
): T {
  if (loadState !== 'ready') return current
  const candidateIds = Array.from(new Set((candidateIds0 || []).map((value) => String(value || '').trim()).filter(Boolean)))
  const validIds = new Set(candidateIds)
  if (current.linked_checkout_task_id && validIds.has(String(current.linked_checkout_task_id))) {
    return current.checkin_link_decision === 'link'
      ? current
      : { ...current, checkin_link_decision: 'link' }
  }
  if (current.linked_checkout_task_id) {
    return { ...current, linked_checkout_task_id: null, checkin_link_decision: null, checkin_link_decision_user_selected: false }
  }
  if (current.checkin_link_decision === 'independent' && current.checkin_link_decision_user_selected) return current
  if (candidateIds.length === 1) {
    return {
      ...current,
      linked_checkout_task_id: candidateIds[0],
      checkin_link_decision: 'link',
      checkin_link_decision_user_selected: false,
      checkin_inspection_scope: 'inspect_and_hang',
    }
  }
  if (candidateIds.length === 0) {
    return { ...current, linked_checkout_task_id: null, checkin_link_decision: 'independent', checkin_link_decision_user_selected: false }
  }
  return current.checkin_link_decision == null
    ? current
    : { ...current, linked_checkout_task_id: null, checkin_link_decision: null, checkin_link_decision_user_selected: false }
}

export function isOrderLinkedAutoCheckinNightsAuthoritative(item: CleaningTurnoverMergeItem | null | undefined): boolean {
  const taskType = String(item?.task_type ?? item?.type ?? '').trim().toLowerCase()
  return !!String(item?.order_id || '').trim()
    && taskType === 'checkin_clean'
    && String(item?.source || '').trim().toLowerCase() === 'auto'
    && item?.auto_sync_enabled !== false
}

function dayOnly(value: any) {
  const day = String(value || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

function sourceId(item: CleaningTurnoverMergeItem) {
  const entityIds = Array.isArray(item.entity_ids)
    ? item.entity_ids.map((value) => String(value || '').trim()).filter(Boolean)
    : []
  if (entityIds.length > 1) return ''
  if (entityIds.length === 1) return entityIds[0]
  return String(item.entity_id || item.id || '').trim()
}

function activeItem(item: CleaningTurnoverMergeItem) {
  const executionState = String(item.execution_state || '').trim().toLowerCase()
  const lifecycleState = String(item.lifecycle_state || '').trim().toLowerCase()
  const status = String(item.status || '').trim().toLowerCase()
  return !['cancelled', 'canceled', 'superseded', 'deleted'].includes(executionState)
    && lifecycleState !== 'deleted'
    && !['cancelled', 'canceled'].includes(status)
}

function reliablePair(checkout: CleaningTurnoverMergeItem, checkin: CleaningTurnoverMergeItem) {
  const checkoutId = sourceId(checkout)
  const linkedCheckoutId = String(checkin.linked_checkout_task_id || '').trim()
  const checkoutTaskDate = dayOnly(checkout.task_date)
  const checkinTaskDate = dayOnly(checkin.task_date)
  const checkoutPropertyId = String(checkout.property_id || '').trim()
  const checkinPropertyId = String(checkin.property_id || '').trim()
  if (checkoutId && linkedCheckoutId === checkoutId) {
    return !!checkoutTaskDate
      && checkoutTaskDate === checkinTaskDate
      && !!checkoutPropertyId
      && checkoutPropertyId === checkinPropertyId
  }
  const checkoutOrderId = String(checkout.order_id || '').trim()
  const checkinOrderId = String(checkin.order_id || '').trim()
  const taskDate = checkoutTaskDate
  return !!checkoutOrderId
    && !!checkinOrderId
    && checkoutOrderId !== checkinOrderId
    && !!taskDate
    && taskDate === checkinTaskDate
    && !!checkoutPropertyId
    && checkoutPropertyId === checkinPropertyId
    && dayOnly(checkout.order_checkout) === taskDate
    && dayOnly(checkin.order_checkin) === taskDate
}

export function manualCheckinCheckoutCandidates<T extends CleaningTurnoverMergeItem>(
  allItems: T[],
  propertyId0: string,
  taskDate0: string,
): T[] {
  const propertyId = String(propertyId0 || '').trim()
  const taskDate = dayOnly(taskDate0)
  if (!propertyId || !taskDate) return []
  const rows = (Array.isArray(allItems) ? allItems : []).filter((item) => (
    String(item.source || '').trim().toLowerCase() === 'cleaning_tasks'
    && String(item.property_id || '').trim() === propertyId
    && dayOnly(item.task_date) === taskDate
    && activeItem(item)
    && !!sourceId(item)
  ))
  const checkouts = rows.filter((item) => String(item.task_type ?? item.type ?? '').trim().toLowerCase() === 'checkout_clean')
  const checkins = rows.filter((item) => String(item.task_type ?? item.type ?? '').trim().toLowerCase() === 'checkin_clean')
  const occupiedCheckoutIds = new Set<string>()
  for (const checkout of checkouts) {
    for (const checkin of checkins) {
      if (!reliablePair(checkout, checkin)) continue
      occupiedCheckoutIds.add(sourceId(checkout))
    }
  }
  return checkouts.filter((checkout) => !occupiedCheckoutIds.has(sourceId(checkout)))
}

export function splitTurnoverMerge<T extends CleaningTurnoverMergeItem>(
  allItems: T[],
  checkouts: T[],
  checkins: T[],
): { turnoverItems: [T, T]; restItems: T[] } | null {
  const candidates = checkouts.flatMap((checkout) => checkins
    .filter((checkin) => reliablePair(checkout, checkin))
    .map((checkin) => [checkout, checkin] as [T, T]))
  if (candidates.length !== 1) return null
  const [checkout, checkin] = candidates[0]

  const turnoverItems: [T, T] = [checkout, checkin]
  const turnoverSet = new Set<T>(turnoverItems)
  return {
    turnoverItems,
    restItems: allItems.filter((item) => !turnoverSet.has(item)),
  }
}
