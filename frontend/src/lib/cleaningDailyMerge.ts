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

export type ManualCheckoutLinkSelection = {
  linked_checkin_task_id: string | null
  checkout_link_decision: 'link' | 'independent' | null
  checkout_link_decision_user_selected: boolean
}

export type ManualCheckinCandidateLoadState = 'loading' | 'ready' | 'error'

export type ManualCheckinCandidateScope = {
  property_id: string
  task_date: string
}

export type ManualCheckinCheckoutCandidate = {
  id: string
  property_id: string
  property_code: string
  task_date: string
  checkout_time: string | null
  status: string | null
}

export type ManualCheckoutCheckinCandidate = {
  id: string
  property_id: string
  property_code: string
  task_date: string
  checkin_time: string | null
  status: string | null
  inspection_scope: 'inspect_and_hang'
}

const MANUAL_CHECKIN_LINK_STALE_ERROR_CODES = new Set([
  'manual_checkin_checkout_link_conflict',
  'manual_checkin_checkout_link_decision_required',
  'manual_checkout_checkin_link_conflict',
])

const MANUAL_CLEANING_CREATE_REPLAY_REVIEW_CODES = new Set([
  'manual_cleaning_create_replay_conflict',
  'manual_cleaning_create_replay_inactive',
])

export function manualCheckinLinkErrorNeedsCandidateRefresh(error: any): boolean {
  return MANUAL_CHECKIN_LINK_STALE_ERROR_CODES.has(String(error?.code || '').trim())
}

export function manualCleaningCreateReplayNeedsReview(error: any): boolean {
  return MANUAL_CLEANING_CREATE_REPLAY_REVIEW_CODES.has(String(error?.code || '').trim())
}

export function clearManualCheckinLinkSelection<T extends ManualCheckinLinkSelection>(current: T): T {
  return {
    ...current,
    linked_checkout_task_id: null,
    checkin_link_decision: null,
    checkin_link_decision_user_selected: false,
  }
}

export function clearManualCheckoutLinkSelection<T extends ManualCheckoutLinkSelection>(current: T): T {
  return {
    ...current,
    linked_checkin_task_id: null,
    checkout_link_decision: null,
    checkout_link_decision_user_selected: false,
  }
}

export function sameManualCheckinCandidateScope(
  left: ManualCheckinCandidateScope | null,
  right: ManualCheckinCandidateScope | null,
): boolean {
  if (!left || !right) return false
  return String(left.property_id || '').trim() === String(right.property_id || '').trim()
    && dayOnly(left.task_date) === dayOnly(right.task_date)
}

export function normalizeManualCheckinCheckoutCandidates(
  payload: any,
  expectedPropertyId0?: string,
  expectedTaskDate0?: string,
): ManualCheckinCheckoutCandidate[] {
  const expectedPropertyId = String(expectedPropertyId0 || '').trim()
  const expectedTaskDate = expectedTaskDate0 ? dayOnly(expectedTaskDate0) : null
  if (!payload || !Array.isArray(payload.items)) throw new Error('invalid_checkin_link_candidates_response')
  const rows = payload.items
  const seen = new Set<string>()
  const out: ManualCheckinCheckoutCandidate[] = []
  for (const row of rows) {
    const id = String(row?.id || '').trim()
    const propertyId = String(row?.property_id || '').trim()
    const taskDate = dayOnly(row?.task_date)
    if (!id || !propertyId || !taskDate) throw new Error('invalid_checkin_link_candidate')
    if (expectedPropertyId && propertyId !== expectedPropertyId) throw new Error('invalid_checkin_link_candidate_context')
    if (expectedTaskDate && taskDate !== expectedTaskDate) throw new Error('invalid_checkin_link_candidate_context')
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      property_id: propertyId,
      property_code: String(row?.property_code || '').trim(),
      task_date: taskDate,
      checkout_time: String(row?.checkout_time || '').trim() || null,
      status: String(row?.status || '').trim() || null,
    })
  }
  return out
}

export function normalizeManualCheckoutCheckinCandidates(
  payload: any,
  expectedPropertyId0?: string,
  expectedTaskDate0?: string,
): ManualCheckoutCheckinCandidate[] {
  const expectedPropertyId = String(expectedPropertyId0 || '').trim()
  const expectedTaskDate = expectedTaskDate0 ? dayOnly(expectedTaskDate0) : null
  if (!payload || !Array.isArray(payload.items)) throw new Error('invalid_checkout_link_candidates_response')
  const seen = new Set<string>()
  const out: ManualCheckoutCheckinCandidate[] = []
  for (const row of payload.items) {
    const id = String(row?.id || '').trim()
    const propertyId = String(row?.property_id || '').trim()
    const taskDate = dayOnly(row?.task_date)
    if (!id || !propertyId || !taskDate || String(row?.inspection_scope || '') !== 'inspect_and_hang') {
      throw new Error('invalid_checkout_link_candidate')
    }
    if (expectedPropertyId && propertyId !== expectedPropertyId) throw new Error('invalid_checkout_link_candidate_context')
    if (expectedTaskDate && taskDate !== expectedTaskDate) throw new Error('invalid_checkout_link_candidate_context')
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      property_id: propertyId,
      property_code: String(row?.property_code || '').trim(),
      task_date: taskDate,
      checkin_time: String(row?.checkin_time || '').trim() || null,
      status: String(row?.status || '').trim() || null,
      inspection_scope: 'inspect_and_hang',
    })
  }
  return out
}

export function clearManualCheckinLinkSelectionForScopeChange<T extends ManualCheckinLinkSelection>(
  current: T,
  previousScope: ManualCheckinCandidateScope | null,
  nextScope: ManualCheckinCandidateScope,
): T {
  if (!previousScope) return current
  if (sameManualCheckinCandidateScope(previousScope, nextScope)) return current
  return clearManualCheckinLinkSelection(current)
}

export function clearManualCheckoutLinkSelectionForScopeChange<T extends ManualCheckoutLinkSelection>(
  current: T,
  previousScope: ManualCheckinCandidateScope | null,
  nextScope: ManualCheckinCandidateScope,
): T {
  if (!previousScope || sameManualCheckinCandidateScope(previousScope, nextScope)) return current
  return clearManualCheckoutLinkSelection(current)
}

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

export function reconcileManualCheckoutLinkSelection<T extends ManualCheckoutLinkSelection>(
  current: T,
  candidateIds0: string[],
  loadState: ManualCheckinCandidateLoadState,
): T {
  if (loadState !== 'ready') return current
  const candidateIds = Array.from(new Set((candidateIds0 || []).map((value) => String(value || '').trim()).filter(Boolean)))
  const validIds = new Set(candidateIds)
  if (current.linked_checkin_task_id && validIds.has(String(current.linked_checkin_task_id))) {
    return current.checkout_link_decision === 'link' ? current : { ...current, checkout_link_decision: 'link' }
  }
  if (current.linked_checkin_task_id) return clearManualCheckoutLinkSelection(current)
  if (current.checkout_link_decision === 'independent' && current.checkout_link_decision_user_selected) return current
  if (candidateIds.length === 1) {
    return {
      ...current,
      linked_checkin_task_id: candidateIds[0],
      checkout_link_decision: 'link',
      checkout_link_decision_user_selected: false,
    }
  }
  if (candidateIds.length === 0) {
    return { ...current, linked_checkin_task_id: null, checkout_link_decision: 'independent', checkout_link_decision_user_selected: false }
  }
  return current.checkout_link_decision == null ? current : clearManualCheckoutLinkSelection(current)
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
