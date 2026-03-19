import { Router } from 'express'
import { requireAnyPerm } from '../auth'
import { hasPg, pgPool } from '../dbAdapter'

export const router = Router()

function dayOnly(v: any): string | null {
  const s = String(v ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function normId(v: any): string | null {
  const s = String(v ?? '').trim()
  return s ? s : null
}

function normStatus(v: any): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'done' || s === 'completed') return 'done'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'in_progress') return 'in_progress'
  if (s === 'assigned') return 'assigned'
  return 'todo'
}

function normUrgency(v: any): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'low' || s === 'medium' || s === 'high' || s === 'urgent') return s
  return 'medium'
}

async function ensureWorkTasksTable() {
  if (!hasPg || !pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS work_tasks (
    id text PRIMARY KEY,
    task_kind text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    property_id text,
    title text NOT NULL DEFAULT '',
    summary text,
    scheduled_date date,
    start_time text,
    end_time text,
    assignee_id text,
    status text NOT NULL DEFAULT 'todo',
    urgency text NOT NULL DEFAULT 'medium',
    created_by text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`)
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_tasks_source ON work_tasks(source_type, source_id);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day_assignee ON work_tasks(scheduled_date, assignee_id, status);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_kind_day ON work_tasks(task_kind, scheduled_date);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day ON work_tasks(scheduled_date);`)
}

router.get('/day', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const date = dayOnly((req.query as any)?.date)
  if (!date) return res.status(400).json({ message: 'invalid date' })
  const includeOverdue = String((req.query as any)?.include_overdue || '').trim() === '1'
  const includeUnscheduled = String((req.query as any)?.include_unscheduled || '').trim() !== '0'
  const includeFuture = String((req.query as any)?.include_future || '').trim() !== '0'
  try {
    if (!hasPg || !pgPool) return res.json({ date, pool: [], groups: {}, tasks: [] })
    await ensureWorkTasksTable()
    const doneSet = ['done', 'completed', 'cancelled', 'canceled']
    const where: string[] = []
    const vals: any[] = [date, doneSet]
    where.push(`scheduled_date = $1::date`)
    if (includeOverdue) where.push(`(scheduled_date IS NOT NULL AND scheduled_date < $1::date)`)
    if (includeUnscheduled) where.push(`(scheduled_date IS NULL)`)
    if (includeFuture) where.push(`(scheduled_date IS NOT NULL AND scheduled_date > $1::date)`)
    const sql = `SELECT * FROM work_tasks WHERE status <> ALL($2::text[]) AND (${where.join(' OR ')}) ORDER BY COALESCE(scheduled_date, $1::date) ASC, urgency DESC, updated_at DESC, id DESC`
    const r = await pgPool.query(sql, vals)
    const tasks = (r?.rows || []).map((x: any) => ({
      ...x,
      id: String(x.id),
      task_kind: String(x.task_kind || ''),
      source_type: String(x.source_type || ''),
      source_id: String(x.source_id || ''),
      property_id: x.property_id ? String(x.property_id) : null,
      title: String(x.title || ''),
      summary: x.summary !== undefined && x.summary !== null ? String(x.summary || '') : null,
      scheduled_date: x.scheduled_date ? String(x.scheduled_date).slice(0, 10) : null,
      start_time: x.start_time !== undefined && x.start_time !== null ? String(x.start_time || '') : null,
      end_time: x.end_time !== undefined && x.end_time !== null ? String(x.end_time || '') : null,
      assignee_id: x.assignee_id ? String(x.assignee_id) : null,
      status: normStatus(x.status),
      urgency: normUrgency(x.urgency),
    }))
    const pool: any[] = []
    const groups: Record<string, any[]> = {}
    for (const t of tasks) {
      const aid = normId(t.assignee_id)
      if (!aid || t.scheduled_date !== date) pool.push(t)
      else {
        groups[aid] = groups[aid] || []
        groups[aid].push(t)
      }
    }
    return res.json({ date, pool, groups, tasks })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'task_center_day_failed' })
  }
})
