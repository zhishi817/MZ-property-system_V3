import { hasPg, pgPool } from '../dbAdapter'
import { db } from '../store'
import { createHash } from 'crypto'
import { v4 as uuid } from 'uuid'
import { defaultInspectionModeForTaskType } from '../lib/cleaningInspection'
import { buildCleaningTaskVisibilityHints, emitWorkTaskEvent } from './workTaskEvents'

export type CleaningSyncAction =
  | 'created'
  | 'updated'
  | 'cancelled'
  | 'superseded'
  | 'no_change'
  | 'skipped_locked'
  | 'failed'

export type SyncOrderToCleaningTasksOpts = { deleted?: boolean; client?: any; jobId?: string }

const CHECKOUT_TASK_TYPE = 'checkout_clean'
const CHECKIN_TASK_TYPE = 'checkin_clean'
const ACTIVE_EXECUTION_STATE = 'active'
const SUPERSEDED_EXECUTION_STATE = 'superseded'
const CANCELLED_EXECUTION_STATE = 'cancelled'
const TEMPORARY_ORDER_PLACEHOLDER_PURPOSE = 'temporary_order_placeholder'

const NON_SUPERSEDABLE_MANUAL_STATUSES = new Set([
  'in_progress',
  'completed',
  'checked',
  'cleaned',
  'restocked',
  'restock_pending',
  'inspected',
  'keys_hung',
  'done',
  'ready',
  'to_inspect',
  'to_hang_keys',
])

const DEFAULT_CHECKOUT_TIME = '10am'
const DEFAULT_CHECKIN_TIME = '3pm'

let schemaEnsured: Promise<void> | null = null
let schemaBootstrapped: Promise<void> | null = null

export function activeCleaningTaskWhereSql(alias = 't'): string {
  const a = alias ? `${alias}.` : ''
  return `COALESCE(${a}execution_state, CASE WHEN lower(COALESCE(${a}status, '')) IN ('cancelled','canceled') THEN 'cancelled' ELSE 'active' END) = 'active'`
}

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
    const rc = await pgPool.query(
      `SELECT
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_sync_logs' AND column_name='job_id') AS has_logs_job_id,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='cleaner_id') AS has_tasks_cleaner_id,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='inspector_id') AS has_tasks_inspector_id,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='keys_required') AS has_tasks_keys_required,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='inspection_mode') AS has_tasks_inspection_mode,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='inspection_due_date') AS has_tasks_inspection_due_date,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='keys_required') AS has_orders_keys_required,
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uniq_cleaning_tasks_order_task_type_v3') AS has_tasks_uq_v3`
    )
    const row = rc?.rows?.[0] || {}
    if (!row?.has_logs_job_id) {
      const err: any = new Error('cleaning_sync_logs_missing_job_id')
      err.code = 'CLEANING_SCHEMA_MISSING'
      throw err
    }
    if (!row?.has_tasks_cleaner_id || !row?.has_tasks_inspector_id) {
      const err: any = new Error('cleaning_tasks_missing_cleaner_fields')
      err.code = 'CLEANING_SCHEMA_MISSING'
      throw err
    }
    if (!row?.has_tasks_keys_required || !row?.has_tasks_inspection_mode || !row?.has_tasks_inspection_due_date) {
      const err: any = new Error('cleaning_tasks_missing_sync_columns')
      err.code = 'CLEANING_SCHEMA_MISSING'
      throw err
    }
    if (!row?.has_orders_keys_required) {
      const err: any = new Error('orders_missing_keys_required')
      err.code = 'CLEANING_SCHEMA_MISSING'
      throw err
    }
    if (!row?.has_tasks_uq_v3) {
      const err: any = new Error('cleaning_tasks_missing_unique_constraint_v3')
      err.code = 'CLEANING_SCHEMA_MISSING'
      throw err
    }
    await ensureCleaningExecutionStateColumns()
  })().catch((e) => {
    schemaEnsured = null
    throw e
  })
  return schemaEnsured
}

async function ensureCleaningExecutionStateColumns(execArg?: any): Promise<void> {
  if (!hasPg || !pgPool) return
  const exec = execArg || pgPool
  await exec.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS execution_state text;`)
  await exec.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS manual_task_purpose text;`)
  await exec.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS superseded_by text;`)
  await exec.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS superseded_reason text;`)
  await exec.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS superseded_at timestamptz;`)
  await exec.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS supersede_conflicts jsonb NOT NULL DEFAULT '[]'::jsonb;`)
  await exec.query(
    `UPDATE cleaning_tasks
        SET execution_state = CASE
          WHEN lower(COALESCE(status, '')) IN ('cancelled','canceled') THEN 'cancelled'
          ELSE 'active'
        END
      WHERE execution_state IS NULL
         OR execution_state NOT IN ('active','superseded','cancelled')`,
  )
  await exec.query(`ALTER TABLE cleaning_tasks ALTER COLUMN execution_state SET DEFAULT 'active';`)
  await exec.query(`ALTER TABLE cleaning_tasks ALTER COLUMN execution_state SET NOT NULL;`)
  await exec.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_execution_state ON cleaning_tasks(execution_state);`)
  await exec.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_active_lookup ON cleaning_tasks(property_id, task_date, task_type) WHERE execution_state = 'active';`)
}

export async function bootstrapCleaningSyncSchemaV2(): Promise<void> {
  if (!hasPg || !pgPool) return
  if (schemaBootstrapped) return schemaBootstrapped
  schemaBootstrapped = (async () => {
    await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspection_mode text;`)
    await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspection_due_date date;`)
    await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS guest_special_request text;`)
    await pgPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    await ensureCleaningExecutionStateColumns()
    schemaEnsured = null
    await ensureCleaningSchemaV2()
  })().catch((e) => {
    schemaBootstrapped = null
    throw e
  })
  return schemaBootstrapped
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
    let keysRequired = row?.keys_required == null ? null : Number(row.keys_required)
    if (!Number.isFinite(keysRequired as any) || !(keysRequired as any)) keysRequired = null
    if (!keysRequired) keysRequired = 1
    const sql = `
      INSERT INTO cleaning_tasks(
        id, order_id, property_id,
        task_type, task_date,
        type, date,
        status, assignee_id, scheduled_at,
        checkout_time, checkin_time,
        cleaner_id, inspector_id,
        keys_required, inspection_mode, inspection_due_date,
        auto_sync_enabled, sync_fingerprint, source,
        execution_state, manual_task_purpose,
        updated_at
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,now())
      ON CONFLICT ON CONSTRAINT uniq_cleaning_tasks_order_task_type_v3
      DO UPDATE SET
        property_id = EXCLUDED.property_id,
        task_date = EXCLUDED.task_date,
        date = EXCLUDED.date,
        execution_state = EXCLUDED.execution_state,
        inspection_mode = COALESCE(cleaning_tasks.inspection_mode, EXCLUDED.inspection_mode),
        inspection_due_date = CASE
          WHEN cleaning_tasks.inspection_mode = 'deferred' AND cleaning_tasks.inspection_due_date IS NOT NULL THEN cleaning_tasks.inspection_due_date
          ELSE EXCLUDED.inspection_due_date
        END,
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
      keysRequired,
      row.inspection_mode ? String(row.inspection_mode) : null,
      row.inspection_due_date ? String(row.inspection_due_date).slice(0, 10) : null,
      row.auto_sync_enabled !== false,
      row.sync_fingerprint ? String(row.sync_fingerprint) : null,
      row.source ? String(row.source) : 'auto',
      row.execution_state ? String(row.execution_state) : ACTIVE_EXECUTION_STATE,
      row.manual_task_purpose ? String(row.manual_task_purpose) : null,
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

function hasValue(v: any): boolean {
  return String(v ?? '').trim() !== ''
}

function nonBlank(v: any): string | null {
  const s = String(v ?? '').trim()
  return s ? s : null
}

function normalizeExecutionState(row: any): string {
  const explicit = String(row?.execution_state || '').trim().toLowerCase()
  if (explicit === ACTIVE_EXECUTION_STATE || explicit === SUPERSEDED_EXECUTION_STATE || explicit === CANCELLED_EXECUTION_STATE) return explicit
  const status = String(row?.status || '').trim().toLowerCase()
  if (status === 'cancelled' || status === 'canceled') return CANCELLED_EXECUTION_STATE
  return ACTIVE_EXECUTION_STATE
}

function canSupersedeManualTaskByFields(row: any): boolean {
  if (hasValue(row?.order_id)) return false
  const taskType = String(row?.task_type || row?.type || '').trim().toLowerCase()
  if (taskType !== CHECKIN_TASK_TYPE && taskType !== CHECKOUT_TASK_TYPE) return false
  const purpose = String(row?.manual_task_purpose || '').trim().toLowerCase()
  if (purpose && purpose !== TEMPORARY_ORDER_PLACEHOLDER_PURPOSE) return false
  if (normalizeExecutionState(row) !== ACTIVE_EXECUTION_STATE) return false
  const status = String(row?.status || '').trim().toLowerCase()
  if (NON_SUPERSEDABLE_MANUAL_STATUSES.has(status)) return false
  return true
}

async function queryHasAnyRows(exec: any, sql: string, params: any[]): Promise<boolean> {
  try {
    const r = await exec.query(sql, params)
    return !!r?.rows?.length
  } catch (e: any) {
    if (String(e?.code || '') === '42P01' || String(e?.code || '') === '42703') return false
    throw e
  }
}

async function hasManualTaskExecutionRecords(task: any, exec: any): Promise<boolean> {
  if (!task) return false
  const executedFields = [
    'started_at',
    'finished_at',
    'key_photo_uploaded_at',
    'lockbox_video_uploaded_at',
  ]
  if (executedFields.some((field) => hasValue(task?.[field]))) return true
  if (task?.cleaned === true || task?.restocked === true || task?.inspected === true) return true
  const taskId = String(task.id || '').trim()
  if (!taskId) return false
  if (await queryHasAnyRows(exec, `SELECT 1 FROM cleaning_task_media WHERE task_id::text = $1 LIMIT 1`, [taskId])) return true
  if (await queryHasAnyRows(exec, `SELECT 1 FROM cleaning_consumable_usages WHERE task_id::text = $1 LIMIT 1`, [taskId])) return true
  if (await queryHasAnyRows(exec, `SELECT 1 FROM cleaning_issues WHERE task_id::text = $1 LIMIT 1`, [taskId])) return true
  return false
}

async function canSupersedeManualTask(task: any, exec: any): Promise<boolean> {
  if (!canSupersedeManualTaskByFields(task)) return false
  return !(await hasManualTaskExecutionRecords(task, exec))
}

async function supersedeTemporaryManualTasksForOrder(params: {
  jobId?: string | null
  orderId: string
  propertyId: string | null
  taskDate: string | null
  taskType: string
  client?: any
}): Promise<number> {
  const { jobId, orderId, propertyId, taskDate, taskType, client } = params
  const normalizedTaskType = String(taskType || '').trim()
  if (!propertyId || !taskDate || ![CHECKIN_TASK_TYPE, CHECKOUT_TASK_TYPE].includes(normalizedTaskType)) return 0

  if (hasPg && (client || pgPool)) {
    await ensureCleaningSchemaV2()
    const exec = client || pgPool!
    const officialRes = await exec.query(
      `SELECT *
       FROM cleaning_tasks
       WHERE (order_id::text) = $1
         AND (task_type::text) = $2
         AND ${activeCleaningTaskWhereSql('cleaning_tasks')}
       LIMIT 1`,
      [String(orderId), normalizedTaskType],
    )
    const official = officialRes?.rows?.[0] || null
    if (!official) return 0

    const manualRes = await exec.query(
      `SELECT t.*
       FROM cleaning_tasks t
       LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
       LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
       WHERE t.order_id IS NULL
         AND (t.task_type::text) = $1
         AND lower(COALESCE(t.source, 'manual')) IN ('manual', '')
         AND (COALESCE(t.task_date, t.date)::date) = ($2::date)
         AND COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) = $3
         AND ${activeCleaningTaskWhereSql('t')}
         AND COALESCE(NULLIF(lower(trim(t.manual_task_purpose)), ''), $4) = $4
         AND lower(COALESCE(t.status, '')) <> ALL($5::text[])
       ORDER BY t.updated_at DESC NULLS LAST, t.id DESC`,
      [normalizedTaskType, taskDate, String(propertyId), TEMPORARY_ORDER_PLACEHOLDER_PURPOSE, Array.from(NON_SUPERSEDABLE_MANUAL_STATUSES)],
    )
    const manualRows = manualRes?.rows || []
    if (!manualRows.length) return 0

    let superseded = 0
    for (const manual of manualRows) {
      if (!(await canSupersedeManualTask(manual, exec))) continue
      const patch = {
        execution_state: SUPERSEDED_EXECUTION_STATE,
        auto_sync_enabled: false,
        superseded_by: String(official.id || ''),
        superseded_reason: 'auto_order_task_created',
        superseded_at: new Date().toISOString(),
        supersede_conflicts: JSON.stringify([]),
      }
      const after = await updateTaskById(String(manual.id), patch, exec)
      await logCleaningSync({
        jobId,
        orderId,
        taskId: manual.id,
        action: 'superseded',
        before: manual,
        after,
        meta: { reason: 'auto_order_task_created', replacement_task_id: String(official.id || ''), task_type: normalizedTaskType },
        client: exec,
      })
      try {
        const changedFields = ['execution_state', 'auto_sync_enabled', 'superseded_by', 'superseded_reason', 'superseded_at', 'supersede_conflicts']
        await emitWorkTaskEvent({
          taskId: `cleaning_task:${String(manual.id)}`,
          sourceType: 'cleaning_tasks',
          sourceRefIds: [String(manual.id)],
          eventType: 'TASK_REMOVED',
          changeScope: 'membership',
          changedFields,
          patch: Object.fromEntries(changedFields.map((field) => [field, (after as any)?.[field] ?? (patch as any)[field]])),
          causedByUserId: null,
          visibilityHints: buildCleaningTaskVisibilityHints(after || manual),
        }, exec)
      } catch {}
      superseded++
    }
    return superseded
  }

  const tasks = db.cleaningTasks as any[]
  const official = tasks.find((task: any) =>
    String(task.order_id || '') === String(orderId) &&
    String(task.task_type || task.type || '') === normalizedTaskType &&
    normalizeExecutionState(task) === ACTIVE_EXECUTION_STATE
  )
  if (!official) return 0
  const manualRows = tasks.filter((task: any) =>
    String(task.property_id || '') === String(propertyId) &&
    String(task.task_date || task.date || '').slice(0, 10) === taskDate &&
    canSupersedeManualTaskByFields(task)
  )
  if (!manualRows.length) return 0
  for (const manual of manualRows) {
    manual.execution_state = SUPERSEDED_EXECUTION_STATE
    manual.auto_sync_enabled = false
    manual.superseded_by = String(official.id || '')
    manual.superseded_reason = 'auto_order_task_created'
    manual.superseded_at = new Date().toISOString()
    manual.supersede_conflicts = []
  }
  return manualRows.length
}

export async function syncCheckoutOldCodeFromCheckinNewCode(params: {
  jobId?: string | null
  orderId: string
  client?: any
}): Promise<{ action: 'updated' | 'no_change' | 'skipped_locked' }> {
  const { jobId, orderId, client } = params
  const checkinTask = await loadTaskByOrder(orderId, CHECKIN_TASK_TYPE, client)
  const checkoutTask = await loadTaskByOrder(orderId, CHECKOUT_TASK_TYPE, client)
  const nextOldCode = nonBlank(checkinTask?.new_code)
  if (!checkinTask || !checkoutTask || !nextOldCode) return { action: 'no_change' }
  if (checkoutTask.auto_sync_enabled === false) {
    await logCleaningSync({
      jobId,
      orderId,
      taskId: checkoutTask.id,
      action: 'skipped_locked',
      before: checkoutTask,
      after: checkoutTask,
      meta: { reason: 'checkout_old_code_from_checkin_new_code', source_task_id: String(checkinTask.id || '') },
      client,
    })
    return { action: 'skipped_locked' }
  }
  if (String(checkoutTask.old_code ?? '').trim() === nextOldCode) return { action: 'no_change' }

  const after = await updateTaskById(String(checkoutTask.id), { old_code: nextOldCode }, client)
  await logCleaningSync({
    jobId,
    orderId,
    taskId: checkoutTask.id,
    action: 'updated',
    before: checkoutTask,
    after,
    meta: { reason: 'checkout_old_code_from_checkin_new_code', source_task_id: String(checkinTask.id || '') },
    client,
  })
  try {
    await emitWorkTaskEvent({
      taskId: `cleaning_task:${String(checkoutTask.id)}`,
      sourceType: 'cleaning_tasks',
      sourceRefIds: [String(checkoutTask.id)],
      eventType: 'TASK_UPDATED',
      changeScope: 'detail',
      changedFields: ['old_code'],
      patch: { old_code: nextOldCode },
      causedByUserId: null,
      visibilityHints: buildCleaningTaskVisibilityHints(after || checkoutTask),
    }, client)
  } catch {}
  return { action: 'updated' }
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
  derivedCode?: string | null
  keysRequired: 1 | 2
}) {
  const { jobId, orderId, deleted, client, taskType, date, statusLower, propertyId, derivedCode, keysRequired } = params
  const beforeTask = await loadTaskByOrder(orderId, taskType, client)

  if (deleted || !date) {
    if (beforeTask) {
      const after = await updateTaskById(String(beforeTask.id), { status: 'cancelled', execution_state: CANCELLED_EXECUTION_STATE }, client)
      await logCleaningSync({ jobId, orderId, taskId: beforeTask.id, action: 'cancelled', before: beforeTask, after, meta: { deleted, date, taskType }, client })
      return { action: 'cancelled' as const }
    }
    await logCleaningSync({ jobId, orderId, taskId: null, action: 'no_change', before: null, after: null, meta: { deleted, date, taskType }, client })
    return { action: 'no_change' as const }
  }

  const fingerprint = sha256([propertyId || '', date, statusLower, taskType, derivedCode || '', String(keysRequired)].join('|'))

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
      old_code: taskType === CHECKOUT_TASK_TYPE ? (derivedCode || null) : null,
      new_code: taskType === CHECKIN_TASK_TYPE ? (derivedCode || null) : null,
      keys_required: keysRequired,
      inspection_mode: defaultInspectionModeForTaskType(taskType),
      inspection_due_date: null,
      auto_sync_enabled: true,
      sync_fingerprint: fingerprint,
      source: 'auto',
      execution_state: ACTIVE_EXECUTION_STATE,
      manual_task_purpose: null,
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
    execution_state: ACTIVE_EXECUTION_STATE,
    keys_required: keysRequired,
    inspection_mode: beforeTask.inspection_mode ?? defaultInspectionModeForTaskType(taskType),
    inspection_due_date: beforeTask.inspection_due_date ?? null,
  }
  if (['cancelled', 'canceled'].includes(String(beforeTask.status || '').trim().toLowerCase())) {
    patch.status = 'pending'
  }
  if (derivedCode) {
    if (taskType === CHECKOUT_TASK_TYPE) patch.old_code = derivedCode
    if (taskType === CHECKIN_TASK_TYPE) patch.new_code = derivedCode
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
    const keysRequiredFallback: 1 | 2 = 1
    if (deleted) {
      const r1 = await syncOneTask({ jobId, orderId: id, deleted: true, client, taskType: CHECKOUT_TASK_TYPE, date: null, statusLower: 'deleted', propertyId: null, derivedCode: null, keysRequired: keysRequiredFallback })
      const r2 = await syncOneTask({ jobId, orderId: id, deleted: true, client, taskType: CHECKIN_TASK_TYPE, date: null, statusLower: 'deleted', propertyId: null, derivedCode: null, keysRequired: keysRequiredFallback })
      return { action: (r1.action === 'cancelled' || r2.action === 'cancelled') ? 'cancelled' : 'no_change' as const }
    }

    const order = await loadOrder(id, client)
    if (!order) {
      const r1 = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKOUT_TASK_TYPE, date: null, statusLower: 'missing', propertyId: null, derivedCode: null, keysRequired: keysRequiredFallback })
      const r2 = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKIN_TASK_TYPE, date: null, statusLower: 'missing', propertyId: null, derivedCode: null, keysRequired: keysRequiredFallback })
      return { action: (r1.action === 'cancelled' || r2.action === 'cancelled') ? 'cancelled' : 'no_change' as const }
    }

    const keysRequired0 = order?.keys_required == null ? 1 : Number(order.keys_required)
    const keysRequired = (Number.isFinite(keysRequired0) && keysRequired0 >= 2 ? 2 : 1) as 1 | 2

    const digits = String(order.guest_phone || '').replace(/\D/g, '')
    const derivedCode = digits.length >= 4 ? digits.slice(-4) : null

    const status = String(order.status || '').trim()
    const statusLower = status.toLowerCase()
    const propertyId = order.property_id ? String(order.property_id) : null
    const checkoutDay = normalizeCheckoutDay(order)
    const checkinDay = normalizeCheckinDay(order)
    const valid = isValidStatus(statusLower)

    if (!valid) {
      const r1 = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKOUT_TASK_TYPE, date: null, statusLower, propertyId, derivedCode: null, keysRequired })
      const r2 = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKIN_TASK_TYPE, date: null, statusLower, propertyId, derivedCode: null, keysRequired })
      return { action: (r1.action === 'cancelled' || r2.action === 'cancelled') ? 'cancelled' : 'no_change' as const }
    }

    const rCheckout = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKOUT_TASK_TYPE, date: checkoutDay, statusLower, propertyId, derivedCode, keysRequired })
    const rCheckin = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKIN_TASK_TYPE, date: checkinDay, statusLower, propertyId, derivedCode, keysRequired })
    const supersededCheckout = await supersedeTemporaryManualTasksForOrder({ jobId, orderId: id, propertyId, taskDate: checkoutDay, taskType: CHECKOUT_TASK_TYPE, client })
    const supersededCheckin = await supersedeTemporaryManualTasksForOrder({ jobId, orderId: id, propertyId, taskDate: checkinDay, taskType: CHECKIN_TASK_TYPE, client })
    const rPassword = await syncCheckoutOldCodeFromCheckinNewCode({ jobId, orderId: id, client })
    const actions = [rCheckout.action, rCheckin.action, rPassword.action]
    if (actions.includes('created')) return { action: 'created' as const }
    if (actions.includes('updated') || supersededCheckout > 0 || supersededCheckin > 0) return { action: 'updated' as const }
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
