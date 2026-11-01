import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'
import { db } from '../store'
import { createHash } from 'crypto'
import { v4 as uuid } from 'uuid'
import { defaultInspectionModeForTaskType } from '../lib/cleaningInspection'
import { buildCleaningTaskVisibilityHints, buildMz031CleaningArrangementRevision, emitWorkTaskEvent } from './workTaskEvents'
import { emitDeferredInspectionCheckinConflictAlerts, reconcileDeferredInspectionCheckinReplacement } from './deferredInspectionCheckinConflict'
import { redactPasswordAuditValues } from '../lib/passwordAudit'
import { assertPasswordAuthoritySchemaReady } from '../lib/passwordAuthoritySchema'

export type CleaningSyncAction =
  | 'created'
  | 'updated'
  | 'cancelled'
  | 'superseded'
  | 'no_change'
  | 'skipped_locked'
  | 'skipped_protected'
  | 'failed'

type CleaningSyncLogAction = CleaningSyncAction | 'scope_normalized'

export type CleaningSyncScope = 'full' | 'checkin_only'

export type SyncOrderToCleaningTasksOpts = {
  deleted?: boolean
  client?: any
  jobId?: string
  scope?: CleaningSyncScope
}

const CHECKOUT_TASK_TYPE = 'checkout_clean'
const CHECKIN_TASK_TYPE = 'checkin_clean'
const ACTIVE_EXECUTION_STATE = 'active'
const SUPERSEDED_EXECUTION_STATE = 'superseded'
const CANCELLED_EXECUTION_STATE = 'cancelled'
const TEMPORARY_ORDER_PLACEHOLDER_PURPOSE = 'temporary_order_placeholder'

const PASSWORD_TERMINAL_STATUSES = new Set([
  'completed',
  'checked',
  'cleaned',
  'restock_pending',
  'restocked',
  'inspected',
  'keys_hung',
  'done',
  'ready',
  'closed',
  'pending_review',
  'replaced',
  'superseded',
  'deleted',
  'cancelled',
  'canceled',
])

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

const GUEST_READY_CHECKIN_IDENTITY_FIELDS = [
  'checkin_time',
  'order_id',
  'task_type',
  'type',
  'status',
  'execution_state',
  'task_date',
  'date',
  'property_id',
] as const

function comparableTaskField(value: any) {
  if (value instanceof Date) return value.toISOString()
  return value == null ? null : String(value)
}

function cleaningTaskKind(row: any) {
  return String(row?.task_type ?? row?.type ?? '').trim().toLowerCase()
}

export function guestReadyCheckinIdentityChangedFields(before: any, after: any) {
  if (cleaningTaskKind(before) !== CHECKIN_TASK_TYPE && cleaningTaskKind(after) !== CHECKIN_TASK_TYPE) return []
  return GUEST_READY_CHECKIN_IDENTITY_FIELDS.filter((field) => (
    comparableTaskField(before?.[field]) !== comparableTaskField(after?.[field])
  ))
}

async function emitGuestReadyCheckinAuthorityEvent(params: {
  before: any
  after: any
  eventType: 'TASK_CREATED' | 'TASK_UPDATED' | 'TASK_REMOVED'
  client?: any
}) {
  const changedIdentityFields = guestReadyCheckinIdentityChangedFields(params.before, params.after)
  if (!changedIdentityFields.length) return
  const task = params.after || params.before
  const taskId = String(task?.id || '').trim()
  if (!taskId) return
  await emitWorkTaskEvent({
    taskId: `cleaning_task:${taskId}`,
    sourceType: 'cleaning_tasks',
    sourceRefIds: [taskId],
    eventType: params.eventType,
    changeScope: params.eventType === 'TASK_UPDATED' ? 'list' : 'membership',
    changedFields: Array.from(new Set([
      ...changedIdentityFields,
      'order_id_checkin',
      'guest_ready_notification',
      'guest_ready_outside_key',
      'available_actions',
    ])),
    // These projections are current-role-specific. The event is only an
    // invalidation signal; every recipient must refetch its own projection.
    patch: {},
    causedByUserId: null,
    visibilityHints: buildCleaningTaskVisibilityHints(task),
  }, params.client)
}

export function activeCleaningTaskWhereSql(alias = 't'): string {
  const a = alias ? `${alias}.` : ''
  return `(COALESCE(${a}execution_state, CASE WHEN lower(COALESCE(${a}status, '')) IN ('cancelled','canceled') THEN 'cancelled' ELSE 'active' END) = 'active'
    AND lower(COALESCE(${a}status, '')) NOT IN ('cancelled','canceled'))`
}

export function isCancelledCleaningTaskStatus(status: any): boolean {
  const s = String(status || '').trim().toLowerCase()
  return s === 'cancelled' || s === 'canceled'
}

export function isInactiveCleaningOrderStatus(status: any): boolean {
  const s = String(status || '').trim().toLowerCase()
  return !s || s === 'invalid' || s.includes('cancel')
}

export function validCleaningTaskOrderWhereSql(taskAlias = 't', orderAlias = 'o'): string {
  const t = taskAlias ? `${taskAlias}.` : ''
  const o = orderAlias ? `${orderAlias}.` : ''
  return `(${t}order_id IS NULL OR (
    ${o}id IS NOT NULL
    AND COALESCE(${o}status, '') <> ''
    AND lower(COALESCE(${o}status, '')) <> 'invalid'
    AND lower(COALESCE(${o}status, '')) NOT LIKE '%cancel%'
  ))`
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
  // Compatibility shim for legacy callers outside R5-2A (notably Task Center).
  // R5-2A HTTP paths use requireR5TaskRuntimeSchema after authorization, and
  // workers warm the marker before work. Do not let this shared legacy name
  // silently broaden the R5 marker failure boundary into deferred modules.
}

export async function bootstrapCleaningSyncSchemaV2(): Promise<void> {
  await ensureCleaningSchemaV2()
}

export async function lockCleaningTurnoverKey(client: any, propertyId: any, taskDate: any): Promise<void> {
  const propertyKey = String(propertyId || '').trim()
  const dateKey = dayOnly(taskDate)
  if (!client || !propertyKey || !dateKey) return
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    [`cleaning-turnover:${propertyKey}`, dateKey],
  )
}

export async function lockCleaningPasswordChainKey(client: any, propertyId: any): Promise<void> {
  let propertyKey = String(propertyId || '').trim()
  if (!client || !propertyKey) return
  if (hasPg) {
    const normalized = await client.query(
      `SELECT COALESCE(p_id.id::text, p_code.id::text, $1::text) AS property_id
       FROM (SELECT 1) seed
       LEFT JOIN properties p_id ON p_id.id::text = $1::text
       LEFT JOIN properties p_code ON upper(p_code.code) = upper($1::text)
       LIMIT 1`,
      [propertyKey],
    )
    propertyKey = String(normalized?.rows?.[0]?.property_id || propertyKey).trim()
  }
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    ['cleaning-password-authority', propertyKey],
  )
}

export async function normalizeCleaningPasswordChainKeys(client: any, propertyIds: any[]): Promise<string[]> {
  const rawKeys = Array.from(new Set((propertyIds || []).map((value) => String(value || '').trim()).filter(Boolean)))
  if (!client || !rawKeys.length || !hasPg) return rawKeys.sort()
  const normalized = await client.query(
    `SELECT COALESCE(p_id.id::text, p_code.id::text, raw.property_id) AS property_id
     FROM unnest($1::text[]) AS raw(property_id)
     LEFT JOIN properties p_id ON p_id.id::text = raw.property_id
     LEFT JOIN properties p_code ON upper(p_code.code) = upper(raw.property_id)`,
    [rawKeys],
  )
  return Array.from(new Set<string>((normalized?.rows || [])
    .map((row: any) => String(row?.property_id || '').trim())
    .filter(Boolean))).sort()
}

export async function lockCleaningOrderIdentityKey(client: any, orderId: any): Promise<void> {
  const orderKey = String(orderId || '').trim()
  if (!client || !orderKey) return
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    ['order-turnover-identity', orderKey],
  )
}

export async function logCleaningSync(params: {
  jobId?: string | null
  orderId: string
  taskId?: string | null
  action: CleaningSyncLogAction
  before?: any
  after?: any
  meta?: any
  client?: any
}) {
  if (!hasPg || !pgPool) return
  await ensureCleaningSchemaV2()
  const exec = params.client || pgPool
  const safeBefore = redactPasswordAuditValues(params.before).value
  const safeAfter = redactPasswordAuditValues(params.after).value
  const safeMeta = redactPasswordAuditValues(params.meta).value
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
        params.before != null ? safeBefore : null,
        params.after != null ? safeAfter : null,
        params.meta != null ? safeMeta : null,
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
      params.before != null ? safeBefore : null,
      params.after != null ? safeAfter : null,
      params.meta != null ? safeMeta : null,
    ]
  )
}

async function loadOrder(orderId: string, client?: any, opts?: { forShare?: boolean }): Promise<any | null> {
  if (hasPg && (client || pgPool)) {
    const exec = client || pgPool!
    const r = await exec.query(`SELECT * FROM orders WHERE (id::text) = $1 LIMIT 1 ${opts?.forShare ? 'FOR SHARE' : ''}`, [String(orderId)])
    return r?.rows?.[0] || null
  }
  return db.orders.find((o: any) => String(o.id) === String(orderId)) || null
}

async function loadTaskByOrder(
  orderId: string,
  taskType: string,
  client?: any,
  opts?: { forUpdate?: boolean; activeOnly?: boolean; passwordMutable?: boolean },
): Promise<any | null> {
  if (hasPg && (client || pgPool)) {
    await ensureCleaningSchemaV2()
    const exec = client || pgPool!
    const r = await exec.query(
      `SELECT *
       FROM cleaning_tasks
       WHERE order_id::text = $1
         AND lower(COALESCE(task_type, type, '')) = $2
         ${(opts?.activeOnly || opts?.passwordMutable) ? `AND ${activeCleaningTaskWhereSql('')}` : ''}
         ${opts?.passwordMutable ? `
         AND lower(COALESCE(status, '')) NOT IN (${Array.from(PASSWORD_TERMINAL_STATUSES).map((status) => `'${status}'`).join(',')})` : ''}
       ORDER BY
         CASE
           WHEN COALESCE(execution_state, 'active') = 'active'
            AND lower(COALESCE(status, '')) NOT IN ('cancelled', 'canceled')
           THEN 0
           ELSE 1
         END,
         updated_at DESC NULLS LAST
       LIMIT 1
       ${opts?.forUpdate ? 'FOR UPDATE' : ''}`,
      [String(orderId), String(taskType).toLowerCase()]
    )
    return r?.rows?.[0] || null
  }
  return (
    (db.cleaningTasks as any[]).find((t: any) => (
      String(t.order_id) === String(orderId)
      && String((t.task_type ?? t.type) || '') === String(taskType)
      && (!(opts?.activeOnly || opts?.passwordMutable) || normalizeExecutionState(t) === ACTIVE_EXECUTION_STATE)
      && (!opts?.passwordMutable || (
        normalizeExecutionState(t) === ACTIVE_EXECUTION_STATE
        && !PASSWORD_TERMINAL_STATUSES.has(String(t.status || '').trim().toLowerCase())
      ))
    )) || null
  )
}

async function loadOrderTaskPropertyIds(orderId: string, client?: any): Promise<string[]> {
  if (hasPg && (client || pgPool)) {
    const exec = client || pgPool!
    const result = await exec.query(
      `SELECT DISTINCT property_id::text AS property_id
       FROM cleaning_tasks
       WHERE order_id::text = $1::text
         AND lower(COALESCE(task_type, type, '')) IN ($2, $3)`,
      [String(orderId), CHECKOUT_TASK_TYPE, CHECKIN_TASK_TYPE],
    )
    return (result?.rows || []).map((row: any) => String(row?.property_id || '').trim()).filter(Boolean)
  }
  return (db.cleaningTasks as any[])
    .filter((task: any) => String(task?.order_id || '') === String(orderId)
      && [CHECKOUT_TASK_TYPE, CHECKIN_TASK_TYPE].includes(cleaningTaskKind(task)))
    .map((task: any) => String(task?.property_id || '').trim())
    .filter(Boolean)
}

async function lockOrderPasswordChainTopology(client: any, orderId: string, nextPropertyId?: any): Promise<void> {
  if (!client) return
  const observed = await loadOrderTaskPropertyIds(orderId, client)
  const lockedKeys = await normalizeCleaningPasswordChainKeys(client, [...observed, nextPropertyId])
  for (const propertyId of lockedKeys) await lockCleaningPasswordChainKey(client, propertyId)
  const verifiedKeys = await normalizeCleaningPasswordChainKeys(client, [
    ...(await loadOrderTaskPropertyIds(orderId, client)),
    nextPropertyId,
  ])
  if (verifiedKeys.some((propertyId) => !lockedKeys.includes(propertyId))) {
    const error: any = new Error('password_chain_topology_changed_retry')
    error.status = 409
    throw error
  }
}

async function insertTask(row: any, client?: any, opts?: { preserveExisting?: boolean }): Promise<any | null> {
  if (hasPg && (client || pgPool)) {
    await ensureCleaningSchemaV2()
    const exec = client || pgPool!
    let keysRequired = row?.keys_required == null ? null : Number(row.keys_required)
    if (!Number.isFinite(keysRequired as any) || !(keysRequired as any)) keysRequired = null
    if (!keysRequired) keysRequired = 1
    const conflictSql = opts?.preserveExisting
      ? `ON CONFLICT ON CONSTRAINT uniq_cleaning_tasks_order_task_type_v3 DO NOTHING`
      : `ON CONFLICT ON CONSTRAINT uniq_cleaning_tasks_order_task_type_v3
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
        updated_at = now()`
    const sql = `
      INSERT INTO cleaning_tasks(
        id, order_id, property_id,
        task_type, task_date,
        type, date,
        status, assignee_id, scheduled_at,
        checkout_time, checkin_time,
        cleaner_id, inspector_id,
        keys_required, inspection_mode, inspection_due_date,
        old_code_authority_status, new_code_authority_status,
        old_code_source_task_id, old_code_source_order_id, old_code_source_field,
        old_code_authority_updated_at, new_code_authority_updated_at,
        auto_sync_enabled, sync_fingerprint, source,
        execution_state, manual_task_purpose,
        updated_at
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,now())
      ${conflictSql}
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
      row.old_code_authority_status ? String(row.old_code_authority_status) : 'needs_review',
      row.new_code_authority_status ? String(row.new_code_authority_status) : 'needs_review',
      row.old_code_source_task_id ? String(row.old_code_source_task_id) : null,
      row.old_code_source_order_id ? String(row.old_code_source_order_id) : null,
      row.old_code_source_field ? String(row.old_code_source_field) : null,
      row.old_code_authority_updated_at || null,
      row.new_code_authority_updated_at || null,
      row.auto_sync_enabled !== false,
      row.sync_fingerprint ? String(row.sync_fingerprint) : null,
      row.source ? String(row.source) : 'auto',
      row.execution_state ? String(row.execution_state) : ACTIVE_EXECUTION_STATE,
      row.manual_task_purpose ? String(row.manual_task_purpose) : null,
    ]
    const r = await exec.query(sql, params)
    return r?.rows?.[0] || null
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

export async function normalizeSameDayTurnoverInspectionScope(params: {
  propertyId: string | null
  taskDates: Array<string | null | undefined>
  jobId?: string | null
  client?: any
}): Promise<number> {
  const propertyId = String(params.propertyId || '').trim()
  const taskDates = Array.from(new Set(params.taskDates.map((value) => dayOnly(value)).filter((value): value is string => !!value))).sort()
  if (!propertyId || !taskDates.length) return 0

  if (hasPg && (params.client || pgPool)) {
    const exec = params.client || pgPool!
    for (const taskDate of taskDates) await lockCleaningTurnoverKey(exec, propertyId, taskDate)
    const result = await exec.query(
      `SELECT *
       FROM cleaning_tasks AS task
       WHERE task.property_id::text = $1
         AND COALESCE(task.task_date, task.date)::date = ANY($2::date[])
         AND lower(COALESCE(task.task_type, task.type, '')) IN ('checkout_clean', 'checkin_clean')
         AND ${activeCleaningTaskWhereSql('task')}
       ORDER BY task.id
       FOR UPDATE`,
      [propertyId, taskDates],
    )
    const rows = result.rows || []
    let updated = 0
    for (const taskDate of taskDates) {
      const sameDayRows = rows.filter((row: any) => dayOnly(row.task_date ?? row.date) === taskDate)
      const kinds = new Set(sameDayRows.map((row: any) => cleaningTaskKind(row)))
      if (!kinds.has(CHECKOUT_TASK_TYPE) || !kinds.has(CHECKIN_TASK_TYPE)) continue
      for (const before of sameDayRows) {
        if (String(before.inspection_scope || '').trim().toLowerCase() === 'inspect_and_hang') continue
        const after = await updateTaskById(String(before.id), { inspection_scope: 'inspect_and_hang' }, exec)
        await logCleaningSync({
          jobId: params.jobId,
          orderId: String(before.order_id || ''),
          taskId: before.id,
          action: 'scope_normalized',
          before,
          after,
          meta: { reason: 'same_day_turnover_scope_normalized', task_date: taskDate },
          client: exec,
        })
        await emitWorkTaskEvent({
          taskId: `cleaning_task:${String(before.id)}`,
          sourceType: 'cleaning_tasks',
          sourceRefIds: [String(before.id)],
          eventType: 'TASK_UPDATED',
          changeScope: 'list',
          changedFields: ['inspection_scope'],
          patch: { inspection_scope: 'inspect_and_hang' },
          causedByUserId: null,
          visibilityHints: buildCleaningTaskVisibilityHints(after || before),
        }, exec)
        updated += 1
      }
    }
    return updated
  }

  const rows = (db.cleaningTasks as any[]).filter((task: any) => (
    String(task.property_id || '').trim() === propertyId
    && taskDates.includes(dayOnly(task.task_date ?? task.date) || '')
    && [CHECKOUT_TASK_TYPE, CHECKIN_TASK_TYPE].includes(cleaningTaskKind(task))
    && normalizeExecutionState(task) === ACTIVE_EXECUTION_STATE
    && !isCancelledCleaningTaskStatus(task.status)
  ))
  let updated = 0
  for (const taskDate of taskDates) {
    const sameDayRows = rows.filter((row: any) => dayOnly(row.task_date ?? row.date) === taskDate)
    const kinds = new Set(sameDayRows.map((row: any) => cleaningTaskKind(row)))
    if (!kinds.has(CHECKOUT_TASK_TYPE) || !kinds.has(CHECKIN_TASK_TYPE)) continue
    for (const task of sameDayRows) {
      if (String(task.inspection_scope || '').trim().toLowerCase() === 'inspect_and_hang') continue
      task.inspection_scope = 'inspect_and_hang'
      updated += 1
    }
  }
  return updated
}

function hasValue(v: any): boolean {
  return String(v ?? '').trim() !== ''
}

function nonBlank(v: any): string | null {
  const s = String(v ?? '').trim()
  return s ? s : null
}

function displayText(v: any): string | null {
  const s = nonBlank(v)
  if (!s) return null
  const normalized = s.toLowerCase()
  if (normalized === 'null' || normalized === 'undefined') return null
  return s
}

function sameDisplayText(a: any, b: any): boolean {
  return String(displayText(a) || '') === String(displayText(b) || '')
}

function joinUniqueDisplayText(values: any[]): string | null {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const s = displayText(value)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out.length ? out.join('；') : null
}

function numberValue(v: any): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function addSupersedeDecision(
  decisions: any[],
  manual: any,
  field: string,
  canonicalValue: any,
  manualValue: any,
  resolution: 'copied_manual' | 'merged_manual' | 'kept_canonical' | 'manual_requires_review' | 'ignored_placeholder',
) {
  const comparableManual = typeof manualValue === 'number' ? manualValue : displayText(manualValue)
  if (comparableManual == null || comparableManual === '') return
  const comparableCanonical = typeof canonicalValue === 'number' ? canonicalValue : displayText(canonicalValue)
  if (comparableCanonical != null && comparableCanonical !== '' && String(comparableCanonical) === String(comparableManual)) return
  if (field === 'old_code' || field === 'new_code') {
    decisions.push({
      field,
      canonical_value_present: String(canonicalValue ?? '').trim().length > 0,
      manual_value_present: String(manualValue ?? '').trim().length > 0,
      values_differ: String(canonicalValue ?? '') !== String(manualValue ?? ''),
      manual_task_id: String(manual?.id || ''),
      resolution,
    })
    return
  }
  decisions.push({
    field,
    canonical_value: canonicalValue ?? null,
    manual_value: manualValue ?? null,
    manual_task_id: String(manual?.id || ''),
    resolution,
  })
}

function buildManualSupersedeMerge(params: {
  manual: any
  official: any
  taskType: string
}): { patch: any; changedFields: string[]; decisions: any[] } {
  const { manual, official, taskType } = params
  const patch: any = {}
  const changedFields: string[] = []
  const decisions: any[] = []

  const manualGuestRequest = displayText(manual?.guest_special_request)
  const officialGuestRequest = displayText(official?.guest_special_request)
  if (manualGuestRequest) {
    if (!officialGuestRequest) {
      patch.guest_special_request = manualGuestRequest
      changedFields.push('guest_special_request')
      addSupersedeDecision(decisions, manual, 'guest_special_request', official?.guest_special_request, manualGuestRequest, 'copied_manual')
    } else if (!sameDisplayText(officialGuestRequest, manualGuestRequest)) {
      const merged = joinUniqueDisplayText([officialGuestRequest, manualGuestRequest])
      if (merged && merged !== officialGuestRequest) {
        patch.guest_special_request = merged
        changedFields.push('guest_special_request')
        addSupersedeDecision(decisions, manual, 'guest_special_request', officialGuestRequest, manualGuestRequest, 'merged_manual')
      }
    }
  }

  if (taskType === CHECKIN_TASK_TYPE) {
    const manualCheckinTime = displayText(manual?.checkin_time)
    const officialCheckinTime = displayText(official?.checkin_time)
    if (manualCheckinTime) {
      if (!officialCheckinTime || officialCheckinTime === DEFAULT_CHECKIN_TIME) {
        if (manualCheckinTime !== officialCheckinTime) {
          patch.checkin_time = manualCheckinTime
          changedFields.push('checkin_time')
          addSupersedeDecision(decisions, manual, 'checkin_time', official?.checkin_time, manualCheckinTime, 'copied_manual')
        }
      } else if (manualCheckinTime !== officialCheckinTime) {
        addSupersedeDecision(decisions, manual, 'checkin_time', officialCheckinTime, manualCheckinTime, 'kept_canonical')
      }
    }

    const linkedCheckoutTaskId = displayText(manual?.linked_checkout_task_id)
    const officialLinkedCheckoutTaskId = displayText(official?.linked_checkout_task_id)
    if (linkedCheckoutTaskId) {
      if (!officialLinkedCheckoutTaskId) {
        patch.linked_checkout_task_id = linkedCheckoutTaskId
        changedFields.push('linked_checkout_task_id')
        addSupersedeDecision(decisions, manual, 'linked_checkout_task_id', null, linkedCheckoutTaskId, 'copied_manual')
      } else if (officialLinkedCheckoutTaskId !== linkedCheckoutTaskId) {
        addSupersedeDecision(decisions, manual, 'linked_checkout_task_id', officialLinkedCheckoutTaskId, linkedCheckoutTaskId, 'manual_requires_review')
      }
    }

    const manualInspectionScope = String(displayText(manual?.inspection_scope) || '').toLowerCase()
    const officialInspectionScope = String(displayText(official?.inspection_scope) || '').toLowerCase()
    if (manualInspectionScope === 'inspect_and_hang' || manualInspectionScope === 'password_only') {
      if (!officialInspectionScope) {
        patch.inspection_scope = manualInspectionScope
        changedFields.push('inspection_scope')
        addSupersedeDecision(decisions, manual, 'inspection_scope', null, manualInspectionScope, 'copied_manual')
      } else if (officialInspectionScope !== manualInspectionScope) {
        addSupersedeDecision(decisions, manual, 'inspection_scope', officialInspectionScope, manualInspectionScope, 'manual_requires_review')
      }
    }
  }

  for (const field of ['assignee_id', 'cleaner_id', 'inspector_id']) {
    const manualValue = displayText(manual?.[field])
    if (!manualValue) continue
    const officialValue = displayText(official?.[field])
    if (!officialValue) {
      patch[field] = manualValue
      changedFields.push(field)
      addSupersedeDecision(decisions, manual, field, null, manualValue, 'copied_manual')
    } else if (officialValue !== manualValue) {
      addSupersedeDecision(decisions, manual, field, officialValue, manualValue, 'manual_requires_review')
    }
  }

  if (taskType === CHECKOUT_TASK_TYPE) {
    const manualCheckoutTime = displayText(manual?.checkout_time)
    const officialCheckoutTime = displayText(official?.checkout_time)
    if (manualCheckoutTime) {
      if (!officialCheckoutTime || officialCheckoutTime === DEFAULT_CHECKOUT_TIME) {
        if (manualCheckoutTime !== officialCheckoutTime) {
          patch.checkout_time = manualCheckoutTime
          changedFields.push('checkout_time')
          addSupersedeDecision(decisions, manual, 'checkout_time', official?.checkout_time, manualCheckoutTime, 'copied_manual')
        }
      } else if (manualCheckoutTime !== officialCheckoutTime) {
        addSupersedeDecision(decisions, manual, 'checkout_time', officialCheckoutTime, manualCheckoutTime, 'kept_canonical')
      }
    }
  }

  for (const field of ['old_code', 'new_code']) {
    const manualValue = displayText(manual?.[field])
    if (!manualValue) continue
    const officialValue = displayText(official?.[field])
    if (officialValue !== manualValue) {
      addSupersedeDecision(decisions, manual, field, official?.[field], manualValue, 'manual_requires_review')
    }
  }

	  const manualKeys = numberValue(manual?.keys_required)
	  if (manualKeys != null) {
	    const officialOrderKeys = numberValue(official?.order_keys_required)
	    const officialTaskKeys = numberValue(official?.keys_required)
	    const canonicalKeys = officialOrderKeys ?? officialTaskKeys
	    if (canonicalKeys == null && (manualKeys === 1 || manualKeys === 2)) {
	      patch.keys_required = manualKeys
	      changedFields.push('keys_required')
	      addSupersedeDecision(decisions, manual, 'keys_required', null, manualKeys, 'copied_manual')
	    } else if (canonicalKeys !== manualKeys) {
	      addSupersedeDecision(decisions, manual, 'keys_required', canonicalKeys, manualKeys, 'manual_requires_review')
	    }
	  }

	  const manualNights = numberValue(manual?.nights_override)
	  if (manualNights != null) {
	    const officialOrderNights = numberValue(official?.order_nights ?? official?.nights)
	    const officialTaskNights = numberValue(official?.nights_override)
	    const canonicalNights = officialOrderNights ?? officialTaskNights
	    if (manualNights === 0 && canonicalNights != null && canonicalNights > 0) {
	      addSupersedeDecision(decisions, manual, 'nights_override', canonicalNights, manualNights, 'ignored_placeholder')
	    } else if (canonicalNights !== manualNights) {
	      addSupersedeDecision(decisions, manual, 'nights_override', canonicalNights, manualNights, 'manual_requires_review')
	    }
	  }

  return { patch, changedFields: Array.from(new Set(changedFields)), decisions }
}

function normalizeExecutionState(row: any): string {
  const explicit = String(row?.execution_state || '').trim().toLowerCase()
  if (explicit === ACTIVE_EXECUTION_STATE || explicit === SUPERSEDED_EXECUTION_STATE || explicit === CANCELLED_EXECUTION_STATE) return explicit
  const status = String(row?.status || '').trim().toLowerCase()
  if (status === 'cancelled' || status === 'canceled') return CANCELLED_EXECUTION_STATE
  return ACTIVE_EXECUTION_STATE
}

export function isPasswordAuthorityTaskMutable(task: any): boolean {
  return !!task
    && normalizeExecutionState(task) === ACTIVE_EXECUTION_STATE
    && !PASSWORD_TERMINAL_STATUSES.has(String(task?.status || '').trim().toLowerCase())
}

export function assertPasswordAuthorityTaskMutable(task: any): void {
  if (isPasswordAuthorityTaskMutable(task)) return
  const error: any = new Error('password_authority_task_terminal')
  error.status = 409
  throw error
}

function canSupersedeManualTaskByFields(row: any): boolean {
  if (hasValue(row?.order_id)) return false
  const source = String(row?.source || 'manual').trim().toLowerCase()
  if (source && source !== 'manual') return false
  const taskType = String(row?.task_type || row?.type || '').trim().toLowerCase()
  if (taskType !== CHECKIN_TASK_TYPE && taskType !== CHECKOUT_TASK_TYPE) return false
  const purpose = String(row?.manual_task_purpose || '').trim().toLowerCase()
  if (purpose && purpose !== TEMPORARY_ORDER_PLACEHOLDER_PURPOSE) return false
  if (normalizeExecutionState(row) !== ACTIVE_EXECUTION_STATE) return false
  const status = String(row?.status || '').trim().toLowerCase()
  if (NON_SUPERSEDABLE_MANUAL_STATUSES.has(status)) return false
  return true
}

function hasManualSupersedeIdentityConflict(decisions: any[]): boolean {
  const protectedFields = new Set(['linked_checkout_task_id', 'inspection_scope', 'assignee_id', 'cleaner_id', 'inspector_id'])
  return (Array.isArray(decisions) ? decisions : []).some((decision) => (
    decision?.resolution === 'manual_requires_review'
    && protectedFields.has(String(decision?.field || ''))
  ))
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
  if (!exec?.query) return false
  const taskId = String(task.id || '').trim()
  if (!taskId) return false
  if (await queryHasAnyRows(exec, `SELECT 1 FROM cleaning_task_media WHERE task_id::text = $1 LIMIT 1`, [taskId])) return true
  if (await queryHasAnyRows(exec, `SELECT 1 FROM cleaning_consumable_usages WHERE task_id::text = $1 LIMIT 1`, [taskId])) return true
  if (await queryHasAnyRows(exec, `SELECT 1 FROM cleaning_issues WHERE task_id::text = $1 LIMIT 1`, [taskId])) return true
  if (await queryHasAnyRows(
    exec,
    `SELECT 1
       FROM work_task_action_audits
      WHERE source_type = 'cleaning_tasks'
        AND source_id::text = $1
      LIMIT 1`,
    [taskId],
  )) return true
  return false
}

export async function __test_hasManualTaskExecutionRecords(task: any, exec: any): Promise<boolean> {
  return hasManualTaskExecutionRecords(task, exec)
}

async function hasUniqueActiveOrderBoundary(params: {
  orderId: string
  propertyId: string
  taskDate: string
  taskType: string
  exec?: any
}): Promise<boolean> {
  const boundaryColumn = params.taskType === CHECKIN_TASK_TYPE ? 'checkin' : 'checkout'
  if (hasPg && params.exec?.query) {
    const result = await params.exec.query(
      `SELECT id::text AS id
         FROM orders
        WHERE property_id::text = $1
          AND ${boundaryColumn}::date = $2::date
          AND COALESCE(status, '') <> ''
          AND lower(COALESCE(status, '')) <> 'invalid'
          AND lower(COALESCE(status, '')) NOT LIKE '%cancel%'
        ORDER BY id::text
        FOR UPDATE`,
      [params.propertyId, params.taskDate],
    )
    const ids = Array.from(new Set((result?.rows || []).map((row: any) => String(row.id || '').trim()).filter(Boolean)))
    return ids.length === 1 && ids[0] === params.orderId
  }
  const ids = Array.from(new Set(
    (db.orders as any[])
      .filter((order: any) => (
        String(order.property_id || '') === params.propertyId
        && dayOnly(order?.[boundaryColumn]) === params.taskDate
        && !isInactiveCleaningOrderStatus(order.status)
      ))
      .map((order: any) => String(order.id || '').trim())
      .filter(Boolean),
  ))
  return ids.length === 1 && ids[0] === params.orderId
}

async function canSupersedeManualTask(task: any, exec: any): Promise<boolean> {
  if (!canSupersedeManualTaskByFields(task)) return false
  const linkedCheckoutTaskId = String(task?.linked_checkout_task_id || '').trim()
  if (linkedCheckoutTaskId) {
    if (hasPg && exec?.query) {
      const linked = await exec.query(
        `SELECT 1
         FROM cleaning_tasks checkout
         WHERE checkout.id::text=$1
           AND lower(COALESCE(checkout.task_type, checkout.type, ''))=$2
           AND checkout.property_id::text=$3
           AND COALESCE(checkout.task_date, checkout.date)::date=$4::date
           AND ${activeCleaningTaskWhereSql('checkout')}
         LIMIT 1`,
        [linkedCheckoutTaskId, CHECKOUT_TASK_TYPE, String(task.property_id || ''), dayOnly(task.task_date ?? task.date)],
      )
      if (!linked?.rows?.length) return false
    } else {
      const linked = (db.cleaningTasks as any[]).find((row: any) => (
        String(row.id || '') === linkedCheckoutTaskId
        && cleaningTaskKind(row) === CHECKOUT_TASK_TYPE
        && String(row.property_id || '') === String(task.property_id || '')
        && dayOnly(row.task_date ?? row.date) === dayOnly(task.task_date ?? task.date)
        && normalizeExecutionState(row) === ACTIVE_EXECUTION_STATE
        && !isCancelledCleaningTaskStatus(row.status)
      ))
      if (!linked) return false
    }
  }
  return !(await hasManualTaskExecutionRecords(task, exec))
}

type CheckoutReverseRelinkPlan = {
  blocked: boolean
  linkedCheckin: any | null
}

async function planCheckoutReverseRelink(params: {
  manualCheckout: any
  officialCheckout: any
  propertyId: string
  taskDate: string
  exec?: any
}): Promise<CheckoutReverseRelinkPlan> {
  const manualCheckoutId = String(params.manualCheckout?.id || '').trim()
  const officialCheckoutId = String(params.officialCheckout?.id || '').trim()
  if (!manualCheckoutId || !officialCheckoutId) return { blocked: true, linkedCheckin: null }

  let sameDayCheckins: any[] = []
  if (hasPg && params.exec?.query) {
    const result = await params.exec.query(
      `SELECT task.*, incoming.checkin AS order_checkin_boundary
         FROM cleaning_tasks task
         LEFT JOIN orders incoming ON incoming.id::text = task.order_id::text
         LEFT JOIN properties p_id ON p_id.id::text = task.property_id::text
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(task.property_id::text)
        WHERE lower(COALESCE(task.task_type, task.type, '')) = $1
          AND COALESCE(task.task_date, task.date)::date = $2::date
          AND COALESCE(p_id.id::text, p_code.id::text, task.property_id::text) = $3
          AND ${activeCleaningTaskWhereSql('task')}
        ORDER BY task.id::text
        FOR UPDATE OF task`,
      [CHECKIN_TASK_TYPE, params.taskDate, params.propertyId],
    )
    sameDayCheckins = result?.rows || []
  } else {
    sameDayCheckins = (db.cleaningTasks as any[])
      .filter((task: any) => (
        cleaningTaskKind(task) === CHECKIN_TASK_TYPE
        && String(task.property_id || '') === params.propertyId
        && dayOnly(task.task_date ?? task.date) === params.taskDate
        && normalizeExecutionState(task) === ACTIVE_EXECUTION_STATE
        && !isCancelledCleaningTaskStatus(task.status)
      ))
      .map((task: any) => {
        const order = (db.orders as any[]).find((item: any) => String(item.id || '') === String(task.order_id || ''))
        return { ...task, order_checkin_boundary: order?.checkin ?? null }
      })
      .sort((a: any, b: any) => String(a.id || '').localeCompare(String(b.id || '')))
  }

  const linkedToManual = sameDayCheckins.filter((task: any) => (
    String(task.linked_checkout_task_id || '').trim() === manualCheckoutId
  ))
  if (!linkedToManual.length) return { blocked: false, linkedCheckin: null }
  if (linkedToManual.length !== 1) return { blocked: true, linkedCheckin: null }

  const linkedCheckin = linkedToManual[0]
  const linkedCheckinId = String(linkedCheckin.id || '')
  const officialAlreadyLinkedElsewhere = sameDayCheckins.some((task: any) => (
    String(task.id || '') !== linkedCheckinId
    && String(task.linked_checkout_task_id || '').trim() === officialCheckoutId
  ))
  const officialAlreadyHasDifferentOrderBoundary = sameDayCheckins.some((task: any) => (
    String(task.id || '') !== linkedCheckinId
    && hasValue(task.order_id)
    && dayOnly(task.order_checkin_boundary) === params.taskDate
  ))
  if (officialAlreadyLinkedElsewhere || officialAlreadyHasDifferentOrderBoundary) {
    return { blocked: true, linkedCheckin: null }
  }
  return { blocked: false, linkedCheckin }
}

async function applyCheckoutReverseRelink(params: {
  jobId?: string | null
  orderId: string
  linkedCheckin: any
  manualCheckout: any
  officialCheckout: any
  exec?: any
}) {
  const before = params.linkedCheckin
  const linkedCheckoutTaskId = String(params.officialCheckout.id || '')
  const after = await updateTaskById(String(before.id || ''), {
    linked_checkout_task_id: linkedCheckoutTaskId,
  }, params.exec)
  if (!after) throw new Error('manual_checkout_reverse_relink_failed')
  await logCleaningSync({
    jobId: params.jobId,
    orderId: params.orderId,
    taskId: before.id,
    action: 'updated',
    before,
    after,
    meta: {
      reason: 'manual_checkout_supersede_relink',
      source_checkout_task_id: String(params.manualCheckout.id || ''),
      replacement_checkout_task_id: linkedCheckoutTaskId,
    },
    client: params.exec,
  })
  await emitWorkTaskEvent({
    taskId: `cleaning_task:${String(before.id)}`,
    sourceType: 'cleaning_tasks',
    sourceRefIds: [String(before.id)],
    eventType: 'TASK_UPDATED',
    changeScope: 'membership',
    changedFields: ['linked_checkout_task_id', 'business_identity', 'source_ref_ids'],
    patch: {},
    causedByUserId: null,
    visibilityHints: buildCleaningTaskVisibilityHints(after),
  }, params.exec)
  return after
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
	      `SELECT cleaning_tasks.*, o.keys_required AS order_keys_required, o.nights AS order_nights,
                  COALESCE(p_id.id::text, p_code.id::text, cleaning_tasks.property_id::text) AS canonical_property_id
	       FROM cleaning_tasks
	       LEFT JOIN orders o ON (o.id::text) = (cleaning_tasks.order_id::text)
         LEFT JOIN properties p_id ON p_id.id::text=cleaning_tasks.property_id::text
         LEFT JOIN properties p_code ON upper(p_code.code)=upper(cleaning_tasks.property_id::text)
	       WHERE (cleaning_tasks.order_id::text) = $1
	         AND (cleaning_tasks.task_type::text) = $2
	         AND ${activeCleaningTaskWhereSql('cleaning_tasks')}
	       LIMIT 1
         FOR UPDATE OF cleaning_tasks`,
	      [String(orderId), normalizedTaskType],
	    )
    let official = officialRes?.rows?.[0] || null
    if (!official) return 0
    if (String(official.canonical_property_id || official.property_id || '') !== String(propertyId)
      || dayOnly(official.task_date ?? official.date) !== taskDate) return 0
    if (!(await hasUniqueActiveOrderBoundary({
      orderId: String(orderId),
      propertyId: String(propertyId),
      taskDate,
      taskType: normalizedTaskType,
      exec,
    }))) return 0

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
       ORDER BY t.updated_at DESC NULLS LAST, t.id DESC
       FOR UPDATE OF t`,
      [normalizedTaskType, taskDate, String(propertyId), TEMPORARY_ORDER_PLACEHOLDER_PURPOSE, Array.from(NON_SUPERSEDABLE_MANUAL_STATUSES)],
    )
    const manualRows = manualRes?.rows || []
    // One automatic order may only take over one unexecuted placeholder.
    // Multiple candidates are ambiguous, so keep every source task intact for
    // an explicit manager decision rather than silently reassigning evidence.
    if (manualRows.length !== 1) return 0
    if (!(await canSupersedeManualTask(manualRows[0], exec))) return 0

    let superseded = 0
    for (const manual of manualRows) {
      const merge = buildManualSupersedeMerge({ manual, official, taskType: normalizedTaskType })
      if (hasManualSupersedeIdentityConflict(merge.decisions)) return 0
      const reverseRelink = normalizedTaskType === CHECKOUT_TASK_TYPE
        ? await planCheckoutReverseRelink({
            manualCheckout: manual,
            officialCheckout: official,
            propertyId: String(propertyId),
            taskDate,
            exec,
          })
        : { blocked: false, linkedCheckin: null }
      if (reverseRelink.blocked) return 0
      if (merge.changedFields.length) {
        const beforeOfficial = official
        const afterOfficial = await updateTaskById(String(official.id), merge.patch, exec)
	        if (afterOfficial) {
	          official = {
	            ...afterOfficial,
	            order_keys_required: official.order_keys_required,
	            order_nights: official.order_nights,
	          }
	        }
        await logCleaningSync({
          jobId,
          orderId,
          taskId: official.id,
          action: 'updated',
          before: beforeOfficial,
          after: afterOfficial || official,
          meta: { reason: 'manual_placeholder_supersede_inherit', source_task_id: String(manual.id || ''), changed_fields: merge.changedFields },
          client: exec,
        })
        const guestReadyIdentityChangedFields = guestReadyCheckinIdentityChangedFields(beforeOfficial, afterOfficial || official)
        const eventInput = {
          taskId: `cleaning_task:${String(official.id)}`,
          sourceType: 'cleaning_tasks',
          sourceRefIds: [String(official.id)],
          eventType: 'TASK_UPDATED' as const,
          changeScope: merge.changedFields.some((field) => field === 'checkin_time' || field === 'checkout_time') ? 'list' as const : 'detail' as const,
          changedFields: guestReadyIdentityChangedFields.length
            ? Array.from(new Set([
                ...merge.changedFields,
                'order_id_checkin',
                'guest_ready_notification',
                'guest_ready_outside_key',
                'available_actions',
              ]))
            : merge.changedFields,
          patch: guestReadyIdentityChangedFields.length
            ? {}
            : Object.fromEntries(merge.changedFields.map((field) => [field, (afterOfficial as any)?.[field] ?? (merge.patch as any)[field]])),
          causedByUserId: null,
          visibilityHints: buildCleaningTaskVisibilityHints(afterOfficial || official),
        }
        if (guestReadyIdentityChangedFields.length) {
          // Qualification changes and their invalidation event must share the
          // caller's transaction; an event failure rolls the task write back.
          await emitWorkTaskEvent(eventInput, exec)
        } else {
          try { await emitWorkTaskEvent(eventInput, exec) } catch {}
        }
      }
      if (reverseRelink.linkedCheckin) {
        await applyCheckoutReverseRelink({
          jobId,
          orderId: String(orderId),
          linkedCheckin: reverseRelink.linkedCheckin,
          manualCheckout: manual,
          officialCheckout: official,
          exec,
        })
      }
      const patch = {
        execution_state: SUPERSEDED_EXECUTION_STATE,
        auto_sync_enabled: false,
        superseded_by: String(official.id || ''),
        superseded_reason: 'auto_order_task_created',
        superseded_at: new Date().toISOString(),
        supersede_conflicts: JSON.stringify(merge.decisions),
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
  if (String(official.property_id || '') !== String(propertyId)
    || dayOnly(official.task_date ?? official.date) !== taskDate) return 0
  if (!(await hasUniqueActiveOrderBoundary({
    orderId: String(orderId),
    propertyId: String(propertyId),
    taskDate,
    taskType: normalizedTaskType,
  }))) return 0
	  const order = (db.orders as any[]).find((item: any) => String(item.id || '') === String(orderId)) || null
	  if (order) {
	    official.order_keys_required = order.keys_required
	    official.order_nights = order.nights
	  }
  const manualRows = tasks.filter((task: any) =>
    String(task.property_id || '') === String(propertyId) &&
    String(task.task_date || task.date || '').slice(0, 10) === taskDate &&
    cleaningTaskKind(task) === normalizedTaskType &&
    canSupersedeManualTaskByFields(task)
  )
  if (manualRows.length !== 1) return 0
  if (!(await canSupersedeManualTask(manualRows[0], null))) return 0
  for (const manual of manualRows) {
    const merge = buildManualSupersedeMerge({ manual, official, taskType: normalizedTaskType })
    if (hasManualSupersedeIdentityConflict(merge.decisions)) return 0
    const reverseRelink = normalizedTaskType === CHECKOUT_TASK_TYPE
      ? await planCheckoutReverseRelink({
          manualCheckout: manual,
          officialCheckout: official,
          propertyId: String(propertyId),
          taskDate,
        })
      : { blocked: false, linkedCheckin: null }
    if (reverseRelink.blocked) return 0
    if (merge.changedFields.length) Object.assign(official, merge.patch)
    if (reverseRelink.linkedCheckin) {
      await applyCheckoutReverseRelink({
        jobId,
        orderId: String(orderId),
        linkedCheckin: reverseRelink.linkedCheckin,
        manualCheckout: manual,
        officialCheckout: official,
      })
    }
    manual.execution_state = SUPERSEDED_EXECUTION_STATE
    manual.auto_sync_enabled = false
    manual.superseded_by = String(official.id || '')
    manual.superseded_reason = 'auto_order_task_created'
    manual.superseded_at = new Date().toISOString()
    manual.supersede_conflicts = merge.decisions
  }
  return manualRows.length
}

export type PasswordAuthorityAuditContext = {
  requestId?: string | null
  actorUserId?: string | null
  actorRole?: string | null
  client?: 'web' | 'mobile' | 'sync_worker' | 'api' | null
}

const memoryPasswordAuthorityReceipts = new Set<string>()

type PasswordAuthorityField = 'old_code' | 'new_code'

type PasswordSyncResult = {
  action: 'updated' | 'no_change' | 'skipped_locked'
  targetTaskId?: string | null
  sourceTaskId?: string | null
  sourceOrderId?: string | null
  reason?: string | null
}

function passwordAuthorityStatus(task: any, field: 'old_code' | 'new_code') {
  const key = field === 'old_code' ? 'old_code_authority_status' : 'new_code_authority_status'
  return String(task?.[key] || '').trim().toLowerCase() || 'needs_review'
}

function isManuallyConfirmedPassword(task: any, field: 'old_code' | 'new_code') {
  return passwordAuthorityStatus(task, field) === 'manual_confirmed'
}

function isTrustedPasswordAuthority(task: any, field: 'old_code' | 'new_code') {
  const status = passwordAuthorityStatus(task, field)
  return status === 'manual_confirmed' || status === 'source_linked'
}

function isLegacyUnverifiedPassword(task: any, field: 'old_code' | 'new_code') {
  const statusField = field === 'old_code' ? 'old_code_authority_status' : 'new_code_authority_status'
  const sourceTaskField = field === 'old_code' ? 'old_code_source_task_id' : null
  const sourceOrderField = field === 'old_code' ? 'old_code_source_order_id' : null
  const rawStatus = String(task?.[statusField] || '').trim().toLowerCase()
  return !!nonBlank(task?.[field])
    && (!rawStatus || rawStatus === 'needs_review')
    && (!sourceTaskField || !nonBlank(task?.[sourceTaskField]))
    && (!sourceOrderField || !nonBlank(task?.[sourceOrderField]))
}

function passwordSourceField(value: any): 'old_code' | 'new_code' | 'manual' | null {
  const field = String(value || '').trim()
  return field === 'old_code' || field === 'new_code' || field === 'manual' ? field : null
}

async function emitPasswordAuthorityEvent(params: {
  targetTask: any
  sourceTaskId?: string | null
  sourceOrderId?: string | null
  sourceField?: 'old_code' | 'new_code' | 'manual' | null
  result: string
  audit?: PasswordAuthorityAuditContext
  changedFields?: string[]
  client?: any
}) {
  const targetId = String(params.targetTask?.id || '').trim()
  if (!targetId) return
  await emitWorkTaskEvent({
    taskId: `cleaning_task:${targetId}`,
    sourceType: 'cleaning_tasks',
    sourceRefIds: Array.from(new Set([targetId, String(params.sourceTaskId || '').trim()].filter(Boolean))),
    eventType: 'TASK_UPDATED',
    changeScope: 'detail',
    changedFields: Array.from(new Set([...(params.changedFields || []), 'password_authority'])),
    patch: {
      password_authority: {
        old_code_status: params.targetTask?.old_code_authority_status || null,
        new_code_status: params.targetTask?.new_code_authority_status || null,
        result: params.result,
      },
    },
    payload: {
      password_sync: {
        request_id: params.audit?.requestId || null,
        actor_role: params.audit?.actorRole || (params.audit?.client === 'sync_worker' ? 'system' : null),
        client: params.audit?.client || 'sync_worker',
        source_task_id: params.sourceTaskId || null,
        source_order_id: params.sourceOrderId || null,
        source_field: params.sourceField || null,
        target_task_id: targetId,
        result: params.result,
      },
    },
    causedByUserId: params.audit?.actorUserId || null,
    visibilityHints: buildCleaningTaskVisibilityHints(params.targetTask),
  }, params.client)
}

export async function claimTaskPasswordAuthorityFields(params: {
  taskId: string
  fields: PasswordAuthorityField[]
  client?: any
  audit?: PasswordAuthorityAuditContext
}): Promise<PasswordAuthorityField[]> {
  const taskId = String(params.taskId || '').trim()
  if (!taskId) return []
  const fields = Array.from(new Set(params.fields || []))
  const exec = params.client || pgPool
  const claimedFields: PasswordAuthorityField[] = []
  const requestId = String(params.audit?.requestId || '').trim()
  if (hasPg && exec) {
    const taskResult = await exec.query(
      `SELECT t.status, t.execution_state, t.order_id::text AS order_id, t.property_id::text AS property_id,
              CASE
                WHEN t.order_id IS NULL THEN true
                WHEN o.id IS NULL THEN false
                ELSE COALESCE(task_property_by_id.id::text, task_property_by_code.id::text, t.property_id::text)
                   = COALESCE(order_property_by_id.id::text, order_property_by_code.id::text, o.property_id::text)
              END AS property_matches_order
       FROM cleaning_tasks t
       LEFT JOIN orders o ON o.id::text = t.order_id::text
       LEFT JOIN properties task_property_by_id ON task_property_by_id.id::text = t.property_id::text
       LEFT JOIN properties task_property_by_code ON upper(task_property_by_code.code) = upper(t.property_id::text)
       LEFT JOIN properties order_property_by_id ON order_property_by_id.id::text = o.property_id::text
       LEFT JOIN properties order_property_by_code ON upper(order_property_by_code.code) = upper(o.property_id::text)
       WHERE t.id::text=$1::text
       LIMIT 1
       FOR UPDATE OF t`,
      [taskId],
    )
    if (taskResult?.rows?.[0]) {
      assertPasswordAuthorityTaskMutable(taskResult.rows[0])
      const taskOrderId = nonBlank(taskResult.rows[0].order_id)
      const lockedOrder = taskOrderId ? await loadOrder(taskOrderId, params.client, { forShare: true }) : null
      const stablePropertyKeys = taskOrderId && lockedOrder
        ? await normalizeCleaningPasswordChainKeys(params.client, [taskResult.rows[0].property_id, lockedOrder.property_id])
        : []
      if (taskResult.rows[0].property_matches_order !== true
        || (taskOrderId && (!lockedOrder || isInactiveCleaningOrderStatus(lockedOrder.status) || stablePropertyKeys.length !== 1))) {
        const error: any = new Error('password_authority_order_property_mismatch')
        error.status = 409
        throw error
      }
    }
  } else {
    const task = (db.cleaningTasks as any[]).find((candidate: any) => String(candidate?.id || '') === taskId)
    if (task) {
      assertPasswordAuthorityTaskMutable(task)
      const orderId = nonBlank(task.order_id)
      if (orderId) {
        const order = (db.orders as any[]).find((candidate: any) => String(candidate?.id || '') === orderId)
        if (!order || isInactiveCleaningOrderStatus(order.status) || String(order.property_id || '') !== String(task.property_id || '')) {
          const error: any = new Error('password_authority_order_property_mismatch')
          error.status = 409
          throw error
        }
      }
    }
  }
  for (const field of fields) {
    if (!requestId) {
      claimedFields.push(field)
      continue
    }
    if (hasPg && exec) {
      const claimed = await exec.query(
        `INSERT INTO cleaning_password_authority_receipts(request_id, task_id, field, actor_user_id, actor_role, client)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (request_id, task_id, field) DO NOTHING
         RETURNING request_id`,
        [
          requestId,
          taskId,
          field,
          params.audit?.actorUserId || null,
          params.audit?.actorRole || null,
          ['web', 'mobile', 'api'].includes(String(params.audit?.client || '')) ? params.audit?.client : 'api',
        ],
      )
      if (claimed?.rowCount) claimedFields.push(field)
      continue
    }
    const receiptKey = `${requestId}:${taskId}:${field}`
    if (memoryPasswordAuthorityReceipts.has(receiptKey)) continue
    memoryPasswordAuthorityReceipts.add(receiptKey)
    claimedFields.push(field)
  }
  return claimedFields
}

export async function confirmTaskPasswordAuthority(params: {
  taskId: string
  fields: PasswordAuthorityField[]
  claimedFields?: PasswordAuthorityField[]
  client?: any
  audit?: PasswordAuthorityAuditContext
}): Promise<{ updatedFields: PasswordAuthorityField[]; task: any | null }> {
  const taskId = String(params.taskId || '').trim()
  if (!taskId) return { updatedFields: [], task: null }
  const fields = Array.from(new Set(params.fields || []))
  const exec = params.client || pgPool
  let before: any = null
  if (hasPg && exec) {
    const result = await exec.query('SELECT * FROM cleaning_tasks WHERE id::text=$1::text LIMIT 1 FOR UPDATE', [taskId])
    before = result?.rows?.[0] || null
  } else {
    before = (db.cleaningTasks as any[]).find((task: any) => String(task.id || '') === taskId) || null
  }
  if (!before) return { updatedFields: [], task: null }
  if (params.claimedFields === undefined) assertPasswordAuthorityTaskMutable(before)

  const claimedFields = params.claimedFields === undefined
    ? await claimTaskPasswordAuthorityFields({ taskId, fields, client: params.client, audit: params.audit })
    : fields.filter((field) => params.claimedFields?.includes(field))
  if (!claimedFields.length) return { updatedFields: [], task: before }

  const patch: Record<string, any> = {}
  const updatedFields: PasswordAuthorityField[] = []
  for (const field of claimedFields) {
    const hasValue = !!nonBlank(before?.[field])
    const statusField = field === 'old_code' ? 'old_code_authority_status' : 'new_code_authority_status'
    const updatedAtField = field === 'old_code' ? 'old_code_authority_updated_at' : 'new_code_authority_updated_at'
    patch[statusField] = hasValue ? 'manual_confirmed' : 'needs_review'
    patch[updatedAtField] = new Date().toISOString()
    if (field === 'old_code') {
      patch.old_code_source_task_id = null
      patch.old_code_source_order_id = null
      patch.old_code_source_field = hasValue ? 'manual' : null
    }
    updatedFields.push(field)
  }
  const after = Object.keys(patch).length ? await updateTaskById(taskId, patch, params.client) : before
  if (after && updatedFields.length) {
    await emitPasswordAuthorityEvent({
      targetTask: after,
      sourceField: 'manual',
      result: updatedFields.some((field) => !!nonBlank(after?.[field])) ? 'manual_confirmed' : 'needs_review',
      audit: params.audit,
      changedFields: updatedFields,
      client: params.client,
    })
  }
  return { updatedFields, task: after || before }
}

export async function syncCheckoutOldCodeFromCheckinNewCode(params: {
  jobId?: string | null
  orderId: string
  client?: any
  audit?: PasswordAuthorityAuditContext
}): Promise<PasswordSyncResult> {
  const { jobId, orderId, client, audit } = params
  let checkinTask = await loadTaskByOrder(orderId, CHECKIN_TASK_TYPE, client, { activeOnly: true })
  let checkoutTask = await loadTaskByOrder(orderId, CHECKOUT_TASK_TYPE, client)
  let sourceOrder = await loadOrder(orderId, client, { forShare: !!client })
  const lockedPropertyIds = client
    ? await normalizeCleaningPasswordChainKeys(client, [checkinTask?.property_id, checkoutTask?.property_id, sourceOrder?.property_id])
    : []
  for (const propertyId of lockedPropertyIds) await lockCleaningPasswordChainKey(client, propertyId)
  checkinTask = await loadTaskByOrder(orderId, CHECKIN_TASK_TYPE, client, { forUpdate: !!client, activeOnly: true })
  checkoutTask = await loadTaskByOrder(orderId, CHECKOUT_TASK_TYPE, client, { forUpdate: !!client, passwordMutable: true })
  sourceOrder = await loadOrder(orderId, client)
  if (client) {
    const verifiedPropertyIds = await normalizeCleaningPasswordChainKeys(client, [checkinTask?.property_id, checkoutTask?.property_id, sourceOrder?.property_id])
    if (verifiedPropertyIds.some((propertyId) => !lockedPropertyIds.includes(propertyId))) {
      const error: any = new Error('password_chain_topology_changed_retry')
      error.status = 409
      throw error
    }
  }
  const nextOldCode = nonBlank(checkinTask?.new_code)
  const sourceTrusted = isTrustedPasswordAuthority(checkinTask, 'new_code')
  if (!checkinTask || !checkoutTask) return { action: 'no_change', reason: 'task_missing_or_target_terminal' }
  const canonicalProperties = client
    ? await normalizeCleaningPasswordChainKeys(client, [checkinTask.property_id, checkoutTask.property_id, sourceOrder?.property_id])
    : Array.from(new Set([nonBlank(checkinTask.property_id), nonBlank(checkoutTask.property_id), nonBlank(sourceOrder?.property_id)].filter(Boolean)))
  const propertyMismatch = !sourceOrder
    || isInactiveCleaningOrderStatus(sourceOrder.status)
    || !nonBlank(sourceOrder.property_id)
    || !nonBlank(checkinTask.property_id)
    || !nonBlank(checkoutTask.property_id)
    || canonicalProperties.length !== 1
  if (propertyMismatch) {
    if (isLegacyUnverifiedPassword(checkoutTask, 'old_code')
      || checkoutTask.auto_sync_enabled === false
      || isManuallyConfirmedPassword(checkoutTask, 'old_code')) {
      return {
        action: 'skipped_locked',
        targetTaskId: String(checkoutTask.id || ''),
        sourceTaskId: String(checkinTask.id || ''),
        sourceOrderId: String(checkinTask.order_id || ''),
        reason: 'property_mismatch_preserved',
      }
    }
    const alreadyReviewing = !nonBlank(checkoutTask.old_code)
      && passwordAuthorityStatus(checkoutTask, 'old_code') === 'needs_review'
      && !nonBlank(checkoutTask.old_code_source_task_id)
      && !nonBlank(checkoutTask.old_code_source_order_id)
    if (alreadyReviewing) return { action: 'no_change', targetTaskId: String(checkoutTask.id || ''), reason: 'property_mismatch' }
    const after = await updateTaskById(String(checkoutTask.id), {
      old_code: null,
      old_code_authority_status: 'needs_review',
      old_code_source_task_id: null,
      old_code_source_order_id: null,
      old_code_source_field: null,
      old_code_authority_updated_at: new Date().toISOString(),
    }, client)
    await emitPasswordAuthorityEvent({
      targetTask: after || checkoutTask,
      sourceTaskId: String(checkinTask.id || ''),
      sourceOrderId: String(checkinTask.order_id || ''),
      sourceField: 'new_code',
      result: 'needs_review:property_mismatch',
      audit,
      changedFields: nonBlank(checkoutTask.old_code) ? ['old_code'] : [],
      client,
    })
    return {
      action: 'updated',
      targetTaskId: String(checkoutTask.id || ''),
      sourceTaskId: String(checkinTask.id || ''),
      sourceOrderId: String(checkinTask.order_id || ''),
      reason: 'property_mismatch',
    }
  }
  if (isLegacyUnverifiedPassword(checkoutTask, 'old_code')) {
    return {
      action: 'no_change',
      targetTaskId: String(checkoutTask.id || ''),
      sourceTaskId: String(checkinTask.id || ''),
      sourceOrderId: String(checkinTask.order_id || ''),
      reason: 'legacy_unverified_preserved',
    }
  }
  if (checkoutTask.auto_sync_enabled === false || isManuallyConfirmedPassword(checkoutTask, 'old_code')) {
    await logCleaningSync({
      jobId,
      orderId,
      taskId: checkoutTask.id,
      action: 'skipped_locked',
      before: checkoutTask,
      after: checkoutTask,
      meta: {
        reason: isManuallyConfirmedPassword(checkoutTask, 'old_code') ? 'checkout_old_code_manual_confirmation_preserved' : 'checkout_old_code_from_checkin_new_code',
        source_task_id: String(checkinTask.id || ''),
      },
      client,
    })
    return {
      action: 'skipped_locked',
      targetTaskId: String(checkoutTask.id || ''),
      sourceTaskId: String(checkinTask.id || ''),
      sourceOrderId: String(checkinTask.order_id || ''),
      reason: isManuallyConfirmedPassword(checkoutTask, 'old_code') ? 'manual_confirmation_preserved' : 'auto_sync_locked',
    }
  }
  const patch = nextOldCode
    ? {
        old_code: nextOldCode,
        old_code_authority_status: sourceTrusted ? 'source_linked' : 'auto_derived',
        old_code_source_task_id: String(checkinTask.id || ''),
        old_code_source_order_id: String(checkinTask.order_id || ''),
        old_code_source_field: 'new_code',
        old_code_authority_updated_at: new Date().toISOString(),
      }
    : {
        old_code: null,
        old_code_authority_status: 'needs_review',
        old_code_source_task_id: String(checkinTask.id || ''),
        old_code_source_order_id: String(checkinTask.order_id || ''),
        old_code_source_field: 'new_code',
        old_code_authority_updated_at: new Date().toISOString(),
      }
  const valueChanged = String(checkoutTask.old_code ?? '').trim() !== String(nextOldCode || '')
  const authorityChanged = passwordAuthorityStatus(checkoutTask, 'old_code') !== patch.old_code_authority_status
    || String(checkoutTask.old_code_source_task_id || '') !== String(checkinTask.id || '')
  if (!valueChanged && !authorityChanged) {
    return {
      action: 'no_change',
      targetTaskId: String(checkoutTask.id || ''),
      sourceTaskId: String(checkinTask.id || ''),
      sourceOrderId: String(checkinTask.order_id || ''),
      reason: nextOldCode ? (sourceTrusted ? 'already_linked' : 'source_unverified') : 'source_missing',
    }
  }

  const after = await updateTaskById(String(checkoutTask.id), patch, client)
  await logCleaningSync({
    jobId,
    orderId,
    taskId: checkoutTask.id,
    action: 'updated',
    before: checkoutTask,
    after,
    meta: {
      reason: nextOldCode ? 'checkout_old_code_from_checkin_new_code' : 'checkout_old_code_source_missing',
      source_task_id: String(checkinTask.id || ''),
      source_order_id: String(checkinTask.order_id || ''),
      result: nextOldCode ? (sourceTrusted ? 'source_linked' : 'auto_derived') : 'needs_review',
    },
    client,
  })
  await emitPasswordAuthorityEvent({
    targetTask: after || checkoutTask,
    sourceTaskId: String(checkinTask.id || ''),
    sourceOrderId: String(checkinTask.order_id || ''),
    sourceField: 'new_code',
    result: nextOldCode ? (sourceTrusted ? 'source_linked' : 'auto_derived') : 'needs_review',
    audit,
    changedFields: valueChanged ? ['old_code'] : [],
    client,
  })
  return {
    action: 'updated',
    targetTaskId: String(checkoutTask.id || ''),
    sourceTaskId: String(checkinTask.id || ''),
    sourceOrderId: String(checkinTask.order_id || ''),
    reason: nextOldCode ? (sourceTrusted ? 'source_linked' : 'source_unverified') : 'source_missing',
  }
}

type PreviousCheckinPasswordBoundary = {
  state: 'available' | 'missing' | 'ambiguous'
  code: string | null
  sourceTaskId: string
  sourceOrderId: string
  sourceField: 'old_code' | 'new_code' | null
  boundaryDay: string
}

async function loadPreviousCheckinPasswordBoundaryOnce(checkinTask: any, client?: any): Promise<PreviousCheckinPasswordBoundary | null> {
  const propertyId = nonBlank(checkinTask?.property_id)
  const checkinDay = dayOnly(checkinTask?.task_date ?? checkinTask?.date)
  const targetOrderId = nonBlank(checkinTask?.order_id)
  if (!propertyId || !checkinDay) return null
  if (targetOrderId) {
    const targetOrder = await loadOrder(targetOrderId, client)
    const targetPropertyKeys = client
      ? await normalizeCleaningPasswordChainKeys(client, [propertyId, targetOrder?.property_id])
      : Array.from(new Set([propertyId, nonBlank(targetOrder?.property_id)].filter(Boolean)))
    if (!targetOrder
      || isInactiveCleaningOrderStatus(targetOrder.status)
      || !nonBlank(targetOrder.property_id)
      || targetPropertyKeys.length !== 1) return null
  }

  if (hasPg && (client || pgPool)) {
    await ensureCleaningSchemaV2()
    const exec = client || pgPool!
    const r = await exec.query(
      `SELECT checkout_task.*,
              source_checkin.id AS source_checkin_task_id,
              source_checkin.property_id::text AS source_checkin_property_id,
              source_checkin.new_code AS source_checkin_new_code,
              source_checkin.new_code_authority_status AS source_checkin_new_code_authority_status,
              COALESCE(source_checkin_property_by_id.id::text, source_checkin_property_by_code.id::text, source_checkin.property_id::text)
                = COALESCE(checkout_property_by_id.id::text, checkout_property_by_code.id::text, checkout_task.property_id::text)
                AS source_checkin_property_matches
       FROM cleaning_tasks checkout_task
       LEFT JOIN orders checkout_order ON checkout_order.id::text = checkout_task.order_id::text
       LEFT JOIN properties checkout_property_by_id
         ON checkout_property_by_id.id::text = checkout_task.property_id::text
       LEFT JOIN properties checkout_property_by_code
         ON upper(checkout_property_by_code.code) = upper(checkout_task.property_id::text)
       LEFT JOIN properties checkout_order_property_by_id
         ON checkout_order_property_by_id.id::text = checkout_order.property_id::text
       LEFT JOIN properties checkout_order_property_by_code
         ON upper(checkout_order_property_by_code.code) = upper(checkout_order.property_id::text)
       LEFT JOIN properties target_property_by_id
         ON target_property_by_id.id::text = $1::text
       LEFT JOIN properties target_property_by_code
         ON upper(target_property_by_code.code) = upper($1::text)
       LEFT JOIN LATERAL (
         SELECT checkin_task.*
         FROM cleaning_tasks checkin_task
         WHERE checkin_task.order_id::text = checkout_task.order_id::text
           AND lower(COALESCE(checkin_task.task_type, checkin_task.type, '')) = '${CHECKIN_TASK_TYPE}'
           AND ${activeCleaningTaskWhereSql('checkin_task')}
         ORDER BY checkin_task.updated_at DESC NULLS LAST
         LIMIT 1
       ) source_checkin ON true
       LEFT JOIN properties source_checkin_property_by_id
         ON source_checkin_property_by_id.id::text = source_checkin.property_id::text
       LEFT JOIN properties source_checkin_property_by_code
         ON upper(source_checkin_property_by_code.code) = upper(source_checkin.property_id::text)
       WHERE lower(COALESCE(checkout_task.task_type, checkout_task.type, '')) = '${CHECKOUT_TASK_TYPE}'
         AND ${activeCleaningTaskWhereSql('checkout_task')}
         AND checkout_task.order_id IS NOT NULL
         AND ${validCleaningTaskOrderWhereSql('checkout_task', 'checkout_order')}
         AND COALESCE(checkout_property_by_id.id::text, checkout_property_by_code.id::text, checkout_task.property_id::text)
             = COALESCE(checkout_order_property_by_id.id::text, checkout_order_property_by_code.id::text, checkout_order.property_id::text)
         AND ($3::text IS NULL OR checkout_task.order_id::text <> $3::text)
         AND COALESCE(checkout_task.task_date, checkout_task.date)::date <= $2::date
         AND COALESCE(checkout_property_by_id.id::text, checkout_property_by_code.id::text, checkout_task.property_id::text)
             = COALESCE(target_property_by_id.id::text, target_property_by_code.id::text, $1::text)
       ORDER BY COALESCE(checkout_task.task_date, checkout_task.date)::date DESC,
                checkout_task.updated_at DESC NULLS LAST`,
      [propertyId, checkinDay, targetOrderId],
    )
    const rows = r?.rows || []
    const row = rows[0]
    if (!row) return null
    const boundaryDay = dayOnly(row.task_date ?? row.date) || ''
    const boundaryRows = rows.filter((candidate: any) => dayOnly(candidate.task_date ?? candidate.date) === boundaryDay)
    const boundaryOrders = new Set(boundaryRows.map((candidate: any) => String(candidate.order_id || '')).filter(Boolean))
    if (boundaryOrders.size !== 1) {
      return {
        state: 'ambiguous',
        code: null,
        sourceTaskId: String(row.id || ''),
        sourceOrderId: '',
        sourceField: null,
        boundaryDay,
      }
    }
    const checkoutCode = nonBlank(row.old_code)
    if (checkoutCode && isTrustedPasswordAuthority(row, 'old_code')) {
      return {
        state: 'available',
        code: checkoutCode,
        sourceTaskId: String(row.id || ''),
        sourceOrderId: String(row.order_id || ''),
        sourceField: 'old_code',
        boundaryDay,
      }
    }
    const checkinCode = row.source_checkin_property_matches ? nonBlank(row.source_checkin_new_code) : null
    const checkinTrusted = ['manual_confirmed', 'source_linked'].includes(String(row.source_checkin_new_code_authority_status || '').trim().toLowerCase())
    if (!checkinCode || !checkinTrusted) {
      return {
        state: 'missing',
        code: null,
        sourceTaskId: String(row.source_checkin_task_id || row.id || ''),
        sourceOrderId: String(row.order_id || ''),
        sourceField: row.source_checkin_task_id ? 'new_code' : 'old_code',
        boundaryDay,
      }
    }
    return {
      state: 'available',
      code: checkinCode,
      sourceTaskId: String(row.source_checkin_task_id || row.id || ''),
      sourceOrderId: String(row.order_id || ''),
      sourceField: 'new_code',
      boundaryDay,
    }
  }

  const sourceRows = (db.cleaningTasks as any[])
    .filter((task: any) => {
      const taskType = String(task?.task_type ?? task?.type ?? '').trim().toLowerCase()
      const taskDay = dayOnly(task?.task_date ?? task?.date)
      return taskType === CHECKOUT_TASK_TYPE
        && String(task?.property_id || '') === propertyId
        && String(task?.order_id || '')
        && (!targetOrderId || String(task.order_id) !== targetOrderId)
        && !!taskDay
        && taskDay <= checkinDay
        && normalizeExecutionState(task) === ACTIVE_EXECUTION_STATE
        && !isCancelledCleaningTaskStatus(task?.status)
        && (() => {
          const order = (db.orders as any[]).find((candidate: any) => String(candidate.id || '') === String(task.order_id || ''))
          return !!order
            && !isInactiveCleaningOrderStatus(order.status)
            && String(order.property_id || '') === String(task.property_id || '')
        })()
    })
    .map((checkoutTask: any) => {
      const sourceCheckin = (db.cleaningTasks as any[])
        .filter((task: any) =>
          String(task?.order_id || '') === String(checkoutTask.order_id || '')
          && String(task?.task_type ?? task?.type ?? '').trim().toLowerCase() === CHECKIN_TASK_TYPE
          && normalizeExecutionState(task) === ACTIVE_EXECUTION_STATE
          && !isCancelledCleaningTaskStatus(task?.status),
        )
        .sort((a: any, b: any) => String(b?.updated_at || '').localeCompare(String(a?.updated_at || '')))[0]
      const checkoutCode = nonBlank(checkoutTask.old_code)
      const checkinCode = String(sourceCheckin?.property_id || '') === String(checkoutTask?.property_id || '')
        ? nonBlank(sourceCheckin?.new_code)
        : null
      const trustedCheckoutCode = checkoutCode && isTrustedPasswordAuthority(checkoutTask, 'old_code') ? checkoutCode : null
      const trustedCheckinCode = checkinCode && isTrustedPasswordAuthority(sourceCheckin, 'new_code') ? checkinCode : null
      const code = trustedCheckoutCode || trustedCheckinCode
      return {
        state: code ? 'available' as const : 'missing' as const,
        code: code || null,
        sourceTaskId: String(trustedCheckoutCode ? checkoutTask.id : (sourceCheckin?.id || checkoutTask.id || '')),
        sourceOrderId: String(checkoutTask.order_id || ''),
        sourceField: trustedCheckoutCode ? 'old_code' as const : (sourceCheckin ? 'new_code' as const : 'old_code' as const),
        taskDay: dayOnly(checkoutTask.task_date ?? checkoutTask.date) || '',
        updatedAt: String(checkoutTask.updated_at || ''),
      }
    })
    .sort((a: any, b: any) => b.taskDay.localeCompare(a.taskDay) || b.updatedAt.localeCompare(a.updatedAt))

  const source = sourceRows[0]
  if (!source) return null
  const sameBoundaryOrders = new Set(sourceRows.filter((row: any) => row.taskDay === source.taskDay).map((row: any) => row.sourceOrderId))
  if (sameBoundaryOrders.size !== 1) {
    return {
      state: 'ambiguous',
      code: null,
      sourceTaskId: source.sourceTaskId,
      sourceOrderId: '',
      sourceField: null,
      boundaryDay: source.taskDay,
    }
  }
  return { ...source, boundaryDay: source.taskDay }
}

async function loadPreviousCheckinPasswordBoundary(checkinTask: any, client?: any): Promise<PreviousCheckinPasswordBoundary | null> {
  const first = await loadPreviousCheckinPasswordBoundaryOnce(checkinTask, client)
  const sourceOrderId = nonBlank(first?.sourceOrderId)
  if (!client || !first || !sourceOrderId) return first

  const lockedSourceOrder = await loadOrder(sourceOrderId, client, { forShare: true })
  if (!lockedSourceOrder || isInactiveCleaningOrderStatus(lockedSourceOrder.status)) return null
  const second = await loadPreviousCheckinPasswordBoundaryOnce(checkinTask, client)
  if (!second) return null
  if (
    second.sourceOrderId !== first.sourceOrderId
    || second.sourceTaskId !== first.sourceTaskId
    || second.sourceField !== first.sourceField
    || second.boundaryDay !== first.boundaryDay
    || second.state !== first.state
  ) {
    return {
      state: 'ambiguous',
      code: null,
      sourceTaskId: second.sourceTaskId || first.sourceTaskId,
      sourceOrderId: '',
      sourceField: null,
      boundaryDay: second.boundaryDay || first.boundaryDay,
    }
  }
  return second
}

export async function syncCheckinOldCodeFromPreviousStay(params: {
  jobId?: string | null
  orderId: string
  client?: any
  expectedSourceOrderId?: string | null
  audit?: PasswordAuthorityAuditContext
}): Promise<PasswordSyncResult> {
  const { jobId, orderId, client, expectedSourceOrderId, audit } = params
  let checkinTask = await loadTaskByOrder(orderId, CHECKIN_TASK_TYPE, client)
  let targetOrder = await loadOrder(orderId, client, { forShare: !!client })
  const lockedPropertyIds = client
    ? await normalizeCleaningPasswordChainKeys(client, [checkinTask?.property_id, targetOrder?.property_id])
    : []
  for (const propertyId of lockedPropertyIds) await lockCleaningPasswordChainKey(client, propertyId)
  checkinTask = await loadTaskByOrder(orderId, CHECKIN_TASK_TYPE, client, { forUpdate: !!client, passwordMutable: true })
  if (!checkinTask) return { action: 'no_change', reason: 'target_missing' }
  targetOrder = await loadOrder(orderId, client)
  if (client) {
    const verifiedPropertyIds = await normalizeCleaningPasswordChainKeys(client, [checkinTask.property_id, targetOrder?.property_id])
    if (verifiedPropertyIds.some((propertyId) => !lockedPropertyIds.includes(propertyId))) {
      const error: any = new Error('password_chain_topology_changed_retry')
      error.status = 409
      throw error
    }
  }
  const source = await loadPreviousCheckinPasswordBoundary(checkinTask, client)
  if (expectedSourceOrderId && String(source?.sourceOrderId || '') !== String(expectedSourceOrderId)) {
    if (
      String(checkinTask.old_code_source_order_id || '') === String(expectedSourceOrderId)
      && !isManuallyConfirmedPassword(checkinTask, 'old_code')
      && checkinTask.auto_sync_enabled !== false
    ) {
      const after = await updateTaskById(String(checkinTask.id), {
        old_code: null,
        old_code_authority_status: 'needs_review',
        old_code_source_task_id: null,
        old_code_source_order_id: null,
        old_code_source_field: null,
        old_code_authority_updated_at: new Date().toISOString(),
      }, client)
      await emitPasswordAuthorityEvent({
        targetTask: after || checkinTask,
        sourceTaskId: checkinTask.old_code_source_task_id || null,
        sourceOrderId: String(expectedSourceOrderId),
        sourceField: passwordSourceField(checkinTask.old_code_source_field),
        result: 'needs_review:source_dependency_changed',
        audit,
        changedFields: nonBlank(checkinTask.old_code) ? ['old_code'] : [],
        client,
      })
    }
    return {
      action: 'no_change',
      targetTaskId: String(checkinTask.id || ''),
      sourceTaskId: source?.sourceTaskId || null,
      sourceOrderId: source?.sourceOrderId || null,
      reason: 'source_dependency_changed',
    }
  }
  if (isLegacyUnverifiedPassword(checkinTask, 'old_code')) {
    return {
      action: 'no_change',
      targetTaskId: String(checkinTask.id || ''),
      sourceTaskId: source?.sourceTaskId || null,
      sourceOrderId: source?.sourceOrderId || null,
      reason: 'legacy_unverified_preserved',
    }
  }
  if (checkinTask.auto_sync_enabled === false || isManuallyConfirmedPassword(checkinTask, 'old_code')) {
    await logCleaningSync({
      jobId,
      orderId,
      taskId: checkinTask.id,
      action: 'skipped_locked',
      before: checkinTask,
      after: checkinTask,
      meta: {
        reason: isManuallyConfirmedPassword(checkinTask, 'old_code') ? 'checkin_old_code_manual_confirmation_preserved' : 'checkin_old_code_from_previous_stay',
        source_task_id: source?.sourceTaskId || null,
        source_order_id: source?.sourceOrderId || null,
        source_field: source?.sourceField || null,
      },
      client,
    })
    return {
      action: source?.state === 'available' ? 'skipped_locked' : 'no_change',
      targetTaskId: String(checkinTask.id || ''),
      sourceTaskId: source?.sourceTaskId || null,
      sourceOrderId: source?.sourceOrderId || null,
      reason: isManuallyConfirmedPassword(checkinTask, 'old_code') ? 'manual_confirmation_preserved' : 'auto_sync_locked',
    }
  }
  const sourceAvailable = source?.state === 'available' && !!source.code
  const patch = sourceAvailable
    ? {
        old_code: source.code,
        old_code_authority_status: 'source_linked',
        old_code_source_task_id: source.sourceTaskId,
        old_code_source_order_id: source.sourceOrderId,
        old_code_source_field: source.sourceField,
        old_code_authority_updated_at: new Date().toISOString(),
      }
    : {
        old_code: null,
        old_code_authority_status: 'needs_review',
        old_code_source_task_id: source?.sourceTaskId || null,
        old_code_source_order_id: source?.sourceOrderId || null,
        old_code_source_field: source?.sourceField || null,
        old_code_authority_updated_at: new Date().toISOString(),
      }
  const valueChanged = String(checkinTask.old_code ?? '').trim() !== String(patch.old_code || '')
  const authorityChanged = passwordAuthorityStatus(checkinTask, 'old_code') !== patch.old_code_authority_status
    || String(checkinTask.old_code_source_task_id || '') !== String(patch.old_code_source_task_id || '')
    || String(checkinTask.old_code_source_order_id || '') !== String(patch.old_code_source_order_id || '')
  if (!valueChanged && !authorityChanged) {
    return {
      action: 'no_change',
      targetTaskId: String(checkinTask.id || ''),
      sourceTaskId: source?.sourceTaskId || null,
      sourceOrderId: source?.sourceOrderId || null,
      reason: sourceAvailable ? 'already_linked' : (source?.state || 'source_missing'),
    }
  }

  const after = await updateTaskById(String(checkinTask.id), patch, client)
  await logCleaningSync({
    jobId,
    orderId,
    taskId: checkinTask.id,
    action: 'updated',
    before: checkinTask,
    after,
    meta: {
      reason: sourceAvailable ? 'checkin_old_code_from_previous_stay' : 'checkin_old_code_source_unavailable',
      source_state: source?.state || 'none',
      source_task_id: source?.sourceTaskId || null,
      source_order_id: source?.sourceOrderId || null,
      source_field: source?.sourceField || null,
      result: sourceAvailable ? 'source_linked' : 'needs_review',
    },
    client,
  })
  await emitPasswordAuthorityEvent({
    targetTask: after || checkinTask,
    sourceTaskId: source?.sourceTaskId || null,
    sourceOrderId: source?.sourceOrderId || null,
    sourceField: source?.sourceField || null,
    result: sourceAvailable ? 'source_linked' : `needs_review:${source?.state || 'none'}`,
    audit,
    changedFields: valueChanged ? ['old_code'] : [],
    client,
  })
  return {
    action: 'updated',
    targetTaskId: String(checkinTask.id || ''),
    sourceTaskId: source?.sourceTaskId || null,
    sourceOrderId: source?.sourceOrderId || null,
    reason: sourceAvailable ? 'source_linked' : (source?.state || 'source_missing'),
  }
}

export type NextCheckinPasswordTargetPreview = {
  state: 'unique' | 'missing' | 'ambiguous' | 'source_missing'
  targetTaskId: string | null
  targetOrderId: string | null
  sourceOrderId: string | null
}

async function invalidateStalePasswordDependents(params: {
  sourceOrderId: string
  keepTargetTaskId?: string | null
  reason: string
  client?: any
  audit?: PasswordAuthorityAuditContext
}) {
  const sourceOrderId = String(params.sourceOrderId || '').trim()
  if (!sourceOrderId) return [] as string[]
  let linked: any[] = []
  if (hasPg && (params.client || pgPool)) {
    const exec = params.client || pgPool!
    const result = await exec.query(
      `SELECT *
       FROM cleaning_tasks
       WHERE old_code_source_order_id::text = $1::text
         AND lower(COALESCE(task_type, type, '')) = '${CHECKIN_TASK_TYPE}'
         AND COALESCE(order_id::text, '') <> $1::text
         AND ${activeCleaningTaskWhereSql('')}
         AND lower(COALESCE(status, '')) NOT IN (${Array.from(PASSWORD_TERMINAL_STATUSES).map((status) => `'${status}'`).join(',')})
       ORDER BY id
       FOR UPDATE`,
      [sourceOrderId],
    )
    linked = result?.rows || []
  } else {
    linked = (db.cleaningTasks as any[]).filter((task: any) => (
      String(task.old_code_source_order_id || '') === sourceOrderId
      && cleaningTaskKind(task) === CHECKIN_TASK_TYPE
      && String(task.order_id || '') !== sourceOrderId
      && normalizeExecutionState(task) === ACTIVE_EXECUTION_STATE
      && !PASSWORD_TERMINAL_STATUSES.has(String(task.status || '').trim().toLowerCase())
    ))
  }

  const invalidated: string[] = []
  for (const before of linked) {
    const taskId = String(before?.id || '').trim()
    if (!taskId || taskId === String(params.keepTargetTaskId || '')) continue
    if (before.auto_sync_enabled === false || isManuallyConfirmedPassword(before, 'old_code')) continue
    const after = await updateTaskById(taskId, {
      old_code: null,
      old_code_authority_status: 'needs_review',
      old_code_source_task_id: null,
      old_code_source_order_id: null,
      old_code_source_field: null,
      old_code_authority_updated_at: new Date().toISOString(),
    }, params.client)
    await logCleaningSync({
      orderId: String(before.order_id || ''),
      taskId,
      action: 'updated',
      before,
      after,
      meta: {
        reason: params.reason,
        source_order_id: sourceOrderId,
        result: 'needs_review',
      },
      client: params.client,
    })
    await emitPasswordAuthorityEvent({
      targetTask: after || before,
      sourceTaskId: before.old_code_source_task_id || null,
      sourceOrderId,
      sourceField: passwordSourceField(before.old_code_source_field),
      result: `needs_review:${params.reason}`,
      audit: params.audit,
      changedFields: nonBlank(before.old_code) ? ['old_code'] : [],
      client: params.client,
    })
    invalidated.push(taskId)
  }
  return invalidated
}

export async function invalidatePasswordDependentsForSourceTask(params: {
  sourceTaskId: string
  sourceOrderId?: string | null
  reason: string
  client?: any
  audit?: PasswordAuthorityAuditContext
}) {
  const sourceTaskId = String(params.sourceTaskId || '').trim()
  if (!sourceTaskId) return [] as string[]
  let linked: any[] = []
  if (hasPg && (params.client || pgPool)) {
    const exec = params.client || pgPool!
    const result = await exec.query(
      `SELECT *
       FROM cleaning_tasks
       WHERE old_code_source_task_id::text = $1::text
         AND id::text <> $1::text
         AND ${activeCleaningTaskWhereSql('')}
         AND lower(COALESCE(status, '')) NOT IN (${Array.from(PASSWORD_TERMINAL_STATUSES).map((status) => `'${status}'`).join(',')})
       ORDER BY id
       FOR UPDATE`,
      [sourceTaskId],
    )
    linked = result?.rows || []
  } else {
    linked = (db.cleaningTasks as any[]).filter((task: any) => (
      String(task.old_code_source_task_id || '') === sourceTaskId
      && String(task.id || '') !== sourceTaskId
      && normalizeExecutionState(task) === ACTIVE_EXECUTION_STATE
      && !PASSWORD_TERMINAL_STATUSES.has(String(task.status || '').trim().toLowerCase())
    ))
  }

  const invalidated: string[] = []
  for (const before of linked) {
    const taskId = String(before?.id || '').trim()
    if (!taskId || before.auto_sync_enabled === false || isManuallyConfirmedPassword(before, 'old_code')) continue
    const after = await updateTaskById(taskId, {
      old_code: null,
      old_code_authority_status: 'needs_review',
      old_code_source_task_id: null,
      old_code_source_order_id: null,
      old_code_source_field: null,
      old_code_authority_updated_at: new Date().toISOString(),
    }, params.client)
    await logCleaningSync({
      orderId: String(before.order_id || ''),
      taskId,
      action: 'updated',
      before,
      after,
      meta: {
        reason: params.reason,
        source_task_id: sourceTaskId,
        source_order_id: params.sourceOrderId || null,
        result: 'needs_review',
      },
      client: params.client,
    })
    await emitPasswordAuthorityEvent({
      targetTask: after || before,
      sourceTaskId,
      sourceOrderId: params.sourceOrderId || before.old_code_source_order_id || null,
      sourceField: passwordSourceField(before.old_code_source_field),
      result: `needs_review:${params.reason}`,
      audit: params.audit,
      changedFields: nonBlank(before.old_code) ? ['old_code'] : [],
      client: params.client,
    })
    invalidated.push(taskId)
  }
  return invalidated
}

export async function previewNextCheckinPasswordTarget(params: {
  sourceOrderId: string
  client?: any
}): Promise<NextCheckinPasswordTargetPreview> {
  const sourceOrderId = String(params.sourceOrderId || '').trim()
  if (!sourceOrderId) return { state: 'source_missing', targetTaskId: null, targetOrderId: null, sourceOrderId: null }
  const sourceCheckout = await loadTaskByOrder(sourceOrderId, CHECKOUT_TASK_TYPE, params.client, { activeOnly: true })
  const propertyId = nonBlank(sourceCheckout?.property_id)
  const boundaryDay = dayOnly(sourceCheckout?.task_date ?? sourceCheckout?.date)
  if (!sourceCheckout || !propertyId || !boundaryDay) return { state: 'source_missing', targetTaskId: null, targetOrderId: null, sourceOrderId }
  const sourceOrder = await loadOrder(sourceOrderId, params.client)
  const sourceOrderPropertyId = nonBlank(sourceOrder?.property_id)
  const sourcePropertyKeys = params.client
    ? await normalizeCleaningPasswordChainKeys(params.client, [propertyId, sourceOrderPropertyId])
    : Array.from(new Set([propertyId, sourceOrderPropertyId].filter(Boolean)))
  if (!sourceOrder || isInactiveCleaningOrderStatus(sourceOrder.status) || !sourceOrderPropertyId || sourcePropertyKeys.length !== 1) {
    return { state: 'source_missing', targetTaskId: null, targetOrderId: null, sourceOrderId }
  }

  let candidates: any[] = []
  if (hasPg && (params.client || pgPool)) {
    const exec = params.client || pgPool!
    const terminalStatuses = Array.from(PASSWORD_TERMINAL_STATUSES).map((_, index) => `$${index + 4}`).join(',')
    const result = await exec.query(
      `SELECT target.*
       FROM cleaning_tasks target
       LEFT JOIN properties target_property_by_id ON target_property_by_id.id::text = target.property_id::text
       LEFT JOIN properties target_property_by_code ON upper(target_property_by_code.code) = upper(target.property_id::text)
       LEFT JOIN properties source_property_by_id ON source_property_by_id.id::text = $1::text
       LEFT JOIN properties source_property_by_code ON upper(source_property_by_code.code) = upper($1::text)
       LEFT JOIN orders target_order ON target_order.id::text = target.order_id::text
       LEFT JOIN properties target_order_property_by_id ON target_order_property_by_id.id::text = target_order.property_id::text
       LEFT JOIN properties target_order_property_by_code ON upper(target_order_property_by_code.code) = upper(target_order.property_id::text)
       WHERE lower(COALESCE(target.task_type, target.type, '')) = '${CHECKIN_TASK_TYPE}'
         AND ${activeCleaningTaskWhereSql('target')}
         AND ${validCleaningTaskOrderWhereSql('target', 'target_order')}
         AND COALESCE(target_property_by_id.id::text, target_property_by_code.id::text, target.property_id::text)
             = COALESCE(target_order_property_by_id.id::text, target_order_property_by_code.id::text, target_order.property_id::text)
         AND target.order_id IS NOT NULL
         AND target.order_id::text <> $2::text
         AND COALESCE(target.task_date, target.date)::date >= $3::date
         AND lower(COALESCE(target.status, '')) NOT IN (${terminalStatuses})
         AND COALESCE(target_property_by_id.id::text, target_property_by_code.id::text, target.property_id::text)
             = COALESCE(source_property_by_id.id::text, source_property_by_code.id::text, $1::text)
       ORDER BY COALESCE(target.task_date, target.date)::date ASC, target.updated_at DESC NULLS LAST
       `,
      [propertyId, sourceOrderId, boundaryDay, ...Array.from(PASSWORD_TERMINAL_STATUSES)],
    )
    candidates = result?.rows || []
  } else {
    candidates = (db.cleaningTasks as any[])
      .filter((task: any) => {
        const order = (db.orders as any[]).find((candidate: any) => String(candidate.id || '') === String(task.order_id || ''))
        const taskDay = dayOnly(task.task_date ?? task.date)
        return cleaningTaskKind(task) === CHECKIN_TASK_TYPE
          && String(task.property_id || '') === propertyId
          && String(task.order_id || '')
          && String(task.order_id || '') !== sourceOrderId
          && !!taskDay
          && taskDay >= boundaryDay
          && normalizeExecutionState(task) === ACTIVE_EXECUTION_STATE
          && !isCancelledCleaningTaskStatus(task.status)
          && !PASSWORD_TERMINAL_STATUSES.has(String(task.status || '').trim().toLowerCase())
          && !!order
          && !isInactiveCleaningOrderStatus(order.status)
          && String(order.property_id || '') === String(task.property_id || '')
      })
      .sort((a: any, b: any) => (dayOnly(a.task_date ?? a.date) || '').localeCompare(dayOnly(b.task_date ?? b.date) || '') || String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
  }
  const first = candidates[0]
  if (!first) return { state: 'missing', targetTaskId: null, targetOrderId: null, sourceOrderId }
  const firstDay = dayOnly(first.task_date ?? first.date)
  const nearest = candidates.filter((candidate) => dayOnly(candidate.task_date ?? candidate.date) === firstDay)
  if (nearest.length !== 1) return { state: 'ambiguous', targetTaskId: null, targetOrderId: null, sourceOrderId }
  return {
    state: 'unique',
    targetTaskId: String(first.id || ''),
    targetOrderId: String(first.order_id || ''),
    sourceOrderId,
  }
}

export async function syncNextCheckinOldCodeFromSourceOrder(params: {
  sourceOrderId: string
  client?: any
  audit?: PasswordAuthorityAuditContext
}): Promise<PasswordSyncResult> {
  if (params.client) {
    let sourceCheckout = await loadTaskByOrder(String(params.sourceOrderId || ''), CHECKOUT_TASK_TYPE, params.client, { activeOnly: true })
    const sourceOrder = await loadOrder(String(params.sourceOrderId || ''), params.client, { forShare: true })
    const lockedPropertyIds = await normalizeCleaningPasswordChainKeys(params.client, [sourceCheckout?.property_id, sourceOrder?.property_id])
    for (const propertyId of lockedPropertyIds) await lockCleaningPasswordChainKey(params.client, propertyId)
    sourceCheckout = await loadTaskByOrder(String(params.sourceOrderId || ''), CHECKOUT_TASK_TYPE, params.client, { activeOnly: true, forUpdate: true })
    const verifiedPropertyIds = await normalizeCleaningPasswordChainKeys(params.client, [sourceCheckout?.property_id, sourceOrder?.property_id])
    if (verifiedPropertyIds.some((propertyId) => !lockedPropertyIds.includes(propertyId))) {
      const error: any = new Error('password_chain_topology_changed_retry')
      error.status = 409
      throw error
    }
  }
  const preview = await previewNextCheckinPasswordTarget({ sourceOrderId: params.sourceOrderId, client: params.client })
  await invalidateStalePasswordDependents({
    sourceOrderId: String(params.sourceOrderId || ''),
    keepTargetTaskId: preview.state === 'unique' ? preview.targetTaskId : null,
    reason: preview.state === 'ambiguous' ? 'next_checkin_ambiguous' : preview.state === 'missing' ? 'next_checkin_missing' : preview.state === 'source_missing' ? 'source_boundary_missing' : 'dependency_reassigned',
    client: params.client,
    audit: params.audit,
  })
  if (preview.state !== 'unique' || !preview.targetOrderId) {
    return {
      action: 'no_change',
      targetTaskId: preview.targetTaskId,
      sourceOrderId: preview.sourceOrderId,
      reason: preview.state === 'ambiguous'
        ? 'next_checkin_ambiguous'
        : preview.state === 'missing'
          ? 'next_checkin_missing'
          : 'source_boundary_missing',
    }
  }
  return syncCheckinOldCodeFromPreviousStay({
    orderId: preview.targetOrderId,
    expectedSourceOrderId: preview.sourceOrderId,
    client: params.client,
    audit: params.audit,
  })
}

function passwordSourceTopologySignature(task: any): string {
  const status = String(task?.status || '').trim().toLowerCase()
  const sourceEligible = normalizeExecutionState(task) === ACTIVE_EXECUTION_STATE
    && !['cancelled', 'canceled', 'deleted', 'replaced', 'superseded'].includes(status)
  return JSON.stringify([
    cleaningTaskKind(task),
    nonBlank(task?.property_id),
    dayOnly(task?.task_date ?? task?.date),
    nonBlank(task?.order_id),
    sourceEligible,
  ])
}

export async function reconcilePasswordAuthorityAfterTaskTopologyChange(params: {
  before: any
  after: any
  client?: any
  audit?: PasswordAuthorityAuditContext
}): Promise<void> {
  const { before, after, client, audit } = params
  if (!before || !after) return
  const sourceTopologyChanged = passwordSourceTopologySignature(before) !== passwordSourceTopologySignature(after)
  const targetBecameMutable = !isPasswordAuthorityTaskMutable(before) && isPasswordAuthorityTaskMutable(after)
  if (!sourceTopologyChanged && !targetBecameMutable) return

  const sourceTaskId = String(before?.id || after?.id || '').trim()
  const beforeOrderId = nonBlank(before?.order_id)
  const afterOrderId = nonBlank(after?.order_id)
  const beforeDependencySourceOrderId = nonBlank(before?.old_code_source_order_id)
  const afterDependencySourceOrderId = nonBlank(after?.old_code_source_order_id)
  if (sourceTopologyChanged && sourceTaskId) {
    await invalidatePasswordDependentsForSourceTask({
      sourceTaskId,
      sourceOrderId: beforeOrderId,
      reason: 'source_task_topology_changed',
      client,
      audit,
    })
  }

  const afterKind = cleaningTaskKind(after)
  let recomputedSourceOrderId: string | null = null
  if (isPasswordAuthorityTaskMutable(after) && afterOrderId && afterKind === CHECKIN_TASK_TYPE) {
    const recomputed = await syncCheckinOldCodeFromPreviousStay({ orderId: afterOrderId, client, audit })
    recomputedSourceOrderId = nonBlank(recomputed.sourceOrderId)
    if (sourceTopologyChanged) await syncCheckoutOldCodeFromCheckinNewCode({ orderId: afterOrderId, client, audit })
  }
  if (sourceTopologyChanged && afterOrderId && afterKind === CHECKOUT_TASK_TYPE) {
    await syncCheckoutOldCodeFromCheckinNewCode({ orderId: afterOrderId, client, audit })
  }

  if (!sourceTopologyChanged) return
  const sourceOrderIds = Array.from(new Set([
    beforeOrderId && [CHECKIN_TASK_TYPE, CHECKOUT_TASK_TYPE].includes(cleaningTaskKind(before)) ? beforeOrderId : null,
    afterOrderId && [CHECKIN_TASK_TYPE, CHECKOUT_TASK_TYPE].includes(afterKind) ? afterOrderId : null,
    beforeDependencySourceOrderId,
    afterDependencySourceOrderId,
    recomputedSourceOrderId,
  ].filter((value): value is string => !!value))).sort()
  for (const sourceOrderId of sourceOrderIds) {
    await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId, client, audit })
  }
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
  protectExisting?: boolean
  createOnly?: boolean
  conflictRetry?: boolean
}) {
  const { jobId, orderId, deleted, client, taskType, date, statusLower, propertyId, derivedCode, keysRequired, protectExisting = false, createOnly = false, conflictRetry = true } = params
  if (!deleted && date && propertyId) await lockCleaningTurnoverKey(client, propertyId, date)
  // The sync decision and its write must observe one serialized task row.
  // Otherwise a concurrent manual arrangement can commit after this read and
  // be overwritten (or misreported as a sync-originated arrangement change).
  const beforeTask = await loadTaskByOrder(orderId, taskType, client, { forUpdate: true })

  if (beforeTask && !createOnly && !isPasswordAuthorityTaskMutable(beforeTask)) {
    await logCleaningSync({
      jobId,
      orderId,
      taskId: beforeTask.id,
      action: 'skipped_locked',
      before: beforeTask,
      after: beforeTask,
      meta: { taskType, reason: 'password_authority_task_terminal' },
      client,
    })
    return { action: 'skipped_locked' as const }
  }

  if (deleted || !date) {
    if (beforeTask) {
      const after = await updateTaskById(String(beforeTask.id), { status: 'cancelled', execution_state: CANCELLED_EXECUTION_STATE }, client)
      await logCleaningSync({ jobId, orderId, taskId: beforeTask.id, action: 'cancelled', before: beforeTask, after, meta: { deleted, date, taskType }, client })
      await emitGuestReadyCheckinAuthorityEvent({ before: beforeTask, after, eventType: 'TASK_REMOVED', client })
      return { action: 'cancelled' as const }
    }
    await logCleaningSync({ jobId, orderId, taskId: null, action: 'no_change', before: null, after: null, meta: { deleted, date, taskType }, client })
    return { action: 'no_change' as const }
  }

  // Keep the persisted fingerprint free of passwords and phone-derived values.
  // Password drift is compared directly in-memory below and never copied into
  // the fingerprint or sync log metadata.
  const fingerprint = sha256([propertyId || '', date, statusLower, taskType, String(keysRequired)].join('|'))

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
      old_code_authority_status: taskType === CHECKOUT_TASK_TYPE && derivedCode ? 'auto_derived' : 'needs_review',
      new_code_authority_status: taskType === CHECKIN_TASK_TYPE && derivedCode ? 'auto_derived' : 'needs_review',
      old_code_authority_updated_at: taskType === CHECKOUT_TASK_TYPE ? new Date().toISOString() : null,
      new_code_authority_updated_at: taskType === CHECKIN_TASK_TYPE ? new Date().toISOString() : null,
      keys_required: keysRequired,
      inspection_mode: defaultInspectionModeForTaskType(taskType),
      inspection_due_date: null,
      auto_sync_enabled: true,
      sync_fingerprint: fingerprint,
      source: 'auto',
      execution_state: ACTIVE_EXECUTION_STATE,
      manual_task_purpose: null,
    }
    const after = await insertTask(row, client, { preserveExisting: protectExisting })
    if (!after && protectExisting && conflictRetry) {
      return syncOneTask({ ...params, conflictRetry: false })
    }
    if (!after) {
      await logCleaningSync({
        jobId,
        orderId,
        taskId: null,
        action: protectExisting ? 'skipped_protected' : 'failed',
        before: null,
        after: null,
        meta: { taskType, reason: protectExisting ? 'concurrent_task_unavailable' : 'task_insert_failed' },
        client,
      })
      return { action: protectExisting ? ('skipped_protected' as const) : ('failed' as const) }
    }
    await logCleaningSync({ jobId, orderId, taskId: after?.id, action: 'created', before: null, after, meta: { fingerprint, taskType }, client })
    await emitGuestReadyCheckinAuthorityEvent({ before: null, after, eventType: 'TASK_CREATED', client })
    return { action: 'created' as const }
  }

  if (createOnly) {
    await logCleaningSync({
      jobId,
      orderId,
      taskId: beforeTask.id,
      action: 'skipped_protected',
      before: beforeTask,
      after: beforeTask,
      meta: { fingerprint, taskType, reason: 'existing_task_not_repaired' },
      client,
    })
    return { action: 'skipped_protected' as const }
  }

  if (beforeTask.auto_sync_enabled === false) {
    await logCleaningSync({ jobId, orderId, taskId: beforeTask.id, action: 'skipped_locked', before: beforeTask, after: beforeTask, meta: { fingerprint, taskType }, client })
    return { action: 'skipped_locked' as const }
  }

  const prevFp = String(beforeTask.sync_fingerprint || '')
  const managedPasswordField = taskType === CHECKOUT_TASK_TYPE ? 'old_code' : 'new_code'
  const expectedPasswordStatus = derivedCode ? 'auto_derived' : 'needs_review'
  const currentManagedPassword = String(beforeTask?.[managedPasswordField] ?? '').trim()
  // A migration-era value without explicit provenance remains unverified even
  // when it happens to equal the phone-derived suggestion. Equality is not
  // evidence that the server, rather than a person, supplied the value.
  const legacyPasswordNeedsReview = isLegacyUnverifiedPassword(beforeTask, managedPasswordField)
  const passwordAuthorityNeedsRefresh = !isManuallyConfirmedPassword(beforeTask, managedPasswordField)
    && !legacyPasswordNeedsReview
    && (
      currentManagedPassword !== String(derivedCode || '')
      || passwordAuthorityStatus(beforeTask, managedPasswordField) !== expectedPasswordStatus
    )
  if (prevFp && prevFp === fingerprint && !passwordAuthorityNeedsRefresh) {
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
  if (taskType === CHECKOUT_TASK_TYPE && !isManuallyConfirmedPassword(beforeTask, 'old_code') && !legacyPasswordNeedsReview) {
    patch.old_code = derivedCode || null
    patch.old_code_authority_status = derivedCode ? 'auto_derived' : 'needs_review'
    patch.old_code_authority_updated_at = new Date().toISOString()
  }
  if (taskType === CHECKIN_TASK_TYPE && !isManuallyConfirmedPassword(beforeTask, 'new_code') && !legacyPasswordNeedsReview) {
    patch.new_code = derivedCode || null
    patch.new_code_authority_status = derivedCode ? 'auto_derived' : 'needs_review'
    patch.new_code_authority_updated_at = new Date().toISOString()
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
  await emitGuestReadyCheckinAuthorityEvent({ before: beforeTask, after, eventType: 'TASK_UPDATED', client })
  const arrangementRevision = buildMz031CleaningArrangementRevision(beforeTask, after)
  if (arrangementRevision) {
    const exec = client || pgPool
    if (exec) {
      await emitWorkTaskEvent({
        taskId: `cleaning_task:${String(beforeTask.id)}`,
        sourceType: 'cleaning_tasks',
        sourceRefIds: [String(beforeTask.id)],
        eventType: 'TASK_ASSIGNMENT_CHANGED',
        changeScope: 'membership',
        changedFields: [
          ...(arrangementRevision.before.scheduled_service_date !== arrangementRevision.after.scheduled_service_date ? ['task_date', 'date'] : []),
          ...(arrangementRevision.before.property_id !== arrangementRevision.after.property_id ? ['property_id'] : []),
          ...(arrangementRevision.before.cleaner_id !== arrangementRevision.after.cleaner_id ? ['cleaner_id'] : []),
          ...(arrangementRevision.before.assignee_id !== arrangementRevision.after.assignee_id ? ['assignee_id'] : []),
          ...(arrangementRevision.before.inspector_id !== arrangementRevision.after.inspector_id ? ['inspector_id'] : []),
          ...(arrangementRevision.before.inspection_mode !== arrangementRevision.after.inspection_mode ? ['inspection_mode'] : []),
          ...(arrangementRevision.before.inspection_scope !== arrangementRevision.after.inspection_scope ? ['inspection_scope'] : []),
          ...(arrangementRevision.before.inspection_due_date !== arrangementRevision.after.inspection_due_date ? ['inspection_due_date'] : []),
        ],
        patch: {},
        payload: { arrangement_revision: arrangementRevision },
        causedByUserId: null,
        visibilityHints: buildCleaningTaskVisibilityHints(after || beforeTask),
      }, exec)
    }
  }
  return { action: 'updated' as const }
}

export async function syncOrderToCleaningTasks(
  orderId: string,
  opts?: SyncOrderToCleaningTasksOpts,
): Promise<{ action: CleaningSyncAction } | null> {
  const id = String(orderId || '').trim()
  const deleted = !!opts?.deleted
  const jobId = opts?.jobId ? String(opts.jobId) : null
  const scope: CleaningSyncScope = opts?.scope === 'checkin_only' ? 'checkin_only' : 'full'
  const startedAt = Date.now()
  if (hasPg && pgPool && !opts?.client) {
    try {
      return await pgRunInTransaction((client) => syncOrderToCleaningTasks(id, { ...(opts || {}), client }))
    } catch (error: any) {
      // The business transaction is already rolled back. Persist the failure
      // audit separately so the rollback does not erase the diagnostic row.
      try {
        await logCleaningSync({
          jobId,
          orderId: id,
          taskId: null,
          action: 'failed',
          before: null,
          after: null,
          meta: { message: String(error?.message || 'sync_failed'), duration_ms: Date.now() - startedAt },
        })
      } catch {}
      throw error
    }
  }
  const client = opts?.client
  try {
    await ensureCleaningSchemaV2()
    assertPasswordAuthoritySchemaReady()
    if (!deleted) await lockCleaningOrderIdentityKey(client, id)
    const keysRequiredFallback: 1 | 2 = 1
    if (scope === 'checkin_only') {
      if (deleted) {
        await logCleaningSync({ jobId, orderId: id, taskId: null, action: 'no_change', before: null, after: null, meta: { scope, reason: 'deleted_order_not_processed' }, client })
        return { action: 'no_change' as const }
      }
      const order = await loadOrder(id, client, { forShare: !!client })
      if (!order) {
        await logCleaningSync({ jobId, orderId: id, taskId: null, action: 'no_change', before: null, after: null, meta: { scope, reason: 'order_not_found' }, client })
        return { action: 'no_change' as const }
      }
      await lockOrderPasswordChainTopology(client, id, order.property_id)
      const statusLower = String(order.status || '').trim().toLowerCase()
      const checkinDay = normalizeCheckinDay(order)
      if (!isValidStatus(statusLower) || !checkinDay) {
        await logCleaningSync({
          jobId,
          orderId: id,
          taskId: null,
          action: 'no_change',
          before: null,
          after: null,
          meta: { scope, reason: !isValidStatus(statusLower) ? 'order_not_active' : 'checkin_date_missing' },
          client,
        })
        return { action: 'no_change' as const }
      }
      const keysRequired0 = order?.keys_required == null ? keysRequiredFallback : Number(order.keys_required)
      const keysRequired = (Number.isFinite(keysRequired0) && keysRequired0 >= 2 ? 2 : 1) as 1 | 2
      const digits = String(order.guest_phone || '').replace(/\D/g, '')
      const derivedCode = digits.length >= 4 ? digits.slice(-4) : null
      const rCheckin = await syncOneTask({
        jobId,
        orderId: id,
        deleted: false,
        client,
        taskType: CHECKIN_TASK_TYPE,
        date: checkinDay,
        statusLower,
        propertyId: order.property_id ? String(order.property_id) : null,
        derivedCode,
        keysRequired,
        protectExisting: true,
        createOnly: true,
      })
      if (rCheckin.action === 'skipped_protected') return { action: 'skipped_protected' as const }
      if (rCheckin.action !== 'created') return { action: 'no_change' as const }
      await normalizeSameDayTurnoverInspectionScope({ propertyId: order.property_id ? String(order.property_id) : null, taskDates: [checkinDay], jobId, client })
      const rCheckinPassword = await syncCheckinOldCodeFromPreviousStay({ jobId, orderId: id, client })
      if (rCheckinPassword.action === 'skipped_locked') return { action: 'skipped_locked' as const }
      return { action: 'created' as const }
    }
    if (deleted) {
      await lockOrderPasswordChainTopology(client, id)
      const r1 = await syncOneTask({ jobId, orderId: id, deleted: true, client, taskType: CHECKOUT_TASK_TYPE, date: null, statusLower: 'deleted', propertyId: null, derivedCode: null, keysRequired: keysRequiredFallback })
      const r2 = await syncOneTask({ jobId, orderId: id, deleted: true, client, taskType: CHECKIN_TASK_TYPE, date: null, statusLower: 'deleted', propertyId: null, derivedCode: null, keysRequired: keysRequiredFallback })
      await invalidateStalePasswordDependents({ sourceOrderId: id, reason: 'source_order_deleted', client, audit: { client: 'sync_worker', actorRole: 'system' } })
      await reconcileDeferredInspectionCheckinReplacement({ checkinOrderId: id, pgClient: client })
      return { action: (r1.action === 'cancelled' || r2.action === 'cancelled') ? 'cancelled' : 'no_change' as const }
    }

    const order = await loadOrder(id, client, { forShare: !!client })
    if (!order) {
      await lockOrderPasswordChainTopology(client, id)
      const r1 = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKOUT_TASK_TYPE, date: null, statusLower: 'missing', propertyId: null, derivedCode: null, keysRequired: keysRequiredFallback })
      const r2 = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKIN_TASK_TYPE, date: null, statusLower: 'missing', propertyId: null, derivedCode: null, keysRequired: keysRequiredFallback })
      await invalidateStalePasswordDependents({ sourceOrderId: id, reason: 'source_order_missing', client, audit: { client: 'sync_worker', actorRole: 'system' } })
      await reconcileDeferredInspectionCheckinReplacement({ checkinOrderId: id, pgClient: client })
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

    await lockOrderPasswordChainTopology(client, id, propertyId)

    if (!valid) {
      const r1 = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKOUT_TASK_TYPE, date: null, statusLower, propertyId, derivedCode: null, keysRequired })
      const r2 = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKIN_TASK_TYPE, date: null, statusLower, propertyId, derivedCode: null, keysRequired })
      await invalidateStalePasswordDependents({ sourceOrderId: id, reason: 'source_order_inactive', client, audit: { client: 'sync_worker', actorRole: 'system' } })
      await reconcileDeferredInspectionCheckinReplacement({ checkinOrderId: id, pgClient: client })
      return { action: (r1.action === 'cancelled' || r2.action === 'cancelled') ? 'cancelled' : 'no_change' as const }
    }

    // Order writes acquire these same advisory keys in ascending date order
    // via the MZ-065 database trigger. Acquire the complete boundary set
    // before any task row lock so order edits/imports and sync cannot deadlock
    // by taking check-in/checkout keys in opposite orders.
    const turnoverBoundaryDates = Array.from(new Set([checkinDay, checkoutDay].filter((value): value is string => !!value))).sort()
    for (const boundaryDate of turnoverBoundaryDates) {
      await lockCleaningTurnoverKey(client, propertyId, boundaryDate)
    }

    const rCheckout = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKOUT_TASK_TYPE, date: checkoutDay, statusLower, propertyId, derivedCode, keysRequired })
    const rCheckin = await syncOneTask({ jobId, orderId: id, deleted: false, client, taskType: CHECKIN_TASK_TYPE, date: checkinDay, statusLower, propertyId, derivedCode, keysRequired })
    const supersededCheckout = await supersedeTemporaryManualTasksForOrder({ jobId, orderId: id, propertyId, taskDate: checkoutDay, taskType: CHECKOUT_TASK_TYPE, client })
    const supersededCheckin = await supersedeTemporaryManualTasksForOrder({ jobId, orderId: id, propertyId, taskDate: checkinDay, taskType: CHECKIN_TASK_TYPE, client })
    const normalizedTurnoverScopes = await normalizeSameDayTurnoverInspectionScope({ propertyId, taskDates: [checkoutDay, checkinDay], jobId, client })
    const rCheckoutPassword = await syncCheckoutOldCodeFromCheckinNewCode({ jobId, orderId: id, client })
    const rCheckinPassword = await syncCheckinOldCodeFromPreviousStay({ jobId, orderId: id, client })
    const rNextCheckinPassword = await syncNextCheckinOldCodeFromSourceOrder({
      sourceOrderId: id,
      client,
      audit: { client: 'sync_worker', actorRole: 'system' },
    })
    const actions = [rCheckout.action, rCheckin.action, rCheckoutPassword.action, rCheckinPassword.action, rNextCheckinPassword.action, ...(normalizedTurnoverScopes > 0 ? ['updated'] : [])]
    await reconcileDeferredInspectionCheckinReplacement({ checkinOrderId: id, pgClient: client })
    if (actions.includes('created') || actions.includes('updated')) {
      await emitDeferredInspectionCheckinConflictAlerts({ checkinOrderId: id, pgClient: client })
    }
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
    skipped_protected: 0,
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
        else if (a === 'skipped_protected') stats.skipped_protected++
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
