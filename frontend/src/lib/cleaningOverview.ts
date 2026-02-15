export type Platform = 'airbnb' | 'booking' | 'direct' | 'other'

export type OrderLite = {
  id: string
  property_id: string
  property_code: string
  guest_name: string
  checkin: string
  checkout: string
  source: string
  status: string
}

export type TodayBlock = {
  total: number
  by_platform: Record<Platform, number>
  orders_by_platform: Record<Platform, OrderLite[]>
}

export function normalizePlatform(source: any): Platform {
  const s = String(source || '').trim().toLowerCase()
  if (!s) return 'other'
  if (s.startsWith('airbnb')) return 'airbnb'
  if (s.startsWith('booking')) return 'booking'
  if (s === 'direct' || s === 'offline') return 'direct'
  return 'other'
}

export function flattenOrdersByPlatform(m: TodayBlock['orders_by_platform'] | undefined | null): OrderLite[] {
  if (!m) return []
  return (['airbnb', 'booking', 'direct', 'other'] as Platform[]).flatMap((p) => m[p] || [])
}

export function computePeak(next7days: { date: string; checkin_count: number; checkout_count: number }[] | null | undefined) {
  const rows = next7days || []
  if (!rows.length) return null
  let best = rows[0]
  let bestVal = (rows[0].checkin_count || 0) + (rows[0].checkout_count || 0)
  for (const r of rows.slice(1)) {
    const v = (r.checkin_count || 0) + (r.checkout_count || 0)
    if (v > bestVal) { best = r; bestVal = v }
  }
  return { date: best.date, total: bestVal }
}

