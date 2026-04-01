type DateOnly = { y: number; m: number; d: number }

export type OrderLike = {
  id: string
  property_id?: string
  checkin?: string
  checkout?: string
  price?: number
  cleaning_fee?: number
  nights?: number
  net_income?: number
  status?: string
  count_in_income?: boolean
  internal_deduction_total?: number
  [k: string]: any
}

export type OrderMonthSegment = OrderLike & { __rid: string }

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function round2(n: any): number {
  const x = Number(n || 0)
  if (!Number.isFinite(x)) return 0
  return Number(x.toFixed(2))
}

function toDayStr(raw?: any): string {
  const str = String(raw || '')
  const m = str.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : ''
}

function parseDateOnly(raw?: any): DateOnly {
  const s = String(raw || '')
  const d = (s || '').slice(0, 10)
  const m = /^\d{4}-\d{2}-\d{2}$/.test(d)
  if (!m) return { y: 1970, m: 1, d: 1 }
  const y = Number(d.slice(0, 4))
  const mm = Number(d.slice(5, 7))
  const dd = Number(d.slice(8, 10))
  if (!y || !mm || !dd) return { y: 1970, m: 1, d: 1 }
  return { y, m: mm, d: dd }
}

function dateOnlyToUtcMs(dt: DateOnly): number {
  return Date.UTC(dt.y, dt.m - 1, dt.d)
}

function diffDays(a: DateOnly, b: DateOnly): number {
  const ms = dateOnlyToUtcMs(b) - dateOnlyToUtcMs(a)
  return ms > 0 ? Math.floor(ms / (24 * 3600 * 1000)) : 0
}

function isSameDay(a: DateOnly, b: DateOnly): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d
}

function startOfMonth(dt: DateOnly): DateOnly {
  return { y: dt.y, m: dt.m, d: 1 }
}

function addMonths(dt: DateOnly, add: number): DateOnly {
  const base = Date.UTC(dt.y, dt.m - 1 + add, 1)
  const d = new Date(base)
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: 1 }
}

function minDate(a: DateOnly, b: DateOnly): DateOnly {
  return dateOnlyToUtcMs(a) <= dateOnlyToUtcMs(b) ? a : b
}

function maxDate(a: DateOnly, b: DateOnly): DateOnly {
  return dateOnlyToUtcMs(a) >= dateOnlyToUtcMs(b) ? a : b
}

function fmtYMD(dt: DateOnly): string {
  return `${String(dt.y).padStart(4, '0')}-${pad2(dt.m)}-${pad2(dt.d)}`
}

function fmtYYYYMM(dt: DateOnly): string {
  return `${String(dt.y).padStart(4, '0')}${pad2(dt.m)}`
}

function parseMonthKeyStart(monthKey: string): DateOnly | null {
  const s = String(monthKey || '').trim()
  if (!/^\d{4}-\d{2}$/.test(s)) return null
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(5, 7))
  if (!y || !m) return null
  return { y, m, d: 1 }
}

export function splitOrderByMonths(o: OrderLike): OrderMonthSegment[] {
  const ciDay = toDayStr(o.checkin)
  const coDay = toDayStr(o.checkout)
  const ci = parseDateOnly(ciDay)
  const co = parseDateOnly(coDay)
  const totalNights = Math.max(0, diffDays(ci, co))
  if (totalNights <= 0) return []
  const totalPrice = Number(o.price || 0)
  const totalCleaning = Number(o.cleaning_fee || 0)
  const netTotal = Math.max(0, Number(((o as any).net_income ?? (totalPrice - totalCleaning))))
  const dailyNet = totalNights ? (Number(netTotal.toFixed(2)) / totalNights) : 0
  const segments: OrderMonthSegment[] = []
  const deductionTotal = Number((o as any).internal_deduction_total || 0)
  const dailyDeduction = totalNights ? (Number(deductionTotal.toFixed(2)) / totalNights) : 0
  let deducted = 0
  let s = ci
  while (dateOnlyToUtcMs(s) < dateOnlyToUtcMs(co)) {
    const boundary = startOfMonth(addMonths(s, 1))
    const e = dateOnlyToUtcMs(co) < dateOnlyToUtcMs(boundary) ? co : boundary
    const nights = Math.max(0, diffDays(parseDateOnly(fmtYMD(s)), parseDateOnly(fmtYMD(e))))
    const net = Number((dailyNet * nights).toFixed(2))
    const clean = isSameDay(e, co) ? totalCleaning : 0
    const price = Number((net + clean).toFixed(2))
    const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
    const __rid = `${o.id}|${fmtYYYYMM(s)}`
    const isLast = isSameDay(e, co)
    const deductionSegment = isLast
      ? round2(Number(deductionTotal || 0) - Number(deducted || 0))
      : round2(dailyDeduction * nights)
    if (!isLast) deducted = round2(deducted + deductionSegment)
    const statusRaw = String((o as any).status || '').toLowerCase()
    const isCanceled = statusRaw.includes('cancel')
    const include = (!isCanceled) || !!((o as any).count_in_income)
    const visibleNet = include ? Number((net - deductionSegment).toFixed(2)) : 0
    segments.push({
      ...o,
      __rid,
      __src_checkin: o.checkin,
      __src_checkout: o.checkout,
      __src_price: totalPrice,
      __src_cleaning_fee: totalCleaning,
      __src_net_income: Number(netTotal.toFixed(2)),
      __src_nights: totalNights,
      checkin: fmtYMD(s) + 'T12:00:00',
      checkout: fmtYMD(e) + 'T11:59:59',
      nights,
      price,
      cleaning_fee: clean,
      net_income: net,
      avg_nightly_price: avg,
      internal_deduction: deductionSegment,
      visible_net_income: visibleNet,
    } as any)
    s = e
  }
  return segments
}

export function monthSegments(orders: OrderLike[], monthStart: any): OrderMonthSegment[] {
  const ms = (() => {
    const d = parseDateOnly(toDayStr(monthStart))
    return startOfMonth(d)
  })()
  const meNext = startOfMonth(addMonths(ms, 1))
  const segs = (orders || []).flatMap((o) => splitOrderByMonths(o))
  return segs.filter((s) => {
    const ci = parseDateOnly(toDayStr((s as any).checkin))
    const co = parseDateOnly(toDayStr((s as any).checkout))
    const a = dateOnlyToUtcMs(ci) > dateOnlyToUtcMs(ms) ? ci : ms
    const b = dateOnlyToUtcMs(co) < dateOnlyToUtcMs(meNext) ? co : meNext
    const overlap = Math.max(0, diffDays(a, b))
    const st = String((s as any).status || '').toLowerCase()
    const isCanceled = st.includes('cancel')
    const include = (!isCanceled) || !!((s as any).count_in_income)
    return overlap > 0 && include
  })
}

export function computeMonthSegmentsForOrders(orders: OrderLike[], monthKey: string): OrderMonthSegment[] {
  const ms = parseMonthKeyStart(monthKey)
  if (!ms) return []
  const monthStart = fmtYMD(ms)
  return monthSegments(Array.isArray(orders) ? orders : [], monthStart)
}

export function sumSegmentsVisibleNetIncome(segments: Array<{ visible_net_income?: any; net_income?: any }>): number {
  const arr = Array.isArray(segments) ? segments : []
  const sum = arr.reduce((s, x: any) => s + Number((x?.visible_net_income ?? x?.net_income ?? 0) || 0), 0)
  return Math.round(sum * 100) / 100
}
