export type OrderCalendarPlatformFilter = 'all' | 'airbnb' | 'booking' | 'offline' | 'other'

export type OrderCalendarRow = {
  status?: unknown
  source?: unknown
  property_id?: unknown
  checkin?: unknown
  checkout?: unknown
}

export function orderSourcePlatform(source?: unknown): Exclude<OrderCalendarPlatformFilter, 'all'> {
  const value = String(source || '').trim().toLowerCase()
  if (value.includes('airbnb')) return 'airbnb'
  if (value.includes('book')) return 'booking'
  if (value === 'offline' || value.includes('direct') || value.includes('manual')) return 'offline'
  return 'other'
}

/**
 * Calendar visibility follows the persisted lifecycle status only. Financial
 * amounts, refunds, platform colours, and overlapping dates are not evidence
 * that an order was cancelled.
 */
export function isCancelledOrderStatus(status?: unknown): boolean {
  const value = String(status || '').trim().toLowerCase()
  return value === 'cancelled' || value === 'canceled'
}

export function filterOrdersForCalendar<T extends OrderCalendarRow>(
  rows: T[] | null | undefined,
  options: {
    propertyId?: unknown
    platformFilter?: OrderCalendarPlatformFilter
  },
): T[] {
  const propertyId = String(options.propertyId || '').trim()
  const platformFilter = options.platformFilter || 'all'
  if (!propertyId) return []

  return (Array.isArray(rows) ? rows : []).filter((order) => {
    if (String(order?.property_id || '').trim() !== propertyId) return false
    if (isCancelledOrderStatus(order?.status)) return false
    if (platformFilter !== 'all' && orderSourcePlatform(order?.source) !== platformFilter) return false
    return !!String(order?.checkin || '').slice(0, 10)
      && !!String(order?.checkout || '').slice(0, 10)
  })
}
