export type CleaningTurnoverMergeItem = {
  order_id?: string | null
  order_code?: string | null
  task_type?: string | null
  type?: string | null
  source?: string | null
  auto_sync_enabled?: boolean | null
  entity_id?: string | null
  id?: string | null
  property_id?: string | null
  task_date?: string | null
  order_checkin?: string | null
  order_checkout?: string | null
  linked_checkout_task_id?: string | null
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
  return String(item.entity_id || item.id || '').trim()
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
