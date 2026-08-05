export type CleaningTurnoverMergeItem = {
  order_id?: string | null
  order_code?: string | null
  task_type?: string | null
  type?: string | null
  source?: string | null
  auto_sync_enabled?: boolean | null
}

export function isOrderLinkedAutoCheckinNightsAuthoritative(item: CleaningTurnoverMergeItem | null | undefined): boolean {
  const taskType = String(item?.task_type ?? item?.type ?? '').trim().toLowerCase()
  return !!String(item?.order_id || '').trim()
    && taskType === 'checkin_clean'
    && String(item?.source || '').trim().toLowerCase() === 'auto'
    && item?.auto_sync_enabled !== false
}

function pickTurnoverSide<T extends CleaningTurnoverMergeItem>(items: T[]): T | null {
  const withOrder = items.find((item) => !!(item.order_id || item.order_code))
  return withOrder || items[0] || null
}

export function splitTurnoverMerge<T extends CleaningTurnoverMergeItem>(
  allItems: T[],
  checkouts: T[],
  checkins: T[],
): { turnoverItems: [T, T]; restItems: T[] } | null {
  const checkout = pickTurnoverSide(checkouts)
  const checkin = pickTurnoverSide(checkins)
  if (!checkout || !checkin) return null

  const turnoverItems: [T, T] = [checkout, checkin]
  const turnoverSet = new Set<T>(turnoverItems)
  return {
    turnoverItems,
    restItems: allItems.filter((item) => !turnoverSet.has(item)),
  }
}
