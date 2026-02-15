import { Router } from 'express'
import { hasPg, pgPool } from '../dbAdapter'
import { db } from '../store'
import { requireAnyPerm } from '../auth'
import { z } from 'zod'

export const router = Router()

function normalizePlatform(source: any): 'airbnb' | 'booking' | 'direct' | 'other' {
  const s = String(source || '').trim().toLowerCase()
  if (!s) return 'other'
  if (s.startsWith('airbnb')) return 'airbnb'
  if (s.startsWith('booking')) return 'booking'
  if (s === 'direct' || s === 'offline') return 'direct'
  return 'other'
}

router.get('/orders-summary', async (_req, res) => {
  try {
    // PG branch: aggregate using Australia/Melbourne calendar
    if (hasPg && pgPool) {
      const sqlTotal = `SELECT COUNT(*)::int AS total FROM orders`
      const sqlDays = `
        WITH base AS (
          SELECT (now() AT TIME ZONE 'Australia/Melbourne')::date AS today_au
        ), days AS (
          SELECT generate_series((SELECT today_au FROM base), (SELECT today_au FROM base) + interval '6 day', interval '1 day')::date AS day
        )
        SELECT 
          to_char(d.day, 'YYYY-MM-DD') AS day,
          COUNT(*) FILTER (WHERE o.checkin = d.day) AS checkin_count,
          COUNT(*) FILTER (WHERE o.checkout = d.day) AS checkout_count
        FROM days d
        LEFT JOIN orders o ON (o.checkin = d.day OR o.checkout = d.day)
        GROUP BY d.day
        ORDER BY d.day
      `
      const r1 = await pgPool.query(sqlTotal)
      const r2 = await pgPool.query(sqlDays)
      const total = Number(r1?.rows?.[0]?.total || 0)
      const next7days = (r2?.rows || []).map((r: any) => ({ date: String(r.day), checkin_count: Number(r.checkin_count || 0), checkout_count: Number(r.checkout_count || 0) }))
      return res.json({ total_orders: total, next7days })
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'stats query failed' })
  }
  // Fallback: memory aggregation
  try {
    const orders = db.orders || []
    const total = orders.length
    const tz = 'Australia/Melbourne'
    function dayStrAtTZ(d: Date): string {
      const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
      const get = (t: string) => parts.find(p => p.type === t)?.value || ''
      const yyyy = get('year'); const mm = get('month'); const dd = get('day')
      return `${yyyy}-${mm}-${dd}`
    }
    const now = new Date()
    const baseStr = dayStrAtTZ(now)
    const baseDate = new Date(`${baseStr}T00:00:00`)
    const days: { date: string; checkin_count: number; checkout_count: number }[] = []
    function orderDayStr(s?: string): string {
      if (!s) return ''
      const d = new Date(s)
      return dayStrAtTZ(d)
    }
    for (let i = 0; i < 7; i++) {
      const d = new Date(baseDate.getTime() + i * 24 * 3600 * 1000)
      const dayStr = dayStrAtTZ(d)
      const ci = orders.filter(o => orderDayStr(o.checkin) === dayStr).length
      const co = orders.filter(o => orderDayStr(o.checkout) === dayStr).length
      days.push({ date: dayStr, checkin_count: ci, checkout_count: co })
    }
    return res.json({ total_orders: total, next7days: days })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'stats compute failed' })
  }
})

router.get('/cleaning-overview', requireAnyPerm(['cleaning.view','cleaning.schedule.manage','cleaning.task.assign']), async (req, res) => {
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  const parsedDate = dateSchema.safeParse(req.query?.date)
  const dateStr = parsedDate.success ? parsedDate.data : undefined
  try {
    if (hasPg && pgPool) {
      const dayExprCheckin = `CASE WHEN substring(o.checkin::text,1,10) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN substring(o.checkin::text,1,10)::date END`
      const dayExprCheckout = `CASE WHEN substring(o.checkout::text,1,10) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN substring(o.checkout::text,1,10)::date END`
      const sql = `
        WITH base AS (
          SELECT COALESCE($1::date, (now() AT TIME ZONE 'Australia/Melbourne')::date) AS day_au
        ), days AS (
          SELECT generate_series((SELECT day_au FROM base), (SELECT day_au FROM base) + interval '6 day', interval '1 day')::date AS day
        )
        SELECT 
          to_char(d.day, 'YYYY-MM-DD') AS day,
          COUNT(*) FILTER (WHERE ${dayExprCheckin} = d.day) AS checkin_count,
          COUNT(*) FILTER (WHERE ${dayExprCheckout} = d.day) AS checkout_count
        FROM days d
        LEFT JOIN orders o ON (${dayExprCheckin} = d.day OR ${dayExprCheckout} = d.day)
        GROUP BY d.day
        ORDER BY d.day
      `
      const rDays = await pgPool.query(sql, [dateStr || null])
      const next7days = (rDays?.rows || []).map((r: any) => ({ date: String(r.day), checkin_count: Number(r.checkin_count || 0), checkout_count: Number(r.checkout_count || 0) }))

      const sqlOrders = `
        WITH base AS (
          SELECT COALESCE($1::date, (now() AT TIME ZONE 'Australia/Melbourne')::date) AS day_au
        )
        SELECT 
          o.id::text AS id,
          COALESCE(o.property_id::text, '') AS property_id,
          COALESCE(p.code, COALESCE(o.property_id::text, '')) AS property_code,
          COALESCE(o.guest_name, '') AS guest_name,
          substring(o.checkin::text,1,10) AS checkin,
          substring(o.checkout::text,1,10) AS checkout,
          COALESCE(o.source, '') AS source,
          COALESCE(o.status, '') AS status
        FROM orders o
        LEFT JOIN properties p ON (p.id::text = o.property_id::text OR p.code = o.property_id::text)
        CROSS JOIN base b
        WHERE ${dayExprCheckin} = b.day_au OR ${dayExprCheckout} = b.day_au
        ORDER BY COALESCE(p.code, COALESCE(o.property_id::text, '')), o.id
      `
      const rOrders = await pgPool.query(sqlOrders, [dateStr || null])
      const baseDate = dateStr || String(rDays?.rows?.[0]?.day || '').slice(0, 10)
      const orders = (rOrders?.rows || []).map((r: any) => ({
        id: String(r.id),
        property_id: String(r.property_id || ''),
        property_code: String(r.property_code || ''),
        guest_name: String(r.guest_name || ''),
        checkin: String(r.checkin || ''),
        checkout: String(r.checkout || ''),
        source: String(r.source || ''),
        status: String(r.status || ''),
      }))

      const initCounts = () => ({ total: 0, by_platform: { airbnb: 0, booking: 0, direct: 0, other: 0 } as Record<string, number> })
      const checkins = initCounts()
      const checkouts = initCounts()
      const checkinOrdersByPlatform: Record<string, any[]> = { airbnb: [], booking: [], direct: [], other: [] }
      const checkoutOrdersByPlatform: Record<string, any[]> = { airbnb: [], booking: [], direct: [], other: [] }
      orders.forEach((o) => {
        const p = normalizePlatform(o.source)
        if (o.checkin === baseDate) {
          checkins.total++
          checkins.by_platform[p] = (checkins.by_platform[p] || 0) + 1
          checkinOrdersByPlatform[p].push(o)
        }
        if (o.checkout === baseDate) {
          checkouts.total++
          checkouts.by_platform[p] = (checkouts.by_platform[p] || 0) + 1
          checkoutOrdersByPlatform[p].push(o)
        }
      })

      return res.json({
        date: baseDate,
        today: {
          checkins: { ...checkins, orders_by_platform: checkinOrdersByPlatform },
          checkouts: { ...checkouts, orders_by_platform: checkoutOrdersByPlatform },
        },
        next7days,
      })
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'stats query failed' })
  }
  try {
    const tz = 'Australia/Melbourne'
    function dayStrAtTZ(d: Date): string {
      const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
      const get = (t: string) => parts.find(p => p.type === t)?.value || ''
      const yyyy = get('year'); const mm = get('month'); const dd = get('day')
      return `${yyyy}-${mm}-${dd}`
    }
    const now = new Date()
    const baseStr = dateStr || dayStrAtTZ(now)
    const baseDate = new Date(`${baseStr}T00:00:00`)

    function orderDayStr(s?: string): string {
      if (!s) return ''
      const d = new Date(s)
      return dayStrAtTZ(d)
    }

    const orders = (db.orders || []).filter((o: any) => {
      const ci = orderDayStr(o.checkin)
      const co = orderDayStr(o.checkout)
      return ci === baseStr || co === baseStr
    }).map((o: any) => ({
      id: String(o.id || ''),
      property_id: String(o.property_id || ''),
      property_code: String(o.property_code || ''),
      guest_name: String(o.guest_name || ''),
      checkin: orderDayStr(o.checkin),
      checkout: orderDayStr(o.checkout),
      source: String(o.source || ''),
      status: String(o.status || ''),
    }))

    const days: { date: string; checkin_count: number; checkout_count: number }[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(baseDate.getTime() + i * 24 * 3600 * 1000)
      const dayStr = dayStrAtTZ(d)
      const ci = (db.orders || []).filter((o: any) => orderDayStr(o.checkin) === dayStr).length
      const co = (db.orders || []).filter((o: any) => orderDayStr(o.checkout) === dayStr).length
      days.push({ date: dayStr, checkin_count: ci, checkout_count: co })
    }

    const initCounts = () => ({ total: 0, by_platform: { airbnb: 0, booking: 0, direct: 0, other: 0 } as Record<string, number> })
    const checkins = initCounts()
    const checkouts = initCounts()
    const checkinOrdersByPlatform: Record<string, any[]> = { airbnb: [], booking: [], direct: [], other: [] }
    const checkoutOrdersByPlatform: Record<string, any[]> = { airbnb: [], booking: [], direct: [], other: [] }
    orders.forEach((o: any) => {
      const p = normalizePlatform(o.source)
      if (o.checkin === baseStr) {
        checkins.total++
        checkins.by_platform[p] = (checkins.by_platform[p] || 0) + 1
        checkinOrdersByPlatform[p].push(o)
      }
      if (o.checkout === baseStr) {
        checkouts.total++
        checkouts.by_platform[p] = (checkouts.by_platform[p] || 0) + 1
        checkoutOrdersByPlatform[p].push(o)
      }
    })

    return res.json({
      date: baseStr,
      today: {
        checkins: { ...checkins, orders_by_platform: checkinOrdersByPlatform },
        checkouts: { ...checkouts, orders_by_platform: checkoutOrdersByPlatform },
      },
      next7days: days,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'stats compute failed' })
  }
})

export default router
