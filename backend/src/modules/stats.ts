import { Router } from 'express'
import { hasPg, pgPool } from '../dbAdapter'
import { db } from '../store'
import { requireAnyPerm } from '../auth'
import { z } from 'zod'
import { ensureCleaningSchemaV2 } from '../services/cleaningSync'

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
      await ensureCleaningSchemaV2()
      const baseSql = `SELECT COALESCE($1::date, (now() AT TIME ZONE 'Australia/Melbourne')::date) AS day_au`
      const baseRes = await pgPool.query(baseSql, [dateStr || null])
      const baseDay = baseRes?.rows?.[0]?.day_au ? String(baseRes.rows[0].day_au).slice(0, 10) : (dateStr || '')

      const byStatusSql = `
        SELECT COALESCE(status,'pending') AS status, COUNT(*)::int AS c
        FROM cleaning_tasks
        WHERE (task_date::date) = ($1::date)
        GROUP BY COALESCE(status,'pending')
      `
      const r1 = await pgPool.query(byStatusSql, [baseDay])
      const byStatus: Record<string, number> = {}
      for (const row of (r1?.rows || [])) {
        byStatus[String(row.status || 'pending')] = Number(row.c || 0)
      }

      const unassignedSql = `
        SELECT COUNT(*)::int AS c
        FROM cleaning_tasks
        WHERE (task_date::date) = ($1::date)
          AND assignee_id IS NULL
          AND COALESCE(status,'') <> 'cancelled'
      `
      const r2 = await pgPool.query(unassignedSql, [baseDay])
      const unassigned = Number(r2?.rows?.[0]?.c || 0)

      const trendSql = `
        WITH base AS (
          SELECT ($1::date) AS day_au
        ), days AS (
          SELECT generate_series((SELECT day_au FROM base), (SELECT day_au FROM base) + interval '6 day', interval '1 day')::date AS day
        )
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COUNT(t.id)::int AS total
        FROM days d
        LEFT JOIN cleaning_tasks t ON (t.task_date::date = d.day)
        GROUP BY d.day
        ORDER BY d.day
      `
      const r3 = await pgPool.query(trendSql, [baseDay])
      const next7days = (r3?.rows || []).map((r: any) => ({ date: String(r.day), total: Number(r.total || 0) }))

      const total = Object.values(byStatus).reduce((a, b) => a + Number(b || 0), 0)
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
    for (const t of tasks) {
      const st = String(t.status || 'pending')
      byStatus[st] = (byStatus[st] || 0) + 1
    }
    const unassigned = tasks.filter((t: any) => !t.assignee_id && String(t.status || '') !== 'cancelled').length
    const next7days: any[] = []
    const baseDate = new Date(`${baseStr}T00:00:00`)
    for (let i = 0; i < 7; i++) {
      const d = new Date(baseDate.getTime() + i * 24 * 3600 * 1000)
      const ds = dayStrAtTZ(d)
      const total = (db.cleaningTasks as any[]).filter((t: any) => String(t.task_date || t.date || '').slice(0, 10) === ds).length
      next7days.push({ date: ds, total })
    }
    const total = tasks.length
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
