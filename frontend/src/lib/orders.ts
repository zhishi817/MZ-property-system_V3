import dayjs from 'dayjs'

export type OrderLike = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; cleaning_fee?: number; nights?: number; source?: string; guest_name?: string; net_income?: number; avg_nightly_price?: number }

export function toDayStr(raw?: any): string {
  const str = String(raw || '')
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) return dayjs(str).format('YYYY-MM-DD')
  const m = str.match(/^(\d{4}-\d{2}-\d{2})$/)
  return m ? m[1] : dayjs(str).format('YYYY-MM-DD')
}

export function splitOrderByMonths(o: OrderLike): (OrderLike & { __rid: string })[] {
  const ciDay = toDayStr(o.checkin)
  const coDay = toDayStr(o.checkout)
  const ci = dayjs(ciDay).startOf('day')
  const co = dayjs(coDay).startOf('day')
  const totalNights = Math.max(0, co.diff(ci, 'day'))
  if (totalNights <= 0) return []
  const totalPrice = Number(o.price || 0)
  const totalCleaning = Number(o.cleaning_fee || 0)
  const dailyNet = totalNights ? (Number((totalPrice - totalCleaning).toFixed(2)) / totalNights) : 0
  const segments: (OrderLike & { __rid: string })[] = []
  let s = ci
  while (s.isBefore(co)) {
    const boundary = s.add(1, 'month').startOf('month')
    const e = co.isBefore(boundary) ? co : boundary
    const nights = Math.max(0, e.startOf('day').diff(s.startOf('day'), 'day'))
    const net = Number((dailyNet * nights).toFixed(2))
    const clean = e.isSame(co) ? totalCleaning : 0
    const price = Number((net + clean).toFixed(2))
    const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
    const __rid = `${o.id}|${s.format('YYYYMM')}`
    segments.push({ ...o, __rid, checkin: s.format('YYYY-MM-DD') + 'T12:00:00', checkout: e.format('YYYY-MM-DD') + 'T11:59:59', nights, price, cleaning_fee: clean, net_income: net, avg_nightly_price: avg } as any)
    s = e
  }
  return segments
}

export function monthSegments(orders: OrderLike[], monthStart: any): (OrderLike & { __rid: string })[] {
  const ms = dayjs(monthStart).startOf('month')
  const me = ms.endOf('month')
  const segs = orders.flatMap(o => splitOrderByMonths(o))
  return segs.filter(s => {
    const ci = dayjs(toDayStr(s.checkin)).startOf('day')
    const co = dayjs(toDayStr(s.checkout)).startOf('day')
    const a = ci.isAfter(ms) ? ci : ms
    const b = co.isBefore(me) ? co : me
    const overlap = Math.max(0, b.diff(a, 'day'))
    return overlap > 0
  })
}

export function monthStats(orders: OrderLike[], monthStart: any) {
  const ms = dayjs(monthStart).startOf('month')
  const me = ms.endOf('month')
  const segs = monthSegments(orders, ms)
  const nights = segs.reduce((sum, o) => sum + Number(o.nights || 0), 0)
  const incomeNet = segs.reduce((sum, o) => sum + Number((o as any).net_income || 0), 0)
  const cleaningFee = segs.reduce((sum, o) => sum + Number(o.cleaning_fee || 0), 0)
  const daysInMonth = me.diff(ms, 'day') + 1
  return { nights, incomeNet: Math.round(incomeNet * 100) / 100, cleaningFee: Math.round(cleaningFee * 100) / 100, daysInMonth }
}