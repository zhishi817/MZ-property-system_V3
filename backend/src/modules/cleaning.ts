import { Router } from 'express'
import { z } from 'zod'
import { requireAnyPerm, requirePerm } from '../auth'
import { addAudit, db } from '../store'
import { hasPg, pgPool } from '../dbAdapter'
import { activeCleaningTaskWhereSql, backfillCleaningTasks, ensureCleaningSchemaV2, syncCheckoutOldCodeFromCheckinNewCode, syncOrderToCleaningTasks } from '../services/cleaningSync'
import { v4 as uuid } from 'uuid'
import { emitNotificationEvent } from '../services/notificationEvents'
import { buildCleaningTaskVisibilityHints, buildWorkTaskVisibilityHints, emitWorkTaskEvent } from '../services/workTaskEvents'
import { defaultInspectionModeForTaskType, deferredProjectionDate, effectiveInspectionMode, isCheckinKeyHandoverTask, normalizeInspectionMode, normalizeInspectionScope } from '../lib/cleaningInspection'

export const router = Router()

const DEFAULT_SUMMARY_CHECKOUT_TIME = '10am'
const DEFAULT_SUMMARY_CHECKIN_TIME = '3pm'

function roleNamesOfRequest(req: any) {
  const user = req?.user || {}
  const roles = Array.isArray(user?.roles) ? user.roles : []
  const primary = String(user?.role || '').trim()
  return Array.from(new Set([primary, ...roles].map((x) => String(x || '').trim()).filter(Boolean)))
}

function requireCleaningManualCreateAccess(req: any, res: any, next: any) {
  const roles = roleNamesOfRequest(req)
  if (roles.includes('admin') || roles.includes('offline_manager') || roles.includes('customer_service')) return next()
  return requireAnyPerm(['cleaning.schedule.manage', 'cleaning.task.assign'])(req, res, next)
}

function auDayStr(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function dayOnly(s?: any): string | null {
  const v = String(s || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

function assignedStatusFromAssignees(cleanerId: any, inspectorId: any) {
  return String(cleanerId || '').trim() || String(inspectorId || '').trim() ? 'assigned' : 'pending'
}

function cleanNotificationText(value: any) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function formatCleaningTaskFieldChange(label: string, nextValue: any, prevValue: any) {
  const next = cleanNotificationText(nextValue) || '-'
  const prev = cleanNotificationText(prevValue) || '-'
  return `${label}：${next}（原：${prev}）`
}

function buildCleaningTaskUpdateNoticeDetails(before: any, after: any) {
  const changes: string[] = []
  const lines: string[] = []
  const taskDate = cleanNotificationText(after?.task_date || after?.date)

  const add = (change: string, label: string, beforeValue: any, afterValue: any) => {
    if (cleanNotificationText(beforeValue) === cleanNotificationText(afterValue)) return
    changes.push(change)
    lines.push(formatCleaningTaskFieldChange(label, afterValue, beforeValue))
  }

  add('password', '旧密码', before?.old_code, after?.old_code)
  add('password', '新密码', before?.new_code, after?.new_code)
  add('time', '退房时间', before?.checkout_time, after?.checkout_time)
  add('time', '入住时间', before?.checkin_time, after?.checkin_time)
  add('note', '客人需求', before?.guest_special_request, after?.guest_special_request)
  add('keys', '需挂钥匙套数', before?.keys_required, after?.keys_required)

  if (cleanNotificationText(before?.status) !== cleanNotificationText(after?.status)) changes.push('status')
  if (
    cleanNotificationText(before?.inspection_mode) !== cleanNotificationText(after?.inspection_mode) ||
    cleanNotificationText(before?.inspection_due_date) !== cleanNotificationText(after?.inspection_due_date)
  ) {
    changes.push('inspection')
  }

  return {
    changes: Array.from(new Set(changes)),
    lines: taskDate && lines.length ? [`任务日期：${taskDate}`, ...lines] : lines,
  }
}

function cleaningTaskSummaryForWorkPatch(task: any) {
  const taskType = String(task?.task_type || task?.type || '').trim().toLowerCase()
  const checkoutTime = cleanNotificationText(task?.checkout_time) || DEFAULT_SUMMARY_CHECKOUT_TIME
  const checkinTime = cleanNotificationText(task?.checkin_time) || DEFAULT_SUMMARY_CHECKIN_TIME
  if (taskType === 'checkout_clean') return `${checkoutTime}退房`
  if (taskType === 'checkin_clean') return `${checkinTime}入住`
  if (taskType === 'stayover_clean') return '清洁'
  if (cleanNotificationText(task?.checkout_time) && cleanNotificationText(task?.checkin_time)) return `${checkoutTime}退房 ${checkinTime}入住`
  if (cleanNotificationText(task?.checkout_time)) return `${checkoutTime}退房`
  if (cleanNotificationText(task?.checkin_time)) return `${checkinTime}入住`
  return null
}

function buildCleaningTaskWorkPatch(after: any, rawChangedFields: string[]) {
  const changedFields = new Set(
    rawChangedFields
      .map((field) => String(field || '').trim())
      .filter((field) => !!field && field !== 'updated_at'),
  )
  const patch: Record<string, any> = {}
  for (const field of changedFields) patch[field] = after?.[field]
  if (changedFields.has('checkout_time')) {
    changedFields.add('start_time')
    changedFields.add('summary')
    changedFields.add('stayed_nights')
    changedFields.add('remaining_nights')
    patch.start_time = after?.checkout_time ?? null
  }
  if (changedFields.has('checkin_time')) {
    changedFields.add('end_time')
    changedFields.add('summary')
    changedFields.add('stayed_nights')
    changedFields.add('remaining_nights')
    patch.end_time = after?.checkin_time ?? null
  }
  if (changedFields.has('summary')) patch.summary = cleaningTaskSummaryForWorkPatch(after)
  return { changedFields: Array.from(changedFields), patch }
}

function actualCleaningTaskChangedFields(before: any, after: any, fields: string[]) {
  return Array.from(new Set(fields))
    .map((field) => String(field || '').trim())
    .filter((field) => {
      if (!field || field === 'updated_at') return false
      return cleanNotificationText(before?.[field]) !== cleanNotificationText(after?.[field])
    })
}

function buildCleaningTaskCreateNoticeDetails(after: any) {
  const changes: string[] = []
  const lines: string[] = []
  const taskType = String(after?.task_type || after?.type || '').trim().toLowerCase()
  const taskDate = cleanNotificationText(after?.task_date || after?.date)
  if (taskDate) lines.push(`任务日期：${taskDate}`)

  const add = (change: string, label: string, value: any) => {
    if (!cleanNotificationText(value)) return
    changes.push(change)
    lines.push(`${label}：${cleanNotificationText(value)}`)
  }

  if (taskType === 'checkout_clean') {
    add('time', '退房时间', after?.checkout_time)
    add('password', '旧密码', after?.old_code)
  } else if (taskType === 'checkin_clean') {
    add('time', '入住时间', after?.checkin_time)
    add('password', '新密码', after?.new_code)
  } else if (taskType === 'stayover_clean') {
    add('time', '入住中清洁时间', after?.checkin_time)
  }
  add('note', '客人需求', after?.guest_special_request)
  const keysRequired = Number(after?.keys_required)
  if (Number.isFinite(keysRequired) && keysRequired > 1) {
    changes.push('keys')
    lines.push(`需挂钥匙套数：${Math.trunc(keysRequired)}`)
  }

  return {
    changes: Array.from(new Set(changes)),
    lines: changes.length ? lines : [],
  }
}

function cleaningTaskNoticeLabel(task: any) {
  const taskType = String(task?.task_type || task?.type || '').trim().toLowerCase()
  if (taskType === 'checkout_clean') return '退房任务'
  if (taskType === 'checkin_clean') return '入住任务'
  if (taskType === 'stayover_clean') return '入住中清洁任务'
  return '清洁任务'
}

function buildCleaningTaskDeletionNotice(task: any) {
  const taskDate = cleanNotificationText(task?.task_date || task?.date)
  const lines = taskDate ? [`任务日期：${taskDate}`, '该任务已删除，不再需要执行。'] : ['该任务已删除，不再需要执行。']
  return {
    title: `${cleaningTaskNoticeLabel(task)}已删除`,
    body: lines.join('\n'),
  }
}

async function resolveCleaningTaskUpdateRecipients(taskIds: string[]) {
  try {
    const ids = Array.from(new Set(taskIds.map((x) => String(x || '').trim()).filter(Boolean)))
    if (!ids.length) return undefined
    const { listCleaningTaskUserIdsBulk, listManagerUserIds } = require('./notifications')
    return Array.from(new Set([...(await listCleaningTaskUserIdsBulk(ids)), ...(await listManagerUserIds())]))
  } catch {
    return undefined
  }
}

function validateAndApplyInspectionPatch(params: {
  patch: any
  current?: any
  taskType?: any
}) {
  const patch = params.patch || {}
  const current = params.current || {}
  const taskType = params.taskType != null ? params.taskType : current?.task_type
  const currentMode = effectiveInspectionMode({
    task_type: taskType,
    inspection_mode: current?.inspection_mode,
    status: current?.status,
    inspector_id: current?.inspector_id,
  })
  const requestedMode = patch.inspection_mode !== undefined ? normalizeInspectionMode(patch.inspection_mode) : null
  if (patch.inspection_mode !== undefined && patch.inspection_mode !== null && !requestedMode) {
    const err: any = new Error('invalid_inspection_mode')
    err.statusCode = 400
    err.exposeMessage = '无效的检查安排'
    throw err
  }
  const nextMode = requestedMode || currentMode || defaultInspectionModeForTaskType(taskType)
  const nextInspectorId = patch.inspector_id !== undefined ? patch.inspector_id : current?.inspector_id
  if (
    patch.inspection_mode === undefined &&
    String(nextInspectorId || '').trim() &&
    nextMode === 'pending_decision'
  ) {
    patch.inspection_mode = 'same_day'
  }
  const nextDue = patch.inspection_due_date !== undefined ? dayOnly(patch.inspection_due_date) : dayOnly(current?.inspection_due_date)
  const finalMode = patch.inspection_mode !== undefined ? patch.inspection_mode : nextMode
  if (finalMode === 'deferred' && !nextDue) {
    const err: any = new Error('inspection_due_date_required')
    err.statusCode = 400
    err.exposeMessage = '延期检查必须选择检查日期'
    throw err
  }
  if (patch.inspection_mode !== undefined && patch.inspection_mode !== finalMode) patch.inspection_mode = finalMode
  if (patch.inspection_due_date !== undefined || finalMode !== 'deferred') {
    patch.inspection_due_date = finalMode === 'deferred' ? nextDue : null
  }
  if ((patch.inspection_mode !== undefined || patch.inspection_due_date !== undefined) && (finalMode === 'pending_decision' || finalMode === 'self_complete') && patch.inspector_id === undefined) {
    patch.inspector_id = null
  }
  return { inspection_mode: finalMode, inspection_due_date: finalMode === 'deferred' ? nextDue : null }
}

function offlineWorkTaskId(taskId: string) {
  return `cleaning_offline_tasks:${String(taskId || '').trim()}`
}

function offlineTaskTypeLabel(taskType: any) {
  const raw = String(taskType || '').trim().toLowerCase()
  if (raw === 'property') return '房源任务'
  if (raw === 'company') return '公司任务'
  return '其他任务'
}

function offlineTaskCompletedTitle(row: any) {
  const typeLabel = offlineTaskTypeLabel(row?.task_type)
  const title = String(row?.title || '').trim()
  return title ? `${typeLabel}已完成：${title}` : `${typeLabel}已完成`
}

function offlineTaskCompletedBody(row: any) {
  const title = String(row?.title || '').trim()
  return title ? `${title} 已标记完成` : '任务已标记完成'
}

function offlineTaskDeletedTitle(row: any) {
  const typeLabel = offlineTaskTypeLabel(row?.task_type)
  const title = String(row?.title || '').trim()
  return title ? `${typeLabel}已删除：${title}` : `${typeLabel}已删除`
}

function offlineTaskDeletedBody(row: any) {
  const lines: string[] = []
  const taskDate = dayOnly(row?.date) || dayOnly(row?.scheduled_date)
  const title = String(row?.title || '').trim()
  const summary = String(row?.content || row?.summary || '').trim()
  if (taskDate) lines.push(`任务日期：${taskDate}`)
  if (title) lines.push(`任务：${title}`)
  if (summary) lines.push(`内容：${summary}`)
  lines.push('该任务已删除，不再需要执行。')
  return lines.join('\n')
}

function enqueueNotification(task: () => Promise<any>) {
  setImmediate(() => {
    task().catch((e: any) => {
      try { console.error(`[cleaning][notification_async_failed] message=${String(e?.message || '')}`) } catch {}
    })
  })
}

async function ensureOfflineTasksTable() {
  if (!hasPg || !pgPool) return
  const r = await pgPool.query(`SELECT to_regclass('public.cleaning_offline_tasks') AS t`)
  const t = r?.rows?.[0]?.t
  if (!t) {
    const err: any = new Error('cleaning_offline_tasks_missing')
    err.code = 'CLEANING_SCHEMA_MISSING'
    throw err
  }
  await pgPool.query(`ALTER TABLE cleaning_offline_tasks ADD COLUMN IF NOT EXISTS photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb;`)
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
    photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`)
  await pgPool.query(`ALTER TABLE IF EXISTS work_tasks ADD COLUMN IF NOT EXISTS photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb;`)
  try { await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_tasks_source ON work_tasks(source_type, source_id);`) } catch {}
  try { await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day_assignee ON work_tasks(scheduled_date, assignee_id, status);`) } catch {}
}

function offlineWorkStatus(value: any) {
  return String(value || '').trim().toLowerCase() === 'done' ? 'done' : 'todo'
}

function normalizePhotoUrls(input: any) {
  const arr = Array.isArray(input) ? input : []
  return Array.from(new Set(arr.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 20)
}

export async function upsertWorkTaskFromOfflineTask(row: any, requestedStatus?: any) {
  if (!hasPg || !pgPool) return
  const id = String(row?.id || '').trim()
  if (!id) return
  await ensureWorkTasksTable()
  const workId = `cleaning_offline_tasks:${id}`
  const scheduled = row?.date ? String(row.date).slice(0, 10) : null
  const assignee = String(row?.assignee_id || '').trim() || null
  const status = offlineWorkStatus(requestedStatus === undefined ? row?.status : requestedStatus)
  const updateStatus = requestedStatus !== undefined
  const urgency = String(row?.urgency || '').trim() || 'medium'
  const photoUrls = normalizePhotoUrls(row?.photo_urls)
  await pgPool.query(
    `INSERT INTO work_tasks(id, task_kind, source_type, source_id, property_id, title, summary, scheduled_date, assignee_id, status, urgency, photo_urls, created_at, updated_at)
     VALUES($1,'offline','cleaning_offline_tasks',$2,$3,$4,$5,$6::date,$7,$8,$9,$10::jsonb,COALESCE($11::timestamptz, now()), now())
     ON CONFLICT (source_type, source_id) DO UPDATE SET
       property_id=EXCLUDED.property_id,
       title=EXCLUDED.title,
       summary=EXCLUDED.summary,
       scheduled_date=EXCLUDED.scheduled_date,
       assignee_id=work_tasks.assignee_id,
       status=CASE WHEN $12::boolean THEN EXCLUDED.status ELSE work_tasks.status END,
       urgency=EXCLUDED.urgency,
       photo_urls=EXCLUDED.photo_urls,
       updated_at=now()
     RETURNING *`,
    [workId, id, row?.property_id || null, String(row?.title || ''), String(row?.content || '') || null, scheduled, assignee, status, urgency, JSON.stringify(photoUrls), row?.created_at || null, updateStatus]
  )
}

async function backfillOfflineWorkTasks() {
  if (!hasPg || !pgPool) return
  await ensureWorkTasksTable()
  // Legacy status is consulted only when creating the canonical work task for the first time.
  await pgPool.query(
    `INSERT INTO work_tasks(
       id, task_kind, source_type, source_id, property_id, title, summary,
       scheduled_date, assignee_id, status, urgency, photo_urls, created_at, updated_at
     )
     SELECT
       'cleaning_offline_tasks:' || t.id::text,
       'offline',
       'cleaning_offline_tasks',
       t.id::text,
       t.property_id,
       COALESCE(t.title, ''),
       NULLIF(COALESCE(t.content, ''), ''),
       t.date::date,
       t.assignee_id,
       CASE WHEN lower(COALESCE(t.status, 'todo')) = 'done' THEN 'done' ELSE 'todo' END,
       COALESCE(NULLIF(t.urgency, ''), 'medium'),
       COALESCE(t.photo_urls, '[]'::jsonb),
       COALESCE(t.created_at, t.updated_at, now()),
       COALESCE(t.updated_at, t.created_at, now())
     FROM cleaning_offline_tasks t
     ON CONFLICT (source_type, source_id) DO NOTHING`,
  )
}

router.get('/staff', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const kind = String((req.query as any)?.kind || '').trim().toLowerCase()
  const rolesForKind = (k: string): string[] => {
    if (k === 'cleaner') return ['cleaner', 'cleaner_inspector']
    if (k === 'inspector') return ['cleaning_inspector', 'cleaner_inspector']
    return ['cleaner', 'cleaning_inspector', 'cleaner_inspector']
  }
  const kindsForRoles = (roleNames: string[], requestedKind: string): Array<'cleaner' | 'inspector'> => {
    const out = new Set<'cleaner' | 'inspector'>()
    const all = Array.from(new Set(roleNames.map((x) => String(x || '').trim()).filter(Boolean)))
    if (all.includes('cleaner') || all.includes('cleaner_inspector')) {
      if (requestedKind !== 'inspector') out.add('cleaner')
    }
    if (all.includes('cleaning_inspector') || all.includes('cleaner_inspector')) {
      if (requestedKind !== 'cleaner') out.add('inspector')
    }
    return Array.from(out)
  }
  const roles = rolesForKind(kind)
  try {
    if (hasPg && pgPool) {
      const r = await pgPool.query(
        `SELECT
           u.id,
           u.username,
           u.email,
           u.role,
           (u.color_hex::text) AS color_hex,
           COALESCE(
             ARRAY_AGG(DISTINCT ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL),
             ARRAY[]::text[]
           ) AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id::text
         GROUP BY u.id
         ORDER BY COALESCE(u.username, u.email) ASC, u.id ASC`,
      )
      const out: any[] = []
      for (const u of (r?.rows || []) as any[]) {
        const roleNames = Array.from(new Set([
          String(u.role || '').trim(),
          ...((Array.isArray(u.roles) ? u.roles : []).map((x: any) => String(x || '').trim())),
        ].filter(Boolean)))
        if (!roleNames.some((role) => roles.includes(role))) continue
        const name = String(u.username || u.email || u.id || '').trim() || String(u.id)
        const base = { id: String(u.id), name, capacity_per_day: 0, is_active: true, color_hex: String(u.color_hex || '#3B82F6') }
        for (const resolvedKind of kindsForRoles(roleNames, kind)) {
          out.push({ ...base, kind: resolvedKind })
        }
      }
      return res.json(out)
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'staff_failed' })
  }
  const users = (db.users || []).filter((u: any) => roles.includes(String(u.role || '')))
  const out: any[] = []
  for (const u of users) {
    const role = String(u.role || '')
    const name = String(u.username || u.email || u.id || '').trim() || String(u.id)
    const base = { id: String(u.id), name, capacity_per_day: 0, is_active: true, color_hex: String((u as any).color_hex || '#3B82F6') }
    if (role === 'cleaner' && kind !== 'inspector') out.push({ ...base, kind: 'cleaner' })
    else if (role === 'cleaning_inspector' && kind !== 'cleaner') out.push({ ...base, kind: 'inspector' })
    else if (role === 'cleaner_inspector') {
      if (kind === 'cleaner') out.push({ ...base, kind: 'cleaner' })
      else if (kind === 'inspector') out.push({ ...base, kind: 'inspector' })
      else out.push({ ...base, kind: 'cleaner' }, { ...base, kind: 'inspector' })
    }
  }
  return res.json(out)
})

const offlineTaskSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  task_type: z.enum(['property', 'company', 'other']),
  title: z.string().min(1),
  content: z.string().optional(),
  kind: z.string().min(1),
  status: z.enum(['todo', 'done']),
  urgency: z.enum(['low', 'medium', 'high', 'urgent']),
  property_id: z.string().nullable().optional(),
  assignee_id: z.string().nullable().optional(),
  photo_urls: z.array(z.string().trim().min(1).max(1200)).max(20).optional(),
}).strict()

router.get('/offline-tasks', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const dateParsed = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().safeParse((req.query as any)?.date)
  const date = dateParsed.success ? dateParsed.data : undefined
  const includeOverdue = String((req.query as any)?.include_overdue || '').trim() === '1'
  try {
    if (hasPg && pgPool) {
      await ensureOfflineTasksTable()
      await backfillOfflineWorkTasks()
      if (!date) {
        const r = await pgPool.query(
          `SELECT t.*, COALESCE(w.status, 'todo') AS status, w.assignee_id AS assignee_id
             FROM cleaning_offline_tasks t
             JOIN work_tasks w ON w.source_type = 'cleaning_offline_tasks' AND w.source_id = t.id::text
            ORDER BY t.date DESC, t.updated_at DESC, t.id DESC`,
        )
        return res.json(r?.rows || [])
      }
      if (includeOverdue) {
        const r = await pgPool.query(
          `SELECT t.*, COALESCE(w.status, 'todo') AS status, w.assignee_id AS assignee_id
             FROM cleaning_offline_tasks t
             JOIN work_tasks w ON w.source_type = 'cleaning_offline_tasks' AND w.source_id = t.id::text
            WHERE (t.date::date = $1::date)
               OR (t.date::date < $1::date AND lower(COALESCE(w.status, 'todo')) <> 'done')
            ORDER BY t.date ASC, t.urgency DESC, t.updated_at DESC, t.id DESC`,
          [date]
        )
        return res.json(r?.rows || [])
      }
      const r = await pgPool.query(
        `SELECT t.*, COALESCE(w.status, 'todo') AS status, w.assignee_id AS assignee_id
           FROM cleaning_offline_tasks t
           JOIN work_tasks w ON w.source_type = 'cleaning_offline_tasks' AND w.source_id = t.id::text
          WHERE t.date::date = $1::date
          ORDER BY t.urgency DESC, t.updated_at DESC, t.id DESC`,
        [date]
      )
      return res.json(r?.rows || [])
    }
    const rows = ((db as any).cleaningOfflineTasks || []) as any[]
    const filtered = date
      ? rows.filter((t: any) => {
          const d = String(t.date || '').slice(0, 10)
          if (d === date) return true
          if (!includeOverdue) return false
          return d < date && String(t.status || '') !== 'done'
        })
      : rows
    filtered.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id || '').localeCompare(String(a.id || '')))
    return res.json(filtered)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'offline_tasks_failed' })
  }
})

router.post('/offline-tasks', requireCleaningManualCreateAccess, async (req, res) => {
  const parsed = offlineTaskSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const payload = parsed.data
  try {
    const row = {
      id: uuid(),
      date: payload.date,
      task_type: payload.task_type,
      title: payload.title,
      content: payload.content || '',
      kind: payload.kind,
      // Kept only for the legacy table's NOT NULL constraint; work_tasks owns task state.
      status: 'todo',
      urgency: payload.urgency,
      property_id: payload.property_id ?? null,
      assignee_id: payload.assignee_id ?? null,
      photo_urls: normalizePhotoUrls(payload.photo_urls),
    }
    if (hasPg && pgPool) {
      await ensureOfflineTasksTable()
      const r = await pgPool.query(
        `INSERT INTO cleaning_offline_tasks(
          id, date, task_type, title, content, kind, status, urgency, property_id, assignee_id, photo_urls
        ) VALUES($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
        [row.id, row.date, row.task_type, row.title, row.content, row.kind, row.status, row.urgency, row.property_id, row.assignee_id, JSON.stringify(row.photo_urls)]
      )
      const out = r?.rows?.[0] || row
      await upsertWorkTaskFromOfflineTask(out, payload.status)
      out.status = offlineWorkStatus(payload.status)
      out.photo_urls = normalizePhotoUrls(out.photo_urls)
      const workTaskId = offlineWorkTaskId(String(out.id || row.id))
      if (String(out.status || '').trim().toLowerCase() !== 'done') {
        try {
          await emitWorkTaskEvent({
            taskId: `work_task:${workTaskId}`,
            sourceType: 'work_tasks',
            sourceRefIds: [workTaskId],
            eventType: 'TASK_CREATED',
            changeScope: 'membership',
            changedFields: ['id', 'title', 'summary', 'scheduled_date', 'status', 'urgency', 'property_id', 'assignee_id', 'photo_urls'],
            patch: {
              id: workTaskId,
              title: out.title,
              summary: out.content || null,
              scheduled_date: out.date,
              status: out.status,
              urgency: out.urgency,
              property_id: out.property_id || null,
              assignee_id: out.assignee_id || null,
              photo_urls: out.photo_urls,
            },
            causedByUserId: String((req as any).user?.sub || '').trim() || null,
            visibilityHints: buildWorkTaskVisibilityHints({ assignee_id: out.assignee_id }),
          })
        } catch {}
      }
      if (String(out.status || '').trim().toLowerCase() === 'done') {
        try {
          await emitWorkTaskEvent({
            taskId: `work_task:${workTaskId}`,
            sourceType: 'work_tasks',
            sourceRefIds: [workTaskId],
            eventType: 'TASK_COMPLETED',
            changeScope: 'list',
            changedFields: ['status'],
            patch: { status: 'done' },
            causedByUserId: String((req as any).user?.sub || '').trim() || null,
            visibilityHints: buildWorkTaskVisibilityHints({ assignee_id: out.assignee_id }),
          })
        } catch {}
        enqueueNotification(() =>
          emitNotificationEvent(
            {
              type: 'WORK_TASK_COMPLETED',
              policyKey: 'work_task_completed',
              entity: 'work_task',
              entityId: workTaskId,
              propertyId: out.property_id ? String(out.property_id) : undefined,
              updatedAt: String(out.updated_at || '').trim() || new Date().toISOString(),
              title: offlineTaskCompletedTitle(out),
              body: offlineTaskCompletedBody(out),
              data: {
                entity: 'work_task',
                entityId: workTaskId,
                action: 'open_work_task',
                kind: 'work_task_completed',
                task_id: workTaskId,
                offline_task_id: String(out.id || ''),
                task_type: String(out.task_type || ''),
              },
              actorUserId: String((req as any).user?.sub || '').trim() || null,
            },
            { operationId: uuid() },
          ),
        )
      }
      return res.status(201).json(out)
    }
    ;(db as any).cleaningOfflineTasks = (db as any).cleaningOfflineTasks || []
    ;(db as any).cleaningOfflineTasks.unshift(row)
    return res.status(201).json(row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create_failed' })
  }
})

router.patch('/offline-tasks/:id', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const { id } = req.params
  const parsed = offlineTaskSchema.partial().safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const patch = parsed.data
  const contentFieldAllowlist = new Set(['date', 'task_type', 'title', 'content', 'kind', 'urgency', 'property_id', 'photo_urls'])
  try {
    if (hasPg && pgPool) {
      await ensureOfflineTasksTable()
      const beforeRes = await pgPool.query('SELECT * FROM cleaning_offline_tasks WHERE id=$1 LIMIT 1', [String(id)])
      const before = beforeRes?.rows?.[0] || null
      if (!before) return res.status(404).json({ message: 'task not found' })
      const keys = Object.keys(patch || {}).filter((k) => (
        k !== 'status'
        && contentFieldAllowlist.has(k)
        && (patch as any)[k] !== undefined
      ))
      if (!keys.length) {
        if ((patch as any).status === undefined) {
          const statusResult = await pgPool.query(
            `SELECT status FROM work_tasks WHERE source_type = 'cleaning_offline_tasks' AND source_id = $1 LIMIT 1`,
            [String(id)],
          )
          return res.json({ ...before, status: offlineWorkStatus(statusResult?.rows?.[0]?.status) })
        }
      }
      const beforeStatusResult = await pgPool.query(
        `SELECT status FROM work_tasks WHERE source_type = 'cleaning_offline_tasks' AND source_id = $1 LIMIT 1`,
        [String(id)],
      )
      const beforeStatus = offlineWorkStatus(beforeStatusResult?.rows?.[0]?.status ?? before.status)
      let row = before
      if (keys.length) {
        const set = keys.map((k, i) => (k === 'photo_urls' ? `"${k}" = $${i + 1}::jsonb` : `"${k}" = $${i + 1}`)).join(', ')
        const values = keys.map((k) => {
          if (k === 'photo_urls') return JSON.stringify(normalizePhotoUrls((patch as any)[k]))
          return (patch as any)[k] === undefined ? null : (patch as any)[k]
        })
        const sql = `UPDATE cleaning_offline_tasks SET ${set}, updated_at=now() WHERE id=$${keys.length + 1} RETURNING *`
        const r1 = await pgPool.query(sql, [...values, String(id)])
        row = r1?.rows?.[0] || null
      }
      if (!row) return res.status(404).json({ message: 'task not found' })
      await upsertWorkTaskFromOfflineTask(row, (patch as any).status)
      const statusResult = await pgPool.query(
        `SELECT status, assignee_id FROM work_tasks WHERE source_type = 'cleaning_offline_tasks' AND source_id = $1 LIMIT 1`,
        [String(id)],
      )
      row.status = offlineWorkStatus(statusResult?.rows?.[0]?.status)
      row.assignee_id = statusResult?.rows?.[0]?.assignee_id ? String(statusResult.rows[0].assignee_id) : null
      row.photo_urls = normalizePhotoUrls(row.photo_urls)
      const canonicalAssigneeId = statusResult?.rows?.[0]?.assignee_id || null
      const completedChanged = beforeStatus !== 'done' && row.status === 'done'
      if (keys.length && !completedChanged) {
        const workTaskId = offlineWorkTaskId(String(row.id || id))
        const changedFields = keys.map((k) => {
          if (k === 'date') return 'scheduled_date'
          if (k === 'content') return 'summary'
          return k
        })
        const patchForEvent: any = {}
        for (const field of changedFields) {
          if (field === 'scheduled_date') patchForEvent.scheduled_date = row.date ? String(row.date).slice(0, 10) : null
          else if (field === 'summary') patchForEvent.summary = row.content || null
          else if (field === 'photo_urls') patchForEvent.photo_urls = row.photo_urls
          else patchForEvent[field] = (row as any)[field]
        }
        try {
          await emitWorkTaskEvent({
            taskId: `work_task:${workTaskId}`,
            sourceType: 'work_tasks',
            sourceRefIds: [workTaskId],
            eventType: 'TASK_UPDATED',
            changeScope: 'list',
            changedFields,
            patch: patchForEvent,
            causedByUserId: String((req as any).user?.sub || '').trim() || null,
            visibilityHints: buildWorkTaskVisibilityHints({ assignee_id: canonicalAssigneeId }),
          })
        } catch {}
      }
      if (completedChanged) {
        const workTaskId = offlineWorkTaskId(String(row.id || id))
        try {
          await emitWorkTaskEvent({
            taskId: `work_task:${workTaskId}`,
            sourceType: 'work_tasks',
            sourceRefIds: [workTaskId],
            eventType: 'TASK_COMPLETED',
            changeScope: 'list',
            changedFields: ['status'],
            patch: { status: 'done' },
            causedByUserId: String((req as any).user?.sub || '').trim() || null,
            visibilityHints: buildWorkTaskVisibilityHints({ assignee_id: canonicalAssigneeId }),
          })
        } catch {}
        enqueueNotification(() =>
          emitNotificationEvent(
            {
              type: 'WORK_TASK_COMPLETED',
              policyKey: 'work_task_completed',
              entity: 'work_task',
              entityId: workTaskId,
              propertyId: row.property_id ? String(row.property_id) : undefined,
              updatedAt: String(row.updated_at || '').trim() || new Date().toISOString(),
              title: offlineTaskCompletedTitle(row),
              body: offlineTaskCompletedBody(row),
              data: {
                entity: 'work_task',
                entityId: workTaskId,
                action: 'open_work_task',
                kind: 'work_task_completed',
                task_id: workTaskId,
                offline_task_id: String(row.id || ''),
                task_type: String(row.task_type || ''),
              },
              actorUserId: String((req as any).user?.sub || '').trim() || null,
            },
            { operationId: uuid() },
          ),
        )
      }
      return res.json(row)
    }
    const rows = ((db as any).cleaningOfflineTasks || []) as any[]
    const t = rows.find((x: any) => String(x.id) === String(id))
    if (!t) return res.status(404).json({ message: 'task not found' })
    for (const key of contentFieldAllowlist) {
      if ((patch as any)[key] !== undefined) (t as any)[key] = (patch as any)[key]
    }
    if ((patch as any).status !== undefined) t.status = (patch as any).status
    return res.json(t)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update_failed' })
  }
})

router.delete('/offline-tasks/:id', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg && pgPool) {
      await ensureOfflineTasksTable()
      await ensureWorkTasksTable()
      const actorUserId = String((req as any).user?.sub || '').trim() || null
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        const offlineResult = await client.query('SELECT * FROM cleaning_offline_tasks WHERE id=$1 LIMIT 1', [String(id)])
        const offlineTask = offlineResult?.rows?.[0] || null
        if (!offlineTask) {
          await client.query('ROLLBACK')
          return res.status(404).json({ message: 'task not found' })
        }
        const workTaskResult = await client.query(
          `SELECT * FROM work_tasks WHERE source_type=$1 AND source_id=$2 LIMIT 1`,
          ['cleaning_offline_tasks', String(id)],
        )
        const workTask = workTaskResult?.rows?.[0] || null
        if (workTask) {
          try {
            await emitWorkTaskEvent({
              taskId: `work_task:${String(workTask.id)}`,
              sourceType: 'work_tasks',
              sourceRefIds: [String(workTask.id)],
              eventType: 'TASK_REMOVED',
              changeScope: 'membership',
              changedFields: ['status'],
              patch: { status: 'cancelled' },
              causedByUserId: actorUserId,
              visibilityHints: buildWorkTaskVisibilityHints(workTask),
            }, client)
          } catch {}
          try {
            await emitNotificationEvent(
              {
                type: 'WORK_TASK_UPDATED',
                policyKey: 'work_task_updated',
                entity: 'work_task',
                entityId: String(workTask.id),
                propertyId: workTask.property_id ? String(workTask.property_id) : undefined,
                updatedAt: String(offlineTask.updated_at || workTask.updated_at || '').trim() || new Date().toISOString(),
                changes: ['deleted', 'status'],
                title: offlineTaskDeletedTitle(offlineTask),
                body: offlineTaskDeletedBody(offlineTask),
                data: {
                  entity: 'work_task',
                  entityId: String(workTask.id),
                  action: 'open_notice',
                  task_id: String(workTask.id),
                  task_title: String(workTask.title || offlineTask.title || ''),
                  task_summary: workTask.summary == null ? (offlineTask.content == null ? null : String(offlineTask.content || '')) : String(workTask.summary || ''),
                  task_date: workTask.scheduled_date ? String(workTask.scheduled_date).slice(0, 10) : (dayOnly(offlineTask.date) || null),
                  assignee_id: workTask.assignee_id ? String(workTask.assignee_id) : null,
                  status: 'cancelled',
                  urgency: workTask.urgency || null,
                  offline_task_id: String(offlineTask.id || id),
                  task_type: String(offlineTask.task_type || ''),
                },
                actorUserId,
              },
              { operationId: uuid(), pgClient: client },
            )
          } catch {}
        }
        await client.query('DELETE FROM work_tasks WHERE source_type=$1 AND source_id=$2', ['cleaning_offline_tasks', String(id)])
        await client.query('DELETE FROM cleaning_offline_tasks WHERE id=$1', [String(id)])
        await client.query('COMMIT')
      } catch (e) {
        try { await client.query('ROLLBACK') } catch {}
        throw e
      } finally {
        client.release()
      }
      return res.json({ ok: true })
    }
    const rows = ((db as any).cleaningOfflineTasks || []) as any[]
    ;(db as any).cleaningOfflineTasks = rows.filter((x: any) => String(x.id) !== String(id))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'delete_failed' })
  }
})

router.get('/tasks', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  const parsed = dateSchema.safeParse((req.query as any)?.date)
  const date = parsed.success ? parsed.data : undefined
  try {
    if (hasPg && pgPool) {
      await ensureCleaningSchemaV2()
      if (date) {
        const r = await pgPool.query(
          `SELECT t.*, o.keys_required AS order_keys_required
           FROM cleaning_tasks t
           LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
           WHERE (COALESCE(t.task_date, t.date)::date) = ($1::date)
             AND ${activeCleaningTaskWhereSql('t')}
           ORDER BY t.property_id NULLS LAST, t.id`,
          [date]
        )
        return res.json((r?.rows || []).map((x: any) => {
          if (x?.order_id && x?.order_keys_required != null) x.keys_required = Number(x.order_keys_required)
          delete x.order_keys_required
          return x
        }))
      }
      const r = await pgPool.query(
        `SELECT t.*, o.keys_required AS order_keys_required
         FROM cleaning_tasks t
         LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
         WHERE ${activeCleaningTaskWhereSql('t')}
         ORDER BY COALESCE(t.task_date, t.date) NULLS LAST, t.property_id NULLS LAST, t.id`,
      )
      return res.json((r?.rows || []).map((x: any) => {
        if (x?.order_id && x?.order_keys_required != null) x.keys_required = Number(x.order_keys_required)
        delete x.order_keys_required
        return x
      }))
    }
    const rows = (db.cleaningTasks as any[]).slice()
    const activeRows = rows.filter((t: any) => {
      const executionState = String(t?.execution_state || '').trim().toLowerCase()
      const status = String(t?.status || '').trim().toLowerCase()
      if (executionState && executionState !== 'active') return false
      if (!executionState && (status === 'cancelled' || status === 'canceled')) return false
      return true
    })
    if (!date) return res.json(activeRows)
    const orders = (db.orders || []) as any[]
    const byId = new Map<string, any>()
    for (const o of orders) byId.set(String(o.id), o)
    return res.json(activeRows.filter((t: any) => String(t.task_date || t.date || '').slice(0, 10) === date).map((t: any) => {
      const out = { ...t }
      const oid = String(out.order_id || '').trim()
      const o = oid ? byId.get(oid) : null
      if (o && o.keys_required != null) out.keys_required = Number(o.keys_required) >= 2 ? 2 : 1
      return out
    }))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'query_failed' })
  }
})

router.get('/history', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const propertyId = String((req.query as any)?.property_id || '').trim()
  if (!propertyId) return res.status(400).json({ message: 'property_id_required' })
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  const parsedFrom = dateSchema.optional().safeParse((req.query as any)?.from)
  const parsedTo = dateSchema.optional().safeParse((req.query as any)?.to)
  const fromRaw = parsedFrom.success ? parsedFrom.data : undefined
  const toRaw = parsedTo.success ? parsedTo.data : undefined
  const limitRaw = Number((req.query as any)?.limit || 200)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 1000) : 200
  const today = new Date()
  const defaultTo = today.toISOString().slice(0, 10)
  const defaultFrom = new Date(today.getTime() - 180 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const from = fromRaw || defaultFrom
  const to = toRaw || defaultTo
  try {
    if (hasPg && pgPool) {
      const sql = `
        SELECT
          t.*,
          p.code AS property_code,
          p.region AS property_region
        FROM cleaning_tasks t
        LEFT JOIN properties p ON p.id = t.property_id
        WHERE t.property_id = $1
          AND (COALESCE(t.task_date, t.date)::date) >= ($2::date)
          AND (COALESCE(t.task_date, t.date)::date) <= ($3::date)
        ORDER BY (COALESCE(t.task_date, t.date)::date) DESC, t.id DESC
        LIMIT $4
      `
      const r = await pgPool.query(sql, [propertyId, from, to, limit])
      return res.json(r?.rows || [])
    }
    const rows = (db.cleaningTasks as any[]).slice().filter((t: any) => String(t.property_id || '') === propertyId)
    const filtered = rows.filter((t: any) => {
      const d = String(t.task_date || t.date || '').slice(0, 10)
      return d && d >= from && d <= to
    })
    filtered.sort((a: any, b: any) => String(b.task_date || b.date || '').localeCompare(String(a.task_date || a.date || '')) || String(b.id || '').localeCompare(String(a.id || '')))
    const props = ((db as any).properties || []) as any[]
    const p = props.find((x: any) => String(x.id) === propertyId) || null
    const out = filtered.slice(0, limit).map((t: any) => ({ ...t, property_code: p?.code || t?.property_code || null, property_region: p?.region || t?.property_region || null }))
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'history_failed' })
  }
})

const patchTaskSchema = z.object({
  property_id: z.string().nullable().optional(),
  task_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['pending', 'assigned', 'in_progress', 'completed', 'cancelled', 'keys_hung']).optional(),
  assignee_id: z.union([z.string().min(1), z.null()]).optional(),
  cleaner_id: z.union([z.string().min(1), z.null()]).optional(),
  inspector_id: z.union([z.string().min(1), z.null()]).optional(),
  inspection_scope: z.enum(['inspect_and_hang', 'password_only']).optional().nullable(),
  inspection_mode: z.enum(['pending_decision', 'same_day', 'deferred', 'self_complete', 'checked_done']).optional().nullable(),
  inspection_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  keys_required: z
    .preprocess((v) => {
      if (v == null) return v
      if (typeof v === 'number') return v
      const n = Number(v)
      return Number.isFinite(n) ? n : v
    }, z.number().int().min(1).max(2))
    .optional()
    .nullable(),
  nights_override: z.union([z.number().int().nonnegative(), z.null()]).optional(),
  old_code: z.union([z.string(), z.null()]).optional(),
  new_code: z.union([z.string(), z.null()]).optional(),
  checkout_time: z.union([z.string(), z.null()]).optional(),
  checkin_time: z.union([z.string(), z.null()]).optional(),
  scheduled_at: z.union([z.string().min(1), z.null()]).optional(),
  guest_special_request: z.union([z.string(), z.null()]).optional(),
  note: z.union([z.string(), z.null()]).optional(),
}).strict()

async function isValidStaffId(id: any, kind: 'cleaner' | 'inspector'): Promise<boolean> {
  if (!id) return true
  const sid = String(id)
  const allowed =
    kind === 'cleaner'
      ? ['cleaner', 'cleaner_inspector']
      : ['cleaning_inspector', 'cleaner_inspector']

  if (hasPg && pgPool) {
    try {
      const r = await pgPool.query('SELECT role FROM users WHERE id=$1 LIMIT 1', [sid])
      const role = String(r?.rows?.[0]?.role || '')
      return allowed.includes(role)
    } catch {
      return false
    }
  }

  const u = (db.users || []).find((x: any) => String(x.id) === sid)
  if (u) return allowed.includes(String((u as any).role || ''))

  const all = (db.cleaners || []).map((x: any) => ({ ...x, kind: x?.kind || 'cleaner', is_active: x?.is_active !== false }))
  const found = all.find((x: any) => String(x.id) === sid && x.is_active !== false && x.kind === kind)
  return !!found
}

async function isValidAnyStaffId(id: any): Promise<boolean> {
  if (!id) return true
  const sid = String(id)
  if (hasPg && pgPool) {
    try {
      const r = await pgPool.query('SELECT id FROM users WHERE id=$1 LIMIT 1', [sid])
      return !!r?.rows?.[0]
    } catch {
      return false
    }
  }
  const u = (db.users || []).find((x: any) => String(x.id) === sid)
  if (u) return true
  const all = (db.cleaners || []).map((x: any) => ({ ...x, is_active: x?.is_active !== false }))
  return all.some((x: any) => String(x.id) === sid && x.is_active !== false)
}

router.patch('/tasks/:id', requirePerm('cleaning.task.assign'), async (req, res) => {
  const { id } = req.params
  const operationId = uuid()
  const opNow = new Date().toISOString()
  const parsed = patchTaskSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!(await isValidStaffId((parsed.data as any).cleaner_id ?? null, 'cleaner'))) return res.status(400).json({ message: '无效的清洁人员' })
  if (!(await isValidStaffId((parsed.data as any).inspector_id ?? null, 'inspector'))) return res.status(400).json({ message: '无效的检查人员' })
  try {
    if (hasPg && pgPool) {
      await ensureCleaningSchemaV2()
      const r0 = await pgPool.query('SELECT * FROM cleaning_tasks WHERE id = $1 LIMIT 1', [String(id)])
      const before = r0?.rows?.[0] || null
      if (!before) return res.status(404).json({ message: 'task not found' })

      if (parsed.data.keys_required !== undefined && before.order_id) {
        return res.status(400).json({ message: '该任务关联订单，钥匙套数请按订单更新（orders.keys_required）' })
      }

      const patch: any = { ...parsed.data }
      if (patch.guest_special_request === undefined && patch.note !== undefined) patch.guest_special_request = patch.note
      delete patch.note
      if (patch.keys_required === null) patch.keys_required = 1
      const isKeyHandoverExecution = isCheckinKeyHandoverTask({
        task_type: patch.task_type ?? before.task_type,
        inspection_scope: patch.inspection_scope ?? before.inspection_scope,
      })
      if (isKeyHandoverExecution) {
        if (!(await isValidAnyStaffId(patch.assignee_id ?? null))) return res.status(400).json({ message: '无效的执行人' })
        if (patch.assignee_id !== undefined && patch.cleaner_id === undefined) patch.cleaner_id = null
      } else {
        if (patch.cleaner_id !== undefined && patch.assignee_id === undefined) patch.assignee_id = patch.cleaner_id
        if (patch.assignee_id !== undefined && patch.cleaner_id === undefined) patch.cleaner_id = patch.assignee_id
      }
      if (patch.task_date != null) patch.date = patch.task_date
      validateAndApplyInspectionPatch({ patch, current: before })
      {
        const beforeStatus = String(before.status || 'pending')
        const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned'
        const incomingStatus = (parsed.data as any).status
        const incomingStatusEligible =
          incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned'
        const touchingAssignees =
          (parsed.data as any).cleaner_id !== undefined ||
          (parsed.data as any).inspector_id !== undefined ||
          parsed.data.assignee_id !== undefined ||
          parsed.data.inspection_mode !== undefined ||
          parsed.data.inspection_due_date !== undefined
        if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
          const nextCleanerId = isKeyHandoverExecution
            ? (patch.assignee_id !== undefined ? (patch.assignee_id ?? null) : (before.assignee_id ?? before.inspector_id ?? null))
            : (patch.cleaner_id !== undefined ? (patch.cleaner_id ?? null) : (before.cleaner_id ?? before.assignee_id ?? null))
          const nextInspectorId = (parsed.data as any).inspector_id !== undefined ? ((parsed.data as any).inspector_id ?? null) : (before.inspector_id ?? null)
          patch.status = assignedStatusFromAssignees(nextCleanerId, nextInspectorId)
        }
      }
      patch.updated_at = new Date().toISOString()

      const keys = Object.keys(patch).filter((k) => patch[k] !== undefined)
      const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
      const values = keys.map((k) => (patch[k] === undefined ? null : patch[k]))
      const sql = `UPDATE cleaning_tasks SET ${set} WHERE id = $${keys.length + 1} RETURNING *`
      const r1 = await pgPool.query(sql, [...values, String(id)])
      const updated = r1?.rows?.[0] || before
      if (
        parsed.data.new_code !== undefined &&
        String(updated?.order_id || '').trim() &&
        String(updated?.task_type || updated?.type || '').trim().toLowerCase() === 'checkin_clean'
      ) {
        await syncCheckoutOldCodeFromCheckinNewCode({ orderId: String(updated.order_id) })
      }
      if (parsed.data.keys_required !== undefined) {
        const orderId = String(updated?.order_id || '').trim()
        const nextK0 = updated?.keys_required == null ? null : Number(updated.keys_required)
        const nextK = Number.isFinite(nextK0 as any) ? Math.max(1, Math.min(2, Math.trunc(nextK0 as any))) : null
        if (orderId && nextK != null) {
          try {
            await pgPool.query(
              `UPDATE cleaning_tasks
               SET keys_required = $1, updated_at = now()
               WHERE order_id::text = $2::text
                 AND ${activeCleaningTaskWhereSql('')}
                 AND COALESCE(keys_required, 1) <> $1`,
              [nextK, orderId],
            )
          } catch {}
        }
      }
      try {
        const actualChangedFields = actualCleaningTaskChangedFields(before, updated, keys)
        if (actualChangedFields.length) {
          const workPatch = buildCleaningTaskWorkPatch(updated, actualChangedFields)
          await emitWorkTaskEvent({
            taskId: `cleaning_task:${String(id)}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: [String(id)],
            eventType: 'TASK_UPDATED',
            changeScope: workPatch.changedFields.some((field) => field === 'checkout_time' || field === 'checkin_time' || field === 'start_time' || field === 'end_time' || field === 'summary') ? 'list' : 'detail',
            changedFields: workPatch.changedFields,
            patch: workPatch.patch,
            causedByUserId: String((req as any)?.user?.sub || '').trim() || null,
            visibilityHints: buildCleaningTaskVisibilityHints(updated),
          })
        }
      } catch {}
      try {
        const { changes, lines } = buildCleaningTaskUpdateNoticeDetails(before, updated)
        const propertyId = String(updated.property_id || '').trim()
        if (changes.length && propertyId) {
          const title = lines.length ? '任务信息更新' : null
          const body = lines.length ? lines.join('\n') : null
          const data = lines.length
            ? { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'cleaning_task_manager_fields_updated' }
            : { entity: 'cleaning_task', entityId: String(id), action: 'open_task' }
          enqueueNotification(async () =>
            emitNotificationEvent(
              {
                type: 'CLEANING_TASK_UPDATED',
                policyKey: 'task_requirements_changed',
                entity: 'cleaning_task',
                entityId: String(id),
                propertyId,
                updatedAt: opNow,
                changes,
                title,
                body,
                data,
                actorUserId: (req as any).user?.sub,
              },
              { operationId },
            ),
          )
        }
      } catch {}
      return res.json(updated)
    }

    const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
    if (!task) return res.status(404).json({ message: 'task not found' })
    const before = { ...task }
    if ((parsed.data as any).keys_required !== undefined && String((task as any).order_id || '').trim()) {
      return res.status(400).json({ message: '该任务关联订单，钥匙套数请按订单更新（orders.keys_required）' })
    }
    if ((parsed.data as any).keys_required === null) (parsed.data as any).keys_required = 1
    const localPatch: any = { ...parsed.data }
    if (localPatch.guest_special_request === undefined && localPatch.note !== undefined) localPatch.guest_special_request = localPatch.note
    delete localPatch.note
    const isKeyHandoverExecution = isCheckinKeyHandoverTask({
      task_type: localPatch.task_type ?? task.task_type,
      inspection_scope: localPatch.inspection_scope ?? task.inspection_scope,
    })
    if (isKeyHandoverExecution && !(await isValidAnyStaffId(localPatch.assignee_id ?? null))) return res.status(400).json({ message: '无效的执行人' })
    validateAndApplyInspectionPatch({ patch: localPatch as any, current: task })
    if (localPatch.property_id !== undefined) task.property_id = localPatch.property_id
    if (localPatch.task_date !== undefined) { task.task_date = localPatch.task_date; task.date = localPatch.task_date }
    if (localPatch.status !== undefined) task.status = localPatch.status
    if (localPatch.cleaner_id !== undefined) task.cleaner_id = localPatch.cleaner_id
    if (localPatch.inspector_id !== undefined) task.inspector_id = localPatch.inspector_id
    if (localPatch.inspection_scope !== undefined) task.inspection_scope = normalizeInspectionScope(localPatch.inspection_scope)
    if (localPatch.inspection_mode !== undefined) task.inspection_mode = localPatch.inspection_mode
    if (localPatch.inspection_due_date !== undefined) task.inspection_due_date = localPatch.inspection_due_date
    if (localPatch.keys_required !== undefined) task.keys_required = localPatch.keys_required
    if (localPatch.nights_override !== undefined) task.nights_override = localPatch.nights_override
    if (localPatch.old_code !== undefined) task.old_code = localPatch.old_code
    if (localPatch.new_code !== undefined) task.new_code = localPatch.new_code
    if (localPatch.checkout_time !== undefined) task.checkout_time = localPatch.checkout_time
    if (localPatch.checkin_time !== undefined) task.checkin_time = localPatch.checkin_time
    if (localPatch.assignee_id !== undefined) task.assignee_id = localPatch.assignee_id
    if (isKeyHandoverExecution) {
      if (localPatch.assignee_id !== undefined && localPatch.cleaner_id === undefined) task.cleaner_id = null
    } else {
      if (localPatch.cleaner_id !== undefined && localPatch.assignee_id === undefined) task.assignee_id = localPatch.cleaner_id
      if (localPatch.assignee_id !== undefined && localPatch.cleaner_id === undefined) task.cleaner_id = localPatch.assignee_id
    }
    if (localPatch.scheduled_at !== undefined) task.scheduled_at = localPatch.scheduled_at
    if (localPatch.guest_special_request !== undefined) task.guest_special_request = localPatch.guest_special_request
    if (
      localPatch.new_code !== undefined &&
      String((task as any).order_id || '').trim() &&
      String((task as any).task_type || (task as any).type || '').trim().toLowerCase() === 'checkin_clean'
    ) {
      await syncCheckoutOldCodeFromCheckinNewCode({ orderId: String((task as any).order_id) })
    }
    {
      const beforeStatus = String((before as any).status || 'pending')
      const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned'
      const incomingStatus = (parsed.data as any).status
      const incomingStatusEligible =
        incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned'
      const touchingAssignees =
        (parsed.data as any).cleaner_id !== undefined ||
        (parsed.data as any).inspector_id !== undefined ||
        parsed.data.assignee_id !== undefined ||
        (parsed.data as any).inspection_mode !== undefined ||
        (parsed.data as any).inspection_due_date !== undefined
      if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
        const cleaner = String(task.cleaner_id || task.assignee_id || '').trim()
        const inspector = String(task.inspector_id || '').trim()
        task.status = assignedStatusFromAssignees(cleaner, inspector)
      }
    }
    if ((parsed.data as any).keys_required !== undefined) {
      const orderId = String((task as any).order_id || '').trim()
      const nextK0 = (task as any).keys_required == null ? null : Number((task as any).keys_required)
      const nextK = Number.isFinite(nextK0 as any) ? Math.max(1, Math.min(2, Math.trunc(nextK0 as any))) : null
      if (orderId && nextK != null) {
        for (const t of (db.cleaningTasks as any[])) {
          if (String((t as any).order_id || '').trim() !== orderId) continue
          if (String((t as any).status || '') === 'cancelled') continue
          ;(t as any).keys_required = nextK
        }
      }
    }
    try {
      const actualChangedFields = actualCleaningTaskChangedFields(before, task, Object.keys(localPatch || {}))
      if (actualChangedFields.length) {
        const workPatch = buildCleaningTaskWorkPatch(task, actualChangedFields)
        await emitWorkTaskEvent({
          taskId: `cleaning_task:${String(id)}`,
          sourceType: 'cleaning_tasks',
          sourceRefIds: [String(id)],
          eventType: 'TASK_UPDATED',
          changeScope: workPatch.changedFields.some((field) => field === 'checkout_time' || field === 'checkin_time' || field === 'start_time' || field === 'end_time' || field === 'summary') ? 'list' : 'detail',
          changedFields: workPatch.changedFields,
          patch: workPatch.patch,
          causedByUserId: String((req as any)?.user?.sub || '').trim() || null,
          visibilityHints: buildCleaningTaskVisibilityHints(task),
        })
      }
    } catch {}
    try {
      const { changes, lines } = buildCleaningTaskUpdateNoticeDetails(before, task)
      const propertyId = String((task as any).property_id || '').trim()
      if (changes.length && propertyId) {
        const title = lines.length ? '任务信息更新' : null
        const body = lines.length ? lines.join('\n') : null
        const data = lines.length
          ? { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'cleaning_task_manager_fields_updated' }
          : { entity: 'cleaning_task', entityId: String(id), action: 'open_task' }
        enqueueNotification(async () =>
          emitNotificationEvent(
            {
              type: 'CLEANING_TASK_UPDATED',
              policyKey: 'task_requirements_changed',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: opNow,
              changes,
              title,
              body,
              data,
              actorUserId: (req as any).user?.sub,
            },
            { operationId },
          ),
        )
      }
    } catch {}
    return res.json(task)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update_failed' })
  }
})

const createTaskSchema = z.object({
  task_type: z.enum(['checkout_clean', 'checkin_clean', 'stayover_clean']).optional(),
  create_mode: z.enum(['checkout', 'checkin', 'turnover', 'stayover']).optional(),
  task_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  property_id: z.string().min(1),
  status: z.enum(['pending', 'assigned', 'in_progress', 'completed', 'cancelled', 'keys_hung']).optional(),
  cleaner_id: z.union([z.string().min(1), z.null()]).optional(),
  inspector_id: z.union([z.string().min(1), z.null()]).optional(),
  inspection_mode: z.enum(['pending_decision', 'same_day', 'deferred', 'self_complete', 'checked_done']).optional().nullable(),
  inspection_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  scheduled_at: z.union([z.string().min(1), z.null()]).optional(),
  old_code: z.union([z.string(), z.null()]).optional(),
  new_code: z.union([z.string(), z.null()]).optional(),
  checkout_time: z.union([z.string(), z.null()]).optional(),
  checkin_time: z.union([z.string(), z.null()]).optional(),
  keys_required: z
    .preprocess((v) => {
      if (v == null) return v
      if (typeof v === 'number') return v
      const n = Number(v)
      return Number.isFinite(n) ? n : v
    }, z.number().int().min(1).max(2))
    .optional()
    .nullable(),
  nights_override: z.union([z.number().int().nonnegative(), z.null()]).optional(),
  guest_special_request: z.union([z.string(), z.null()]).optional(),
  note: z.union([z.string(), z.null()]).optional(),
}).strict()

router.post('/tasks', requireCleaningManualCreateAccess, async (req, res) => {
  const parsed = createTaskSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!(await isValidStaffId((parsed.data as any).cleaner_id ?? null, 'cleaner'))) return res.status(400).json({ message: '无效的清洁人员' })
  if (!(await isValidStaffId((parsed.data as any).inspector_id ?? null, 'inspector'))) return res.status(400).json({ message: '无效的检查人员' })
  const operationId = uuid()
  try {
    const mode = (parsed.data as any).create_mode
    const taskType = parsed.data.task_type
    if (!mode && !taskType) return res.status(400).json({ message: 'missing task_type' })
    const types =
      mode === 'turnover' ? ['checkout_clean', 'checkin_clean'] :
      mode === 'checkout' ? ['checkout_clean'] :
      mode === 'checkin' ? ['checkin_clean'] :
      mode === 'stayover' ? ['stayover_clean'] :
      [String(taskType)]

    const createdRows: any[] = []
    const rawPropertyId = String(parsed.data.property_id || '').trim()
    let normalizedPropertyId = rawPropertyId
    if (hasPg && pgPool) {
      try {
        const r = await pgPool.query('SELECT id::text AS id FROM properties WHERE id::text=$1 OR upper(code)=upper($1) LIMIT 1', [rawPropertyId])
        const row = r?.rows?.[0]
        const id = row?.id ? String(row.id) : ''
        if (!id) return res.status(400).json({ message: '无效的房源' })
        normalizedPropertyId = id
      } catch {}
    } else {
      const anyDb: any = db as any
      const props: any[] = Array.isArray(anyDb?.properties) ? anyDb.properties : []
      const found = props.find((p) => String(p?.id || '') === rawPropertyId || String(p?.code || '').toLowerCase() === rawPropertyId.toLowerCase())
      const id = found?.id ? String(found.id) : ''
      if (!id) return res.status(400).json({ message: '无效的房源' })
      normalizedPropertyId = id
    }
    const base: any = {
      order_id: null,
      property_id: normalizedPropertyId,
      task_date: parsed.data.task_date,
      date: parsed.data.task_date,
      status: parsed.data.status || assignedStatusFromAssignees(parsed.data.cleaner_id ?? null, (parsed.data as any).inspector_id ?? null),
      assignee_id: (parsed.data.cleaner_id ?? null),
      cleaner_id: (parsed.data.cleaner_id ?? null),
      inspector_id: (parsed.data.inspector_id ?? null),
      scheduled_at: parsed.data.scheduled_at ?? null,
      old_code: parsed.data.old_code ?? null,
      new_code: parsed.data.new_code ?? null,
      checkout_time: parsed.data.checkout_time ?? null,
      checkin_time: parsed.data.checkin_time ?? null,
      keys_required: parsed.data.keys_required == null ? 1 : parsed.data.keys_required,
      nights_override: (parsed.data as any).nights_override ?? null,
      guest_special_request: (parsed.data as any).guest_special_request ?? (parsed.data as any).note ?? null,
      auto_sync_enabled: true,
      source: 'manual',
      execution_state: 'active',
      manual_task_purpose: null,
    }
    if (hasPg && pgPool) {
      await ensureCleaningSchemaV2()
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        for (const tt of types) {
          const row: any = {
            id: uuid(),
            ...base,
            task_type: tt,
            type: tt,
            inspection_mode: normalizeInspectionMode((parsed.data as any).inspection_mode) || defaultInspectionModeForTaskType(tt),
            inspection_due_date: (parsed.data as any).inspection_due_date ?? null,
          }
          validateAndApplyInspectionPatch({ patch: row, taskType: tt })
          const keys = Object.keys(row).filter((k) => row[k] !== undefined)
          const cols = keys.map((k) => `"${k}"`).join(', ')
          const args = keys.map((_, i) => `$${i + 1}`).join(', ')
          const values = keys.map((k) => row[k])
          const sql = `INSERT INTO cleaning_tasks(${cols}) VALUES(${args}) RETURNING *`
          const r = await client.query(sql, values)
          const created = r?.rows?.[0] || row
          createdRows.push(created)
          await emitWorkTaskEvent({
            taskId: `cleaning_task:${String(created.id)}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: [String(created.id)],
            eventType: 'TASK_CREATED',
            changeScope: 'list',
            changedFields: ['task_type', 'task_date', 'date', 'status', 'assignee_id', 'cleaner_id', 'inspector_id', 'scheduled_at', 'property_id'],
            patch: {
              id: created.id,
              task_type: created.task_type,
              task_date: created.task_date,
              date: created.date,
              status: created.status,
              assignee_id: created.assignee_id,
              cleaner_id: created.cleaner_id,
              inspector_id: created.inspector_id,
              scheduled_at: created.scheduled_at,
              property_id: created.property_id,
            },
            causedByUserId: String((req as any)?.user?.sub || '').trim() || null,
            visibilityHints: buildCleaningTaskVisibilityHints(created),
          }, client)
        }
        await client.query('COMMIT')
      } catch (e) {
        try { await client.query('ROLLBACK') } catch {}
        throw e
      } finally {
        client.release()
      }
      for (const created of createdRows) {
        try {
          const { changes, lines } = buildCleaningTaskCreateNoticeDetails(created)
          const propertyId = String(created?.property_id || '').trim()
          if (!changes.length || !propertyId) continue
          enqueueNotification(async () =>
            emitNotificationEvent(
              {
                type: 'CLEANING_TASK_UPDATED',
                policyKey: 'task_requirements_changed',
                entity: 'cleaning_task',
                entityId: String(created.id),
                propertyId,
                updatedAt: new Date().toISOString(),
                changes,
                title: '任务信息更新',
                body: lines.join('\n'),
                data: { entity: 'cleaning_task', entityId: String(created.id), action: 'open_task', kind: 'cleaning_task_manager_fields_updated' },
                actorUserId: (req as any).user?.sub,
              },
              { operationId },
            ),
          )
        } catch {}
      }
      if (createdRows.length === 1) return res.json(createdRows[0])
      return res.json({ ok: true, created: createdRows.length })
    }
    for (const tt of types) {
      const row: any = {
        id: uuid(),
        ...base,
        task_type: tt,
        type: tt,
        inspection_mode: normalizeInspectionMode((parsed.data as any).inspection_mode) || defaultInspectionModeForTaskType(tt),
        inspection_due_date: (parsed.data as any).inspection_due_date ?? null,
      }
      validateAndApplyInspectionPatch({ patch: row, taskType: tt })
      ;(db.cleaningTasks as any[]).push(row)
      createdRows.push(row)
    }
    if (createdRows.length === 1) return res.json(createdRows[0])
    return res.json({ ok: true, created: createdRows.length })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create_failed' })
  }
})

router.delete('/tasks/:id', requirePerm('cleaning.task.assign'), async (req, res) => {
  const { id } = req.params
  const actor = (req as any).user
  const actorId = actor?.sub ? String(actor.sub) : undefined
  try {
    if (hasPg && pgPool) {
      const r0 = await pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [String(id)])
      const before = r0?.rows?.[0] || null
      if (!before) return res.status(404).json({ message: 'task not found' })
      const r1 = await pgPool.query(`UPDATE cleaning_tasks SET status='cancelled', execution_state='cancelled', auto_sync_enabled=false, updated_at=now() WHERE id=$1 RETURNING *`, [String(id)])
      const after = r1?.rows?.[0] || null
      await emitWorkTaskEvent({
        taskId: `cleaning_task:${String(id)}`,
        sourceType: 'cleaning_tasks',
        sourceRefIds: [String(id)],
        eventType: 'TASK_REMOVED',
        changeScope: 'membership',
        changedFields: ['status', 'execution_state'],
        patch: { status: 'cancelled', execution_state: 'cancelled' },
        causedByUserId: actorId || null,
        visibilityHints: buildCleaningTaskVisibilityHints(after || before),
      })
      try {
        const propertyId = String((after || before)?.property_id || '').trim()
        if (propertyId) {
          const { title, body } = buildCleaningTaskDeletionNotice(after || before)
          await emitNotificationEvent(
            {
              type: 'CLEANING_TASK_UPDATED',
              policyKey: 'task_deleted',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: String(after?.updated_at || before?.updated_at || '').trim() || new Date().toISOString(),
              changes: ['deleted', 'status'],
              title,
              body,
              data: {
                entity: 'cleaning_task',
                entityId: String(id),
                action: 'open_notice',
                task_id: String(id),
                task_type: String((after || before)?.task_type || (after || before)?.type || ''),
                task_date: cleanNotificationText((after || before)?.task_date || (after || before)?.date) || null,
                status: 'cancelled',
              },
              actorUserId: actorId || null,
            },
            { operationId: uuid() },
          )
        }
      } catch {}
      addAudit('cleaning_task', String(id), 'delete', before, after, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') })
      return res.json({ ok: true })
    }
    const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
    if (!task) return res.status(404).json({ message: 'task not found' })
    const before = { ...task }
    task.status = 'cancelled'
    task.execution_state = 'cancelled'
    task.auto_sync_enabled = false
    addAudit('cleaning_task', String(id), 'delete', before, { ...task }, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') })
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'delete_failed' })
  }
})

const bulkDeleteSchema = z.object({ ids: z.array(z.string().min(1)).min(1) }).strict()
router.post('/tasks/bulk-delete', requirePerm('cleaning.task.assign'), async (req, res) => {
  const parsed = bulkDeleteSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const actor = (req as any).user
  const actorId = actor?.sub ? String(actor.sub) : undefined
  const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)))
  try {
    if (hasPg && pgPool) {
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        for (const id of ids) {
          const r0 = await client.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
          const before = r0?.rows?.[0] || null
          if (!before) continue
          const r1 = await client.query(`UPDATE cleaning_tasks SET status='cancelled', execution_state='cancelled', auto_sync_enabled=false, updated_at=now() WHERE id=$1 RETURNING *`, [id])
          const after = r1?.rows?.[0] || null
          await emitWorkTaskEvent({
            taskId: `cleaning_task:${String(id)}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: [String(id)],
            eventType: 'TASK_REMOVED',
            changeScope: 'membership',
            changedFields: ['status', 'execution_state'],
            patch: { status: 'cancelled', execution_state: 'cancelled' },
            causedByUserId: actorId || null,
            visibilityHints: buildCleaningTaskVisibilityHints(after || before),
          }, client)
          try {
            const propertyId = String((after || before)?.property_id || '').trim()
            if (propertyId) {
              const { title, body } = buildCleaningTaskDeletionNotice(after || before)
              await emitNotificationEvent(
                {
                  type: 'CLEANING_TASK_UPDATED',
                  policyKey: 'task_deleted',
                  entity: 'cleaning_task',
                  entityId: String(id),
                  propertyId,
                  updatedAt: String(after?.updated_at || before?.updated_at || '').trim() || new Date().toISOString(),
                  changes: ['deleted', 'status'],
                  title,
                  body,
                  data: {
                    entity: 'cleaning_task',
                    entityId: String(id),
                    action: 'open_notice',
                    task_id: String(id),
                    task_type: String((after || before)?.task_type || (after || before)?.type || ''),
                    task_date: cleanNotificationText((after || before)?.task_date || (after || before)?.date) || null,
                    status: 'cancelled',
                  },
                  actorUserId: actorId || null,
                },
                { operationId: uuid(), pgClient: client },
              )
            }
          } catch {}
          addAudit('cleaning_task', String(id), 'delete', before, after, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') })
        }
        await client.query('COMMIT')
      } catch (e) {
        try { await client.query('ROLLBACK') } catch {}
        throw e
      } finally {
        client.release()
      }
      return res.json({ ok: true, deleted: ids.length })
    }
    let cnt = 0
    for (const id of ids) {
      const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
      if (!task) continue
      const before = { ...task }
      task.status = 'cancelled'
      task.execution_state = 'cancelled'
      task.auto_sync_enabled = false
      addAudit('cleaning_task', String(id), 'delete', before, { ...task }, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') })
      cnt++
    }
    return res.json({ ok: true, deleted: cnt })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'bulk_delete_failed' })
  }
})

const bulkPatchSchema = z.object({ ids: z.array(z.string().min(1)).min(1), patch: patchTaskSchema }).strict()
router.post('/tasks/bulk-patch', requirePerm('cleaning.task.assign'), async (req, res) => {
  const parsed = bulkPatchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!(await isValidStaffId((parsed.data.patch as any).cleaner_id ?? null, 'cleaner'))) return res.status(400).json({ message: '无效的清洁人员' })
  if (!(await isValidStaffId((parsed.data.patch as any).inspector_id ?? null, 'inspector'))) return res.status(400).json({ message: '无效的检查人员' })
  if (!(await isValidAnyStaffId((parsed.data.patch as any).assignee_id ?? null))) return res.status(400).json({ message: '无效的执行人' })
  const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)))
  const basePatch: any = { ...parsed.data.patch }
  if (basePatch.guest_special_request === undefined && basePatch.note !== undefined) basePatch.guest_special_request = basePatch.note
  delete basePatch.note
  if (basePatch.keys_required === null) basePatch.keys_required = 1
  if (basePatch.cleaner_id !== undefined && basePatch.assignee_id === undefined) basePatch.assignee_id = basePatch.cleaner_id
  if (basePatch.assignee_id !== undefined && basePatch.cleaner_id === undefined) basePatch.cleaner_id = basePatch.assignee_id
  try {
    const updated: any[] = []
    if (basePatch.keys_required !== undefined) {
      if (hasPg && pgPool) {
        const r = await pgPool.query(
          `SELECT COUNT(1) AS cnt
           FROM cleaning_tasks
           WHERE id::text = ANY($1::text[])
             AND order_id IS NOT NULL`,
          [ids],
        )
        const cnt = r?.rows?.[0]?.cnt == null ? 0 : Number(r.rows[0].cnt)
        if (Number.isFinite(cnt) && cnt > 0) return res.status(400).json({ message: '批量任务包含关联订单的任务，钥匙套数请按订单更新（orders.keys_required）' })
      } else {
        const hasOrder = ids.some((id) => {
          const t = (db.cleaningTasks as any[]).find((x: any) => String(x.id) === String(id))
          return !!String((t as any)?.order_id || '').trim()
        })
        if (hasOrder) return res.status(400).json({ message: '批量任务包含关联订单的任务，钥匙套数请按订单更新（orders.keys_required）' })
      }
    }
    for (const id of ids) {
      const r = await (async () => {
        if (hasPg && pgPool) {
          await ensureCleaningSchemaV2()
          const r0 = await pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
          const before = r0?.rows?.[0] || null
          if (!before) return null
          const patch: any = { ...basePatch }
          if (patch.task_date != null) patch.date = patch.task_date
          validateAndApplyInspectionPatch({ patch, current: before })
          {
            const beforeStatus = String(before.status || 'pending')
            const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned'
            const incomingStatus = (basePatch as any).status
            const incomingStatusEligible =
              incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned'
            const touchingAssignees =
              (basePatch as any).cleaner_id !== undefined ||
              (basePatch as any).inspector_id !== undefined ||
              (basePatch as any).assignee_id !== undefined ||
              (basePatch as any).inspection_mode !== undefined ||
              (basePatch as any).inspection_due_date !== undefined
            if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
              const nextCleanerId = patch.cleaner_id !== undefined ? (patch.cleaner_id ?? null) : (before.cleaner_id ?? before.assignee_id ?? null)
              const nextInspectorId = patch.inspector_id !== undefined ? (patch.inspector_id ?? null) : (before.inspector_id ?? null)
              patch.status = assignedStatusFromAssignees(nextCleanerId, nextInspectorId)
            }
          }
          patch.updated_at = new Date().toISOString()
          const keys = Object.keys(patch).filter((k) => patch[k] !== undefined)
          if (!keys.length) return before
          const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(', ')
          const values = keys.map((k) => (patch[k] === undefined ? null : patch[k]))
          const sql = `UPDATE cleaning_tasks SET ${set} WHERE id=$${keys.length + 1} RETURNING *`
          const r1 = await pgPool.query(sql, [...values, id])
          const after = r1?.rows?.[0] || before
          if (
            basePatch.new_code !== undefined &&
            String(after?.order_id || '').trim() &&
            String(after?.task_type || after?.type || '').trim().toLowerCase() === 'checkin_clean'
          ) {
            await syncCheckoutOldCodeFromCheckinNewCode({ orderId: String(after.order_id) })
          }
          const changedFields = Object.keys(patch || {}).filter((key) => patch[key] !== undefined)
          const assignmentChanged = ['assignee_id', 'cleaner_id', 'inspector_id'].some((key) => changedFields.includes(key))
          await emitWorkTaskEvent({
            taskId: `cleaning_task:${String(id)}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: [String(id)],
            eventType: assignmentChanged ? 'TASK_ASSIGNMENT_CHANGED' : (String(after?.status || '').trim().toLowerCase() === 'cancelled' ? 'TASK_REMOVED' : 'TASK_UPDATED'),
            changeScope: assignmentChanged ? 'membership' : (String(after?.status || '').trim().toLowerCase() === 'cancelled' ? 'membership' : 'list'),
            changedFields,
            patch: Object.fromEntries(changedFields.map((field) => [field, (after as any)?.[field]])),
            causedByUserId: String((req as any)?.user?.sub || '').trim() || null,
            visibilityHints: buildCleaningTaskVisibilityHints(after || before),
          })
          return after
        }
        const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
        if (!task) return null
        const patch: any = { ...basePatch }
        validateAndApplyInspectionPatch({ patch, current: task })
        if (patch.property_id !== undefined) task.property_id = patch.property_id
        if (patch.task_date !== undefined) { task.task_date = patch.task_date; task.date = patch.task_date }
        if (patch.status !== undefined) task.status = patch.status
        if (patch.cleaner_id !== undefined) task.cleaner_id = patch.cleaner_id
        if (patch.inspector_id !== undefined) task.inspector_id = patch.inspector_id
        if (patch.assignee_id !== undefined) task.assignee_id = patch.assignee_id
        if (patch.inspection_mode !== undefined) task.inspection_mode = patch.inspection_mode
        if (patch.inspection_due_date !== undefined) task.inspection_due_date = patch.inspection_due_date
        if (patch.keys_required !== undefined) task.keys_required = patch.keys_required
        if (patch.old_code !== undefined) task.old_code = patch.old_code
        if (patch.new_code !== undefined) task.new_code = patch.new_code
        if (patch.scheduled_at !== undefined) task.scheduled_at = patch.scheduled_at
        if (patch.guest_special_request !== undefined) task.guest_special_request = patch.guest_special_request
        if (
          patch.new_code !== undefined &&
          String((task as any).order_id || '').trim() &&
          String((task as any).task_type || (task as any).type || '').trim().toLowerCase() === 'checkin_clean'
        ) {
          await syncCheckoutOldCodeFromCheckinNewCode({ orderId: String((task as any).order_id) })
        }
        {
          const beforeStatus = String((task as any).status || 'pending')
          const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned'
          const incomingStatus = (patch as any).status
          const incomingStatusEligible =
            incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned'
          const touchingAssignees =
            (patch as any).cleaner_id !== undefined ||
            (patch as any).inspector_id !== undefined ||
            (patch as any).assignee_id !== undefined ||
            (patch as any).inspection_mode !== undefined ||
            (patch as any).inspection_due_date !== undefined
          if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
            const cleaner = String(task.cleaner_id || task.assignee_id || '').trim()
            const inspector = String(task.inspector_id || '').trim()
            ;(task as any).status = assignedStatusFromAssignees(cleaner, inspector)
          }
        }
        return task
      })()
      if (r) updated.push(r)
    }
    return res.json({ ok: true, updated: updated.length })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'bulk_patch_failed' })
  }
})

const bulkIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1) }).strict()

router.post('/tasks/bulk-lock-auto-sync', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const parsed = bulkIdsSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)))
  if (!ids.length) return res.status(400).json({ message: 'ids required' })
  try {
    if (hasPg && pgPool) {
      const r = await pgPool.query(
        'UPDATE cleaning_tasks SET auto_sync_enabled=false, updated_at=now() WHERE id = ANY($1::text[]) RETURNING id',
        [ids]
      )
      return res.json({ ok: true, updated: r?.rowCount || 0 })
    }
    let cnt = 0
    for (const id of ids) {
      const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
      if (!task) continue
      task.auto_sync_enabled = false
      cnt++
    }
    return res.json({ ok: true, updated: cnt })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'bulk_lock_failed' })
  }
})

router.post('/tasks/bulk-restore-auto-sync', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const parsed = bulkIdsSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)))
  if (!ids.length) return res.status(400).json({ message: 'ids required' })
  try {
    if (hasPg && pgPool) {
      const r = await pgPool.query(
        'UPDATE cleaning_tasks SET auto_sync_enabled=true, updated_at=now() WHERE id = ANY($1::text[]) RETURNING id, order_id',
        [ids]
      )
      const orderIds = Array.from(new Set((r?.rows || []).map((x: any) => String(x?.order_id || '')).filter(Boolean)))
      if (orderIds.length) {
        try {
          const { pgRunInTransaction } = require('../dbAdapter')
          const { enqueueCleaningSyncJobTx } = require('../services/cleaningSyncJobs')
          const idsForJob = orderIds.slice()
          setTimeout(() => {
            ;(async () => {
              await pgRunInTransaction(async (client: any) => {
                for (const orderId of idsForJob) {
                  try {
                    await enqueueCleaningSyncJobTx(client, { order_id: orderId, action: 'updated', payload_snapshot: { id: orderId } })
                  } catch {}
                }
              })
            })().catch(() => {})
          }, 0)
        } catch {}
      }
      return res.json({ ok: true, updated: r?.rowCount || 0 })
    }
    let cnt = 0
    for (const id of ids) {
      const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
      if (!task) continue
      task.auto_sync_enabled = true
      cnt++
    }
    return res.json({ ok: true, updated: cnt })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'bulk_restore_failed' })
  }
})

router.post('/tasks/:id/restore-auto-sync', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg && pgPool) {
      const r0 = await pgPool.query('SELECT * FROM cleaning_tasks WHERE id = $1 LIMIT 1', [String(id)])
      const task = r0?.rows?.[0] || null
      if (!task) return res.status(404).json({ message: 'task not found' })
      const r1 = await pgPool.query('UPDATE cleaning_tasks SET auto_sync_enabled=true, updated_at=now() WHERE id=$1 RETURNING *', [String(id)])
      const updated = r1?.rows?.[0] || task
      const orderId = updated?.order_id ? String(updated.order_id) : ''
      if (orderId) {
        try {
          const { pgRunInTransaction } = require('../dbAdapter')
          const { enqueueCleaningSyncJobTx } = require('../services/cleaningSyncJobs')
          await pgRunInTransaction(async (client: any) => {
            await enqueueCleaningSyncJobTx(client, { order_id: orderId, action: 'updated', payload_snapshot: { id: orderId } })
          })
        } catch {}
      }
      return res.json({ ok: true, task: updated })
    }
    const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
    if (!task) return res.status(404).json({ message: 'task not found' })
    task.auto_sync_enabled = true
    return res.json({ ok: true, task })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'restore_failed' })
  }
})

router.get('/sync-logs', requireAnyPerm(['cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const orderId = String((req.query as any)?.order_id || '').trim() || null
  const limitRaw = Number((req.query as any)?.limit || 100)
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 100))
  try {
    if (!hasPg || !pgPool) return res.json([])
    if (orderId) {
      const r = await pgPool.query('SELECT * FROM cleaning_sync_logs WHERE (order_id::text)=$1 ORDER BY created_at DESC LIMIT $2', [orderId, limit])
      return res.json(r?.rows || [])
    }
    const r = await pgPool.query('SELECT * FROM cleaning_sync_logs ORDER BY created_at DESC LIMIT $1', [limit])
    return res.json(r?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'logs_failed' })
  }
})

const rangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

router.get('/calendar-range', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const parsed = rangeSchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const from = parsed.data.from
  const to = parsed.data.to
  const includeDeferredInspection = String((req.query as any)?.include_deferred_inspection || '').trim() === '1'
  try {
    const items: any[] = []
    if (hasPg && pgPool) {
      await ensureCleaningSchemaV2()
      const r = await pgPool.query(
        `SELECT
           t.id,
           t.order_id,
           COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
           COALESCE(p_id.code::text, p_code.code::text) AS property_code,
           COALESCE(p_id.region::text, p_code.region::text) AS property_region,
           t.task_type,
           COALESCE(t.task_date, t.date)::text AS task_date,
           t.status,
           t.assignee_id,
           t.cleaner_id,
           t.inspector_id,
           t.inspection_mode,
           t.inspection_scope,
           t.inspection_due_date::text AS inspection_due_date,
           t.scheduled_at,
           t.key_photo_uploaded_at,
           key_media.task_id IS NOT NULL AS has_key_photo,
           t.checkout_time,
           t.checkin_time,
           t.nights_override,
           t.source,
           t.auto_sync_enabled,
           t.old_code,
           t.new_code,
           t.guest_special_request,
           t.note,
           (o.confirmation_code::text) AS order_code,
           COALESCE(t.nights_override, o.nights) AS nights
         FROM cleaning_tasks t
         LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
         LEFT JOIN (
           SELECT DISTINCT task_id::text AS task_id
           FROM cleaning_task_media
           WHERE type = 'key_photo'
         ) key_media ON key_media.task_id = t.id::text
         LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
         WHERE (
             ((COALESCE(task_date, date)::date) >= ($1::date) AND (COALESCE(task_date, date)::date) <= ($2::date))
             OR ($3::boolean = true AND t.inspection_due_date IS NOT NULL AND (t.inspection_due_date::date) <= ($2::date))
           )
           AND ${activeCleaningTaskWhereSql('t')}
           AND (t.order_id IS NULL OR o.id IS NOT NULL)
           AND (
             t.order_id IS NULL
             OR (
               COALESCE(o.status, '') <> ''
               AND lower(COALESCE(o.status, '')) <> 'invalid'
               AND lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'
             )
           )
         ORDER BY COALESCE(task_date, date) ASC, COALESCE(p_id.code, p_code.code) NULLS LAST, t.id`,
        [from, to, includeDeferredInspection]
      )
      for (const row of (r?.rows || [])) {
        const d = String(row.task_date || '').slice(0, 10)
        const rawType = row.task_type ? String(row.task_type) : 'cleaning_task'
        const inspectionMode = effectiveInspectionMode(row)
        const inspectionDueDate = dayOnly(row.inspection_due_date)
        const label =
          rawType === 'checkout_clean' ? '退房' :
          rawType === 'checkin_clean' ? '入住' :
          rawType === 'stayover_clean' ? '入住中清洁' :
          rawType
        const baseItem = {
          source: 'cleaning_tasks' as const,
          order_id: row.order_id ? String(row.order_id) : null,
          order_code: row.order_code ? String(row.order_code) : null,
          property_id: row.property_id ? String(row.property_id) : null,
          property_code: row.property_code ? String(row.property_code) : null,
          property_region: row.property_region ? String(row.property_region) : null,
          task_type: row.task_type ? String(row.task_type) : null,
          checkin_sync_status: rawType === 'checkin_clean' ? (row.order_id ? 'synced' : 'pending') : null,
          status: String(row.status || 'pending'),
          assignee_id: row.assignee_id ? String(row.assignee_id) : null,
          cleaner_id: row.cleaner_id ? String(row.cleaner_id) : (row.assignee_id ? String(row.assignee_id) : null),
          inspector_id: row.inspector_id ? String(row.inspector_id) : null,
          scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
          key_photo_uploaded_at: row.key_photo_uploaded_at ? String(row.key_photo_uploaded_at) : null,
          has_key_photo: !!row.has_key_photo,
          auto_sync_enabled: row.auto_sync_enabled !== false,
          old_code: row.old_code != null ? String(row.old_code || '') : null,
          new_code: row.new_code != null ? String(row.new_code || '') : null,
          guest_special_request: row.guest_special_request != null ? String(row.guest_special_request || '') : null,
          note: row.note != null ? String(row.note || '') : null,
          nights: row.nights != null ? Number(row.nights) : null,
          summary_checkout_time: String(row.checkout_time || '').trim() || DEFAULT_SUMMARY_CHECKOUT_TIME,
          summary_checkin_time: String(row.checkin_time || '').trim() || DEFAULT_SUMMARY_CHECKIN_TIME,
          inspection_mode: inspectionMode,
          inspection_scope: normalizeInspectionScope(row.inspection_scope),
          inspection_due_date: inspectionDueDate,
        }
        if (d >= from && d <= to) {
          items.push({
            ...baseItem,
            entity_id: String(row.id),
            entity_ids: [String(row.id)],
            label,
            task_date: d,
            cleaning_board_enabled: true,
            inspection_board_enabled: inspectionMode === 'same_day' || inspectionMode === 'pending_decision',
            deferred_inspection_view: false,
          })
        }
        if (includeDeferredInspection) {
          const projectionDate = deferredProjectionDate({
            inspectionMode,
            inspectionDueDate,
            dateFrom: from,
            dateTo: to,
            status: row.status,
          })
          if (projectionDate) {
            const deferredLabel =
              rawType === 'checkout_clean' ? '退房延期检查' :
              rawType === 'checkin_clean' ? '入住延期检查' :
              `${label}延期检查`
            items.push({
              ...baseItem,
              entity_id: `${String(row.id)}::deferred_inspection:${projectionDate}`,
              entity_ids: [String(row.id)],
              label: deferredLabel,
              task_date: projectionDate,
              cleaning_board_enabled: false,
              inspection_board_enabled: true,
              deferred_inspection_view: true,
            })
          }
        }
      }
      await ensureOfflineTasksTable()
      await backfillOfflineWorkTasks()
      const r2 = await pgPool.query(
        `SELECT
           t.id,
           t.date::text AS date,
           t.task_type,
           t.title,
           t.content,
           COALESCE(w.status, 'todo') AS status,
           t.urgency,
           t.property_id,
           w.assignee_id AS assignee_id,
           COALESCE(t.photo_urls, '[]'::jsonb) AS photo_urls,
           COALESCE(p_id.code::text, p_code.code::text) AS property_code,
           COALESCE(p_id.region::text, p_code.region::text) AS property_region
         FROM cleaning_offline_tasks t
         JOIN work_tasks w ON w.source_type = 'cleaning_offline_tasks' AND w.source_id = t.id::text
         LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
         WHERE (t.date::date) >= ($1::date) AND (t.date::date) <= ($2::date)
         ORDER BY t.date ASC, t.property_id NULLS LAST, t.id`,
        [from, to]
      )
      for (const row of (r2?.rows || [])) {
        items.push({
          source: 'offline_tasks',
          entity_id: String(row.id),
          order_id: null,
          order_code: null,
          property_id: row.property_id ? String(row.property_id) : null,
          property_code: row.property_code ? String(row.property_code) : null,
          property_region: row.property_region ? String(row.property_region) : null,
          task_type: row.task_type ? String(row.task_type) : null,
          label: String(row.title || 'offline_task'),
          content: row.content != null ? String(row.content || '') : null,
          task_date: String(row.date || '').slice(0, 10),
          status: String(row.status || 'pending'),
          assignee_id: row.assignee_id ? String(row.assignee_id) : null,
          scheduled_at: null,
          urgency: row.urgency ? String(row.urgency) : 'medium',
          photo_urls: normalizePhotoUrls(row.photo_urls),
          old_code: null,
          new_code: null,
          nights: null,
          summary_checkout_time: null,
          summary_checkin_time: null,
        })
      }
      return res.json(items)
    }

    const tasks = (db.cleaningTasks as any[]).filter((t: any) => {
      const d = String(t.task_date || t.date || '').slice(0, 10)
      return d >= from && d <= to
    })
    for (const t of tasks) {
      if (String(t.status || '') === 'cancelled') continue
      const d = String(t.task_date || t.date || '').slice(0, 10)
      const rawType = String(t.task_type || t.type || 'checkout_clean')
      const inspectionMode = effectiveInspectionMode(t)
      const inspectionDueDate = dayOnly((t as any).inspection_due_date)
      const label =
        rawType === 'checkout_clean' ? '退房' :
        rawType === 'checkin_clean' ? '入住' :
        rawType === 'stayover_clean' ? '入住中清洁' :
        rawType
      const order = (db.orders as any[]).find((o: any) => String(o.id) === String(t.order_id)) || null
      const prop = (db.properties as any[]).find((p: any) => String(p.id) === String(t.property_id)) || null
      if (t.order_id && !order) continue
      const statusLower = String(order?.status || '').trim().toLowerCase()
      if (t.order_id && (!statusLower || statusLower === 'invalid' || statusLower.includes('cancel'))) continue
      const baseItem = {
        source: 'cleaning_tasks' as const,
        order_id: t.order_id ? String(t.order_id) : null,
        order_code: order?.confirmation_code ? String(order.confirmation_code) : null,
        property_id: t.property_id ? String(t.property_id) : null,
        property_code: prop?.code ? String(prop.code) : null,
        property_region: prop?.region ? String(prop.region) : null,
        task_type: rawType || null,
        checkin_sync_status: rawType === 'checkin_clean' ? (t.order_id ? 'synced' : 'pending') : null,
        status: String(t.status || 'pending'),
        assignee_id: t.assignee_id ? String(t.assignee_id) : null,
        cleaner_id: t.cleaner_id ? String(t.cleaner_id) : (t.assignee_id ? String(t.assignee_id) : null),
        inspector_id: t.inspector_id ? String(t.inspector_id) : null,
        scheduled_at: t.scheduled_at ? String(t.scheduled_at) : null,
        auto_sync_enabled: t.auto_sync_enabled !== false,
        old_code: t.old_code != null ? String(t.old_code || '') : null,
        new_code: t.new_code != null ? String(t.new_code || '') : null,
        guest_special_request: t.guest_special_request != null ? String(t.guest_special_request || '') : null,
        note: t.note != null ? String(t.note || '') : null,
        nights: t.nights_override != null ? Number(t.nights_override) : (order?.nights != null ? Number(order.nights) : null),
        summary_checkout_time: String(t.checkout_time || '').trim() || DEFAULT_SUMMARY_CHECKOUT_TIME,
        summary_checkin_time: String(t.checkin_time || '').trim() || DEFAULT_SUMMARY_CHECKIN_TIME,
        inspection_mode: inspectionMode,
        inspection_due_date: inspectionDueDate,
      }
      items.push({
        ...baseItem,
        entity_id: String(t.id),
        entity_ids: [String(t.id)],
        label,
        task_date: d,
        cleaning_board_enabled: true,
        inspection_board_enabled: inspectionMode === 'same_day' || inspectionMode === 'pending_decision',
        deferred_inspection_view: false,
      })
      if (includeDeferredInspection) {
        const projectionDate = deferredProjectionDate({
          inspectionMode,
          inspectionDueDate,
          dateFrom: from,
          dateTo: to,
          status: t.status,
        })
        if (projectionDate) {
          const deferredLabel =
            rawType === 'checkout_clean' ? '退房延期检查' :
            rawType === 'checkin_clean' ? '入住延期检查' :
            `${label}延期检查`
          items.push({
            ...baseItem,
            entity_id: `${String(t.id)}::deferred_inspection:${projectionDate}`,
            entity_ids: [String(t.id)],
            label: deferredLabel,
            task_date: projectionDate,
            cleaning_board_enabled: false,
            inspection_board_enabled: true,
            deferred_inspection_view: true,
          })
        }
      }
    }
    const offline = (db as any).cleaningOfflineTasks || []
    for (const t of offline) {
      const d = String(t.date || '').slice(0, 10)
      if (d < from || d > to) continue
      const prop = (db.properties as any[]).find((p: any) => String(p.id) === String(t.property_id || '')) || null
      items.push({
        source: 'offline_tasks',
        entity_id: String(t.id),
        order_id: null,
        order_code: null,
        property_id: t.property_id ? String(t.property_id) : null,
        property_code: prop?.code ? String(prop.code) : null,
        property_region: prop?.region ? String(prop.region) : null,
        task_type: t.task_type ? String(t.task_type) : null,
        label: String(t.title || 'offline_task'),
        content: t.content != null ? String(t.content || '') : null,
        task_date: d,
        status: String(t.status || 'pending'),
        assignee_id: t.assignee_id ? String(t.assignee_id) : null,
        scheduled_at: null,
        urgency: t.urgency ? String(t.urgency) : 'medium',
        photo_urls: normalizePhotoUrls(t.photo_urls),
        old_code: null,
        new_code: null,
        nights: null,
        summary_checkout_time: null,
        summary_checkin_time: null,
      })
    }
    items.sort((a, b) => String(a.task_date).localeCompare(String(b.task_date)) || String(a.property_id || '').localeCompare(String(b.property_id || '')))
    return res.json(items)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'calendar_failed' })
  }
})

router.post('/backfill', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  const fromParsed = dateSchema.safeParse((req.query as any)?.date_from)
  const toParsed = dateSchema.safeParse((req.query as any)?.date_to)
  const today = auDayStr(new Date())
  const from = (fromParsed.success ? fromParsed.data : undefined) || dayOnly(new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()) || today
  const to = (toParsed.success ? toParsed.data : undefined) || dayOnly(new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()) || today
  try {
    const r = await backfillCleaningTasks({ dateFrom: from, dateTo: to })
    return res.json({ ok: true, from, to, ...r })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'backfill_failed' })
  }
})

router.get('/debug/state', requirePerm('cleaning.schedule.manage'), async (_req, res) => {
  try {
    if (!hasPg || !pgPool) {
      return res.json({
        pg: false,
        memory: { orders: (db.orders || []).length, cleaningTasks: (db.cleaningTasks || []).length, cleaners: (db.cleaners || []).length },
      })
    }
    const rDb = await pgPool.query('SELECT current_database() AS db, current_schema() AS schema')
    const rPath = await pgPool.query('SHOW search_path')
    const rTables = await pgPool.query(`SELECT table_schema FROM information_schema.tables WHERE table_name='cleaning_tasks' ORDER BY table_schema`)
    const rCountOrders = await pgPool.query('SELECT COUNT(*)::int AS c FROM orders')
    const rCountTasks = await pgPool.query('SELECT COUNT(*)::int AS c FROM cleaning_tasks')
    const rCountLogs = await pgPool.query('SELECT COUNT(*)::int AS c FROM cleaning_sync_logs')
    const rMinMax = await pgPool.query(`SELECT MIN(COALESCE(task_date, date))::text AS min, MAX(COALESCE(task_date, date))::text AS max FROM cleaning_tasks`)
    return res.json({
      pg: true,
      db: rDb?.rows?.[0] || null,
      search_path: String(rPath?.rows?.[0]?.search_path || ''),
      cleaning_tasks_schemas: (rTables?.rows || []).map((x: any) => x.table_schema),
      counts: {
        orders: rCountOrders?.rows?.[0]?.c ?? null,
        cleaning_tasks: rCountTasks?.rows?.[0]?.c ?? null,
        cleaning_sync_logs: rCountLogs?.rows?.[0]?.c ?? null,
      },
      minmax: { min: rMinMax?.rows?.[0]?.min || null, max: rMinMax?.rows?.[0]?.max || null },
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'debug_failed' })
  }
})

router.get('/debug/order-sample', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  const fromParsed = dateSchema.safeParse((req.query as any)?.from)
  const toParsed = dateSchema.safeParse((req.query as any)?.to)
  const from = fromParsed.success ? fromParsed.data : undefined
  const to = toParsed.success ? toParsed.data : undefined
  const limitRaw = Number((req.query as any)?.limit || 5)
  const limit = Math.max(1, Math.min(20, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 5))
  try {
    if (!hasPg || !pgPool) return res.json({ pg: false })
    const dayExprCheckout = `CASE WHEN substring(o.checkout::text,1,10) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN substring(o.checkout::text,1,10)::date END`
    const dayExprCheckin = `CASE WHEN substring(o.checkin::text,1,10) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN substring(o.checkin::text,1,10)::date END`
    const whereRange =
      from && to
        ? `(
            ((${dayExprCheckout}) IS NOT NULL AND (${dayExprCheckout}) >= ($1::date) AND (${dayExprCheckout}) <= ($2::date))
            OR
            ((${dayExprCheckin}) IS NOT NULL AND (${dayExprCheckin}) >= ($1::date) AND (${dayExprCheckin}) <= ($2::date))
          )`
        : `(${dayExprCheckout}) IS NOT NULL OR (${dayExprCheckin}) IS NOT NULL`
    const params = from && to ? [from, to, limit] : [limit]
    const sql = `
      SELECT
        (o.id::text) AS id,
        (o.property_id::text) AS property_id,
        COALESCE(o.status,'') AS status,
        o.checkin::text AS checkin_text,
        o.checkout::text AS checkout_text,
        o.nights AS nights,
        (${dayExprCheckin})::text AS checkin_day,
        (${dayExprCheckout})::text AS checkout_day
      FROM orders o
      WHERE ${whereRange}
      ORDER BY COALESCE((${dayExprCheckout}), (${dayExprCheckin})) ASC, o.id
      LIMIT $${from && to ? 3 : 1}
    `
    const r = await pgPool.query(sql, params)
    const rows = r?.rows || []
    const full: any[] = []
    for (const rr of rows) {
      const r2 = await pgPool.query('SELECT * FROM orders WHERE (id::text)=$1 LIMIT 1', [String(rr.id)])
      const o = r2?.rows?.[0] || null
      const checkin = o?.checkin
      const checkout = o?.checkout
      full.push({
        summary: rr,
        runtime: o
          ? {
              checkin_type: Object.prototype.toString.call(checkin),
              checkout_type: Object.prototype.toString.call(checkout),
              checkin_str: String(checkin),
              checkout_str: String(checkout),
            }
          : null,
      })
    }
    return res.json({ ok: true, from: from || null, to: to || null, limit, rows: full })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'order_sample_failed' })
  }
})

router.post('/debug/sync-one', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const schema = z.object({ order_id: z.string().min(1) }).strict()
  const parsed = schema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const orderId = String(parsed.data.order_id)
  try {
    if (!hasPg || !pgPool) return res.status(400).json({ message: 'pg=false' })
    const beforeTasks = await pgPool.query('SELECT * FROM cleaning_tasks WHERE (order_id::text)=$1 ORDER BY task_type, id', [orderId])
    const beforeCount = Number(beforeTasks?.rows?.length || 0)
    let job: any = null
    try {
      const { pgRunInTransaction } = require('../dbAdapter')
      const { enqueueCleaningSyncJobTx } = require('../services/cleaningSyncJobs')
      await pgRunInTransaction(async (client: any) => {
        job = await enqueueCleaningSyncJobTx(client, { order_id: orderId, action: 'updated', payload_snapshot: { id: orderId } })
      })
    } catch (e: any) {
      job = { error: String(e?.message || 'enqueue_failed') }
    }
    const afterTasks = await pgPool.query('SELECT * FROM cleaning_tasks WHERE (order_id::text)=$1 ORDER BY task_type, id', [orderId])
    const afterCount = Number(afterTasks?.rows?.length || 0)
    const orderRow = await pgPool.query('SELECT * FROM orders WHERE (id::text)=$1 LIMIT 1', [orderId])
    return res.json({
      ok: true,
      order_id: orderId,
      before_count: beforeCount,
      after_count: afterCount,
      job,
      order: orderRow?.rows?.[0] || null,
      tasks: afterTasks?.rows || [],
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'sync_one_failed' })
  }
})

router.get('/tasks/minmax', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  const parsed = dateSchema.safeParse((req.query as any)?.from)
  const from = parsed.success ? (parsed.data || auDayStr(new Date())) : auDayStr(new Date())
  try {
    if (!hasPg || !pgPool) return res.json({ ok: true, min: null, max: null, from })
    const sql = `SELECT MIN(COALESCE(task_date, date))::text AS min, MAX(COALESCE(task_date, date))::text AS max FROM cleaning_tasks WHERE (COALESCE(task_date, date)::date) >= ($1::date)`
    const r = await pgPool.query(sql, [from])
    const min = r?.rows?.[0]?.min ? String(r.rows[0].min).slice(0, 10) : null
    const max = r?.rows?.[0]?.max ? String(r.rows[0].max).slice(0, 10) : null
    return res.json({ ok: true, min, max, from })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'minmax_failed' })
  }
})
