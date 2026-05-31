import { Router } from 'express'
import { z } from 'zod'
import { v4 as uuid } from 'uuid'
import { requireAnyPerm, requirePerm } from '../auth'
import { db } from '../store'
import { hasPg, pgPool } from '../dbAdapter'
import { ensureCleaningSchemaV2 } from '../services/cleaningSync'
import { defaultInspectionModeForTaskType, deferredProjectionDate, effectiveInspectionMode } from '../lib/cleaningInspection'

export const router = Router()

type BoardMode = 'board' | 'region' | 'final'
type TaskSource = 'cleaning' | 'work'

const DEFAULT_SUMMARY_CHECKOUT_TIME = '10am'
const DEFAULT_SUMMARY_CHECKIN_TIME = '3pm'
const DEFERRED_ROW_KEY = 'deferred:holding'
const DEFERRED_ROW_TITLE = '未安排区域 / 后续处理'
const DEFERRED_INSPECTION_ROW_KEY = 'deferred:inspection'
const DEFERRED_INSPECTION_ROW_TITLE = '延后检查'
const COMPLETED_ROW_KEY = 'group:completed'
const COMPLETED_ROW_TITLE = '已完成'
const WORK_TASK_VISIBILITY_START = '2026-06-01'

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
  scheduled_at?: string | null
  auto_sync_enabled?: boolean
  has_key_photo?: boolean
  key_photo_uploaded_at?: string | null
  inspection_mode?: 'pending_decision' | 'same_day' | 'self_complete' | 'deferred' | null
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

const memoryTaskFlags = new Map<string, TaskFlag>()
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
  if (s === 'done' || s === 'completed' || s === 'keys_hung' || s === 'ready') return 'done'
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
        .map((x) => (x && typeof x === 'object' ? text((x as any).content) : ''))
        .filter(Boolean)
      if (parts.length) return parts.join(' ')
    }
    if (j && typeof j === 'object') {
      const c = text((j as any).content)
      if (c) return c
    }
  } catch {}
  return s
}

function workTaskDisplayText(row: any): { title: string; detail: string } {
  const region = text(row?.property_region)
  const propertyCode = text(row?.property_code) || text(row?.property_id)
  const rawTitle = text(row?.title)
  const rawDetail = workSummaryText(row?.summary)
  const workRef = text(row?.id)
  const title = propertyCode
    ? (region ? `${region} ${propertyCode}` : propertyCode)
    : (rawTitle || workRef || '线下任务')
  const detailParts = [
    propertyCode && rawTitle && rawTitle !== title ? rawTitle : '',
    rawDetail && rawDetail !== rawTitle ? rawDetail : '',
    propertyCode && workRef && workRef !== title && workRef !== rawTitle ? workRef : '',
  ].filter(Boolean)
  return {
    title,
    detail: detailParts.join('，') || rawDetail || rawTitle || workRef || '线下任务',
  }
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

function inspectionModeOf(task: any) {
  const raw = lower(task.inspection_mode)
  if (raw === 'pending_decision' || raw === 'same_day' || raw === 'self_complete' || raw === 'deferred') return raw
  const tt = lower(task.task_type)
  if (tt === 'stayover_clean') return 'self_complete'
  if (tt === 'checkin_clean') return 'same_day'
  if (text(task.inspector_id)) return 'same_day'
  return 'pending_decision'
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
  if (ss.includes('completed')) return 'completed'
  if (ss.length) return ss[0]
  return 'pending'
}

function mergeCleaningTasks(list: BoardTask[]): BoardTask[] {
  const byProp = new Map<string, BoardTask[]>()
  for (const task of list) {
    const pid = text(task.property_id)
    const groupKey = `${pid}|${task.deferred_inspection_view ? `deferred:${text(task.inspection_due_date) || task.task_date}` : 'normal'}`
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
      const cleanerId = all.every((x) => text(x.cleaner_id || x.assignee_id) === text(all[0].cleaner_id || all[0].assignee_id)) ? (text(all[0].cleaner_id || all[0].assignee_id) || null) : null
      const assigneeId = all.every((x) => text(x.assignee_id) === text(all[0].assignee_id)) ? (text(all[0].assignee_id) || cleanerId) : cleanerId
      const inspectorId = all.every((x) => text(x.inspector_id) === text(all[0].inspector_id)) ? (text(all[0].inspector_id) || null) : null
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
        task_ids: Array.from(new Set(ids)),
        task_kind: 'turnover',
        title: mergedSummary.title,
        detail: [mergedSummary.detail, nightsText].filter(Boolean).join('，'),
        status: mergedStatus(all.map((x) => x.status)),
        assignee_id: assigneeId,
        cleaner_id: cleanerId,
        inspector_id: inspectorId,
        auto_sync_enabled: autoSync,
        has_key_photo: all.some((x) => !!x.has_key_photo),
        key_photo_uploaded_at: all.find((x) => text(x.key_photo_uploaded_at))?.key_photo_uploaded_at || null,
        inspection_mode: checkout.inspection_mode || checkin.inspection_mode || null,
        inspection_due_date: checkout.inspection_due_date || checkin.inspection_due_date || null,
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

async function loadCleaningTasks(date: string): Promise<BoardTask[]> {
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
         t.inspection_due_date::text AS inspection_due_date,
         t.scheduled_at,
         t.key_photo_uploaded_at,
         EXISTS(
           SELECT 1
           FROM cleaning_task_media m
           WHERE m.task_id::text = t.id::text AND m.type = 'key_photo'
         ) AS has_key_photo,
         t.checkout_time,
         t.checkin_time,
         t.nights_override,
         t.auto_sync_enabled,
         t.old_code,
         t.new_code,
         (o.confirmation_code::text) AS order_code,
         COALESCE(t.nights_override, o.nights) AS nights
       FROM cleaning_tasks t
       LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
       LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
       LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
       WHERE (
           ((COALESCE(t.task_date, t.date)::date) = ($1::date))
           OR (t.inspection_due_date IS NOT NULL AND (t.inspection_due_date::date) <= ($1::date))
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
        dateTo: date,
        status: row.status,
      })
      if (d === date) {
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
          scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
          auto_sync_enabled: row.auto_sync_enabled !== false,
          has_key_photo: !!row.has_key_photo,
          key_photo_uploaded_at: row.key_photo_uploaded_at ? String(row.key_photo_uploaded_at) : null,
          old_code: row.old_code != null ? String(row.old_code || '') : null,
          new_code: row.new_code != null ? String(row.new_code || '') : null,
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
          scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
          auto_sync_enabled: row.auto_sync_enabled !== false,
          has_key_photo: !!row.has_key_photo,
          key_photo_uploaded_at: row.key_photo_uploaded_at ? String(row.key_photo_uploaded_at) : null,
          old_code: row.old_code != null ? String(row.old_code || '') : null,
          new_code: row.new_code != null ? String(row.new_code || '') : null,
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
    if (taskDate === date) {
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
        scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
        auto_sync_enabled: row.auto_sync_enabled !== false,
        has_key_photo: false,
        key_photo_uploaded_at: null,
        old_code: row.old_code != null ? String(row.old_code || '') : null,
        new_code: row.new_code != null ? String(row.new_code || '') : null,
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
        AND (${where.join(' OR ')})
      ORDER BY COALESCE(w.scheduled_date, $1::date) ASC, w.urgency DESC, w.updated_at DESC, w.id DESC
    `
    const r = await pgPool.query(sql, vals)
    return (r?.rows || []).map((row: any) => {
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
    }})
  }
  const rows = (((db as any).workTasks || []) as any[]).slice()
  return rows
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
    const rawIds = task.task_source === 'cleaning' && task.deferred_inspection_view ? task.task_ids : [task.task_id]
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
    const layout = params.itemLayouts.get(boardTaskKey(task.task_source, task.task_id))
    let rowKey = layout?.row_key || defaultRegionRowKey(task)
    if (rowKey === DEFERRED_ROW_KEY) rowKey = defaultRegionRowKey(task)
    const rowMeta = params.rowMetas.get(rowKey)
    const rowType = (rowMeta?.row_type || (rowKey.startsWith('group:') ? 'final_group' : 'region')) as 'region' | 'final_group' | 'deferred'
    const rowTitle = text(rowMeta?.row_title) || rowTitleFromKey(rowKey)
    const rowOrder = rowMeta?.row_order ?? (rowType === 'final_group' ? 2000 : 1000)
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
    return !text(task.cleaner_id || task.assignee_id)
  })
  const pendingInspection = cleaningTasks.filter((task) => {
    if (task.temporarily_skipped || task.deferred_inspection_view) return false
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
    loadCleaningTasks(date),
    loadWorkTasks(date, includeOverdue, includeUnscheduled, includeFuture),
    loadTaskFlags(date),
    loadBoardRows(date, 'board'),
    loadBoardItems(date, 'board'),
  ])
  const allTasks = [...cleaningTasks, ...workTasks]
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
    tasks: workTasks.map((task) => ({
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
  const includeFuture = String((req.query as any)?.include_future || '').trim() !== '0'
  try {
    if (!hasPg && !Array.isArray((db as any).cleaningTasks)) {
      return res.json({ date, pool: [], groups: {}, tasks: [], rows: [], region_rows: [], final_group_rows: [], deferred_rows: [], entry_readiness: { ready_for_final_grouping: true, unresolved_primary_count: 0, pending_inspection_count: 0, skipped_count: 0 } })
    }
    const payload = await buildTaskCenterDay(date, includeOverdue, includeUnscheduled, includeFuture)
    return res.json(payload)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'task_center_day_failed' })
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
        for (const row of rowMap.values()) {
          await client.query(
            `INSERT INTO task_center_board_rows(task_date, board_mode, row_key, row_type, row_title, row_order, assignments, lane_order, updated_by, updated_at)
             VALUES($1::date, $2, $3, $4, $5, $6, COALESCE((SELECT assignments FROM task_center_board_rows WHERE task_date=$1::date AND board_mode=$2 AND row_key=$3), '{}'::jsonb), $7::jsonb, $8, now())
             ON CONFLICT (task_date, board_mode, row_key)
             DO UPDATE SET row_type=EXCLUDED.row_type, row_title=EXCLUDED.row_title, row_order=EXCLUDED.row_order, lane_order=EXCLUDED.lane_order, updated_by=EXCLUDED.updated_by, updated_at=now()`,
            [date, mode, row.row_key, row.row_type, row.row_title || rowTitleFromKey(row.row_key), Number(row.row_order || 0), JSON.stringify(row.subrow_order || []), String(user.username || user.sub || '')],
          )
        }
        for (const item of items) {
          await client.query(
            `INSERT INTO task_center_board_items(task_date, board_mode, task_source, task_id, row_key, lane_key, item_order, updated_by, updated_at)
             VALUES($1::date, $2, $3, $4, $5, $6, $7, $8, now())
             ON CONFLICT (task_date, board_mode, task_source, task_id)
             DO UPDATE SET row_key=EXCLUDED.row_key, lane_key=EXCLUDED.lane_key, item_order=EXCLUDED.item_order, updated_by=EXCLUDED.updated_by, updated_at=now()`,
            [date, mode, item.task_source, item.task_id, item.row_key, item.subrow_key || item.lane_key || defaultSubrowKey(), Number(item.item_order || 0), String(user.username || user.sub || '')],
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
