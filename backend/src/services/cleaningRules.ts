export type CleaningPriority = 'low' | 'medium' | 'high' | 'urgent'
export type CleaningServiceType = 'standard' | 'deep' | 'linen_only' | 'inspection'

export type OrderForCleaning = {
  id: string
  source?: string | null
  property_id?: string | null
  checkin?: any
  checkout?: any
  nights?: any
  status?: string | null
  cleaning_fee?: any
  note?: string | null
  guest_name?: string | null
  guest_phone?: string | null
  confirmation_code?: string | null
}

export type PropertyForCleaning = {
  id: string
  code?: string | null
  capacity?: number | null
  type?: string | null
}

function dayOnly(s?: any): string | null {
  if (!s) return null
  try {
    const d = new Date(s)
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  } catch {}
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(s))
  return m ? m[0] : null
}

function clampPriority(p: number): CleaningPriority {
  if (p <= 0) return 'low'
  if (p === 1) return 'medium'
  if (p === 2) return 'high'
  return 'urgent'
}

function addDays(isoDay: string, days: number) {
  const d = new Date(`${isoDay}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function diffDays(fromIsoDay: string, toIsoDay: string) {
  const a = new Date(`${fromIsoDay}T00:00:00Z`).getTime()
  const b = new Date(`${toIsoDay}T00:00:00Z`).getTime()
  return Math.round((b - a) / (24 * 3600 * 1000))
}

function toInt(v: any): number | null {
  if (v == null) return null
  const n = Number(v)
  if (!isFinite(n)) return null
  const i = Math.trunc(n)
  if (i <= 0) return null
  return i
}

function normalizeStayDates(order: OrderForCleaning): { checkin: string | null; checkout: string | null; nights: number | null; warnings: string[] } {
  const warnings: string[] = []
  const ci = dayOnly(order.checkin)
  let co = dayOnly(order.checkout)
  const nights = toInt((order as any).nights)
  if (ci && nights) {
    const inferred = addDays(ci, nights)
    if (!co) {
      co = inferred
      warnings.push('checkout_missing_inferred_from_nights')
    } else {
      const diff = diffDays(ci, co)
      if (diff !== nights) {
        co = inferred
        warnings.push(`checkout_mismatch_inferred_from_nights(diff=${diff},nights=${nights})`)
      }
    }
  }
  if (ci && co) {
    const d = diffDays(ci, co)
    if (d < 0) {
      if (nights) {
        co = addDays(ci, nights)
        warnings.push('checkout_before_checkin_corrected_from_nights')
      } else {
        warnings.push('checkout_before_checkin')
      }
    }
  }
  return { checkin: ci, checkout: co, nights, warnings }
}

export function computeCleaningTaskFields(
  order: OrderForCleaning,
  property: PropertyForCleaning | null,
  type: 'checkout_cleaning' | 'checkin_cleaning',
  nowDay?: string
) {
  const today = nowDay || new Date().toISOString().slice(0, 10)
  const norm = normalizeStayDates(order)
  const co = norm.checkout
  const ci = norm.checkin
  const date = (type === 'checkout_cleaning' ? co : ci) || co || ci
  if (!date) throw new Error('order_missing_dates')

  const rooms = Math.max(1, Number(property?.capacity || 1))
  const fee = Number(order.cleaning_fee || 0)
  let service_type: CleaningServiceType = 'standard'
  const note = String(order.note || '').toLowerCase()
  if (/deep|deepclean|深度/.test(note)) service_type = 'deep'
  if (/linen|bed|床品/.test(note)) service_type = 'linen_only'
  if (fee >= 180) service_type = 'deep'
  const propType = String(property?.type || '').toLowerCase()
  if (/inspection/.test(propType)) service_type = 'inspection'

  let p = 1
  const daysTo = diffDays(today, date)
  if (daysTo <= 0) p = 3
  else if (daysTo <= 1) p = 3
  else if (daysTo <= 3) p = 2
  else if (daysTo <= 7) p = 1
  else p = 0
  if (rooms >= 4) p += 1
  if (service_type === 'deep') p += 1
  const src = String(order.source || '').toLowerCase()
  if (src.includes('booking')) p += 1
  const priority = clampPriority(p)

  const lines: string[] = []
  const propCode = String(property?.code || order.property_id || '').trim()
  if (propCode) lines.push(`property:${propCode}`)
  if (src) lines.push(`source:${src}`)
  lines.push(`type:${type}`)
  lines.push(`service:${service_type}`)
  lines.push(`rooms:${rooms}`)
  if (order.guest_name) lines.push(`guest:${String(order.guest_name).trim()}`)
  if (order.confirmation_code) lines.push(`code:${String(order.confirmation_code).trim()}`)
  if (type === 'checkout_cleaning' && co) lines.push(`checkout:${co}`)
  if (type === 'checkin_cleaning' && ci) lines.push(`checkin:${ci}`)
  const content = lines.join('\n')

  const recommended_start_day = type === 'checkout_cleaning' ? date : addDays(date, -1)

  return { date, rooms, service_type, priority, content, recommended_start_day, warnings: norm.warnings }
}
