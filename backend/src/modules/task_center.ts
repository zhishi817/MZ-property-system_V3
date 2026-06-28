import { Router } from 'express'
import { z } from 'zod'
import { v4 as uuid } from 'uuid'
import { requireAnyPerm, requirePerm } from '../auth'
import { db } from '../store'
import { hasPg, pgPool } from '../dbAdapter'
import { ensureCleaningSchemaV2 } from '../services/cleaningSync'
import {
  defaultInspectionModeForTaskType,
  deferredProjectionDate,
  effectiveInspectionMode,
  isInspectionModeAllowedForTask,
  mergeTurnoverTaskPlan,
} from '../lib/cleaningInspection'
import { buildCleaningTaskVisibilityHints, buildWorkTaskVisibilityHints, emitWorkTaskEvent } from '../services/workTaskEvents'
import { emitNotificationEvent } from '../services/notificationEvents'

export const router = Router()

type BoardMode = 'board' | 'region' | 'final'
type TaskSource = 'cleaning' | 'work'

const DEFAULT_SUMMARY_CHECKOUT_TIME = '10am'
const DEFAULT_SUMMARY_CHECKIN_TIME = '3pm'
const DEFERRED_ROW_KEY = 'deferred:holding'
const DEFERRED_ROW_TITLE = '未安排区域 / 后续处理'
const DEFERRED_INSPECTION_ROW_KEY = 'deferred:inspection'
const DEFERRED_INSPECTION_ROW_TITLE = '延期检查'
const COMPLETED_ROW_KEY = 'group:completed'
const COMPLETED_ROW_TITLE = '已完成'
const WORK_TASK_VISIBILITY_START = '2026-06-01'
const PROPERTY_FOLLOWUP_SOURCE_TYPES = ['property_maintenance', 'property_deep_cleaning', 'property_daily_necessities'] as const

type BoardTask = {
  item_key: string
  task_source: TaskSource
  task_id: string
  task_ids: string[]
  task_kind: string
  source_type?: string | null
  source_id?: string | null
  property_id: string | null
  property_code: string | null
  property_region: string | null
  status: string
  urgency?: string | null
  title: string
  detail: string
  summary?: string | null
  task_date: string
  assignee_id: string | null
  cleaner_id: string | null
  inspector_id: string | null
  order_id?: string | null
  order_code?: string | null
  checkin_sync_status?: 'pending' | 'synced' | null
  scheduled_at?: string | null
  auto_sync_enabled?: boolean
  has_key_photo?: boolean
  key_photo_uploaded_at?: string | null
  inspection_mode?: 'pending_decision' | 'same_day' | 'deferred' | 'self_complete' | 'checked_done' | null
  inspection_scope?: 'inspect_and_hang' | 'password_only' | null
  inspection_due_date?: string | null
  deferred_inspection_view?: boolean
  can_configure_inspection?: boolean
  old_code?: string | null
  new_code?: string | null
  nights?: number | null
  summary_checkout_time?: string | null
  summary_checkin_time?: string | null
  temporarily_skipped?: boolean
  skip_reason?: string | null
  skip_bucket?: string | null
}

type BoardSubrow = {
  subrow_key: string
  tasks: BoardTask[]
}

type BoardRow = {
  row_key: string
  row_title: string
  row_type: 'region' | 'final_group' | 'deferred'
  row_order: number
  assignments: Record<string, any>
  subrow_order: string[]
  subrows: BoardSubrow[]
}

type TaskFlag = {
  task_source: TaskSource
  task_id: string
  temporarily_skipped: boolean
  skip_reason: string | null
  bucket: string | null
}

type BoardItemLayout = {
  task_source: TaskSource
  task_id: string
  row_key: string
  subrow_key: string
  item_order: number
}

type BoardRowMeta = {
  row_key: string
  board_mode: BoardMode
  row_type: 'region' | 'final_group' | 'deferred'
  row_title: string
  row_order: number
  assignments: Record<string, any>
  subrow_order: string[]
}

type TaskSaveDiff = {
  taskId: string
  changedFields: string[]
  pushChanges: string[]
  pushRecipientUserIds: string[]
  priority?: 'high' | 'medium' | 'low'
}

const memoryTaskFlags = new Map<string, TaskFlag>()
let cleaningInspectionScopeEnsured = false
let cleaningInspectionScopeEnsuring: Promise<void> | null = null

async function ensureCleaningInspectionScopeColumn() {
  if (!hasPg || !pgPool) return
  if (cleaningInspectionScopeEnsured) return
  if (cleaningInspectionScopeEnsuring) return cleaningInspectionScopeEnsuring
  cleaningInspectionScopeEnsuring = pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspection_scope text;`)
    .then(() => {
      cleaningInspectionScopeEnsured = true
    })
    .catch((error) => {
      cleaningInspectionScopeEnsured = false
      cleaningInspectionScopeEnsuring = null
      throw error
    })
    .finally(() => {
      cleaningInspectionScopeEnsuring = null
    })
  return cleaningInspectionScopeEnsuring
}

function normalizeInspectionScope(value: any): 'inspect_and_hang' | 'password_only' | null {
  const raw = text(value).toLowerCase()
  if (!raw) return null
  return raw === 'password_only' ? 'password_only' : 'inspect_and_hang'
}
const memoryBoardItems = new Map<string, BoardItemLayout>()
const memoryBoardRows = new Map<string, BoardRowMeta>()

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
  if (s === 'keys_hung') return 'keys_hung'
  if (s === 'done' || s === 'completed' || s === 'ready') return 'done'
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

function text(v: any): string {
  return String(v ?? '').trim()
}

function lower(v: any): string {
  return text(v).toLowerCase()
}

function nullableText(v: any): string | null {
  const s = text(v)
  return s ? s : null
}

function dayText(v: any): string | null {
  const d = dayOnly(v)
  if (d) return d
  const s = text(v)
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null
}

function uniqTextList(items: any[]): string[] {
  return Array.from(new Set((items || []).map((item) => text(item)).filter(Boolean)))
}

function cleaningTaskLabel(taskTypeRaw: any) {
  const taskType = lower(taskTypeRaw)
  if (taskType === 'checkin_clean') return '入住任务'
  if (taskType === 'checkout_clean') return '退房任务'
  if (taskType === 'stayover_clean') return '入住中清洁任务'
  return '清洁任务'
}

function taskChangeLabel(change: string) {
  if (change === 'assignee') return '执行人'
  if (change === 'inspection') return '检查安排'
  if (change === 'date') return '日期'
  if (change === 'content') return '内容'
  if (change === 'status') return '状态'
  if (change === 'urgency') return '紧急度'
  return change
}

function taskChangeBody(changes: string[]) {
  const labels = uniqTextList(changes).map(taskChangeLabel)
  return labels.length ? `已更新：${labels.join('、')}` : '任务安排已更新'
}

function isImportantTaskStatus(statusRaw: any) {
  const status = lower(statusRaw)
  return status === 'done'
    || status === 'completed'
    || status === 'ready'
    || status === 'cancelled'
    || status === 'canceled'
    || status === 'keys_hung'
}

function buildCleaningSaveDiff(before: any, assignment: any): TaskSaveDiff | null {
  const taskId = text(assignment?.task_id)
  if (!taskId || !before) return null
  const oldCleaner = nullableText(before.cleaner_id || before.assignee_id)
  const nextCleaner = nullableText(assignment.cleaner_id)
  const oldAssignee = nullableText(before.assignee_id)
  const nextAssignee = nextCleaner
  const oldInspector = nullableText(before.inspector_id)
  const nextInspector = lower(assignment.status) === 'keys_hung' && !nullableText(assignment.inspector_id)
    ? oldInspector
    : nullableText(assignment.inspector_id)
  const oldInspectionMode = nullableText(before.inspection_mode)
  const nextInspectionMode = nullableText(assignment.inspection_mode)
  const oldInspectionScope = normalizeInspectionScope(before.inspection_scope)
  const nextInspectionScope = normalizeInspectionScope(assignment.inspection_scope)
  const oldInspectionDueDate = dayText(before.inspection_due_date)
  const nextInspectionDueDate = dayText(assignment.inspection_due_date)
  const oldStatus = nullableText(before.status)
  const nextStatus = nullableText(assignment.status)
  const changedFields: string[] = []
  const pushChanges: string[] = []
  const recipients: any[] = []

  const cleanerChanged = oldCleaner !== nextCleaner
  if (cleanerChanged) {
    changedFields.push('cleaner_id')
    pushChanges.push('assignee')
    recipients.push(oldCleaner, nextCleaner)
  } else if (oldAssignee !== nextAssignee) {
    changedFields.push('assignee_id')
  }

  if (oldInspector !== nextInspector) {
    changedFields.push('inspector_id')
    pushChanges.push('inspection')
    recipients.push(oldInspector, nextInspector)
  }
  if (oldInspectionMode !== nextInspectionMode) {
    changedFields.push('inspection_mode')
    pushChanges.push('inspection')
  }
  if (oldInspectionScope !== nextInspectionScope) {
    changedFields.push('inspection_scope')
    pushChanges.push('inspection')
  }
  if (oldInspectionDueDate !== nextInspectionDueDate) {
    changedFields.push('inspection_due_date')
    pushChanges.push('inspection')
  }
  if (oldStatus !== nextStatus) {
    changedFields.push('status')
    const assignmentOnlyStatus = cleanerChanged && lower(oldStatus) !== lower(nextStatus) && lower(nextStatus) === 'assigned'
    if (!assignmentOnlyStatus && isImportantTaskStatus(nextStatus)) {
      pushChanges.push('status')
    }
  }

  if (pushChanges.some((change) => change === 'inspection' || change === 'status')) {
    recipients.push(nextCleaner, nextInspector)
  }

  if (!changedFields.length) return null
  return {
    taskId,
    changedFields: uniqTextList(changedFields),
    pushChanges: uniqTextList(pushChanges),
    pushRecipientUserIds: uniqTextList(recipients),
    priority: pushChanges.includes('status') ? 'medium' : undefined,
  }
}

function buildWorkSaveDiff(before: any, assignment: any): TaskSaveDiff | null {
  const taskId = text(assignment?.task_id)
  if (!taskId || !before) return null
  const oldAssignee = nullableText(before.assignee_id)
  const nextAssignee = nullableText(assignment.assignee_id)
  const oldTitle = text(before.title)
  const nextTitle = text(assignment.title) || oldTitle
  const oldSummary = nullableText(before.summary)
  const nextSummary = nullableText(assignment.summary)
  const oldScheduledDate = dayText(before.scheduled_date)
  const nextScheduledDate = assignment.scheduled_date == null ? oldScheduledDate : dayText(assignment.scheduled_date)
  const oldStatus = nullableText(before.status)
  const nextStatus = nullableText(assignment.status) || (
    ['todo', 'assigned'].includes(lower(before.status))
      ? (nextAssignee ? 'assigned' : 'todo')
      : oldStatus
  )
  const oldUrgency = nullableText(before.urgency)
  const nextUrgency = nullableText(assignment.urgency) || oldUrgency
  const changedFields: string[] = []
  const pushChanges: string[] = []
  const recipients: any[] = []

  const assigneeChanged = oldAssignee !== nextAssignee
  if (oldTitle !== nextTitle) {
    changedFields.push('title')
    pushChanges.push('content')
  }
  if (oldSummary !== nextSummary) {
    changedFields.push('summary')
    pushChanges.push('content')
  }
  if (oldScheduledDate !== nextScheduledDate) {
    changedFields.push('scheduled_date')
    pushChanges.push('date')
  }
  if (assigneeChanged) {
    changedFields.push('assignee_id')
    pushChanges.push('assignee')
    recipients.push(oldAssignee, nextAssignee)
  }
  if (oldStatus !== nextStatus) {
    changedFields.push('status')
    const assignmentOnlyStatus = assigneeChanged && ['todo', 'assigned'].includes(lower(oldStatus)) && ['todo', 'assigned'].includes(lower(nextStatus))
    if (!assignmentOnlyStatus && isImportantTaskStatus(nextStatus)) {
      pushChanges.push('status')
    }
  }
  if (oldUrgency !== nextUrgency) {
    changedFields.push('urgency')
    pushChanges.push('urgency')
  }

  if (pushChanges.some((change) => change !== 'assignee')) {
    recipients.push(nextAssignee)
  }

  if (!changedFields.length) return null
  const onlyUrgency = pushChanges.length === 1 && pushChanges[0] === 'urgency'
  return {
    taskId,
    changedFields: uniqTextList(changedFields),
    pushChanges: uniqTextList(pushChanges),
    pushRecipientUserIds: uniqTextList(recipients),
    priority: onlyUrgency ? 'low' : 'medium',
  }
}

function normalizeBoardMode(_mode?: string | null): BoardMode {
  return 'board'
}

function propertyRegionKey(v: any): string {
  const s = text(v)
  return s ? s.toLowerCase() : ''
}

function parseJsonObject(v: any, fallback: Record<string, any> = {}): Record<string, any> {
  if (!v) return { ...fallback }
  if (typeof v === 'object' && !Array.isArray(v)) return { ...(v as any) }
  try {
    const parsed = JSON.parse(String(v))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { ...fallback }
  } catch {
    return { ...fallback }
  }
}

function parseJsonArray(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean)
  try {
    const parsed = JSON.parse(String(v ?? '[]'))
    return Array.isArray(parsed) ? parsed.map((x) => String(x)).filter(Boolean) : []
  } catch {
    return []
  }
}

function workSummaryText(raw: string | null | undefined): string {
  const s = text(raw)
  if (!s) return ''
  try {
    const j: any = JSON.parse(s)
    if (Array.isArray(j)) {
      const parts = j
        .flatMap((x) => {
          if (!x || typeof x !== 'object') return text(x)
          return [
            text((x as any).content),
            text((x as any).detail),
            text((x as any).summary),
            text((x as any).description),
          ]
        })
        .filter((part) => part && part !== '问题摘要')
      if (parts.length) return parts.join(' ')
      return ''
    }
    if (j && typeof j === 'object') {
      const c = [
        text((j as any).content),
        text((j as any).detail),
        text((j as any).summary),
        text((j as any).description),
      ].find((part) => part && part !== '问题摘要')
      if (c) return c
      return ''
    }
  } catch {}
  return s
}

function isInternalWorkRef(v: any): boolean {
  return /^(property_maintenance|property_deep_cleaning|work_tasks|cleaning_offline_tasks):[0-9a-f-]{8,}/i.test(text(v))
}

function isGeneratedWorkNo(v: any): boolean {
  return /^(R|DC)-\d{8}-[a-z0-9]+$/i.test(text(v))
}

function isPropertyFollowupTask(task: Pick<BoardTask, 'source_type'>) {
  return PROPERTY_FOLLOWUP_SOURCE_TYPES.includes(text(task.source_type) as typeof PROPERTY_FOLLOWUP_SOURCE_TYPES[number])
}

function workTaskDisplayText(row: any): { title: string; detail: string } {
  const region = text(row?.property_region)
  const propertyCode = text(row?.property_code) || text(row?.property_id)
  const rawTitle = text(row?.title)
  const rawDetail = workSummaryText(row?.summary)
  const workRef = text(row?.id)
  const taskKind = lower(row?.task_kind)
  const hideGeneratedTitle = (taskKind === 'maintenance' || taskKind === 'deep_cleaning') && isGeneratedWorkNo(rawTitle)
  const title = propertyCode
    ? (region ? `${region} ${propertyCode}` : propertyCode)
    : (!hideGeneratedTitle && rawTitle ? rawTitle : '线下任务')
  const detailParts = [
    propertyCode && rawTitle && !hideGeneratedTitle && rawTitle !== title ? rawTitle : '',
    rawDetail && rawDetail !== rawTitle ? rawDetail : '',
  ].filter((part) => part && !isInternalWorkRef(part))
  const fallback = taskKind === 'maintenance' ? '维修任务' : (taskKind === 'deep_cleaning' ? '深度清洁' : '线下任务')
  return {
    title,
    detail: detailParts.join('，') || rawDetail || (!hideGeneratedTitle ? rawTitle : '') || fallback,
  }
}

function mapWorkTaskRowToBoardTask(row: any, date: string): BoardTask {
  const display = workTaskDisplayText(row)
  return {
    item_key: `work:${String(row.id)}`,
    task_source: 'work' as const,
    task_id: String(row.id),
    task_ids: [String(row.id)],
    task_kind: String(row.task_kind || ''),
    source_type: row.source_type ? String(row.source_type) : null,
    source_id: row.source_id ? String(row.source_id) : null,
    property_id: row.property_id ? String(row.property_id) : null,
    property_code: row.property_code ? String(row.property_code) : null,
    property_region: row.property_region ? String(row.property_region) : null,
    status: normStatus(row.status),
    urgency: normUrgency(row.urgency),
    title: display.title,
    detail: display.detail,
    summary: row.summary != null ? String(row.summary || '') : null,
    task_date: row.scheduled_date ? String(row.scheduled_date).slice(0, 10) : date,
    assignee_id: row.assignee_id ? String(row.assignee_id) : null,
    cleaner_id: null,
    inspector_id: null,
  }
}

function dedupeBoardTasks(tasks: BoardTask[]): BoardTask[] {
  const out: BoardTask[] = []
  const seen = new Set<string>()
  for (const task of tasks) {
    const sourceType = text(task.source_type)
    const sourceId = text(task.source_id)
    const sourceKey = sourceType && sourceId ? `${sourceType}:${sourceId}` : ''
    const key = sourceKey || task.task_id
    if (seen.has(key)) continue
    seen.add(key)
    out.push(task)
  }
  return out
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
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_tasks_source ON work_tasks(source_type, source_id);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day_assignee ON work_tasks(scheduled_date, assignee_id, status);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_kind_day ON work_tasks(task_kind, scheduled_date);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day ON work_tasks(scheduled_date);`)
}

async function syncPropertyFollowupWorkTasks() {
  if (!hasPg || !pgPool) return
  await ensureWorkTasksTable()
  const tableResult = await pgPool.query(
    `SELECT
       to_regclass('public.property_maintenance') IS NOT NULL AS has_maintenance,
       to_regclass('public.property_deep_cleaning') IS NOT NULL AS has_deep_cleaning,
       to_regclass('public.property_daily_necessities') IS NOT NULL AS has_daily_necessities`,
  )
  const available = tableResult.rows?.[0] || {}
  const activeParts: string[] = []
  if (available.has_maintenance) {
    activeParts.push(`
      SELECT 'property_maintenance'::text AS source_type,
             m.id::text AS source_id,
             'maintenance'::text AS task_kind,
             COALESCE(p.id::text, m.property_id::text) AS property_id,
             COALESCE(NULLIF(m.work_no::text, ''), '维修任务') AS title,
             NULLIF(COALESCE(m.details::text, ''), '') AS summary,
             'medium'::text AS urgency,
             NULL::text AS source_assignee_id,
             COALESCE(m.created_at, m.submitted_at, now()) AS created_at
        FROM property_maintenance m
        LEFT JOIN properties p ON p.id::text = m.property_id::text OR upper(p.code::text) = upper(m.property_id::text)
       WHERE lower(COALESCE(m.status::text, 'pending')) NOT IN ('review_pending','completed','done','ready','canceled','cancelled')`)
  }
  if (available.has_deep_cleaning) {
    activeParts.push(`
      SELECT 'property_deep_cleaning'::text AS source_type,
             d.id::text AS source_id,
             'deep_cleaning'::text AS task_kind,
             COALESCE(p.id::text, d.property_id::text) AS property_id,
             COALESCE(NULLIF(d.work_no::text, ''), '深度清洁') AS title,
             NULLIF(COALESCE(d.project_desc::text, d.details::text, ''), '') AS summary,
             'medium'::text AS urgency,
             NULL::text AS source_assignee_id,
             COALESCE(d.created_at, d.submitted_at, now()) AS created_at
        FROM property_deep_cleaning d
        LEFT JOIN properties p ON p.id::text = d.property_id::text OR upper(p.code::text) = upper(d.property_id::text)
       WHERE lower(COALESCE(d.status::text, 'pending')) NOT IN ('review_pending','completed','done','ready','canceled','cancelled')`)
  }
  if (available.has_daily_necessities) {
    activeParts.push(`
      SELECT 'property_daily_necessities'::text AS source_type,
             n.id::text AS source_id,
             'daily_necessities'::text AS task_kind,
             COALESCE(p.id::text, n.property_id::text) AS property_id,
             COALESCE(NULLIF(n.item_name::text, ''), '日用品更换') AS title,
             NULLIF(CONCAT_WS('，', NULLIF(n.note::text, ''), CASE WHEN COALESCE(n.quantity, 0) > 0 THEN '数量 ' || n.quantity::text ELSE NULL END), '') AS summary,
             'medium'::text AS urgency,
             NULL::text AS source_assignee_id,
             COALESCE(n.created_at, n.submitted_at, now()) AS created_at
        FROM property_daily_necessities n
        LEFT JOIN properties p ON p.id::text = n.property_id::text OR upper(p.code::text) = upper(n.property_id::text)
       WHERE lower(COALESCE(n.status::text, 'need_replace')) = 'need_replace'`)
  }
  if (!activeParts.length) return
  const activeSql = activeParts.join('\nUNION ALL\n')
  await pgPool.query(
    `WITH active AS (${activeSql})
     DELETE FROM work_tasks w
      WHERE w.source_type = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM active a
           WHERE a.source_type = w.source_type
             AND a.source_id = w.source_id
        )`,
    [PROPERTY_FOLLOWUP_SOURCE_TYPES],
  )
  await pgPool.query(
    `WITH active AS (${activeSql}),
     checkout_dates AS (
       SELECT COALESCE(task_property.id::text, t.property_id::text) AS property_id,
              MIN(COALESCE(t.task_date, t.date)::date) AS next_checkout_date
         FROM cleaning_tasks t
         LEFT JOIN properties task_property
           ON task_property.id::text = t.property_id::text
           OR upper(task_property.code::text) = upper(t.property_id::text)
         LEFT JOIN orders o ON o.id::text = t.order_id::text
        WHERE lower(COALESCE(t.task_type::text, '')) = 'checkout_clean'
          AND COALESCE(t.task_date, t.date)::date >= timezone('Australia/Melbourne', now())::date
          AND lower(COALESCE(t.status::text, '')) NOT IN ('cancelled','canceled')
          AND (
            t.order_id IS NULL
            OR (
              o.id IS NOT NULL
              AND lower(COALESCE(o.status::text, '')) <> 'invalid'
              AND lower(COALESCE(o.status::text, '')) NOT LIKE '%cancel%'
            )
          )
        GROUP BY COALESCE(task_property.id::text, t.property_id::text)
     ),
     projected AS (
       SELECT a.*, checkout.next_checkout_date
         FROM active a
         LEFT JOIN checkout_dates checkout ON checkout.property_id = a.property_id
     )
     INSERT INTO work_tasks(
       id, task_kind, source_type, source_id, property_id, title, summary,
       scheduled_date, assignee_id, status, urgency, created_at, updated_at
     )
     SELECT p.source_type || ':' || p.source_id,
            p.task_kind,
            p.source_type,
            p.source_id,
            p.property_id,
            p.title,
            p.summary,
            p.next_checkout_date,
            p.source_assignee_id,
            CASE WHEN p.source_assignee_id IS NULL THEN 'todo' ELSE 'assigned' END,
            CASE WHEN p.urgency IN ('low','medium','high','urgent') THEN p.urgency ELSE 'medium' END,
            p.created_at,
            now()
       FROM projected p
     ON CONFLICT (source_type, source_id) DO UPDATE SET
       task_kind = EXCLUDED.task_kind,
       property_id = EXCLUDED.property_id,
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       scheduled_date = CASE
         WHEN work_tasks.assignee_id IS NULL OR work_tasks.scheduled_date IS NULL THEN EXCLUDED.scheduled_date
         ELSE work_tasks.scheduled_date
       END,
       assignee_id = COALESCE(work_tasks.assignee_id, EXCLUDED.assignee_id),
       status = CASE
         WHEN lower(COALESCE(work_tasks.status, 'todo')) IN ('todo','assigned')
           THEN CASE WHEN COALESCE(work_tasks.assignee_id, EXCLUDED.assignee_id) IS NULL THEN 'todo' ELSE 'assigned' END
         ELSE work_tasks.status
       END,
       urgency = EXCLUDED.urgency,
       updated_at = CASE
         WHEN work_tasks.task_kind IS DISTINCT FROM EXCLUDED.task_kind
           OR work_tasks.property_id IS DISTINCT FROM EXCLUDED.property_id
           OR work_tasks.title IS DISTINCT FROM EXCLUDED.title
           OR work_tasks.summary IS DISTINCT FROM EXCLUDED.summary
           OR ((work_tasks.assignee_id IS NULL OR work_tasks.scheduled_date IS NULL) AND work_tasks.scheduled_date IS DISTINCT FROM EXCLUDED.scheduled_date)
           OR (work_tasks.assignee_id IS NULL AND EXCLUDED.assignee_id IS NOT NULL)
         THEN now()
         ELSE work_tasks.updated_at
       END`,
  )
}

async function hasCleaningOfflineTasksTable() {
  if (!hasPg || !pgPool) return false
  const result = await pgPool.query(`SELECT to_regclass('public.cleaning_offline_tasks') AS table_name`)
  return !!result?.rows?.[0]?.table_name
}

async function backfillOfflineTasksToWorkTasks(date: string, includeOverdue: boolean, includeFuture: boolean) {
  if (!hasPg || !pgPool) return false
  if (!(await hasCleaningOfflineTasksTable())) return false
  // Legacy status is used only to bootstrap a missing canonical work task.
  const where: string[] = [`t.date::date = $1::date`]
  if (includeOverdue) where.push(`t.date::date < $1::date`)
  if (includeFuture) where.push(`t.date::date > $1::date`)
  await pgPool.query(
    `INSERT INTO work_tasks(
       id, task_kind, source_type, source_id, property_id,
       title, summary, scheduled_date, assignee_id, status, urgency,
       created_at, updated_at
     )
     SELECT
       ('cleaning_offline_tasks:' || t.id::text) AS id,
       'offline' AS task_kind,
       'cleaning_offline_tasks' AS source_type,
       t.id::text AS source_id,
       t.property_id,
       COALESCE(t.title, '') AS title,
       NULLIF(COALESCE(t.content, ''), '') AS summary,
       t.date::date AS scheduled_date,
       t.assignee_id,
       CASE WHEN COALESCE(t.status, 'todo') = 'done' THEN 'done' ELSE 'todo' END AS status,
       COALESCE(NULLIF(t.urgency, ''), 'medium') AS urgency,
       COALESCE(t.created_at, t.updated_at, now()) AS created_at,
       COALESCE(t.updated_at, t.created_at, now()) AS updated_at
     FROM cleaning_offline_tasks t
     WHERE ${where.join(' OR ')}
     ON CONFLICT (source_type, source_id) DO NOTHING`,
    [date],
  )
  return true
}

async function ensureTaskCenterTables() {
  if (!hasPg || !pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS task_center_task_flags (
    task_date date NOT NULL,
    task_source text NOT NULL,
    task_id text NOT NULL,
    temporarily_skipped boolean NOT NULL DEFAULT false,
    skip_reason text,
    bucket text,
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_date, task_source, task_id)
  );`)
  await pgPool.query(`CREATE TABLE IF NOT EXISTS task_center_board_items (
    task_date date NOT NULL,
    board_mode text NOT NULL,
    task_source text NOT NULL,
    task_id text NOT NULL,
    row_key text NOT NULL,
    lane_key text NOT NULL,
    item_order integer NOT NULL DEFAULT 0,
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_date, board_mode, task_source, task_id)
  );`)
  await pgPool.query(`CREATE TABLE IF NOT EXISTS task_center_board_rows (
    task_date date NOT NULL,
    board_mode text NOT NULL,
    row_key text NOT NULL,
    row_type text NOT NULL,
    row_title text NOT NULL,
    row_order integer NOT NULL DEFAULT 0,
    assignments jsonb NOT NULL DEFAULT '{}'::jsonb,
    lane_order jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_date, board_mode, row_key)
  );`)
}

function canConfigureInspection(task: { task_type?: string | null; deferred_inspection_view?: boolean }) {
  if (task.deferred_inspection_view) return false
  const tt = lower(task.task_type)
  return tt === 'checkout_clean' || tt === 'turnover'
}

function isStayoverTask(task: { task_type?: string | null; title?: string | null }) {
  const taskType = lower(task.task_type)
  const label = text(task.title)
  return taskType === 'stayover_clean' || label.includes('入住中清洁') || label.toLowerCase().includes('stayover')
}

function isCheckinOnlyTask(task: { task_type?: string | null; title?: string | null; task_ids?: string[] }) {
  if ((task.task_ids || []).length > 1) return false
  if (isStayoverTask(task)) return false
  const taskType = lower(task.task_type)
  const label = text(task.title)
  return taskType === 'checkin_clean' || (label.includes('入住') && !label.includes('退房'))
}

function requiresCleanerAssignment(task: { task_type?: string | null; title?: string | null; task_ids?: string[] }) {
  return !isCheckinOnlyTask(task)
}

function inspectionModeOf(task: any) {
  return effectiveInspectionMode(task)
}

function summaryText(task: any): { title: string; detail: string } {
  const region = text(task.property_region)
  const code = text(task.property_code) || text(task.property_id) || '-'
  const checkoutT = text(task.summary_checkout_time) || DEFAULT_SUMMARY_CHECKOUT_TIME
  const checkinT = text(task.summary_checkin_time) || DEFAULT_SUMMARY_CHECKIN_TIME
  const type = lower(task.task_type)
  const title = region ? `${region} ${code}` : code
  if (type === 'turnover') return { title, detail: `${checkoutT}退房 ${checkinT}入住` }
  if (type === 'checkout_clean') return { title, detail: `${checkoutT}退房` }
  if (type === 'checkin_clean') return { title, detail: `${checkinT}入住` }
  if (type === 'stayover_clean') return { title, detail: '入住中清洁' }
  return { title, detail: text(task.title) }
}

function inspectionSummaryText(task: any): { title: string; detail: string } {
  const region = text(task.property_region)
  const code = text(task.property_code) || text(task.property_id) || '-'
  const title = region ? `${region} ${code}` : code
  return { title, detail: '待检查' }
}

function mergedStatus(statuses: string[]) {
  const ss = statuses.map((s) => text(s) || 'pending')
  if (ss.length && ss.every((x) => x === 'cancelled')) return 'cancelled'
  if (ss.includes('pending')) return 'pending'
  if (ss.includes('assigned')) return 'assigned'
  if (ss.includes('in_progress')) return 'in_progress'
  if (ss.includes('keys_hung')) return 'keys_hung'
  if (ss.includes('completed')) return 'completed'
  if (ss.length) return ss[0]
  return 'pending'
}

function mergeCleaningTasks(list: BoardTask[]): BoardTask[] {
  const byProp = new Map<string, BoardTask[]>()
  for (const task of list) {
    const pid = text(task.property_id)
    const groupDate = task.deferred_inspection_view ? text(task.inspection_due_date) || task.task_date : task.task_date
    const groupKey = `${pid}|${task.deferred_inspection_view ? 'deferred' : 'normal'}:${groupDate || 'unknown'}`
    const arr = byProp.get(groupKey) || []
    arr.push(task)
    byProp.set(groupKey, arr)
  }
  const out: BoardTask[] = []
  const preferOrderLinked = (xs: BoardTask[]) => {
    const withOrder = xs.filter((x) => text(x.order_id))
    return withOrder.length ? withOrder : xs
  }
  for (const items of byProp.values()) {
    const deferreds = items.filter((x) => x.deferred_inspection_view === true)
    if (deferreds.length) {
      const first = deferreds[0]
      const ids = Array.from(new Set(deferreds.flatMap((x) => x.task_ids).filter(Boolean)))
      const cleanerId = deferreds.every((x) => text(x.cleaner_id || x.assignee_id) === text(first.cleaner_id || first.assignee_id))
        ? (text(first.cleaner_id || first.assignee_id) || null)
        : null
      const assigneeId = deferreds.every((x) => text(x.assignee_id) === text(first.assignee_id))
        ? (text(first.assignee_id) || cleanerId)
        : cleanerId
      const inspectorId = deferreds.every((x) => text(x.inspector_id) === text(first.inspector_id))
        ? (text(first.inspector_id) || null)
        : null
      out.push({
        ...first,
        item_key: `cleaning:deferred:${ids.join(',')}`,
        task_id: `deferred:${ids.join(',')}`,
        task_ids: ids,
        task_kind: 'deferred_inspection',
        title: first.title,
        detail: '待检查',
        status: mergedStatus(deferreds.map((x) => x.status)),
        assignee_id: assigneeId,
        cleaner_id: cleanerId,
        inspector_id: inspectorId,
        checkin_sync_status: null,
        auto_sync_enabled: deferreds.every((x) => x.auto_sync_enabled !== false),
        has_key_photo: deferreds.some((x) => !!x.has_key_photo),
        key_photo_uploaded_at: deferreds.find((x) => text(x.key_photo_uploaded_at))?.key_photo_uploaded_at || null,
        summary_checkout_time: null,
        summary_checkin_time: null,
        deferred_inspection_view: true,
        can_configure_inspection: false,
      })
      continue
    }
    const stayovers = items.filter((x) => lower(x.task_kind) === 'stayover_clean')
    const checkins = preferOrderLinked(items.filter((x) => lower(x.task_kind) === 'checkin_clean'))
    const checkouts = preferOrderLinked(items.filter((x) => lower(x.task_kind) === 'checkout_clean'))
    if (checkins.length && checkouts.length) {
      const all = [...checkins, ...checkouts]
      const ids = all.flatMap((x) => x.task_ids).filter(Boolean)
      const first = all[0]
      const turnoverPlan = mergeTurnoverTaskPlan(all.map((task) => ({
        task_type: task.task_kind,
        cleaner_id: task.cleaner_id,
        assignee_id: task.assignee_id,
        inspector_id: task.inspector_id,
        status: task.status,
        inspection_mode: task.inspection_mode,
        inspection_due_date: task.inspection_due_date,
      })))
      const autoSync = all.every((x) => x.auto_sync_enabled !== false)
      const checkout = checkouts[0]
      const checkin = checkins[0]
      const mergedSummary = summaryText({
        property_region: first.property_region,
        property_code: first.property_code,
        property_id: first.property_id,
        task_type: 'turnover',
        title: '退房 入住',
        summary_checkout_time: checkout.summary_checkout_time || DEFAULT_SUMMARY_CHECKOUT_TIME,
        summary_checkin_time: checkin.summary_checkin_time || DEFAULT_SUMMARY_CHECKIN_TIME,
      })
      const mergedNights = checkin.nights ?? checkout.nights ?? first.nights ?? null
      const nightsText = mergedNights != null && Number(mergedNights) > 0 ? `住${Number(mergedNights)}晚` : ''
      out.push({
        ...first,
        item_key: `cleaning:${ids.join(',')}`,
        task_id: ids.join(','),
        task_ids: Array.from(new Set([
          ...checkouts.flatMap((task) => task.task_ids),
          ...checkins.flatMap((task) => task.task_ids),
        ].filter(Boolean))),
        task_kind: 'turnover',
        title: mergedSummary.title,
        detail: [mergedSummary.detail, nightsText].filter(Boolean).join('，'),
        status: turnoverPlan.status,
        assignee_id: turnoverPlan.assigneeId,
        cleaner_id: turnoverPlan.cleanerId,
        inspector_id: turnoverPlan.inspectorId,
        checkin_sync_status: checkin.checkin_sync_status || null,
        auto_sync_enabled: autoSync,
        has_key_photo: all.some((x) => !!x.has_key_photo),
        key_photo_uploaded_at: all.find((x) => text(x.key_photo_uploaded_at))?.key_photo_uploaded_at || null,
        inspection_mode: turnoverPlan.inspectionMode,
        inspection_due_date: turnoverPlan.inspectionDueDate,
        old_code: null,
        new_code: null,
        summary_checkout_time: checkout.summary_checkout_time || null,
        summary_checkin_time: checkin.summary_checkin_time || null,
        can_configure_inspection: true,
      })
      const rest = items.filter((x) => lower(x.task_kind) !== 'checkin_clean' && lower(x.task_kind) !== 'checkout_clean')
      out.push(...rest)
    } else {
      if (stayovers.length) out.push(...stayovers)
      const rest = items.filter((x) => !stayovers.includes(x))
      out.push(...rest)
    }
  }
  out.sort((a, b) =>
    propertyRegionKey(a.property_region).localeCompare(propertyRegionKey(b.property_region)) ||
    text(a.property_code).localeCompare(text(b.property_code)) ||
    text(a.title).localeCompare(text(b.title)) ||
    text(a.task_id).localeCompare(text(b.task_id)),
  )
  return out
}

function taskDateInScope(taskDate: string | null, date: string, includeOverdue: boolean, includeFuture: boolean) {
  if (!taskDate) return false
  if (taskDate === date) return true
  if (includeOverdue && taskDate < date) return true
  if (includeFuture && taskDate > date) return true
  return false
}

async function loadCleaningTasks(date: string, includeOverdue: boolean, includeFuture: boolean): Promise<BoardTask[]> {
  if (hasPg && pgPool) {
    await ensureCleaningSchemaV2()
    await ensureCleaningInspectionScopeColumn()
    const dateScopes = [`((COALESCE(t.task_date, t.date)::date) = ($1::date))`]
    if (includeOverdue) dateScopes.push(`((COALESCE(t.task_date, t.date)::date) < ($1::date))`)
    if (includeFuture) dateScopes.push(`((COALESCE(t.task_date, t.date)::date) > ($1::date))`)
    const inspectionDueScopes = [`(t.inspection_due_date IS NOT NULL AND (t.inspection_due_date::date) <= ($1::date))`]
    if (includeFuture) inspectionDueScopes.push(`(t.inspection_due_date IS NOT NULL AND (t.inspection_due_date::date) > ($1::date))`)
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
           ${dateScopes.join('\n           OR ')}
           OR ${inspectionDueScopes.join('\n           OR ')}
         )
         AND COALESCE(t.status,'') <> 'cancelled'
         AND (t.order_id IS NULL OR o.id IS NOT NULL)
         AND (
           t.order_id IS NULL
           OR (
             COALESCE(o.status, '') <> ''
             AND lower(COALESCE(o.status, '')) <> 'invalid'
             AND lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'
           )
         )
       ORDER BY COALESCE(t.task_date, t.date) ASC, COALESCE(p_id.code, p_code.code) NULLS LAST, t.id`,
      [date],
    )
    const tasks: BoardTask[] = []
    for (const row of (r?.rows || [])) {
      const d = text(row.task_date).slice(0, 10)
      const rawType = text(row.task_type) || 'cleaning_task'
      const inspectionMode = effectiveInspectionMode(row)
      const inspectionDueDate = dayOnly(row.inspection_due_date)
      const label =
        rawType === 'checkout_clean' ? '退房' :
        rawType === 'checkin_clean' ? '入住' :
        rawType === 'stayover_clean' ? '入住中清洁' :
        rawType
      const projectionDate = deferredProjectionDate({
        inspectionMode,
        inspectionDueDate,
        dateFrom: date,
        dateTo: includeFuture ? '9999-12-31' : date,
        status: row.status,
      })
      if (taskDateInScope(d, date, includeOverdue, includeFuture)) {
        const sum = summaryText({
          property_region: row.property_region,
          property_code: row.property_code,
          property_id: row.property_id,
          task_type: rawType,
          title: label,
          summary_checkout_time: text(row.checkout_time) || DEFAULT_SUMMARY_CHECKOUT_TIME,
          summary_checkin_time: text(row.checkin_time) || DEFAULT_SUMMARY_CHECKIN_TIME,
        })
        tasks.push({
          item_key: `cleaning:${String(row.id)}`,
          task_source: 'cleaning',
          task_id: String(row.id),
          task_ids: [String(row.id)],
          task_kind: rawType,
          property_id: row.property_id ? String(row.property_id) : null,
          property_code: row.property_code ? String(row.property_code) : null,
          property_region: row.property_region ? String(row.property_region) : null,
          status: text(row.status) || 'pending',
          title: sum.title,
          detail: sum.detail || label,
          task_date: d,
          assignee_id: row.assignee_id ? String(row.assignee_id) : null,
          cleaner_id: row.cleaner_id ? String(row.cleaner_id) : (row.assignee_id ? String(row.assignee_id) : null),
          inspector_id: row.inspector_id ? String(row.inspector_id) : null,
          order_id: row.order_id ? String(row.order_id) : null,
          order_code: row.order_code ? String(row.order_code) : null,
          checkin_sync_status: rawType === 'checkin_clean' ? (row.order_id ? 'synced' : 'pending') : null,
          scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
          auto_sync_enabled: row.auto_sync_enabled !== false,
          has_key_photo: !!row.has_key_photo,
          key_photo_uploaded_at: row.key_photo_uploaded_at ? String(row.key_photo_uploaded_at) : null,
          old_code: row.old_code != null ? String(row.old_code || '') : null,
          new_code: row.new_code != null ? String(row.new_code || '') : null,
          inspection_scope: rawType === 'checkin_clean' ? normalizeInspectionScope(row.inspection_scope) : null,
          nights: row.nights != null ? Number(row.nights) : null,
          summary_checkout_time: text(row.checkout_time) || DEFAULT_SUMMARY_CHECKOUT_TIME,
          summary_checkin_time: text(row.checkin_time) || DEFAULT_SUMMARY_CHECKIN_TIME,
          inspection_mode: inspectionMode as any,
          inspection_due_date: inspectionDueDate,
          deferred_inspection_view: false,
          can_configure_inspection: rawType === 'checkout_clean' || rawType === 'checkin_clean',
        })
      }
      if (projectionDate && !(inspectionMode === 'deferred' && d === date && projectionDate === date)) {
        const sum = inspectionSummaryText({
          property_region: row.property_region,
          property_code: row.property_code,
          property_id: row.property_id,
        })
        tasks.push({
          item_key: `cleaning:${String(row.id)}::deferred_inspection:${projectionDate}`,
          task_source: 'cleaning',
          task_id: `${String(row.id)}::deferred_inspection:${projectionDate}`,
          task_ids: [String(row.id)],
          task_kind: 'deferred_inspection',
          property_id: row.property_id ? String(row.property_id) : null,
          property_code: row.property_code ? String(row.property_code) : null,
          property_region: row.property_region ? String(row.property_region) : null,
          status: text(row.status) || 'pending',
          title: sum.title,
          detail: sum.detail,
          task_date: projectionDate,
          assignee_id: row.assignee_id ? String(row.assignee_id) : null,
          cleaner_id: row.cleaner_id ? String(row.cleaner_id) : (row.assignee_id ? String(row.assignee_id) : null),
          inspector_id: row.inspector_id ? String(row.inspector_id) : null,
          order_id: row.order_id ? String(row.order_id) : null,
          order_code: row.order_code ? String(row.order_code) : null,
          checkin_sync_status: rawType === 'checkin_clean' ? (row.order_id ? 'synced' : 'pending') : null,
          scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
          auto_sync_enabled: row.auto_sync_enabled !== false,
          has_key_photo: !!row.has_key_photo,
          key_photo_uploaded_at: row.key_photo_uploaded_at ? String(row.key_photo_uploaded_at) : null,
          old_code: row.old_code != null ? String(row.old_code || '') : null,
          new_code: row.new_code != null ? String(row.new_code || '') : null,
          inspection_scope: rawType === 'checkin_clean' ? normalizeInspectionScope(row.inspection_scope) : null,
          nights: row.nights != null ? Number(row.nights) : null,
          summary_checkout_time: null,
          summary_checkin_time: null,
          inspection_mode: inspectionMode as any,
          inspection_due_date: inspectionDueDate,
          deferred_inspection_view: true,
          can_configure_inspection: false,
        })
      }
    }
    return mergeCleaningTasks(tasks)
  }
  const rows = (db.cleaningTasks as any[]).slice()
  const props = ((db as any).properties || []) as any[]
  const orders = ((db as any).orders || []) as any[]
  const mapped: BoardTask[] = []
  for (const row of rows) {
    const taskDate = dayOnly(row.task_date || row.date)
    const prop = props.find((p: any) => String(p.id) === String(row.property_id) || lower(p.code) === lower(row.property_id)) || null
    const order = orders.find((o: any) => String(o.id) === String(row.order_id)) || null
    const inspectionMode = effectiveInspectionMode(row)
    const inspectionDueDate = dayOnly(row.inspection_due_date)
    if (taskDateInScope(taskDate, date, includeOverdue, includeFuture)) {
      const sum = summaryText({
        property_region: prop?.region,
        property_code: prop?.code,
        property_id: row.property_id,
        task_type: row.task_type,
        summary_checkout_time: text(row.checkout_time) || DEFAULT_SUMMARY_CHECKOUT_TIME,
        summary_checkin_time: text(row.checkin_time) || DEFAULT_SUMMARY_CHECKIN_TIME,
      })
      mapped.push({
        item_key: `cleaning:${String(row.id)}`,
        task_source: 'cleaning',
        task_id: String(row.id),
        task_ids: [String(row.id)],
        task_kind: text(row.task_type) || 'cleaning_task',
        property_id: row.property_id ? String(row.property_id) : null,
        property_code: prop?.code ? String(prop.code) : null,
        property_region: prop?.region ? String(prop.region) : null,
        status: text(row.status) || 'pending',
        title: sum.title,
        detail: sum.detail,
        task_date: taskDate || date,
        assignee_id: row.assignee_id ? String(row.assignee_id) : null,
        cleaner_id: row.cleaner_id ? String(row.cleaner_id) : (row.assignee_id ? String(row.assignee_id) : null),
        inspector_id: row.inspector_id ? String(row.inspector_id) : null,
        order_id: row.order_id ? String(row.order_id) : null,
        order_code: order?.confirmation_code ? String(order.confirmation_code) : null,
        checkin_sync_status: lower(row.task_type) === 'checkin_clean' ? (row.order_id ? 'synced' : 'pending') : null,
        scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
        auto_sync_enabled: row.auto_sync_enabled !== false,
        has_key_photo: false,
        key_photo_uploaded_at: null,
        old_code: row.old_code != null ? String(row.old_code || '') : null,
        new_code: row.new_code != null ? String(row.new_code || '') : null,
        inspection_scope: lower(row.task_type) === 'checkin_clean' ? normalizeInspectionScope(row.inspection_scope) : null,
        nights: row.nights_override != null ? Number(row.nights_override) : null,
        summary_checkout_time: text(row.checkout_time) || DEFAULT_SUMMARY_CHECKOUT_TIME,
        summary_checkin_time: text(row.checkin_time) || DEFAULT_SUMMARY_CHECKIN_TIME,
        inspection_mode: inspectionMode as any,
        inspection_due_date: inspectionDueDate,
        deferred_inspection_view: false,
        can_configure_inspection: lower(row.task_type) === 'checkout_clean' || lower(row.task_type) === 'checkin_clean',
      })
    }
  }
  return mergeCleaningTasks(mapped)
}

async function loadWorkTasks(date: string, includeOverdue: boolean, includeUnscheduled: boolean, includeFuture: boolean): Promise<BoardTask[]> {
  if (hasPg && pgPool) {
    await ensureWorkTasksTable()
    await backfillOfflineTasksToWorkTasks(date, includeOverdue, includeFuture)
    const doneSet = ['done', 'completed', 'cancelled', 'canceled']
    const where: string[] = []
    const vals: any[] = [date, doneSet, WORK_TASK_VISIBILITY_START]
    where.push(`w.scheduled_date = $1::date`)
    if (includeOverdue) where.push(`(w.scheduled_date IS NOT NULL AND w.scheduled_date < $1::date)`)
    if (includeUnscheduled) where.push(`(w.scheduled_date IS NULL)`)
    if (includeFuture) where.push(`(w.scheduled_date IS NOT NULL AND w.scheduled_date > $1::date)`)
    const sql = `
      SELECT
        w.*,
        COALESCE(p_id.code::text, p_code.code::text) AS property_code,
        COALESCE(p_id.region::text, p_code.region::text) AS property_region
      FROM work_tasks w
      LEFT JOIN properties p_id ON (p_id.id::text) = (w.property_id::text)
      LEFT JOIN properties p_code ON upper(p_code.code) = upper(w.property_id::text)
      WHERE w.status <> ALL($2::text[])
        AND COALESCE(w.created_at::date, w.scheduled_date, $1::date) >= $3::date
        AND NOT (w.source_type = ANY($4::text[]) AND w.scheduled_date IS NULL)
        AND (${where.join(' OR ')})
      ORDER BY COALESCE(w.scheduled_date, $1::date) ASC, w.urgency DESC, w.updated_at DESC, w.id DESC
    `
    vals.push(PROPERTY_FOLLOWUP_SOURCE_TYPES)
    const r = await pgPool.query(sql, vals)
    const workTasks = (r?.rows || []).map((row: any) => mapWorkTaskRowToBoardTask(row, date))
    return workTasks
  }
  const rows = (((db as any).workTasks || []) as any[]).slice()
  const workTasks = rows
    .filter((row: any) => {
      const created = dayOnly(row.created_at || row.updated_at || row.scheduled_date)
      if (created && created < WORK_TASK_VISIBILITY_START) return false
      const status = normStatus(row.status)
      if (status === 'done' || status === 'cancelled') return false
      const scheduled = dayOnly(row.scheduled_date)
      if (scheduled === date) return true
      if (includeOverdue && scheduled && scheduled < date) return true
      if (includeUnscheduled && !scheduled) return true
      if (includeFuture && scheduled && scheduled > date) return true
      return false
    })
    .map((row: any) => {
      const display = workTaskDisplayText(row)
      return {
      item_key: `work:${String(row.id)}`,
      task_source: 'work' as const,
      task_id: String(row.id),
      task_ids: [String(row.id)],
      task_kind: String(row.task_kind || ''),
      source_type: row.source_type ? String(row.source_type) : null,
      source_id: row.source_id ? String(row.source_id) : null,
      property_id: row.property_id ? String(row.property_id) : null,
      property_code: null,
      property_region: null,
      status: normStatus(row.status),
      urgency: normUrgency(row.urgency),
      title: display.title,
      detail: display.detail,
      summary: row.summary != null ? String(row.summary || '') : null,
      task_date: dayOnly(row.scheduled_date) || date,
      assignee_id: row.assignee_id ? String(row.assignee_id) : null,
      cleaner_id: null,
      inspector_id: null,
    }})
  const offlineTasks = (((db as any).cleaningOfflineTasks || []) as any[])
    .filter((row: any) => {
      const status = normStatus(row.status)
      if (status === 'done' || status === 'cancelled') return false
      const scheduled = dayOnly(row.date)
      if (scheduled === date) return true
      if (includeOverdue && scheduled && scheduled < date) return true
      if (includeFuture && scheduled && scheduled > date) return true
      return false
    })
    .map((row: any) => mapWorkTaskRowToBoardTask({
      id: `cleaning_offline_tasks:${String(row.id)}`,
      task_kind: 'offline',
      source_type: 'cleaning_offline_tasks',
      source_id: String(row.id),
      property_id: row.property_id || null,
      property_code: null,
      property_region: null,
      title: row.title,
      summary: row.content,
      scheduled_date: row.date,
      assignee_id: row.assignee_id || null,
      status: row.status,
      urgency: row.urgency,
    }, date))
  return dedupeBoardTasks([...workTasks, ...offlineTasks])
}

async function loadTaskFlags(date: string) {
  const keyOf = (taskSource: TaskSource, taskId: string) => `${date}|${taskSource}|${taskId}`
  const out = new Map<string, TaskFlag>()
  if (hasPg && pgPool) {
    await ensureTaskCenterTables()
    const r = await pgPool.query(
      `SELECT task_source, task_id, temporarily_skipped, skip_reason, bucket
       FROM task_center_task_flags
       WHERE task_date = $1::date`,
      [date],
    )
    for (const row of r?.rows || []) {
      out.set(keyOf(String(row.task_source) as TaskSource, String(row.task_id)), {
        task_source: String(row.task_source) as TaskSource,
        task_id: String(row.task_id),
        temporarily_skipped: row.temporarily_skipped === true,
        skip_reason: row.skip_reason != null ? String(row.skip_reason || '') : null,
        bucket: row.bucket != null ? String(row.bucket || '') : null,
      })
    }
    return out
  }
  for (const value of memoryTaskFlags.values()) {
    const parts = value.task_id.includes('|') ? [] : []
    void parts
  }
  for (const [key, value] of memoryTaskFlags.entries()) {
    if (!key.startsWith(`${date}|`)) continue
    out.set(key, value)
  }
  return out
}

async function loadBoardRows(date: string, mode: BoardMode) {
  const boardMode = normalizeBoardMode(mode)
  const out = new Map<string, BoardRowMeta>()
  if (hasPg && pgPool) {
    await ensureTaskCenterTables()
    const r = await pgPool.query(
      `SELECT row_key, board_mode, row_type, row_title, row_order, assignments, lane_order
       FROM task_center_board_rows
       WHERE task_date = $1::date AND board_mode = $2
       ORDER BY row_order ASC, row_key ASC`,
      [date, boardMode],
    )
    for (const row of r?.rows || []) {
      out.set(String(row.row_key), {
        row_key: String(row.row_key),
        board_mode: boardMode,
        row_type: (String(row.row_type) as any) || 'final_group',
        row_title: String(row.row_title || ''),
        row_order: Number(row.row_order || 0),
        assignments: parseJsonObject(row.assignments),
        subrow_order: parseJsonArray(row.lane_order),
      })
    }
    return out
  }
  for (const [key, value] of memoryBoardRows.entries()) {
    if (!key.startsWith(`${date}|${boardMode}|`)) continue
    out.set(value.row_key, value)
  }
  return out
}

async function loadBoardItems(date: string, mode: BoardMode) {
  const boardMode = normalizeBoardMode(mode)
  const out = new Map<string, BoardItemLayout>()
  if (hasPg && pgPool) {
    await ensureTaskCenterTables()
    const r = await pgPool.query(
      `SELECT task_source, task_id, row_key, lane_key, item_order
       FROM task_center_board_items
       WHERE task_date = $1::date AND board_mode = $2`,
      [date, boardMode],
    )
    for (const row of r?.rows || []) {
      const taskSource = String(row.task_source) as TaskSource
      const taskId = String(row.task_id)
      out.set(`${taskSource}:${taskId}`, {
        task_source: taskSource,
        task_id: taskId,
        row_key: String(row.row_key || ''),
        subrow_key: String(row.lane_key || ''),
        item_order: Number(row.item_order || 0),
      })
    }
    return out
  }
  for (const [key, value] of memoryBoardItems.entries()) {
    if (!key.startsWith(`${date}|${boardMode}|`)) continue
    out.set(`${value.task_source}:${value.task_id}`, value)
  }
  return out
}

function defaultRegionRowKey(task: BoardTask) {
  if (task.deferred_inspection_view) return DEFERRED_INSPECTION_ROW_KEY
  if (task.task_source === 'cleaning' && isCompletedBoardStatus(task.status)) return COMPLETED_ROW_KEY
  if (task.task_source === 'cleaning' && inspectionModeOf(task) === 'deferred') return DEFERRED_INSPECTION_ROW_KEY
  const region = text(task.property_region)
  return region ? `region:${region}` : DEFERRED_ROW_KEY
}

function defaultSubrowKey() {
  return 'subrow:default'
}

function boardTaskKey(taskSource: TaskSource, taskId: string) {
  return `${taskSource}:${taskId}`
}

function defaultRowOrderFromKey(rowKey: string, rowType: BoardRow['row_type']) {
  if (rowKey === COMPLETED_ROW_KEY) return 2080
  if (rowKey === DEFERRED_INSPECTION_ROW_KEY) return 9998
  if (rowKey === DEFERRED_ROW_KEY) return 9999
  return rowType === 'final_group' ? 2000 : 1000
}

function rowTitleFromKey(rowKey: string) {
  if (rowKey === DEFERRED_ROW_KEY) return DEFERRED_ROW_TITLE
  if (rowKey === DEFERRED_INSPECTION_ROW_KEY) return DEFERRED_INSPECTION_ROW_TITLE
  if (rowKey === COMPLETED_ROW_KEY) return COMPLETED_ROW_TITLE
  if (rowKey.startsWith('region:')) return rowKey.slice('region:'.length) || '未分区'
  if (rowKey.startsWith('group:')) return '新增分组'
  return rowKey
}

function sortRows(rows: BoardRow[]) {
  rows.sort((a, b) => a.row_order - b.row_order || a.row_title.localeCompare(b.row_title))
  let finalIndex = 1
  for (const row of rows) {
    if (row.row_type !== 'final_group') continue
    if (row.row_key === COMPLETED_ROW_KEY) {
      row.row_title = COMPLETED_ROW_TITLE
      continue
    }
    if (!text(row.row_title) || row.row_title === '新增分组') {
      row.row_title = `第${finalIndex}组`
    }
    finalIndex += 1
  }
}

function isCompletedBoardStatus(status: any) {
  const s = text(status).toLowerCase()
  return s === 'done' || s === 'completed' || s === 'ready' || s === 'keys_hung'
}

function buildRows(params: {
  date: string
  tasks: BoardTask[]
  taskFlags: Map<string, TaskFlag>
  rowMetas: Map<string, BoardRowMeta>
  itemLayouts: Map<string, BoardItemLayout>
}) {
  const rows = new Map<string, BoardRow>()
  const deferredTasks: BoardTask[] = []
  const deferredInspectionTasks: BoardTask[] = []
  for (const task of params.tasks) {
    const rawIds = task.task_source === 'cleaning'
      ? Array.from(new Set([task.task_id, ...task.task_ids].map((taskId) => text(taskId)).filter(Boolean)))
      : [task.task_id]
    const matchFlags = rawIds
      .map((id) => params.taskFlags.get(`${params.date}|${task.task_source}|${id}`))
      .filter(Boolean) as TaskFlag[]
    const flag = matchFlags.find((x) => x.temporarily_skipped) || matchFlags[0] || null
    task.temporarily_skipped = flag?.temporarily_skipped === true
    task.skip_reason = flag?.skip_reason || null
    task.skip_bucket = flag?.bucket || null
    if (task.deferred_inspection_view === true) {
      deferredInspectionTasks.push(task)
      continue
    }
    const shouldDefer = task.temporarily_skipped || !text(task.property_region) || text(task.skip_bucket) === 'deferred'
    if (shouldDefer) {
      deferredTasks.push(task)
      continue
    }
    const layoutKeys = task.task_source === 'cleaning'
      ? [task.task_id, ...task.task_ids]
      : [task.task_id]
    const layout = Array.from(new Set(layoutKeys.map((taskId) => text(taskId)).filter(Boolean)))
      .map((taskId) => params.itemLayouts.get(boardTaskKey(task.task_source, taskId)))
      .find(Boolean)
    let rowKey = layout?.row_key || defaultRegionRowKey(task)
    if (rowKey === DEFERRED_ROW_KEY) rowKey = defaultRegionRowKey(task)
    const rowMeta = params.rowMetas.get(rowKey)
    const rowType = (rowMeta?.row_type || (rowKey.startsWith('group:') ? 'final_group' : 'region')) as 'region' | 'final_group' | 'deferred'
    const rowTitle = text(rowMeta?.row_title) || rowTitleFromKey(rowKey)
    const rowOrder = rowMeta?.row_order ?? defaultRowOrderFromKey(rowKey, rowType)
    const row = rows.get(rowKey) || {
      row_key: rowKey,
      row_title: rowTitle,
      row_type: rowType,
      row_order: rowOrder,
      assignments: rowMeta?.assignments || {},
      subrow_order: rowMeta?.subrow_order || [],
      subrows: [],
    }
    let subrowKey = layout?.subrow_key || defaultSubrowKey()
    if (!subrowKey) subrowKey = defaultSubrowKey()
    let subrow = row.subrows.find((x) => x.subrow_key === subrowKey)
    if (!subrow) {
      subrow = {
        subrow_key: subrowKey,
        tasks: [],
      }
      row.subrows.push(subrow)
    }
    ;(task as any).__item_order = layout?.item_order ?? subrow.tasks.length
    subrow.tasks.push(task)
    rows.set(rowKey, row)
  }
  const deferredMeta = params.rowMetas.get(DEFERRED_ROW_KEY)
  const deferredRow: BoardRow = {
    row_key: DEFERRED_ROW_KEY,
    row_title: deferredMeta?.row_title || DEFERRED_ROW_TITLE,
    row_type: 'deferred',
    row_order: deferredMeta?.row_order ?? 9999,
    assignments: deferredMeta?.assignments || {},
    subrow_order: deferredMeta?.subrow_order || [defaultSubrowKey()],
    subrows: [{
      subrow_key: defaultSubrowKey(),
      tasks: deferredTasks,
    }],
  }
  const deferredInspectionMeta = params.rowMetas.get(DEFERRED_INSPECTION_ROW_KEY)
  const deferredInspectionRow: BoardRow = {
    row_key: DEFERRED_INSPECTION_ROW_KEY,
    row_title: deferredInspectionMeta?.row_title || DEFERRED_INSPECTION_ROW_TITLE,
    row_type: 'deferred',
    row_order: deferredInspectionMeta?.row_order ?? 9998,
    assignments: deferredInspectionMeta?.assignments || {},
    subrow_order: deferredInspectionMeta?.subrow_order || [defaultSubrowKey()],
    subrows: [{
      subrow_key: defaultSubrowKey(),
      tasks: deferredInspectionTasks,
    }],
  }
  for (const rowMeta of params.rowMetas.values()) {
    if (rowMeta.row_key === DEFERRED_ROW_KEY || rowMeta.row_key === DEFERRED_INSPECTION_ROW_KEY) continue
    if (rows.has(rowMeta.row_key)) continue
    const subrowKeys = rowMeta.subrow_order.length ? rowMeta.subrow_order : [defaultSubrowKey()]
    rows.set(rowMeta.row_key, {
      row_key: rowMeta.row_key,
      row_title: rowMeta.row_title,
      row_type: rowMeta.row_type,
      row_order: rowMeta.row_order,
      assignments: rowMeta.assignments,
      subrow_order: rowMeta.subrow_order,
      subrows: subrowKeys.map((subrowKey) => ({
        subrow_key: subrowKey,
        tasks: [],
      })),
    })
  }
  const boardRows = Array.from(rows.values())
  for (const row of boardRows) {
    const subrowOrder = row.subrow_order.length ? row.subrow_order : row.subrows.map((subrow) => subrow.subrow_key)
    for (const subrowKey of subrowOrder) {
      if (row.subrows.some((subrow) => subrow.subrow_key === subrowKey)) continue
      row.subrows.push({
        subrow_key: subrowKey,
        tasks: [],
      })
    }
    row.subrows.sort((a, b) => {
      const ia = subrowOrder.indexOf(a.subrow_key)
      const ib = subrowOrder.indexOf(b.subrow_key)
      const va = ia >= 0 ? ia : Number.MAX_SAFE_INTEGER
      const vb = ib >= 0 ? ib : Number.MAX_SAFE_INTEGER
      return va - vb || a.subrow_key.localeCompare(b.subrow_key)
    })
    for (const subrow of row.subrows) {
      subrow.tasks.sort((a: any, b: any) => Number(a.__item_order || 0) - Number(b.__item_order || 0) || a.title.localeCompare(b.title))
      for (const task of subrow.tasks as any[]) delete task.__item_order
    }
  }
  sortRows(boardRows)
  return { rows: [...boardRows, deferredInspectionRow, deferredRow] }
}

function buildEntryReadiness(tasks: BoardTask[]) {
  const cleaningTasks = tasks.filter((task) => task.task_source === 'cleaning')
  const unresolvedPrimary = cleaningTasks.filter((task) => {
    if (task.temporarily_skipped || task.deferred_inspection_view) return false
    if (isCompletedBoardStatus(task.status)) return false
    if (!requiresCleanerAssignment(task)) return false
    return !text(task.cleaner_id || task.assignee_id)
  })
  const pendingInspection = cleaningTasks.filter((task) => {
    if (task.temporarily_skipped || task.deferred_inspection_view) return false
    if (isCompletedBoardStatus(task.status)) return false
    const mode = inspectionModeOf(task)
    if (mode === 'pending_decision') return true
    if ((mode === 'same_day' || mode === 'deferred') && !text(task.inspector_id)) return true
    return false
  })
  const skippedCount = cleaningTasks.filter((task) => task.temporarily_skipped).length
  return {
    ready_for_final_grouping: unresolvedPrimary.length === 0,
    unresolved_primary_count: unresolvedPrimary.length,
    pending_inspection_count: pendingInspection.length,
    skipped_count: skippedCount,
  }
}

async function buildTaskCenterDay(date: string, includeOverdue: boolean, includeUnscheduled: boolean, includeFuture: boolean) {
  const [cleaningTasks, workTasks, taskFlags, rowMetas, itemLayouts] = await Promise.all([
    loadCleaningTasks(date, false, false),
    loadWorkTasks(date, includeOverdue, includeUnscheduled, includeFuture),
    loadTaskFlags(date),
    loadBoardRows(date, 'board'),
    loadBoardItems(date, 'board'),
  ])
  const propertyFollowups = workTasks.filter(isPropertyFollowupTask)
  const regularWorkTasks = workTasks.filter((task) => !isPropertyFollowupTask(task))
  const allTasks = [...cleaningTasks, ...regularWorkTasks]
  const board = buildRows({
    date,
    tasks: allTasks.map((task) => ({ ...task })),
    taskFlags,
    rowMetas,
    itemLayouts,
  })
  const rows = board.rows
  const regularRows = rows.filter((row) => row.row_type !== 'deferred')
  const deferredRows = rows.filter((row) => row.row_type === 'deferred')
  const allBoardTasks = rows.flatMap((row) => row.subrows.flatMap((subrow) => subrow.tasks))
  return {
    date,
    pool: [],
    groups: {},
    tasks: regularWorkTasks.map((task) => ({
      id: task.task_id,
      task_kind: task.task_kind,
      source_type: task.source_type || '',
      source_id: task.source_id || '',
      property_id: task.property_id,
      title: task.title,
      summary: task.summary || task.detail || null,
      scheduled_date: task.task_date,
      start_time: null,
      end_time: null,
      assignee_id: task.assignee_id,
      status: normStatus(task.status),
      urgency: normUrgency(task.urgency),
    })),
    property_followups: propertyFollowups,
    rows,
    region_rows: regularRows,
    final_group_rows: regularRows.filter((row) => row.row_type === 'final_group'),
    deferred_rows: deferredRows,
    entry_readiness: buildEntryReadiness(allBoardTasks),
  }
}

const layoutSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mode: z.enum(['board', 'region', 'final']).optional().default('board'),
  rows: z.array(z.object({
    row_key: z.string().min(1),
    row_type: z.enum(['region', 'final_group', 'deferred']),
    row_title: z.string().optional(),
    row_order: z.number().int().optional(),
    subrow_order: z.array(z.string()).optional(),
    lane_order: z.array(z.string()).optional(),
  })).optional(),
  subrows: z.array(z.object({
    row_key: z.string().min(1),
    subrow_key: z.string().min(1),
    subrow_order: z.number().int().optional(),
  })).optional(),
  items: z.array(z.object({
    task_source: z.enum(['cleaning', 'work']),
    task_id: z.string().min(1),
    row_key: z.string().min(1),
    subrow_key: z.string().optional(),
    lane_key: z.string().optional(),
    item_order: z.number().int().optional(),
  })).optional(),
}).strict().refine((value) => (value.rows?.length || 0) > 0 || (value.subrows?.length || 0) > 0 || (value.items?.length || 0) > 0, {
  message: 'rows, subrows or items is required',
})

const rowAssignmentsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mode: z.enum(['board', 'region', 'final']).optional().default('board'),
  row_key: z.string().min(1),
  row_type: z.enum(['region', 'final_group', 'deferred']).optional(),
  row_title: z.string().optional(),
  row_order: z.number().int().optional(),
  subrow_order: z.array(z.string()).optional(),
  lane_order: z.array(z.string()).optional(),
  assignments: z.record(z.any()).default({}),
}).strict()

const taskFlagsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tasks: z.array(z.object({
    task_source: z.enum(['cleaning', 'work']),
    task_id: z.string().min(1),
    temporarily_skipped: z.boolean(),
    skip_reason: z.string().nullable().optional(),
    bucket: z.string().nullable().optional(),
  })).min(1),
}).strict()

const saveBoardSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mode: z.enum(['board', 'region', 'final']).optional().default('board'),
  rows: z.array(z.object({
    row_key: z.string().min(1),
    row_type: z.enum(['region', 'final_group', 'deferred']),
    row_title: z.string().optional(),
    row_order: z.number().int().optional(),
    subrow_order: z.array(z.string()).optional(),
    lane_order: z.array(z.string()).optional(),
  })).min(1),
  subrows: z.array(z.object({
    row_key: z.string().min(1),
    subrow_key: z.string().min(1),
    subrow_order: z.number().int().optional(),
  })).default([]),
  items: z.array(z.object({
    task_source: z.enum(['cleaning', 'work']),
    task_id: z.string().min(1),
    row_key: z.string().min(1),
    subrow_key: z.string().optional(),
    lane_key: z.string().optional(),
    item_order: z.number().int().optional(),
  })).default([]),
  row_assignments: z.array(z.object({
    row_key: z.string().min(1),
    assignments: z.record(z.any()).default({}),
  })).default([]),
  cleaning_assignments: z.array(z.object({
    task_id: z.string().min(1),
    cleaner_id: z.string().min(1).nullable(),
    inspector_id: z.string().min(1).nullable(),
    inspection_mode: z.enum(['pending_decision', 'same_day', 'deferred', 'self_complete', 'checked_done']),
    inspection_scope: z.enum(['inspect_and_hang', 'password_only']).nullable().optional(),
    inspection_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    status: z.string().min(1),
  })).default([]),
  work_assignments: z.array(z.object({
    task_id: z.string().min(1),
    assignee_id: z.string().min(1).nullable(),
    title: z.string().optional(),
    summary: z.string().nullable().optional(),
    scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    status: z.string().optional(),
    urgency: z.enum(['low', 'medium', 'high', 'urgent']).nullable().optional(),
  })).default([]),
  task_flags: z.array(z.object({
    task_source: z.enum(['cleaning', 'work']),
    task_id: z.string().min(1),
    temporarily_skipped: z.boolean(),
    skip_reason: z.string().nullable(),
    bucket: z.string().nullable(),
  })).default([]),
}).strict()

const deleteRowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  row_key: z.string().min(1),
  mode: z.enum(['board', 'region', 'final']).optional().default('board'),
}).strict()

router.get('/day', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const date = dayOnly((req.query as any)?.date)
  if (!date) return res.status(400).json({ message: 'invalid date' })
  const includeOverdue = String((req.query as any)?.include_overdue || '').trim() === '1'
  const includeUnscheduled = String((req.query as any)?.include_unscheduled || '').trim() !== '0'
  const includeFuture = String((req.query as any)?.include_future || '').trim() === '1'
  try {
    if (!hasPg && !Array.isArray((db as any).cleaningTasks)) {
      return res.json({ date, pool: [], groups: {}, tasks: [], property_followups: [], rows: [], region_rows: [], final_group_rows: [], deferred_rows: [], entry_readiness: { ready_for_final_grouping: true, unresolved_primary_count: 0, pending_inspection_count: 0, skipped_count: 0 } })
    }
    await syncPropertyFollowupWorkTasks()
    const payload = await buildTaskCenterDay(date, includeOverdue, includeUnscheduled, includeFuture)
    return res.json(payload)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'task_center_day_failed' })
  }
})

router.post('/save-board', requirePerm('cleaning.task.assign'), async (req, res) => {
  const parsed = saveBoardSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const payload = parsed.data
  const mode = normalizeBoardMode(payload.mode)
  const user = (req as any).user || {}
  const updatedBy = String(user.username || user.sub || '')
  const assignmentsByRow = new Map(payload.row_assignments.map((row) => [row.row_key, row.assignments || {}]))
  const rowMap = new Map<string, {
    row_key: string
    row_type: 'region' | 'final_group' | 'deferred'
    row_title: string
    row_order: number
    assignments: Record<string, any>
    subrow_order: string[]
  }>()
  for (const row of payload.rows) {
    rowMap.set(row.row_key, {
      row_key: row.row_key,
      row_type: row.row_type,
      row_title: row.row_title || rowTitleFromKey(row.row_key),
      row_order: Number(row.row_order || 0),
      assignments: assignmentsByRow.get(row.row_key) || {},
      subrow_order: row.subrow_order || row.lane_order || [],
    })
  }
  for (const subrow of payload.subrows) {
    const row = rowMap.get(subrow.row_key)
    if (row && !row.subrow_order.includes(subrow.subrow_key)) row.subrow_order.push(subrow.subrow_key)
  }
  for (const row of rowMap.values()) {
    if (!row.subrow_order.length) row.subrow_order = [defaultSubrowKey()]
  }
  const inspectorIds = Array.from(new Set(
    payload.cleaning_assignments.map((item) => text(item.inspector_id)).filter(Boolean),
  ))
  try {
    if (hasPg && pgPool) {
      await ensureCleaningSchemaV2()
      await ensureCleaningInspectionScopeColumn()
      await ensureWorkTasksTable()
      await ensureTaskCenterTables()
      if (inspectorIds.length) {
        const staffResult = await pgPool.query(
          `SELECT
             u.id::text AS id,
             u.role,
             COALESCE(ARRAY_AGG(DISTINCT ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL), ARRAY[]::text[]) AS roles
           FROM users u
           LEFT JOIN user_roles ur ON ur.user_id = u.id::text
           WHERE u.id::text = ANY($1::text[])
           GROUP BY u.id`,
          [inspectorIds],
        )
        const validIds = new Set<string>()
        for (const row of staffResult.rows || []) {
          const roles = [String(row.role || ''), ...(Array.isArray(row.roles) ? row.roles.map((item: any) => String(item || '')) : [])]
          if (roles.some((role) => role === 'cleaning_inspector' || role === 'cleaner_inspector')) validIds.add(String(row.id))
        }
        const invalidId = inspectorIds.find((id) => !validIds.has(id))
        if (invalidId) return res.status(400).json({ message: '无效的检查人员' })
      }
      if (payload.cleaning_assignments.length) {
        const taskTypeResult = await pgPool.query(
          `SELECT id::text AS id, task_type, inspection_scope
           FROM cleaning_tasks
           WHERE id::text = ANY($1::text[])`,
          [payload.cleaning_assignments.map((item) => item.task_id)],
        )
        const taskTypeById = new Map<string, { task_type: string | null; inspection_scope: string | null }>()
        for (const row of taskTypeResult.rows || []) {
          taskTypeById.set(String(row.id), {
            task_type: row.task_type ? String(row.task_type) : null,
            inspection_scope: row.inspection_scope ? String(row.inspection_scope) : null,
          })
        }
        for (const assignment of payload.cleaning_assignments) {
          const taskMeta = taskTypeById.get(String(assignment.task_id))
          const nextScope = assignment.inspection_scope ?? taskMeta?.inspection_scope ?? null
          if (isInspectionModeAllowedForTask({
            taskType: taskMeta?.task_type,
            inspectionScope: nextScope,
            inspectionMode: assignment.inspection_mode,
          })) {
            continue
          }
          return res.status(400).json({ message: '仅改密码任务不能设置为自完成或已检查' })
        }
      }
      const client = await pgPool.connect()
      const eventInputs: Parameters<typeof emitWorkTaskEvent>[0][] = []
      let layoutChanged = false
      let pushNotificationEvents = 0
      let pushNotificationRecipients = 0
      let changedCleaningTasks: any[] = []
      let changedWorkTasks: any[] = []
      const cleaningDiffById = new Map<string, TaskSaveDiff>()
      const workDiffById = new Map<string, TaskSaveDiff>()
      try {
        await client.query('BEGIN')
        if (payload.cleaning_assignments.length) {
          const beforeResult = await client.query(
            `SELECT id::text AS id,
                    task_type,
                    property_id,
                    task_date,
                    cleaner_id,
                    assignee_id,
                    inspector_id,
                    inspection_mode,
                    inspection_scope,
                    inspection_due_date,
                    status
             FROM cleaning_tasks
             WHERE id::text = ANY($1::text[])
             FOR UPDATE`,
            [payload.cleaning_assignments.map((item) => item.task_id)],
          )
          const beforeById = new Map<string, any>((beforeResult.rows || []).map((row: any) => [String(row.id), row]))
          for (const assignment of payload.cleaning_assignments) {
            const diff = buildCleaningSaveDiff(beforeById.get(String(assignment.task_id)), assignment)
            if (diff) cleaningDiffById.set(diff.taskId, diff)
          }
        }
        if (payload.work_assignments.length) {
          const beforeResult = await client.query(
            `SELECT id::text AS id,
                    task_kind,
                    source_type,
                    source_id,
                    property_id,
                    title,
                    summary,
                    scheduled_date,
                    assignee_id,
                    status,
                    urgency
             FROM work_tasks
             WHERE id::text = ANY($1::text[])
             FOR UPDATE`,
            [payload.work_assignments.map((item) => item.task_id)],
          )
          const beforeById = new Map<string, any>((beforeResult.rows || []).map((row: any) => [String(row.id), row]))
          for (const assignment of payload.work_assignments) {
            const diff = buildWorkSaveDiff(beforeById.get(String(assignment.task_id)), assignment)
            if (diff) workDiffById.set(diff.taskId, diff)
          }
        }
        const rowValues = Array.from(rowMap.values()).map((row) => ({
          row_key: row.row_key,
          row_type: row.row_type,
          row_title: row.row_title,
          row_order: row.row_order,
          assignments: row.assignments,
          lane_order: row.subrow_order,
        }))
        const rowLayoutResult = await client.query(
          `INSERT INTO task_center_board_rows(task_date, board_mode, row_key, row_type, row_title, row_order, assignments, lane_order, updated_by, updated_at)
           SELECT $1::date, $2, x.row_key, x.row_type, x.row_title, x.row_order, x.assignments, x.lane_order, $4, now()
           FROM jsonb_to_recordset($3::jsonb) AS x(
             row_key text,
             row_type text,
             row_title text,
             row_order integer,
             assignments jsonb,
             lane_order jsonb
           )
           ON CONFLICT (task_date, board_mode, row_key)
           DO UPDATE SET row_type=EXCLUDED.row_type, row_title=EXCLUDED.row_title, row_order=EXCLUDED.row_order, assignments=EXCLUDED.assignments, lane_order=EXCLUDED.lane_order, updated_by=EXCLUDED.updated_by, updated_at=now()
           WHERE task_center_board_rows.row_type IS DISTINCT FROM EXCLUDED.row_type
              OR task_center_board_rows.row_title IS DISTINCT FROM EXCLUDED.row_title
              OR task_center_board_rows.row_order IS DISTINCT FROM EXCLUDED.row_order
              OR task_center_board_rows.assignments IS DISTINCT FROM EXCLUDED.assignments
              OR task_center_board_rows.lane_order IS DISTINCT FROM EXCLUDED.lane_order
           RETURNING row_key`,
          [payload.date, mode, JSON.stringify(rowValues), updatedBy],
        )
        if (Number(rowLayoutResult.rowCount || 0) > 0) layoutChanged = true
        if (payload.items.length) {
          const itemLayoutResult = await client.query(
            `INSERT INTO task_center_board_items(task_date, board_mode, task_source, task_id, row_key, lane_key, item_order, updated_by, updated_at)
             SELECT $1::date, $2, x.task_source, x.task_id, x.row_key, x.lane_key, x.item_order, $4, now()
             FROM jsonb_to_recordset($3::jsonb) AS x(
               task_source text,
               task_id text,
               row_key text,
               lane_key text,
               item_order integer
             )
             ON CONFLICT (task_date, board_mode, task_source, task_id)
             DO UPDATE SET row_key=EXCLUDED.row_key, lane_key=EXCLUDED.lane_key, item_order=EXCLUDED.item_order, updated_by=EXCLUDED.updated_by, updated_at=now()
             WHERE task_center_board_items.row_key IS DISTINCT FROM EXCLUDED.row_key
                OR task_center_board_items.lane_key IS DISTINCT FROM EXCLUDED.lane_key
                OR task_center_board_items.item_order IS DISTINCT FROM EXCLUDED.item_order
             RETURNING task_source, task_id`,
            [
              payload.date,
              mode,
              JSON.stringify(payload.items.map((item) => ({
                task_source: item.task_source,
                task_id: item.task_id,
                row_key: item.row_key,
                lane_key: item.subrow_key || item.lane_key || defaultSubrowKey(),
                item_order: Number(item.item_order || 0),
              }))),
              updatedBy,
            ],
          )
          if (Number(itemLayoutResult.rowCount || 0) > 0) layoutChanged = true
        }
        if (payload.cleaning_assignments.length) {
          const result = await client.query(
            `UPDATE cleaning_tasks AS task
             SET cleaner_id = x.cleaner_id,
                 assignee_id = x.cleaner_id,
                 inspector_id = CASE
                   WHEN lower(COALESCE(x.status, '')) = 'keys_hung' AND x.inspector_id IS NULL
                     THEN task.inspector_id
                   ELSE x.inspector_id
                 END,
                 inspection_mode = x.inspection_mode,
                 inspection_scope = x.inspection_scope,
                 inspection_due_date = CASE WHEN x.inspection_due_date IS NULL THEN NULL ELSE x.inspection_due_date::date END,
                 status = x.status,
                 updated_at = now()
             FROM jsonb_to_recordset($1::jsonb) AS x(
               task_id text,
               cleaner_id text,
               inspector_id text,
               inspection_mode text,
               inspection_scope text,
               inspection_due_date text,
               status text
             )
             WHERE task.id::text = x.task_id
               AND (
                 task.cleaner_id IS DISTINCT FROM x.cleaner_id
                 OR task.assignee_id IS DISTINCT FROM x.cleaner_id
                 OR task.inspector_id IS DISTINCT FROM CASE
                   WHEN lower(COALESCE(x.status, '')) = 'keys_hung' AND x.inspector_id IS NULL
                     THEN task.inspector_id
                   ELSE x.inspector_id
                 END
                 OR task.inspection_mode IS DISTINCT FROM x.inspection_mode
                 OR task.inspection_scope IS DISTINCT FROM x.inspection_scope
                 OR task.inspection_due_date::text IS DISTINCT FROM x.inspection_due_date
                 OR task.status IS DISTINCT FROM x.status
               )
             RETURNING task.*`,
            [JSON.stringify(payload.cleaning_assignments)],
          )
          changedCleaningTasks = result.rows || []
        }
        if (payload.work_assignments.length) {
          const result = await client.query(
            `UPDATE work_tasks AS task
             SET title = COALESCE(NULLIF(x.title, ''), task.title),
                 summary = x.summary,
                 scheduled_date = CASE WHEN x.scheduled_date IS NULL THEN task.scheduled_date ELSE x.scheduled_date::date END,
                 assignee_id = x.assignee_id,
                 status = CASE
                   WHEN NULLIF(COALESCE(x.status, ''), '') IS NOT NULL
                     THEN x.status
                   WHEN lower(COALESCE(task.status, 'todo')) IN ('todo', 'assigned')
                     THEN CASE WHEN NULLIF(COALESCE(x.assignee_id, ''), '') IS NULL THEN 'todo' ELSE 'assigned' END
                   ELSE task.status
                 END,
                 urgency = COALESCE(NULLIF(x.urgency, ''), task.urgency),
                 updated_by = $2,
                 updated_at = now()
             FROM jsonb_to_recordset($1::jsonb) AS x(
               task_id text,
               assignee_id text,
               title text,
               summary text,
               scheduled_date text,
               status text,
               urgency text
             )
             WHERE task.id::text = x.task_id
               AND (
                 task.title IS DISTINCT FROM COALESCE(NULLIF(x.title, ''), task.title)
                 OR task.summary IS DISTINCT FROM x.summary
                 OR task.scheduled_date::text IS DISTINCT FROM CASE WHEN x.scheduled_date IS NULL THEN task.scheduled_date::text ELSE x.scheduled_date END
                 OR task.assignee_id IS DISTINCT FROM x.assignee_id
                 OR task.urgency IS DISTINCT FROM COALESCE(NULLIF(x.urgency, ''), task.urgency)
                 OR (
                   NULLIF(COALESCE(x.status, ''), '') IS NOT NULL
                   AND task.status IS DISTINCT FROM x.status
                 )
                 OR (
                   lower(COALESCE(task.status, 'todo')) IN ('todo', 'assigned')
                   AND NULLIF(COALESCE(x.status, ''), '') IS NULL
                   AND task.status IS DISTINCT FROM CASE WHEN NULLIF(COALESCE(x.assignee_id, ''), '') IS NULL THEN 'todo' ELSE 'assigned' END
                 )
               )
             RETURNING task.*`,
            [JSON.stringify(payload.work_assignments), updatedBy],
          )
          changedWorkTasks = result.rows || []
          if (changedWorkTasks.some((task: any) => String(task.source_type || '') === 'cleaning_offline_tasks') && await hasCleaningOfflineTasksTable()) {
            await client.query(
              `UPDATE cleaning_offline_tasks AS t
               SET date = w.scheduled_date,
                   title = w.title,
                   content = COALESCE(w.summary, ''),
                   assignee_id = w.assignee_id,
                   urgency = w.urgency,
                   updated_at = now()
               FROM work_tasks w
               WHERE w.source_type = 'cleaning_offline_tasks'
                 AND t.id::text = w.source_id::text
                 AND w.id::text = ANY($1::text[])`,
              [changedWorkTasks.map((task: any) => String(task.id))],
            )
          }
        }
        const workAssigneeIds = Array.from(new Set(changedWorkTasks.map((task: any) => String(task.assignee_id || '').trim()).filter(Boolean)))
        const workAssigneeNames = new Map<string, string>()
        if (workAssigneeIds.length) {
          try {
            const assigneeResult = await client.query(
              `SELECT id::text AS id,
                      COALESCE(NULLIF(TRIM(display_name), ''), NULLIF(TRIM(username), ''), NULLIF(TRIM(email), ''), id::text) AS name
               FROM users
               WHERE id::text = ANY($1::text[])`,
              [workAssigneeIds],
            )
            for (const row of assigneeResult?.rows || []) {
              workAssigneeNames.set(String(row.id), String(row.name || row.id || ''))
            }
          } catch {}
        }
        for (const task of changedWorkTasks) {
          const diff = workDiffById.get(String(task.id))
          if (!diff) continue
          const recipients = uniqTextList(diff.pushRecipientUserIds)
          if (!diff.pushChanges.length || !recipients.length) continue
          const assigneeId = String(task.assignee_id || '').trim()
          const actorId = String(user.sub || '').trim()
          const taskDate = task.scheduled_date ? String(task.scheduled_date).slice(0, 10) : payload.date
          const taskTitle = String(task.title || '').trim() || '线下任务'
          const taskSummary = String(task.summary || '').trim()
          const assigneeName = workAssigneeNames.get(assigneeId) || assigneeId
          try {
            const notificationResult = await emitNotificationEvent(
              {
                type: 'WORK_TASK_UPDATED',
                policyKey: 'work_task_updated',
                entity: 'work_task',
                entityId: String(task.id),
                propertyId: task.property_id ? String(task.property_id) : undefined,
                updatedAt: String(task.updated_at || '').trim() || new Date().toISOString(),
                title: '任务安排已更新',
                body: [
                  taskChangeBody(diff.pushChanges),
                  `任务：${taskTitle}`,
                  taskSummary ? `内容：${taskSummary}` : '',
                  `日期：${taskDate}`,
                ].filter(Boolean).join('\n'),
                changes: diff.pushChanges,
                data: {
                  entity: 'work_task',
                  entityId: String(task.id),
                  action: 'open_work_task',
                  kind: 'work_task_updated',
                  task_id: String(task.id),
                  task_title: taskTitle,
                  task_summary: taskSummary || null,
                  task_date: taskDate,
                  assignee_id: assigneeId,
                  assignee_name: assigneeName,
                  status: task.status,
                  urgency: task.urgency,
                },
                priority: diff.priority,
                actorUserId: actorId || null,
                recipientUserIds: recipients,
              },
              { operationId: uuid(), pgClient: client },
            )
            if (Number((notificationResult as any)?.sent || 0) > 0) {
              pushNotificationEvents += 1
              pushNotificationRecipients += Number((notificationResult as any).sent || 0)
            }
          } catch {}
        }
        if (payload.task_flags.length) {
          await client.query(
            `INSERT INTO task_center_task_flags(task_date, task_source, task_id, temporarily_skipped, skip_reason, bucket, updated_by, updated_at)
             SELECT $1::date, x.task_source, x.task_id, x.temporarily_skipped, x.skip_reason, x.bucket, $3, now()
             FROM jsonb_to_recordset($2::jsonb) AS x(
               task_source text,
               task_id text,
               temporarily_skipped boolean,
               skip_reason text,
               bucket text
             )
             ON CONFLICT (task_date, task_source, task_id)
             DO UPDATE SET temporarily_skipped=EXCLUDED.temporarily_skipped, skip_reason=EXCLUDED.skip_reason, bucket=EXCLUDED.bucket, updated_by=EXCLUDED.updated_by, updated_at=now()
             WHERE task_center_task_flags.temporarily_skipped IS DISTINCT FROM EXCLUDED.temporarily_skipped
                OR task_center_task_flags.skip_reason IS DISTINCT FROM EXCLUDED.skip_reason
                OR task_center_task_flags.bucket IS DISTINCT FROM EXCLUDED.bucket`,
            [payload.date, JSON.stringify(payload.task_flags), updatedBy],
          )
        }
        for (const task of changedCleaningTasks) {
          const diff = cleaningDiffById.get(String(task.id))
          if (!diff) continue
          const actorId = String(user.sub || '').trim()
          const taskId = String(task.id)
          if (diff.pushChanges.length && diff.pushRecipientUserIds.length) {
            try {
              const notificationResult = await emitNotificationEvent(
                {
                  type: 'CLEANING_TASK_UPDATED',
                  entity: 'cleaning_task',
                  entityId: taskId,
                  propertyId: task.property_id ? String(task.property_id) : undefined,
                  updatedAt: String(task.updated_at || '').trim() || new Date().toISOString(),
                  changes: diff.pushChanges,
                  title: `${cleaningTaskLabel(task.task_type)}安排已更新`,
                  body: taskChangeBody(diff.pushChanges),
                  data: {
                    entity: 'cleaning_task',
                    entityId: taskId,
                    action: 'open_task',
                    kind: 'cleaning_task_updated',
                    task_id: taskId,
                    task_type: task.task_type || null,
                    task_date: task.task_date ? String(task.task_date).slice(0, 10) : null,
                    assignee_id: task.assignee_id || null,
                    cleaner_id: task.cleaner_id || null,
                    inspector_id: task.inspector_id || null,
                    status: task.status,
                  },
                  priority: diff.priority,
                  actorUserId: actorId || null,
                  excludeActor: false,
                  recipientUserIds: diff.pushRecipientUserIds,
                },
                { operationId: uuid(), pgClient: client },
              )
              if (Number((notificationResult as any)?.sent || 0) > 0) {
                pushNotificationEvents += 1
                pushNotificationRecipients += Number((notificationResult as any).sent || 0)
              }
            } catch (error: any) {
              console.error(`[task-center] cleaning_assignment_notification_failed task_id=${taskId} message=${String(error?.message || error || '')}`)
            }
          }
          eventInputs.push({
            taskId: `cleaning_task:${taskId}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: [taskId],
            eventType: diff.changedFields.some((field) => field === 'cleaner_id' || field === 'assignee_id' || field === 'inspector_id') ? 'TASK_ASSIGNMENT_CHANGED' : 'TASK_UPDATED',
            changeScope: diff.changedFields.some((field) => field === 'cleaner_id' || field === 'assignee_id' || field === 'inspector_id') ? 'membership' : 'list',
            changedFields: diff.changedFields,
            patch: {
              cleaner_id: task.cleaner_id ?? null,
              assignee_id: task.assignee_id ?? null,
              inspector_id: task.inspector_id ?? null,
              inspection_mode: task.inspection_mode ?? null,
              inspection_scope: normalizeInspectionScope((task as any).inspection_scope),
              inspection_due_date: task.inspection_due_date ?? null,
              status: task.status,
            },
            causedByUserId: String(user.sub || '').trim() || null,
            visibilityHints: buildCleaningTaskVisibilityHints(task),
          })
        }
        for (const task of changedWorkTasks) {
          const diff = workDiffById.get(String(task.id))
          if (!diff) continue
          eventInputs.push({
            taskId: String(task.id),
            sourceType: String(task.source_type || 'work_tasks'),
            sourceRefIds: [String(task.source_id || task.id)],
            eventType: diff.changedFields.includes('assignee_id') ? 'TASK_ASSIGNMENT_CHANGED' : 'TASK_UPDATED',
            changeScope: diff.changedFields.includes('assignee_id') ? 'membership' : 'list',
            changedFields: diff.changedFields,
            patch: {
              title: task.title ?? '',
              summary: task.summary ?? null,
              scheduled_date: task.scheduled_date ? String(task.scheduled_date).slice(0, 10) : null,
              assignee_id: task.assignee_id ?? null,
              status: task.status,
              urgency: task.urgency ?? null,
            },
            payload: {
              task_title: task.title ?? '',
              task_summary: task.summary ?? null,
              task_date: task.scheduled_date ? String(task.scheduled_date).slice(0, 10) : null,
            },
            causedByUserId: String(user.sub || '').trim() || null,
            visibilityHints: buildWorkTaskVisibilityHints(task),
          })
        }
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch {}
        throw error
      } finally {
        client.release()
      }
      if (eventInputs.length) {
        void Promise.allSettled(eventInputs.map((eventInput) => emitWorkTaskEvent(eventInput)))
          .then((results) => {
            const failed = results.filter((item) => item.status === 'rejected')
            if (failed.length) console.error(`[task-center] background_event_emit_failed count=${failed.length}`)
          })
          .catch((error: any) => {
            console.error(`[task-center] background_event_emit_failed message=${String(error?.message || error || '')}`)
          })
      }
      return res.json({
        ok: true,
        rows: rowMap.size,
        items: payload.items.length,
        cleaning_assignments: payload.cleaning_assignments.length,
        work_assignments: payload.work_assignments.length,
        changed_tasks: {
          cleaning: changedCleaningTasks.length,
          work: changedWorkTasks.length,
          total: changedCleaningTasks.length + changedWorkTasks.length,
        },
        push_notifications: {
          events: pushNotificationEvents,
          recipients: pushNotificationRecipients,
        },
        realtime_events: eventInputs.length,
        layout_changed: layoutChanged,
      })
    }

    for (const row of rowMap.values()) {
      memoryBoardRows.set(`${payload.date}|${mode}|${row.row_key}`, {
        row_key: row.row_key,
        board_mode: mode,
        row_type: row.row_type,
        row_title: row.row_title,
        row_order: row.row_order,
        assignments: row.assignments,
        subrow_order: row.subrow_order,
      })
    }
    for (const item of payload.items) {
      memoryBoardItems.set(`${payload.date}|${mode}|${item.task_source}|${item.task_id}`, {
        task_source: item.task_source,
        task_id: item.task_id,
        row_key: item.row_key,
        subrow_key: item.subrow_key || item.lane_key || defaultSubrowKey(),
        item_order: Number(item.item_order || 0),
      })
    }
    const cleaningById = new Map(payload.cleaning_assignments.map((item) => [item.task_id, item]))
    for (const task of ((db as any).cleaningTasks || []) as any[]) {
      const assignment = cleaningById.get(String(task.id))
      if (!assignment) continue
      task.cleaner_id = assignment.cleaner_id
      task.assignee_id = assignment.cleaner_id
      task.inspector_id = assignment.inspector_id
      task.inspection_mode = assignment.inspection_mode
      task.inspection_due_date = assignment.inspection_due_date
      task.status = assignment.status
    }
    const workById = new Map(payload.work_assignments.map((item) => [item.task_id, item]))
    for (const task of (((db as any).workTasks || []) as any[])) {
      const assignment = workById.get(String(task.id))
      if (!assignment) continue
      task.assignee_id = assignment.assignee_id
      if (['todo', 'assigned'].includes(String(task.status || 'todo').toLowerCase())) task.status = assignment.assignee_id ? 'assigned' : 'todo'
    }
    for (const task of payload.task_flags) {
      memoryTaskFlags.set(`${payload.date}|${task.task_source}|${task.task_id}`, {
        task_source: task.task_source,
        task_id: task.task_id,
        temporarily_skipped: task.temporarily_skipped,
        skip_reason: task.skip_reason,
        bucket: task.bucket,
      })
    }
    return res.json({ ok: true, rows: rowMap.size, items: payload.items.length })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'task_center_save_board_failed' })
  }
})

router.post('/layout', requirePerm('cleaning.task.assign'), async (req, res) => {
  const parsed = layoutSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const date = parsed.data.date
  const mode = normalizeBoardMode(parsed.data.mode)
  const rows = parsed.data.rows || []
  const subrows = parsed.data.subrows || []
  const items = parsed.data.items || []
  const user = (req as any).user || {}
  const rowMap = new Map<string, {
    row_key: string
    row_type: 'region' | 'final_group' | 'deferred'
    row_title?: string
    row_order?: number
    subrow_order: string[]
  }>()
  for (const row of rows) {
    rowMap.set(row.row_key, {
      row_key: row.row_key,
      row_type: row.row_type,
      row_title: row.row_title,
      row_order: row.row_order,
      subrow_order: row.subrow_order || row.lane_order || [],
    })
  }
  for (const subrow of subrows) {
    const hit = rowMap.get(subrow.row_key) || {
      row_key: subrow.row_key,
      row_type: (subrow.row_key === DEFERRED_ROW_KEY || subrow.row_key === DEFERRED_INSPECTION_ROW_KEY) ? 'deferred' : (subrow.row_key.startsWith('group:') ? 'final_group' : 'region'),
      row_title: rowTitleFromKey(subrow.row_key),
      row_order: undefined,
      subrow_order: [],
    }
    if (!hit.subrow_order.includes(subrow.subrow_key)) hit.subrow_order.push(subrow.subrow_key)
    rowMap.set(subrow.row_key, hit)
  }
  for (const row of rowMap.values()) {
    if (!row.subrow_order.length) row.subrow_order = [defaultSubrowKey()]
  }
  try {
    if (hasPg && pgPool) {
      await ensureTaskCenterTables()
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        const rowValues = Array.from(rowMap.values()).map((row) => ({
          row_key: row.row_key,
          row_type: row.row_type,
          row_title: row.row_title || rowTitleFromKey(row.row_key),
          row_order: Number(row.row_order || 0),
          lane_order: row.subrow_order || [],
        }))
        if (rowValues.length) {
          await client.query(
            `INSERT INTO task_center_board_rows(task_date, board_mode, row_key, row_type, row_title, row_order, assignments, lane_order, updated_by, updated_at)
             SELECT $1::date, $2, x.row_key, x.row_type, x.row_title, x.row_order, '{}'::jsonb, x.lane_order, $4, now()
             FROM jsonb_to_recordset($3::jsonb) AS x(
               row_key text,
               row_type text,
               row_title text,
               row_order integer,
               lane_order jsonb
             )
             ON CONFLICT (task_date, board_mode, row_key)
             DO UPDATE SET row_type=EXCLUDED.row_type, row_title=EXCLUDED.row_title, row_order=EXCLUDED.row_order, lane_order=EXCLUDED.lane_order, updated_by=EXCLUDED.updated_by, updated_at=now()`,
            [date, mode, JSON.stringify(rowValues), String(user.username || user.sub || '')],
          )
        }
        if (items.length) {
          await client.query(
            `INSERT INTO task_center_board_items(task_date, board_mode, task_source, task_id, row_key, lane_key, item_order, updated_by, updated_at)
             SELECT $1::date, $2, x.task_source, x.task_id, x.row_key, x.lane_key, x.item_order, $4, now()
             FROM jsonb_to_recordset($3::jsonb) AS x(
               task_source text,
               task_id text,
               row_key text,
               lane_key text,
               item_order integer
             )
             ON CONFLICT (task_date, board_mode, task_source, task_id)
             DO UPDATE SET row_key=EXCLUDED.row_key, lane_key=EXCLUDED.lane_key, item_order=EXCLUDED.item_order, updated_by=EXCLUDED.updated_by, updated_at=now()`,
            [
              date,
              mode,
              JSON.stringify(items.map((item) => ({
                task_source: item.task_source,
                task_id: item.task_id,
                row_key: item.row_key,
                lane_key: item.subrow_key || item.lane_key || defaultSubrowKey(),
                item_order: Number(item.item_order || 0),
              }))),
              String(user.username || user.sub || ''),
            ],
          )
        }
        await client.query('COMMIT')
      } catch (e) {
        try { await client.query('ROLLBACK') } catch {}
        throw e
      } finally {
        client.release()
      }
      return res.json({ ok: true, updated: items.length })
    }
    for (const row of rowMap.values()) {
      memoryBoardRows.set(`${date}|${mode}|${row.row_key}`, {
        row_key: row.row_key,
        board_mode: mode,
        row_type: row.row_type,
        row_title: row.row_title || rowTitleFromKey(row.row_key),
        row_order: Number(row.row_order || 0),
        assignments: memoryBoardRows.get(`${date}|${mode}|${row.row_key}`)?.assignments || {},
        subrow_order: row.subrow_order || [],
      })
    }
    for (const item of items) {
      memoryBoardItems.set(`${date}|${mode}|${item.task_source}|${item.task_id}`, {
        task_source: item.task_source,
        task_id: item.task_id,
        row_key: item.row_key,
        subrow_key: item.subrow_key || item.lane_key || defaultSubrowKey(),
        item_order: Number(item.item_order || 0),
      })
    }
    return res.json({ ok: true, updated: items.length })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'task_center_layout_failed' })
  }
})

router.post('/row-assignments', requirePerm('cleaning.task.assign'), async (req, res) => {
  const parsed = rowAssignmentsSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const payload = parsed.data
  const user = (req as any).user || {}
  const mode = normalizeBoardMode(payload.mode)
  try {
    if (hasPg && pgPool) {
      await ensureTaskCenterTables()
      await pgPool.query(
        `INSERT INTO task_center_board_rows(task_date, board_mode, row_key, row_type, row_title, row_order, assignments, lane_order, updated_by, updated_at)
         VALUES($1::date, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, now())
         ON CONFLICT (task_date, board_mode, row_key)
         DO UPDATE SET row_type=EXCLUDED.row_type, row_title=EXCLUDED.row_title, row_order=EXCLUDED.row_order, assignments=EXCLUDED.assignments, lane_order=EXCLUDED.lane_order, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [
          payload.date,
          mode,
          payload.row_key,
          payload.row_type || ((payload.row_key === DEFERRED_ROW_KEY || payload.row_key === DEFERRED_INSPECTION_ROW_KEY) ? 'deferred' : (payload.row_key.startsWith('group:') ? 'final_group' : 'region')),
          payload.row_title || rowTitleFromKey(payload.row_key),
          Number(payload.row_order || 0),
          JSON.stringify(payload.assignments || {}),
          JSON.stringify(payload.subrow_order || payload.lane_order || [defaultSubrowKey()]),
          String(user.username || user.sub || ''),
        ],
      )
      return res.json({ ok: true })
    }
    memoryBoardRows.set(`${payload.date}|${mode}|${payload.row_key}`, {
      row_key: payload.row_key,
      board_mode: mode,
      row_type: payload.row_type || ((payload.row_key === DEFERRED_ROW_KEY || payload.row_key === DEFERRED_INSPECTION_ROW_KEY) ? 'deferred' : (payload.row_key.startsWith('group:') ? 'final_group' : 'region')),
      row_title: payload.row_title || rowTitleFromKey(payload.row_key),
      row_order: Number(payload.row_order || 0),
      assignments: payload.assignments || {},
      subrow_order: payload.subrow_order || payload.lane_order || [defaultSubrowKey()],
    })
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'task_center_row_assignments_failed' })
  }
})

router.post('/task-flags', requirePerm('cleaning.task.assign'), async (req, res) => {
  const parsed = taskFlagsSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const user = (req as any).user || {}
  try {
    if (hasPg && pgPool) {
      await ensureTaskCenterTables()
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        for (const task of parsed.data.tasks) {
          await client.query(
            `INSERT INTO task_center_task_flags(task_date, task_source, task_id, temporarily_skipped, skip_reason, bucket, updated_by, updated_at)
             VALUES($1::date, $2, $3, $4, $5, $6, $7, now())
             ON CONFLICT (task_date, task_source, task_id)
             DO UPDATE SET temporarily_skipped=EXCLUDED.temporarily_skipped, skip_reason=EXCLUDED.skip_reason, bucket=EXCLUDED.bucket, updated_by=EXCLUDED.updated_by, updated_at=now()`,
            [parsed.data.date, task.task_source, task.task_id, task.temporarily_skipped, task.skip_reason || null, task.bucket || null, String(user.username || user.sub || '')],
          )
        }
        await client.query('COMMIT')
      } catch (e) {
        try { await client.query('ROLLBACK') } catch {}
        throw e
      } finally {
        client.release()
      }
      return res.json({ ok: true, updated: parsed.data.tasks.length })
    }
    for (const task of parsed.data.tasks) {
      memoryTaskFlags.set(`${parsed.data.date}|${task.task_source}|${task.task_id}`, {
        task_source: task.task_source,
        task_id: task.task_id,
        temporarily_skipped: task.temporarily_skipped,
        skip_reason: task.skip_reason || null,
        bucket: task.bucket || null,
      })
    }
    return res.json({ ok: true, updated: parsed.data.tasks.length })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'task_center_task_flags_failed' })
  }
})

async function createBoardRow(req: any, res: any) {
  const date = dayOnly((req.body || {}).date)
  if (!date) return res.status(400).json({ message: 'invalid date' })
  try {
    const rowKey = `group:${uuid()}`
    const user = (req as any).user || {}
    const boardMode = normalizeBoardMode('board')
    if (hasPg && pgPool) {
      await ensureTaskCenterTables()
      const orderRes = await pgPool.query(
        `SELECT COALESCE(MAX(row_order), 0)::int AS max_order
         FROM task_center_board_rows
         WHERE task_date = $1::date AND board_mode = $2`,
        [date, boardMode],
      )
      const nextOrder = Number(orderRes.rows?.[0]?.max_order || 0) + 100
      await pgPool.query(
        `INSERT INTO task_center_board_rows(task_date, board_mode, row_key, row_type, row_title, row_order, assignments, lane_order, updated_by, updated_at)
         VALUES($1::date, $2, $3, 'final_group', '', $4, '{}'::jsonb, $5::jsonb, $6, now())
         ON CONFLICT (task_date, board_mode, row_key)
         DO UPDATE SET row_order=EXCLUDED.row_order, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [date, boardMode, rowKey, nextOrder, JSON.stringify([defaultSubrowKey()]), String(user.username || user.sub || '')],
      )
      return res.json({ ok: true, row_key: rowKey })
    }
    const currentOrders = Array.from(memoryBoardRows.values())
      .filter((item) => item.board_mode === boardMode)
      .map((item) => Number(item.row_order || 0))
    const nextOrder = (currentOrders.length ? Math.max(...currentOrders) : 0) + 100
    memoryBoardRows.set(`${date}|${boardMode}|${rowKey}`, {
      row_key: rowKey,
      board_mode: boardMode,
      row_type: 'final_group',
      row_title: '',
      row_order: nextOrder,
      assignments: {},
      subrow_order: [defaultSubrowKey()],
    })
    return res.json({ ok: true, row_key: rowKey })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'task_center_create_row_failed' })
  }
}

router.post('/delete-row', requirePerm('cleaning.task.assign'), async (req, res) => {
  const parsed = deleteRowSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { date, row_key: rowKey } = parsed.data
  const mode = normalizeBoardMode(parsed.data.mode)
  if (!rowKey.startsWith('group:')) return res.status(400).json({ message: 'only custom group rows can be deleted' })
  try {
    if (hasPg && pgPool) {
      await ensureTaskCenterTables()
      const itemRes = await pgPool.query(
        `SELECT COUNT(*)::int AS cnt
         FROM task_center_board_items
         WHERE task_date = $1::date AND board_mode = $2 AND row_key = $3`,
        [date, mode, rowKey],
      )
      if (Number(itemRes.rows?.[0]?.cnt || 0) > 0) {
        return res.status(400).json({ message: 'row_not_empty' })
      }
      await pgPool.query(
        `DELETE FROM task_center_board_rows
         WHERE task_date = $1::date AND board_mode = $2 AND row_key = $3`,
        [date, mode, rowKey],
      )
      return res.json({ ok: true })
    }
    const hasItems = Array.from(memoryBoardItems.entries()).some(([key, item]) => {
      return key.startsWith(`${date}|${mode}|`) && item.row_key === rowKey
    })
    if (hasItems) return res.status(400).json({ message: 'row_not_empty' })
    memoryBoardRows.delete(`${date}|${mode}|${rowKey}`)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'task_center_delete_row_failed' })
  }
})

router.post('/create-row', requirePerm('cleaning.task.assign'), createBoardRow)
router.post('/create-final-row', requirePerm('cleaning.task.assign'), createBoardRow)
