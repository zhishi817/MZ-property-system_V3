import { hasPg, pgPool } from '../dbAdapter'
import { db } from '../store'
import { createHash } from 'crypto'
import { v4 as uuid } from 'uuid'

export type CleaningSyncAction =
  | 'created'
  | 'updated'
  | 'cancelled'
  | 'no_change'
  | 'skipped_locked'
  | 'failed'

export type SyncOrderToCleaningTasksOpts = { deleted?: boolean; client?: any; jobId?: string }

const CHECKOUT_TASK_TYPE = 'checkout_clean'
const CHECKIN_TASK_TYPE = 'checkin_clean'

const DEFAULT_CHECKOUT_TIME = '10am'
const DEFAULT_CHECKIN_TIME = '3pm'

let schemaEnsured: Promise<void> | null = null

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function __test_dayOnly(s?: any) { return dayOnly(s) }

function dayOnly(s?: any): string | null {
  if (!s) return null
  if (s instanceof Date) {
    const yyyy = s.getUTCFullYear()
    const mm = String(s.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(s.getUTCDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }
  try {
    const d = new Date(s)
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  } catch {}
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(s))
  return m ? m[0] : null
}

function addDays(isoDay: string, days: number) {
  const d = new Date(`${isoDay}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function pickOrderField(order: any, keys: string[]) {
  for (const k of keys) {
    if (order && Object.prototype.hasOwnProperty.call(order, k) && order[k] != null) return order[k]
  }
  return undefined
}

function normalizeCheckoutDay(order: any): string | null {
  const ciRaw = pickOrderField(order, ['checkin', 'checkin_date', 'checkinDate', 'start_date', 'startDate', 'checkin_at', 'checkinAt'])
  const coRaw = pickOrderField(order, ['checkout', 'checkout_date', 'checkoutDate', 'end_date', 'endDate', 'checkout_at', 'checkoutAt'])
  const ci = dayOnly(ciRaw)
  let co = dayOnly(coRaw)
  const nightsRaw = order?.nights
  const nights = Number.isFinite(Number(nightsRaw)) ? Math.trunc(Number(nightsRaw)) : null
  if (ci && nights && nights > 0) {
    const inferred = addDays(ci, nights)
    if (!co) co = inferred
  }
  return co
}

function normalizeCheckinDay(order: any): string | null {
  const ciRaw = pickOrderField(order, ['checkin', 'checkin_date', 'checkinDate', 'start_date', 'startDate', 'checkin_at', 'checkinAt'])
  return dayOnly(ciRaw)
}

function isInvalidStatus(raw: any): boolean {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return true
  if (s === 'invalid') return true
  if (s.includes('cancel')) return true
  return false
}

function isValidStatus(raw: any): boolean {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return false
  if (isInvalidStatus(s)) return false
  const allow = new Set(['confirmed', 'paid', 'checked_in', 'checked_out'])
  if (allow.has(s)) return true
  return true
}

export async function ensureCleaningSchemaV2(): Promise<void> {
  if (!hasPg || !pgPool) return
  if (schemaEnsured) return schemaEnsured
  schemaEnsured = (async () => {
    const r = await pgPool.query(
      `SELECT
         to_regclass('public.cleaning_tasks') AS cleaning_tasks,
         to_regclass('public.cleaning_sync_logs') AS cleaning_sync_logs`
    )
    const ct = r?.rows?.[0]?.cleaning_tasks
    const cl = r?.rows?.[0]?.cleaning_sync_logs
    if (!ct) {
      const err: any = new Error('cleaning_tasks_missing')
      err.code = 'CLEANING_SCHEMA_MISSING'
      throw err
    }
    if (!cl) {
      const err: any = new Error('cleaning_sync_logs_missing')
      err.code = 'CLEANING_SCHEMA_MISSING'
      throw err
    }
  })().catch((e) => {
    schemaEnsured = null
    throw e
  })
  return schemaEnsured
}

export async function logCleaningSync(params: {
  jobId?: string | null
  orderId: string
  taskId?: string | null
  action: CleaningSyncAction
  before?: any
  after?: any
  meta?: any
  client?: any
}) {
  if (!hasPg || !pgPool) return
  await ensureCleaningSchemaV2()
  const exec = params.client || pgPool
  const jobId = params.jobId ? String(params.jobId) : null
  if (jobId) {
    await exec.query(
      `INSERT INTO cleaning_sync_logs(id, job_id, order_id, task_id, action, before, after, meta)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (job_id, action, task_id) WHERE job_id IS NOT NULL DO NOTHING`,
      [
        uuid(),
        jobId,
        String(params.orderId || ''),
        params.taskId ? String(params.taskId) : null,
        String(params.action || ''),
        params.before != null ? params.before : null,
        params.after != null ? params.after : null,
        params.meta != null ? params.meta : null,
      ]
    )
    return
  }
  await exec.query(
    'INSERT INTO cleaning_sync_logs(id, order_id, task_id, action, before, after, meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      uuid(),
      String(params.orderId || ''),
      params.taskId ? String(params.taskId) : null,
      String(params.action || ''),
      params.before != null ? params.before : null,
      params.after != null ? params.after : null,
      params.meta != null ? params.meta : null,
    ]
  )
}

async function loadOrder(orderId: string, client?: any): Promise<any | null> {
  if (hasPg && (client || pgPool)) {
    const exec = client || pgPool!
    const r = await exec.query('SELECT * FROM orders WHERE (id::text) = $1 LIMIT 1', [String(orderId)])
    return r?.rows?.[0] || null
  }
  return db.orders.find((o: any) => String(o.id) === String(orderId)) || null
}

async function loadTaskByOrder(orderId: string, taskType: string, client?: any): Promise<any | null> {
  if (hasPg && (client || pgPool)) {
    await ensureCleaningSchemaV2()
    const exec = client || pgPool!
    const r = await exec.query(
      'SELECT * FROM cleaning_tasks WHERE (order_id::text) = $1 AND (task_type::text) = $2 LIMIT 1',
      [String(orderId), String(taskType)]
    )
    return r?.rows?.[0] || null
  }
  return (
    (db.cleaningTasks as any[]).find(
      (t: any) => String(t.order_id) === String(orderId) && String((t.task_type ?? t.type) || '') === String(taskType)
    ) || null
  )
}

async function insertTask(row: any, client?: any): Promise<any> {
  if (hasPg && (client || pgPool)) {
    await ensureCleaningSchemaV2()
    const exec = client || pgPool!
    const sql = `
      INSERT INTO cleaning_tasks(
        id, order_id, property_id,
        task_type, task_date,
        type, date,
        status, assignee_id, scheduled_at,
        checkout_time, checkin_time,
        cleaner_id, inspector_id,
        auto_sync_enabled, sync_fingerprint, source,
        updated_at
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
      ON CONFLICT ON CONSTRAINT uniq_cleaning_tasks_order_task_type_v3
      DO UPDATE SET
        property_id = EXCLUDED.property_id,
        task_date = EXCLUDED.task_date,
        date = EXCLUDED.date,
        sync_fingerprint = EXCLUDED.sync_fingerprint,
        source = EXCLUDED.source,
        updated_at = now()
      RETURNING *
    `
    const params = [
      String(row.id),
      row.order_id ? String(row.order_id) : null,
      row.property_id ? String(row.property_id) : null,
      String(row.task_type),
      row.task_date,
      String(row.type),
      row.date,
      String(row.status),
      row.assignee_id ? String(row.assignee_id) : null,
      row.scheduled_at ? String(row.scheduled_at) : null,
      row.checkout_time != null ? String(row.checkout_time) : null,
      row.checkin_time != null ? String(row.checkin_time) : null,
      row.cleaner_id != null ? String(row.cleaner_id) : null,
      row.inspector_id != null ? String(row.inspector_id) : null,
      row.auto_sync_enabled !== false,
      row.sync_fingerprint ? String(row.sync_fingerprint) : null,
      row.source ? String(row.source) : 'auto',
    ]
    const r = await exec.query(sql, params)
    return r?.rows?.[0] || row
  }
  const next = { ...row }
  ;(db.cleaningTasks as any[]).push(next)
  return next
}

async function updateTaskById(id: string, patch: any, client?: any): Promise<any | null> {
  if (hasPg && (client || pgPool)) {
    await ensureCleaningSchemaV2()
    const exec = client || pgPool!
    const keys = Object.keys(patch || {}).filter((k) => patch[k] !== undefined)
    if (!keys.length) return null
    const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
    const values = keys.map((k) => (patch[k] === undefined ? null : patch[k]))
    const sql = `UPDATE cleaning_tasks SET ${set}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`
    const r = await exec.query(sql, [...values, String(id)])
    return r?.rows?.[0] || null
  }
  const t = (db.cleaningTasks as any[]).find((x: any) => String(x.id) === String(id))
  if (!t) return null
  Object.assign(t, patch)
  return t
}

async function syncOneTask(params: {
  jobId?: string | null
  orderId: string
  deleted: boolean
  client?: any
  taskType: string
  date: string | null
  statusLower: string
  propertyId: string | null
}) {
  const { jobId, orderId, deleted, client, taskType, date, statusLower, propertyId } = params
  const beforeTask = await loadTaskByOrder(orderId, taskType, client)

  if (deleted || !date) {
    if (beforeTask) {
      const after = await updateTaskById(String(beforeTask.id), { status: 'cancelled' }, client)
      await logCleaningSync({ jobId, orderId, taskId: beforeTask.id, action: 'cancelled', before: beforeTask, after, meta: { deleted, date, taskType }, client })
      return { action: 'cancelled' as const }
    }
    await logCleaningSync({ jobId, orderId, taskId: null, action: 'no_change', before: null, after: null, meta: { deleted, date, taskType }, client })
    return { action: 'no_change' as const }
  }

  const fingerprint = sha256([propertyId || '', date, statusLower, taskType].join('|'))

  if (!beforeTask) {
    const row = {
      id: uuid(),
      order_id: orderId,
      property_id: propertyId,
      task_type: taskType,
      task_date: date,
      type: taskType,
      date,
      status: 'pending',
      assignee_id: null,
      scheduled_at: null,
      checkout_time: taskType === CHECKOUT_TASK_TYPE ? DEFAULT_CHECKOUT_TIME : null,
      checkin_time: taskType === CHECKIN_TASK_TYPE ? DEFAULT_CHECKIN_TIME : null,
      auto_sync_enabled: true,
      sync_fingerprint: fingerprint,
      source: 'auto',
    }
    const after = await insertTask(row, client)
    await logCleaningSync({ jobId, orderId, taskId: after?.id, action: 'created', before: null, after, meta: { fingerprint, taskType }, client })
    return { action: 'created' as const }
  }

  if (beforeTask.auto_sync_enabled === false) {
    await logCleaningSync({ jobId, orderId, taskId: beforeTask.id, action: 'skipped_locked', before: beforeTask, after: beforeTask, meta: { fingerprint, taskType }, client })
    return { action: 'skipped_locked' as const }
  }

  const prevFp = String(beforeTask.sync_fingerprint || '')
  if (prevFp && prevFp === fingerprint) {
    await logCleaningSync({ jobId, orderId, taskId: beforeTask.id, action: 'no_change', before: beforeTask, after: beforeTask, meta: { fingerprint, taskType }, client })
    return { action: 'no_change' as const }
  }

  const propChanged = String(beforeTask.property_id || '') !== String(propertyId || '')
  const patch: any = {
    property_id: propertyId,
    task_type: taskType,
    task_date: date,
    type: taskType,
    date,
    sync_fingerprint: fingerprint,
    source: 'auto',
    auto_sync_enabled: true,
  }
  if (taskType === CHECKOUT_TASK_TYPE && !String(beforeTask.checkout_time || '').trim()) {
    patch.checkout_time = DEFAULT_CHECKOUT_TIME
  }
  if (taskType === CHECKIN_TASK_TYPE && !String(beforeTask.checkin_time || '').trim()) {
    patch.checkin_time = DEFAULT_CHECKIN_TIME
  }
  if (propChanged) {
    patch.assignee_id = null
    patch.scheduled_at = null
  }
  const after = await updateTaskById(String(beforeTask.id), patch, client)
  await logCleaningSync({ jobId, orderId, taskId: beforeTask.id, action: 'updated', before: beforeTask, after, meta: { fingerprint, propChanged, taskType }, client })
  return { action: 'updated' as const }
}

export async function syncOrderToCleaningTasks(orderId: string, opts?: SyncOrderToCleaningTasksOpts) {
  const id = String(orderId || '').trim()
  const client = opts?.client
  const deleted = !!opts?.deleted
  const jobId = opts?.jobId ? String(opts.jobId) : null
  const startedAt = Date.now()
  try {
    await ensureCleaningSchemaV2()
    if (deleted) {
      const r1 = await syncOneTask({ jobId, orderId: id, deleted: true, client, taskType: CHECKOUT_TASK_TYPE, date: null, statusLower: 'deleted', propertyId: null })
      const r2 = await syncOneTask({ jobId, orderId: id, deleted: true, client, taskType: CHECKIN_TASK_TYPE, date: null, statusLower: 'deleted', propertyId: null })
      return { action: (r1.action === 'cancelled' || r2.action === 'cancelled') ? 'cancelled' : 'no_change' as const }
    }

    const order = await loadOrder(id, client)
    if (!order) {
      const r1 = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKOUT_TASK_TYPE, date: null, statusLower: 'missing', propertyId: null })
      const r2 = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKIN_TASK_TYPE, date: null, statusLower: 'missing', propertyId: null })
      return { action: (r1.action === 'cancelled' || r2.action === 'cancelled') ? 'cancelled' : 'no_change' as const }
    }

    const status = String(order.status || '').trim()
    const statusLower = status.toLowerCase()
    const propertyId = order.property_id ? String(order.property_id) : null
    const checkoutDay = normalizeCheckoutDay(order)
    const checkinDay = normalizeCheckinDay(order)
    const valid = isValidStatus(statusLower)

    if (!valid) {
      const r1 = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKOUT_TASK_TYPE, date: null, statusLower, propertyId })
      const r2 = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKIN_TASK_TYPE, date: null, statusLower, propertyId })
      return { action: (r1.action === 'cancelled' || r2.action === 'cancelled') ? 'cancelled' : 'no_change' as const }
    }

    const rCheckout = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKOUT_TASK_TYPE, date: checkoutDay, statusLower, propertyId })
    const rCheckin = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKIN_TASK_TYPE, date: checkinDay, statusLower, propertyId })
    const actions = [rCheckout.action, rCheckin.action]
    if (actions.includes('created')) return { action: 'created' as const }
    if (actions.includes('updated')) return { action: 'updated' as const }
    if (actions.includes('cancelled')) return { action: 'cancelled' as const }
    if (actions.includes('skipped_locked')) return { action: 'skipped_locked' as const }
    return { action: 'no_change' as const }
  } catch (e: any) {
    try {
      await logCleaningSync({
        jobId,
        orderId: String(orderId || ''),
        taskId: null,
        action: 'failed',
        before: null,
        after: null,
        meta: { message: String(e?.message || 'sync_failed'), duration_ms: Date.now() - startedAt },
        client: opts?.client,
      })
    } catch {}
    throw e
  }
}

export async function backfillCleaningTasks(params: { dateFrom: string; dateTo: string; concurrency?: number }) {
  const from = String(params.dateFrom || '').slice(0, 10)
  const to = String(params.dateTo || '').slice(0, 10)
  const concurrency = Math.max(1, Math.min(25, Number(params.concurrency || 10)))
  await ensureCleaningSchemaV2()

  let tasksBefore: number | null = null
  if (hasPg && pgPool) {
    const r0 = await pgPool.query('SELECT COUNT(*)::int AS c FROM cleaning_tasks')
    tasksBefore = Number(r0?.rows?.[0]?.c ?? 0)
  } else {
    tasksBefore = (db.cleaningTasks as any[]).length
  }

  let orderIds: string[] = []
  if (hasPg && pgPool) {
    const dayExprCheckout = `CASE WHEN substring(o.checkout::text,1,10) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN substring(o.checkout::text,1,10)::date END`
    const dayExprCheckin = `CASE WHEN substring(o.checkin::text,1,10) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN substring(o.checkin::text,1,10)::date END`
    const sql = `
      SELECT (o.id::text) AS id
      FROM orders o
      WHERE (
          ((${dayExprCheckout}) IS NOT NULL AND (${dayExprCheckout}) >= ($1::date) AND (${dayExprCheckout}) <= ($2::date))
          OR
          ((${dayExprCheckin}) IS NOT NULL AND (${dayExprCheckin}) >= ($1::date) AND (${dayExprCheckin}) <= ($2::date))
        )
        AND COALESCE(o.status, '') <> ''
        AND lower(COALESCE(o.status, '')) <> 'invalid'
        AND lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'
      ORDER BY COALESCE(${dayExprCheckout}, ${dayExprCheckin}) ASC, o.id
    `
    const r = await pgPool.query(sql, [from, to])
    orderIds = (r?.rows || []).map((x: any) => String(x?.id || '')).filter(Boolean)
  } else {
    const orders = (db.orders as any[]) || []
    orderIds = orders
      .filter((o: any) => {
        const d = normalizeCheckoutDay(o)
        if (!d) return false
        if (d < from || d > to) return false
        return isValidStatus(o?.status)
      })
      .map((o: any) => String(o.id))
      .filter(Boolean)
  }

  const sample: any[] = []
  for (const sid of orderIds.slice(0, 3)) {
    try {
      const o = await loadOrder(sid)
      const statusLower = String(o?.status || '').trim().toLowerCase()
      const ci = normalizeCheckinDay(o)
      const co = normalizeCheckoutDay(o)
      sample.push({
        id: sid,
        status: o?.status ?? null,
        status_lower: statusLower,
        valid: isValidStatus(statusLower),
        nights: o?.nights ?? null,
        checkin_raw: (o as any)?.checkin ?? (o as any)?.checkin_date ?? null,
        checkout_raw: (o as any)?.checkout ?? (o as any)?.checkout_date ?? null,
        checkin_day: ci,
        checkout_day: co,
        has_property_id: !!o?.property_id,
      })
    } catch (e: any) {
      sample.push({ id: sid, error: String(e?.message || 'load_failed') })
    }
  }

  const stats = {
    total: orderIds.length,
    created: 0,
    updated: 0,
    cancelled: 0,
    no_change: 0,
    skipped_locked: 0,
    failed: 0,
  }

  let i = 0
  const workers = Array.from({ length: Math.min(concurrency, orderIds.length || 1) }).map(async () => {
    while (true) {
      const idx = i++
      if (idx >= orderIds.length) return
      const id = orderIds[idx]
      try {
        const r = await syncOrderToCleaningTasks(id)
        const a = String((r as any)?.action || '')
        if (a === 'created') stats.created++
        else if (a === 'updated') stats.updated++
        else if (a === 'cancelled') stats.cancelled++
        else if (a === 'skipped_locked') stats.skipped_locked++
        else stats.no_change++
      } catch {
        stats.failed++
      }
    }
  })
  await Promise.all(workers)

  let tasksAfter: number | null = null
  let tasksInRangeAfter: number | null = null
  if (hasPg && pgPool) {
    const r1 = await pgPool.query('SELECT COUNT(*)::int AS c FROM cleaning_tasks')
    tasksAfter = Number(r1?.rows?.[0]?.c ?? 0)
    const r2 = await pgPool.query(
      `SELECT COUNT(*)::int AS c FROM cleaning_tasks WHERE (COALESCE(task_date, date)::date) >= ($1::date) AND (COALESCE(task_date, date)::date) <= ($2::date)`,
      [from, to]
    )
    tasksInRangeAfter = Number(r2?.rows?.[0]?.c ?? 0)
  } else {
    tasksAfter = (db.cleaningTasks as any[]).length
    tasksInRangeAfter = (db.cleaningTasks as any[]).filter((t: any) => {
      const d = String(t.task_date || t.date || '').slice(0, 10)
      return d >= from && d <= to
    }).length
  }
  return { ...stats, tasks_before: tasksBefore, tasks_after: tasksAfter, tasks_in_range_after: tasksInRangeAfter, sample }
}
