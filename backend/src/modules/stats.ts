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
      const baseSql = `SELECT COALESCE($1::date, (now() AT TIME ZONE 'Australia/Melbourne')::date) AS day_au`
      const baseRes = await pgPool.query(baseSql, [dateStr || null])
      const baseDay = baseRes?.rows?.[0]?.day_au ? String(baseRes.rows[0].day_au).slice(0, 10) : (dateStr || '')

      const byStatusSql = `
        WITH day_tasks AS (
          SELECT
            COALESCE(property_id, id) AS group_key,
            BOOL_AND(lower(COALESCE(status,'')) IN ('cancelled','canceled')) AS all_cancelled,
            BOOL_OR(COALESCE(task_type,'') ILIKE 'checkout%' OR COALESCE(type,'') ILIKE 'checkout%') AS has_checkout,
            BOOL_OR(lower(COALESCE(task_type,'')) = 'stayover_clean' OR lower(COALESCE(type,'')) = 'stayover_clean') AS has_stayover,
            BOOL_OR((COALESCE(task_type,'') ILIKE 'checkout%' OR COALESCE(type,'') ILIKE 'checkout%') AND lower(COALESCE(status,'')) NOT IN ('cancelled','canceled')) AS has_checkout_active,
            BOOL_OR((lower(COALESCE(task_type,'')) = 'stayover_clean' OR lower(COALESCE(type,'')) = 'stayover_clean') AND lower(COALESCE(status,'')) NOT IN ('cancelled','canceled')) AS has_stayover_active,
            MAX(
              CASE lower(COALESCE(status,'pending'))
                WHEN 'in_progress' THEN 4
                WHEN 'assigned' THEN 3
                WHEN 'completed' THEN 2
                WHEN 'pending' THEN 1
                WHEN 'cancelled' THEN 0
                WHEN 'canceled' THEN 0
                ELSE 1
              END
            ) AS status_rank
          FROM cleaning_tasks
          WHERE (task_date::date) = ($1::date)
          GROUP BY COALESCE(property_id, id)
        ),
        rollup AS (
          SELECT
            CASE
              WHEN all_cancelled THEN 'cancelled'
              WHEN status_rank = 4 THEN 'in_progress'
              WHEN status_rank = 3 THEN 'assigned'
              WHEN status_rank = 2 THEN 'completed'
              ELSE 'pending'
            END AS status,
            CASE
              WHEN all_cancelled THEN false
              WHEN status_rank = 1 THEN true
              ELSE false
            END AS is_unassigned
          FROM day_tasks
          WHERE (has_checkout_active OR has_stayover_active)
        )
        SELECT
          status,
          COUNT(*)::int AS c,
          SUM(CASE WHEN is_unassigned THEN 1 ELSE 0 END)::int AS unassigned
        FROM rollup
        GROUP BY status
      `
      const r1 = await pgPool.query(byStatusSql, [baseDay])
      const byStatus: Record<string, number> = {}
      let unassigned = 0
      let total = 0
      for (const row of (r1?.rows || [])) {
        byStatus[String(row.status || 'pending')] = Number(row.c || 0)
        unassigned += Number(row.unassigned || 0)
        total += Number(row.c || 0)
      }

      const dayExprCheckout = `CASE
        WHEN substring(o.checkout::text,1,10) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN substring(o.checkout::text,1,10)::date
        WHEN substring(o.checkout::text,1,10) ~ '^\\d{2}/\\d{2}/\\d{4}$' THEN to_date(substring(o.checkout::text,1,10), 'DD/MM/YYYY')
        ELSE NULL
      END`
      const dayExprCheckin = `CASE
        WHEN substring(o.checkin::text,1,10) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN substring(o.checkin::text,1,10)::date
        WHEN substring(o.checkin::text,1,10) ~ '^\\d{2}/\\d{2}/\\d{4}$' THEN to_date(substring(o.checkin::text,1,10), 'DD/MM/YYYY')
        ELSE NULL
      END`
      const trendSql = `
        WITH base AS (
          SELECT ($1::date) AS day_au
        ), days AS (
          SELECT generate_series((SELECT day_au FROM base), (SELECT day_au FROM base) + interval '6 day', interval '1 day')::date AS day
        ),
        task_agg AS (
          SELECT
            t.task_date::date AS day,
            COUNT(DISTINCT COALESCE(t.property_id, t.id)) FILTER (WHERE
              COALESCE(t.task_type,'') ILIKE 'checkout%' OR
              COALESCE(t.type,'') ILIKE 'checkout%' OR
              lower(COALESCE(t.task_type,'')) = 'stayover_clean' OR
              lower(COALESCE(t.type,'')) = 'stayover_clean'
            )::int AS task_out,
            COUNT(DISTINCT COALESCE(t.property_id, t.id)) FILTER (WHERE
              COALESCE(t.task_type,'') ILIKE 'checkin%' OR
              COALESCE(t.type,'') ILIKE 'checkin%'
            )::int AS task_in
          FROM cleaning_tasks t
          WHERE t.task_date::date >= (SELECT day_au FROM base)
            AND t.task_date::date <= (SELECT day_au FROM base) + interval '6 day'
            AND lower(COALESCE(t.status,'')) NOT IN ('cancelled','canceled')
          GROUP BY t.task_date::date
        ),
        order_agg AS (
          SELECT
            d.day AS day,
            COUNT(*) FILTER (WHERE (${dayExprCheckout}) = d.day)::int AS order_out,
            COUNT(*) FILTER (WHERE (${dayExprCheckin}) = d.day)::int AS order_in
          FROM days d
          LEFT JOIN orders o ON (
            ((${dayExprCheckout}) = d.day OR (${dayExprCheckin}) = d.day)
            AND COALESCE(o.status, '') <> ''
            AND lower(COALESCE(o.status, '')) <> 'invalid'
            AND lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'
          )
          GROUP BY d.day
        )
        SELECT
          to_char(d.day, 'YYYY-MM-DD') AS day,
          (
            CASE
              WHEN COALESCE(ta.task_out, 0) > 0 THEN COALESCE(ta.task_out, 0)
              ELSE COALESCE(oa.order_out, 0)
            END
          )::int AS check_out_count,
          GREATEST(COALESCE(ta.task_in, 0), COALESCE(oa.order_in, 0))::int AS check_in_count
        FROM days d
        LEFT JOIN task_agg ta ON ta.day = d.day
        LEFT JOIN order_agg oa ON oa.day = d.day
        ORDER BY d.day
      `
      const r3 = await pgPool.query(trendSql, [baseDay])
      const next7days = (r3?.rows || []).map((r: any) => {
        const co = Number(r.check_out_count || 0)
        const ci = Number(r.check_in_count || 0)
        return { date: String(r.day), check_out_count: co, check_in_count: ci, total: co + ci }
      })

      return res.json({
        date: baseDay,
        today: {
          total,
          unassigned,
          by_status: {
            pending: byStatus.pending || 0,
            assigned: byStatus.assigned || 0,
            in_progress: byStatus.in_progress || 0,
            completed: byStatus.completed || 0,
            cancelled: byStatus.cancelled || byStatus.canceled || 0,
          },
        },
        next7days,
      })
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'stats query failed' })
  }
  try {
    const tz = 'Australia/Melbourne'
    const dayStrAtTZ = (d: Date): string => {
      const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
      const get = (t: string) => parts.find(p => p.type === t)?.value || ''
      return `${get('year')}-${get('month')}-${get('day')}`
    }
    const baseStr = dateStr || dayStrAtTZ(new Date())
    const byStatus: Record<string, number> = {}
    const tasks = (db.cleaningTasks as any[]).filter((t: any) => String(t.task_date || t.date || '').slice(0, 10) === baseStr)
    const groups = new Map<string, { allCancelled: boolean; rank: number; hasCheckoutActive: boolean; hasStayoverActive: boolean }>()
    function rankStatus(st: any): number {
      const s = String(st || 'pending').trim().toLowerCase()
      if (s === 'in_progress') return 4
      if (s === 'assigned') return 3
      if (s === 'completed') return 2
      if (s === 'cancelled' || s === 'canceled') return 0
      return 1
    }
    for (const t of tasks) {
      const key = String(t.property_id || t.id || '')
      const r = rankStatus(t.status)
      const cancelled = ['cancelled', 'canceled'].includes(String(t.status || '').toLowerCase())
      const tt = String(t.task_type || t.type || '').toLowerCase()
      const hasCheckoutActive = !cancelled && tt.startsWith('checkout')
      const hasStayoverActive = !cancelled && tt === 'stayover_clean'
      const cur = groups.get(key)
      if (!cur) groups.set(key, { allCancelled: cancelled, rank: r, hasCheckoutActive, hasStayoverActive })
      else groups.set(key, {
        allCancelled: cur.allCancelled && cancelled,
        rank: Math.max(cur.rank, r),
        hasCheckoutActive: cur.hasCheckoutActive || hasCheckoutActive,
        hasStayoverActive: cur.hasStayoverActive || hasStayoverActive,
      })
    }
    let unassigned = 0
    for (const g of groups.values()) {
      if (!g.hasCheckoutActive && !g.hasStayoverActive) continue
      let st: string
      if (g.rank === 4) st = 'in_progress'
      else if (g.rank === 3) st = 'assigned'
      else if (g.rank === 2) st = 'completed'
      else st = 'pending'
      byStatus[st] = (byStatus[st] || 0) + 1
      if (st === 'pending') unassigned += 1
    }
    const next7days: any[] = []
    const baseDate = new Date(`${baseStr}T00:00:00`)
    const isCheckoutTask = (t: any) => {
      const tt = String(t.task_type || t.type || '').toLowerCase()
      const lb = String(t.label || '').toLowerCase()
      return tt.startsWith('checkout') || tt.includes('turnover') || tt === 'stayover_clean' || lb.includes('退房') || lb.includes('checkout') || lb.includes('入住中清洁')
    }
    const isCheckinTask = (t: any) => {
      const tt = String(t.task_type || t.type || '').toLowerCase()
      const lb = String(t.label || '').toLowerCase()
      return tt.startsWith('checkin') || tt.includes('turnover') || lb.includes('入住') || lb.includes('checkin')
    }
    for (let i = 0; i < 7; i++) {
      const d = new Date(baseDate.getTime() + i * 24 * 3600 * 1000)
      const ds = dayStrAtTZ(d)
      const dayTasks = (db.cleaningTasks as any[]).filter((t: any) => String(t.task_date || t.date || '').slice(0, 10) === ds)
      const outSet = new Set<string>()
      const inSet = new Set<string>()
      for (const t of dayTasks) {
        const st = String(t.status || '').toLowerCase()
        if (st === 'cancelled' || st === 'canceled') continue
        const key = String(t.property_id || t.id || '')
        if (!key) continue
        if (isCheckoutTask(t)) outSet.add(key)
        if (isCheckinTask(t)) inSet.add(key)
      }
      const check_out_count = outSet.size
      const check_in_count = inSet.size
      next7days.push({ date: ds, check_out_count, check_in_count, total: check_out_count + check_in_count })
    }
    const total = Array.from(groups.values()).filter((g) => g.hasCheckoutActive || g.hasStayoverActive).length
    return res.json({
      date: baseStr,
      today: {
        total,
        unassigned,
        by_status: {
          pending: byStatus.pending || 0,
          assigned: byStatus.assigned || 0,
          in_progress: byStatus.in_progress || 0,
          completed: byStatus.completed || 0,
          cancelled: byStatus.cancelled || byStatus.canceled || 0,
        },
      },
      next7days,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'stats compute failed' })
  }
})

export default router
