import dayjs from 'dayjs'

export function parseDateOnly(raw?: any): any {
  const s = String(raw || '')
  const d = (s || '').slice(0, 10)
  const m = /^\d{4}-\d{2}-\d{2}$/.test(d)
  if (!m) {
    try { console.error('[DATE_PARSE_ERROR] expect YYYY-MM-DD, got:', s) } catch {}
    return dayjs('1970-01-01').startOf('day')
  }
  return dayjs(d, 'YYYY-MM-DD', true).startOf('day')
}

export type OrderLike = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; cleaning_fee?: number; nights?: number; source?: string; guest_name?: string; net_income?: number; avg_nightly_price?: number }

export function toDayStr(raw?: any): string {
  const str = String(raw || '')
  const m = str.match(/^\d{4}-\d{2}-\d{2}$/)
  if (m) return m[0]
  const m2 = str.match(/^(\d{4}-\d{2}-\d{2})T/)
  if (m2) return m2[1]
  try { console.error('[DATE_STRING_ERROR] expect YYYY-MM-DD or YYYY-MM-DDT..., got:', str) } catch {}
  return ''
}

export function splitOrderByMonths(o: OrderLike): (OrderLike & { __rid: string })[] {
  const ciDay = toDayStr(o.checkin)
  const coDay = toDayStr(o.checkout)
  const ci = parseDateOnly(ciDay)
  const co = parseDateOnly(coDay)
  const totalNights = Math.max(0, co.diff(ci, 'day'))
  if (totalNights <= 0) return []
  const totalPrice = Number(o.price || 0)
  const totalCleaning = Number(o.cleaning_fee || 0)
  const dailyNet = totalNights ? (Number((totalPrice - totalCleaning).toFixed(2)) / totalNights) : 0
  const segments: (OrderLike & { __rid: string })[] = []
  const deductionTotal = Number((o as any).internal_deduction_total || 0)
  let s = ci
  while (s.isBefore(co)) {
    const boundary = s.add(1, 'month').startOf('month')
    const e = co.isBefore(boundary) ? co : boundary
    const nights = Math.max(0, parseDateOnly(e.format('YYYY-MM-DD')).diff(parseDateOnly(s.format('YYYY-MM-DD')), 'day'))
    const net = Number((dailyNet * nights).toFixed(2))
    const clean = e.isSame(co) ? totalCleaning : 0
    const price = Number((net + clean).toFixed(2))
    const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
    const __rid = `${o.id}|${s.format('YYYYMM')}`
    const deductionSegment = e.isSame(co) ? deductionTotal : 0
    const visibleNet = Number((net - deductionSegment).toFixed(2))
    segments.push({
      ...o,
      __rid,
      __src_checkin: o.checkin,
      __src_checkout: o.checkout,
      __src_price: totalPrice,
      __src_cleaning_fee: totalCleaning,
      __src_net_income: Number((totalPrice - totalCleaning).toFixed(2)),
      __src_nights: totalNights,
      checkin: s.format('YYYY-MM-DD') + 'T12:00:00',
      checkout: e.format('YYYY-MM-DD') + 'T11:59:59',
      nights,
      price,
      cleaning_fee: clean,
      net_income: net,
      avg_nightly_price: avg,
      internal_deduction: deductionSegment,
      visible_net_income: visibleNet
    } as any)
    s = e
  }
  return segments
}

export function monthSegments(orders: OrderLike[], monthStart: any): (OrderLike & { __rid: string })[] {
  const ms = dayjs(monthStart).startOf('month')
  const meNext = ms.add(1, 'month').startOf('month')
  const segs = orders.flatMap(o => splitOrderByMonths(o))
  return segs.filter(s => {
    const ci = parseDateOnly(toDayStr(s.checkin))
    const co = parseDateOnly(toDayStr(s.checkout))
    const a = ci.isAfter(ms) ? ci : ms
    const b = co.isBefore(meNext) ? co : meNext
    const overlap = Math.max(0, b.diff(a, 'day'))
    return overlap > 0
  })
}

export function monthStats(orders: OrderLike[], monthStart: any) {
  const ms = dayjs(monthStart).startOf('month')
  const meNext = ms.add(1, 'month').startOf('month')
  const segs = monthSegments(orders, ms)
  const nights = segs.reduce((sum, o) => sum + Number(o.nights || 0), 0)
  const incomeNet = segs.reduce((sum, o) => sum + Number((o as any).net_income || 0), 0)
  const cleaningFee = segs.reduce((sum, o) => sum + Number(o.cleaning_fee || 0), 0)
  const daysInMonth = meNext.diff(ms, 'day')
  return { nights, incomeNet: Math.round(incomeNet * 100) / 100, cleaningFee: Math.round(cleaningFee * 100) / 100, daysInMonth }
}

export function getMonthSegmentsForProperty(orders: OrderLike[], monthStart: any, pid?: string): (OrderLike & { __rid: string })[] {
  const ms = dayjs(monthStart).startOf('month')
  const list = pid ? orders.filter(o => String(o.property_id) === String(pid)) : orders
  return monthSegments(list, ms)
}