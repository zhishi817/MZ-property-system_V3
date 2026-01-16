import { Router } from 'express'
import { hasPg, pgPool } from '../dbAdapter'
import { db } from '../store'

export const router = Router()

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

export default router
