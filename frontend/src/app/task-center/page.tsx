"use client"

import { Alert, Button, DatePicker, Empty, Input, Modal, Select, Skeleton, Space, Switch, Tag, message } from 'antd'
import { DeleteOutlined, HolderOutlined, LeftOutlined, PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { getJSON, patchJSON, postJSON } from '../../lib/api'
import styles from '../cleaning/cleaningSchedule.module.scss'

type Staff = {
  id: string
  name: string
  kind?: 'cleaner' | 'inspector' | 'maintenance'
  is_active?: boolean
  color_hex?: string | null
}

type TaskCenterTask = {
  item_key: string
  task_source: 'cleaning' | 'work'
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
  current_row_key?: string
  current_subrow_key?: string
}

type TaskCenterSubrow = {
  subrow_key: string
  tasks: TaskCenterTask[]
}

type TaskCenterLine = {
  line_key: string
  row_key: string
  row_type: 'region' | 'final_group' | 'deferred'
  assignments: Record<string, any>
  tasks: TaskCenterTask[]
  start_index: number
  line_index: number
  inspectionIds: string[]
  workIds: string[]
}

type TaskCenterDisplayRow = {
  row_key: string
  row_title: string
  row_order: number
  row_type: 'region' | 'final_group' | 'deferred'
  assignments: Record<string, any>
  inspectionIds: string[]
  workIds: string[]
  lines: TaskCenterLine[]
}

type TaskCenterRow = {
  row_key: string
  row_title: string
  row_type: 'region' | 'final_group' | 'deferred'
  row_order: number
  assignments: Record<string, any>
  subrow_order: string[]
  subrows: TaskCenterSubrow[]
}

type TaskCenterDay = {
  date: string
  rows: TaskCenterRow[]
  region_rows?: TaskCenterRow[]
  final_group_rows?: TaskCenterRow[]
  deferred_rows?: TaskCenterRow[]
  entry_readiness: {
    ready_for_final_grouping: boolean
    unresolved_primary_count: number
    pending_inspection_count: number
    skipped_count: number
  }
}

type TaskDetailDraft = {
  cleaner_id: string | null
  inspector_id: string | null
  assignee_id: string | null
  inspection_mode: 'pending_decision' | 'same_day' | 'self_complete' | 'deferred'
  inspection_due_date: Dayjs | null
  keys_hung: boolean
  title: string
  summary: string
  urgency: 'low' | 'medium' | 'high' | 'urgent'
  temporarily_skipped: boolean
  skip_reason: string
  deferred_to_date: Dayjs | null
}

const DEFERRED_ROW_KEY = 'deferred:holding'
const DEFERRED_INSPECTION_ROW_KEY = 'deferred:inspection'
const COMPLETED_ROW_KEY = 'group:completed'
const DEFAULT_SUBROW_KEY = 'subrow:default'
const TASKS_PER_LINE = 4
const DEFAULT_SUMMARY_CHECKOUT_TIME = '10am'
const DEFAULT_SUMMARY_CHECKIN_TIME = '3pm'
const TASK_CENTER_TIMEZONE = 'Australia/Melbourne'
const TASK_CENTER_DAY_END_HOUR = 18

function melbourneDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TASK_CENTER_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const map = Object.fromEntries(parts.map((item) => [item.type, item.value]))
  return {
    year: String(map.year || ''),
    month: String(map.month || ''),
    day: String(map.day || ''),
    hour: Number(map.hour || 0),
  }
}

function defaultTaskCenterDate(now = new Date()) {
  const parts = melbourneDateParts(now)
  const base = dayjs(`${parts.year}-${parts.month}-${parts.day}`)
  return parts.hour >= TASK_CENTER_DAY_END_HOUR ? base.add(1, 'day') : base
}

function displayRowOrder(rowKey: string) {
  if (rowKey === 'region:Melbourne') return 10
  if (rowKey === 'region:West Melbourne') return 11
  if (rowKey === 'region:Docklands') return 20
  if (rowKey === 'region:Southbank') return 30
  if (rowKey === 'region:St Kilda') return 40
  if (rowKey === COMPLETED_ROW_KEY) return 80
  if (rowKey === 'work:bottom') return 90
  if (rowKey === DEFERRED_INSPECTION_ROW_KEY) return 95
  if (rowKey === DEFERRED_ROW_KEY) return 100
  return 70
}

function isCustomBoardRow(rowKey: string, rowType: TaskCenterRow['row_type']) {
  return rowType === 'final_group' && rowKey.startsWith('group:')
}

function cleaningTimingVisibility(task: Pick<TaskCenterTask, 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view'>) {
  if (task.deferred_inspection_view) return { showCheckout: false, showCheckin: false }
  const kind = String(task.task_kind || '').trim().toLowerCase()
  if (kind === 'turnover') return { showCheckout: true, showCheckin: true }
  if (kind === 'checkout_clean') return { showCheckout: true, showCheckin: false }
  if (kind === 'checkin_clean') return { showCheckout: false, showCheckin: true }
  if (kind === 'stayover_clean') return { showCheckout: false, showCheckin: false }
  const text = `${String(task.title || '')} ${String(task.detail || '')}`.toLowerCase()
  const hasCheckout = text.includes('退房')
  const hasCheckin = text.includes('入住')
  if ((task.task_ids || []).length > 1) return { showCheckout: hasCheckout || true, showCheckin: hasCheckin || true }
  return { showCheckout: hasCheckout, showCheckin: hasCheckin }
}

function parseSummaryTime(raw: string | null | undefined) {
  const text = String(raw || '').trim().toLowerCase()
  if (!text) return null
  const hit = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!hit) return null
  let hour = Number(hit[1] || 0)
  const minute = Number(hit[2] || 0)
  const meridiem = String(hit[3] || '').trim().toLowerCase()
  if (meridiem === 'am') {
    if (hour === 12) hour = 0
  } else if (meridiem === 'pm') {
    if (hour < 12) hour += 12
  }
  return hour * 60 + minute
}

function normalizedSummaryTime(raw: string | null | undefined) {
  return String(raw || '').trim()
}

function isDefaultSummaryTime(raw: string | null | undefined, defaultValue: string) {
  const actual = parseSummaryTime(raw)
  const expected = parseSummaryTime(defaultValue)
  if (actual != null && expected != null) return actual === expected
  return normalizedSummaryTime(raw).toLowerCase() === defaultValue.toLowerCase()
}

function specialTimingTags(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'summary_checkout_time' | 'summary_checkin_time'>) {
  if (task.task_source !== 'cleaning') return [] as Array<{ key: string; label: string; time: string; tone: 'danger' | 'success' | 'purple' }>
  const timing = cleaningTimingVisibility(task)
  const tags: Array<{ key: string; label: string; time: string; tone: 'danger' | 'success' | 'purple' }> = []
  const checkoutTime = normalizedSummaryTime(task.summary_checkout_time)
  const checkinTime = normalizedSummaryTime(task.summary_checkin_time)
  if (timing.showCheckout && checkoutTime && !isDefaultSummaryTime(checkoutTime, DEFAULT_SUMMARY_CHECKOUT_TIME)) {
    const checkoutMin = parseSummaryTime(checkoutTime)
    const defaultMin = parseSummaryTime(DEFAULT_SUMMARY_CHECKOUT_TIME)
    let label = '退房'
    if (checkoutMin != null && defaultMin != null) label = checkoutMin > defaultMin ? '晚退房' : (checkoutMin < defaultMin ? '早退房' : '退房')
    tags.push({ key: 'checkout', label, time: checkoutTime, tone: 'danger' })
  }
  if (timing.showCheckin && checkinTime && !isDefaultSummaryTime(checkinTime, DEFAULT_SUMMARY_CHECKIN_TIME)) {
    const checkinMin = parseSummaryTime(checkinTime)
    const defaultMin = parseSummaryTime(DEFAULT_SUMMARY_CHECKIN_TIME)
    let label = '入住'
    if (checkinMin != null && defaultMin != null) label = checkinMin < defaultMin ? '早入住' : (checkinMin > defaultMin ? '晚入住' : '入住')
    const tone = label === '早入住' ? 'purple' : (label === '晚入住' ? 'success' : 'danger')
    tags.push({ key: 'checkin', label, time: checkinTime, tone })
  }
  return tags
}

function shouldShowNights(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view'>) {
  if (task.task_source !== 'cleaning' || task.deferred_inspection_view) return false
  const timing = cleaningTimingVisibility(task)
  return timing.showCheckin
}

function isCheckinOnlyCleaningTask(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view'>) {
  if (task.task_source !== 'cleaning' || task.deferred_inspection_view) return false
  const timing = cleaningTimingVisibility(task)
  return timing.showCheckin && !timing.showCheckout
}

function isKeysHungStatus(status: string | null | undefined) {
  return String(status || '').trim().toLowerCase() === 'keys_hung'
}

function isCompletedBoardStatus(status: string | null | undefined) {
  const value = String(status || '').trim().toLowerCase()
  return value === 'keys_hung' || value === 'ready' || value === 'done' || value === 'completed'
}

function cleaningSummaryParts(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'summary_checkout_time' | 'summary_checkin_time' | 'nights'>) {
  if (task.task_source !== 'cleaning') return [String(task.detail || '').trim()].filter(Boolean)
  const parts: string[] = []
  const timing = cleaningTimingVisibility(task)
  const checkoutTime = normalizedSummaryTime(task.summary_checkout_time)
  const checkinTime = normalizedSummaryTime(task.summary_checkin_time)
  if (timing.showCheckout) {
    parts.push(isDefaultSummaryTime(checkoutTime, DEFAULT_SUMMARY_CHECKOUT_TIME) || !checkoutTime ? '退房' : `${checkoutTime}退房`)
  }
  if (timing.showCheckin) {
    parts.push(isDefaultSummaryTime(checkinTime, DEFAULT_SUMMARY_CHECKIN_TIME) || !checkinTime ? '入住' : `${checkinTime}入住`)
  }
  if (!parts.length) parts.push(cleaningTaskFlowLabel(task))
  if (shouldShowNights(task) && task.nights != null && Number(task.nights) > 0) parts.push(`住${Number(task.nights)}晚`)
  return parts
}

function cleaningSecondarySummary(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'summary_checkout_time' | 'summary_checkin_time' | 'nights'>) {
  if (task.task_source !== 'cleaning') return String(task.detail || '').trim()
  const parts = cleaningSummaryParts(task)
  return parts.join('，') || String(task.detail || '').trim()
}

function cleaningTaskFlowLabel(task: Pick<TaskCenterTask, 'task_kind' | 'title' | 'detail' | 'deferred_inspection_view'>) {
  if (task.deferred_inspection_view) return '待检查'
  const kind = String(task.task_kind || '').trim().toLowerCase()
  if (kind === 'turnover') return '退房入住'
  if (kind === 'checkout_clean') return '退房'
  if (kind === 'checkin_clean') return '入住'
  if (kind === 'stayover_clean') return '入住中清洁'
  return String(task.detail || task.title || '任务安排').trim()
}

function detailHeroSummary(task: TaskCenterTask) {
  if (task.task_source === 'work') return String(task.summary || task.detail || '线下任务').trim()
  const parts = cleaningSummaryParts(task)
  return parts.join(' · ')
}

export default function TaskCenterPage() {
  const [date, setDate] = useState<Dayjs>(() => defaultTaskCenterDate())
  const [staff, setStaff] = useState<Staff[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string; region?: string | null }[]>([])
  const [dayData, setDayData] = useState<TaskCenterDay | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filterText, setFilterText] = useState('')
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [pendingTaskKeys, setPendingTaskKeys] = useState<string[]>([])
  const [detailTask, setDetailTask] = useState<TaskCenterTask | null>(null)
  const [detailDraft, setDetailDraft] = useState<TaskDetailDraft | null>(null)
  const [detailSaving, setDetailSaving] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)
  const [creatingRow, setCreatingRow] = useState(false)
  const [offlineCreate, setOfflineCreate] = useState<{
    date: Dayjs
    task_type: 'property' | 'company' | 'other'
    title: string
    content: string
    urgency: 'low' | 'medium' | 'high' | 'urgent'
    property_id: string | null
    assignee_id: string | null
  } | null>(null)

  const dateStr = useMemo(() => date.format('YYYY-MM-DD'), [date])

  const loadStaff = useCallback(async () => {
    const rows = await getJSON<Staff[]>('/cleaning/staff').catch(() => [])
    setStaff(Array.isArray(rows) ? rows : [])
  }, [])

  const loadProps = useCallback(async () => {
    const rows = await getJSON<any[]>('/properties?include_archived=true').catch(() => [])
    setProperties(Array.isArray(rows) ? rows : [])
  }, [])

  const loadDay = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const payload = await getJSON<TaskCenterDay>(`/task-center/day?date=${encodeURIComponent(dateStr)}&include_overdue=1&include_unscheduled=1&include_future=1`, { timeoutMs: 20000 })
      setDayData(payload || null)
    } catch (e: any) {
      setError(String(e?.message || '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [dateStr])

  useEffect(() => {
    loadStaff().catch(() => {})
    loadProps().catch(() => {})
  }, [loadProps, loadStaff])

  useEffect(() => {
    loadDay().catch(() => {})
  }, [loadDay])

  const activeStaff = useMemo(() => staff.filter((item) => item.is_active !== false), [staff])
  const activeCleaners = useMemo(() => activeStaff.filter((item) => (item.kind || 'cleaner') === 'cleaner'), [activeStaff])
  const activeInspectors = useMemo(() => activeStaff.filter((item) => (item.kind || 'cleaner') === 'inspector'), [activeStaff])

  const staffById = useMemo(() => {
    const map = new Map<string, Staff>()
    for (const item of activeStaff) map.set(String(item.id), item)
    return map
  }, [activeStaff])

  const allRows = useMemo(() => dayData?.rows || [], [dayData?.rows])

  const filterQuery = useMemo(() => filterText.trim().toLowerCase(), [filterText])
  const filteringActive = filterQuery.length > 0

  const filteredRows = useMemo(() => {
    if (!filterQuery) return allRows
    return allRows
      .map((row) => ({
        ...row,
        subrows: row.subrows
          .map((subrow) => ({
            ...subrow,
            tasks: subrow.tasks.filter((task) => {
              const text = `${task.title} ${task.detail} ${task.property_region || ''} ${task.property_code || ''} ${task.summary || ''}`.toLowerCase()
              return text.includes(filterQuery)
            }),
          }))
          .filter((subrow) => subrow.tasks.length > 0),
      }))
      .filter((row) => row.subrows.some((subrow) => subrow.tasks.length > 0))
  }, [allRows, filterQuery])

  const allBoardTasks = useMemo(() => allRows.flatMap((row) => row.subrows.flatMap((subrow) => subrow.tasks)), [allRows])

  const allCleaningTaskRefs = useMemo(() => {
    const ids: string[] = []
    for (const task of allBoardTasks) {
      if (task.task_source !== 'cleaning') continue
      ids.push(...task.task_ids.map((id) => String(id)))
    }
    return Array.from(new Set(ids.filter(Boolean)))
  }, [allBoardTasks])

  const lockTaskIds = useMemo(() => {
    const ids: string[] = []
    for (const task of allBoardTasks) {
      if (task.task_source !== 'cleaning') continue
      if (!String(task.order_id || '').trim()) continue
      if (task.auto_sync_enabled === false) continue
      ids.push(...task.task_ids.map((id) => String(id)))
    }
    return Array.from(new Set(ids.filter(Boolean)))
  }, [allBoardTasks])

  const unlockTaskIds = useMemo(() => {
    const ids: string[] = []
    for (const task of allBoardTasks) {
      if (task.task_source !== 'cleaning') continue
      if (!String(task.order_id || '').trim()) continue
      if (task.auto_sync_enabled !== false) continue
      ids.push(...task.task_ids.map((id) => String(id)))
    }
    return Array.from(new Set(ids.filter(Boolean)))
  }, [allBoardTasks])

  const dayLocked = useMemo(() => {
    return allBoardTasks.some((task) => task.task_source === 'cleaning' && task.auto_sync_enabled === false && String(task.order_id || '').trim())
  }, [allBoardTasks])

  const propertyOptions = useMemo(() => (
    properties
      .filter((item) => String(item.id || '').trim())
      .map((item) => {
        const code = String(item.code || '').trim()
        const address = String(item.address || '').trim()
        const label = code ? (address ? `${code} ${address}` : code) : (address || String(item.id))
        return { value: String(item.id), label }
      })
  ), [properties])

  const cleanerOptions = useMemo(() => activeCleaners.map((item) => ({ value: item.id, label: item.name })), [activeCleaners])
  const inspectorOptions = useMemo(() => activeInspectors.map((item) => ({ value: item.id, label: item.name })), [activeInspectors])
  const allStaffOptions = useMemo(() => activeStaff.map((item) => ({ value: item.id, label: item.name })), [activeStaff])

  const normalizeHex = useCallback((hex: any): string | null => {
    const value = String(hex || '').trim()
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) return null
    return value.toUpperCase()
  }, [])

  const hexToRgba = useCallback((hex: string, alpha: number) => {
    const raw = hex.replace('#', '')
    const r = parseInt(raw.slice(0, 2), 16)
    const g = parseInt(raw.slice(2, 4), 16)
    const b = parseInt(raw.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }, [])

  const assignedColorForTask = useCallback((task: TaskCenterTask) => {
    const staffId = String(task.cleaner_id || task.assignee_id || '').trim()
    const hex = staffId ? normalizeHex(staffById.get(staffId)?.color_hex) : null
    return hex
  }, [normalizeHex, staffById])

  const cardStyleForTask = useCallback((task: TaskCenterTask) => {
    const assignedColor = assignedColorForTask(task)
    if (task.temporarily_skipped) {
      return {
        background: 'rgba(254, 242, 242, 0.92)',
        borderColor: 'rgba(239, 68, 68, 0.28)',
      }
    }
    if (!assignedColor) return {}
    return {
      background: hexToRgba(assignedColor, 0.16),
      borderColor: hexToRgba(assignedColor, 0.42),
    }
  }, [assignedColorForTask, hexToRgba])

  const textColorForTask = useCallback((task: TaskCenterTask) => {
    if (task.temporarily_skipped) return '#7f1d1d'
    return null
  }, [])

  const stripeColorForTask = useCallback((task: TaskCenterTask) => {
    if (task.temporarily_skipped) return '#ef4444'
    const assignedColor = assignedColorForTask(task)
    if (assignedColor) return assignedColor
    if (task.task_source === 'cleaning') return '#cbd5e1'
    if (task.urgency === 'urgent') return '#ef4444'
    if (task.urgency === 'high') return '#f97316'
    return '#94a3b8'
  }, [assignedColorForTask])

  const statusText = useCallback((status: string | null | undefined) => {
    const value = String(status || '').trim().toLowerCase()
    if (value === 'pending' || value === 'todo') return '待处理'
    if (value === 'assigned') return '已分配'
    if (value === 'in_progress') return '进行中'
    if (value === 'keys_hung') return '已挂钥匙'
    if (value === 'ready') return '已就绪'
    if (value === 'completed' || value === 'done') return '已完成'
    if (value === 'cancelled') return '已取消'
    return value || '-'
  }, [])

  const statusChipCls = useCallback((status: string | null | undefined) => {
    const value = String(status || '').trim().toLowerCase()
    if (value === 'keys_hung' || value === 'ready') return styles.statusDone
    if (value === 'completed' || value === 'done') return styles.statusDone
    if (value === 'in_progress') return styles.statusInProgress
    if (value === 'assigned') return styles.statusAssigned
    if (value === 'cancelled') return styles.statusCancelled
    return styles.statusPending
  }, [])

  const inspectionModeText = useCallback((mode: string | null | undefined) => {
    if (mode === 'same_day') return '同日检查'
    if (mode === 'self_complete') return '自完成'
    if (mode === 'deferred') return '延后检查'
    return '待确认'
  }, [])

  const addPending = useCallback((keys: string[]) => {
    setPendingTaskKeys((prev) => Array.from(new Set([...prev, ...keys])))
  }, [])

  const removePending = useCallback((keys: string[]) => {
    setPendingTaskKeys((prev) => prev.filter((item) => !keys.includes(item)))
  }, [])

  const hasPendingKey = useCallback((key: string) => pendingTaskKeys.includes(key), [pendingTaskKeys])

  const taskPendingKeys = useCallback((task: TaskCenterTask) => {
    if (task.task_source === 'cleaning') return task.task_ids.map((id) => `cleaning:${String(id)}`)
    return [`work:${String(task.task_id)}`]
  }, [])

  const cloneRows = useCallback((rows: TaskCenterRow[]) => {
    return rows.map((row) => ({
      ...row,
      assignments: { ...(row.assignments || {}) },
      subrow_order: [...(row.subrow_order || [])],
      subrows: row.subrows.map((subrow) => ({
        ...subrow,
        tasks: [...subrow.tasks],
      })),
    }))
  }, [])

  const buildReadinessFromRows = useCallback((rows: TaskCenterRow[]) => {
    const cleaningTasks = rows
      .flatMap((row) => row.subrows.flatMap((subrow) => subrow.tasks))
      .filter((task) => task.task_source === 'cleaning')
    const unresolvedPrimaryCount = cleaningTasks.filter((task) => {
      if (task.temporarily_skipped || task.deferred_inspection_view) return false
      return !String(task.cleaner_id || task.assignee_id || '').trim()
    }).length
    const pendingInspectionCount = cleaningTasks.filter((task) => {
      if (task.temporarily_skipped || task.deferred_inspection_view) return false
      const mode = String(task.inspection_mode || '').trim()
      if (!mode || mode === 'pending_decision') return true
      if ((mode === 'same_day' || mode === 'deferred') && !String(task.inspector_id || '').trim()) return true
      return false
    }).length
    const skippedCount = cleaningTasks.filter((task) => task.temporarily_skipped).length
    return {
      ready_for_final_grouping: unresolvedPrimaryCount === 0,
      unresolved_primary_count: unresolvedPrimaryCount,
      pending_inspection_count: pendingInspectionCount,
      skipped_count: skippedCount,
    }
  }, [])

  const replaceRowsLocally = useCallback((rows: TaskCenterRow[]) => {
    setDayData((prev) => {
      if (!prev) return prev
      const readiness = buildReadinessFromRows(rows)
      return {
        ...prev,
        rows,
        region_rows: rows.filter((row) => row.row_type !== 'deferred'),
        final_group_rows: rows.filter((row) => row.row_type === 'final_group'),
        deferred_rows: rows.filter((row) => row.row_type === 'deferred'),
        entry_readiness: readiness,
      }
    })
  }, [buildReadinessFromRows])

  const normalizeRowsForBoard = useCallback((rows: TaskCenterRow[]) => {
    return rows.map((row) => ({
      ...row,
      assignments: { ...(row.assignments || {}) },
      subrow_order: [DEFAULT_SUBROW_KEY],
      subrows: [{
        subrow_key: DEFAULT_SUBROW_KEY,
        tasks: row.subrows.flatMap((subrow) => [...subrow.tasks]),
      }],
    }))
  }, [])

  const buildEmptyBoardRow = useCallback((rowKey: string, rowOrder: number): TaskCenterRow => ({
    row_key: rowKey,
    row_title: '',
    row_type: 'final_group',
    row_order: rowOrder,
    assignments: {},
    subrow_order: [DEFAULT_SUBROW_KEY],
    subrows: [{
      subrow_key: DEFAULT_SUBROW_KEY,
      tasks: [],
    }],
  }), [])

  const defaultBoardRowKeyForTask = useCallback((task: TaskCenterTask) => {
    if (task.deferred_inspection_view) return DEFERRED_INSPECTION_ROW_KEY
    if (task.temporarily_skipped) return DEFERRED_ROW_KEY
    if (task.task_source === 'cleaning' && isCompletedBoardStatus(task.status)) return COMPLETED_ROW_KEY
    const region = String(task.property_region || '').trim()
    return region ? `region:${region}` : DEFERRED_ROW_KEY
  }, [])

  const ensureBoardRow = useCallback((rows: TaskCenterRow[], rowKey: string) => {
    const existing = rows.find((item) => item.row_key === rowKey)
    if (existing) return existing
    const rowType: TaskCenterRow['row_type'] = rowKey === DEFERRED_ROW_KEY
      || rowKey === DEFERRED_INSPECTION_ROW_KEY
      ? 'deferred'
      : (rowKey.startsWith('group:') ? 'final_group' : 'region')
    const rowTitle = rowKey === DEFERRED_ROW_KEY
      ? '后续处理'
      : rowKey === DEFERRED_INSPECTION_ROW_KEY
        ? '延后检查'
      : rowKey === COMPLETED_ROW_KEY
        ? '已完成'
      : (rowKey.startsWith('region:') ? rowKey.slice('region:'.length) : '')
    const row: TaskCenterRow = {
      row_key: rowKey,
      row_title: rowTitle,
      row_type: rowType,
      row_order: displayRowOrder(rowKey),
      assignments: {},
      subrow_order: [DEFAULT_SUBROW_KEY],
      subrows: [{
        subrow_key: DEFAULT_SUBROW_KEY,
        tasks: [],
      }],
    }
    rows.push(row)
    return row
  }, [])

  const layoutPayloadFromRows = useCallback((rows: TaskCenterRow[]) => ({
    rows: rows.map((row, rowIndex) => ({
      row_key: row.row_key,
      row_type: row.row_type,
      row_title: row.row_title,
      row_order: rowIndex + 1,
      subrow_order: [DEFAULT_SUBROW_KEY],
    })),
    subrows: rows.map((row) => ({
      row_key: row.row_key,
      subrow_key: DEFAULT_SUBROW_KEY,
      subrow_order: 1,
    })),
    items: rows.flatMap((row) => row.subrows.flatMap((subrow) => subrow.tasks.map((task, taskIndex) => ({
      task_source: task.task_source,
      task_id: task.task_id,
      row_key: row.row_key,
      subrow_key: DEFAULT_SUBROW_KEY,
      item_order: taskIndex + 1,
    })))),
  }), [])

  const persistBoardLayout = useCallback(async (rows: TaskCenterRow[]) => {
    await postJSON('/task-center/layout', {
      date: dateStr,
      mode: 'board',
      ...layoutPayloadFromRows(normalizeRowsForBoard(rows)),
    }, { timeoutMs: 20000 })
  }, [dateStr, layoutPayloadFromRows, normalizeRowsForBoard])

  const saveTaskFlags = useCallback(async (task: TaskCenterTask, temporarilySkipped: boolean, skipReason: string) => {
    const refs = task.task_source === 'cleaning' ? task.task_ids.map((id) => ({ task_source: 'cleaning' as const, task_id: String(id) })) : [{ task_source: 'work' as const, task_id: String(task.task_id) }]
    await postJSON('/task-center/task-flags', {
      date: dateStr,
      tasks: refs.map((ref) => ({
        task_source: ref.task_source,
        task_id: ref.task_id,
        temporarily_skipped: temporarilySkipped,
        skip_reason: temporarilySkipped ? (skipReason || '暂不安排') : null,
        bucket: temporarilySkipped ? 'deferred' : null,
      })),
    }, { timeoutMs: 20000 })
  }, [dateStr])

  const patchCleaningTasks = useCallback(async (ids: string[], patch: Record<string, any>) => {
    const uniq = Array.from(new Set(ids.map((item) => String(item)).filter(Boolean)))
    if (!uniq.length) return
    await postJSON('/cleaning/tasks/bulk-patch', { ids: uniq, patch }, { timeoutMs: 20000 })
  }, [])

  const patchWorkTask = useCallback(async (taskId: string, patch: Record<string, any>) => {
    await patchJSON(`/work-tasks/${encodeURIComponent(taskId)}`, patch, { timeoutMs: 20000 })
  }, [])

  const autoWorkStatus = useCallback((currentStatus: string | null | undefined, assigneeId: string | null) => {
    const current = String(currentStatus || '').trim().toLowerCase()
    if (current === 'in_progress' || current === 'done' || current === 'completed' || current === 'cancelled') return currentStatus || current
    return assigneeId ? 'assigned' : 'todo'
  }, [])

  const autoCleaningStatus = useCallback((currentStatus: string | null | undefined, cleanerId: string | null, inspectorId: string | null) => {
    const current = String(currentStatus || '').trim().toLowerCase()
    if (current === 'in_progress' || current === 'done' || current === 'completed' || current === 'cancelled' || current === 'keys_hung' || current === 'ready') return currentStatus || current
    return String(cleanerId || inspectorId || '').trim() ? 'assigned' : 'pending'
  }, [])

  const nextCleaningDetailStatus = useCallback((task: TaskCenterTask, draft: TaskDetailDraft) => {
    if (task.task_source !== 'cleaning') return task.status
    if (isCheckinOnlyCleaningTask(task) && draft.keys_hung) return 'keys_hung'
    if (isKeysHungStatus(task.status) && !draft.keys_hung) {
      return String(draft.cleaner_id || draft.inspector_id || '').trim() ? 'assigned' : 'pending'
    }
    return autoCleaningStatus(task.status, draft.cleaner_id, draft.inspector_id)
  }, [autoCleaningStatus])

  const openTaskDetail = useCallback((task: TaskCenterTask, row: TaskCenterRow, subrow: TaskCenterSubrow) => {
    setDetailTask({ ...task, current_row_key: row.row_key, current_subrow_key: subrow.subrow_key })
    setDetailDraft({
      cleaner_id: task.cleaner_id || null,
      inspector_id: task.inspector_id || null,
      assignee_id: task.assignee_id || null,
      inspection_mode: (task.inspection_mode || 'pending_decision') as TaskDetailDraft['inspection_mode'],
      inspection_due_date: task.inspection_due_date ? dayjs(task.inspection_due_date) : null,
      keys_hung: isKeysHungStatus(task.status),
      title: String(task.title || ''),
      summary: String(task.summary || task.detail || ''),
      urgency: (['low', 'medium', 'high', 'urgent'].includes(String(task.urgency || '').trim().toLowerCase()) ? String(task.urgency).trim().toLowerCase() : 'medium') as TaskDetailDraft['urgency'],
      temporarily_skipped: task.temporarily_skipped === true,
      skip_reason: String(task.skip_reason || ''),
      deferred_to_date: null,
    })
  }, [])

  const closeTaskDetail = useCallback(() => {
    if (detailSaving) return
    setDetailTask(null)
    setDetailDraft(null)
  }, [detailSaving])

  const rowsAfterTaskDetail = useCallback((rows: TaskCenterRow[], task: TaskCenterTask, draft: TaskDetailDraft) => {
    const nextStatus = nextCleaningDetailStatus(task, draft)
    const nextInspectionMode = draft.keys_hung ? 'self_complete' : draft.inspection_mode
    const nextRows = rows.map((row) => ({
      ...row,
      subrows: row.subrows.map((subrow) => ({
        ...subrow,
        tasks: subrow.tasks.map((item) => {
          const sameTask =
            item.item_key === task.item_key ||
            (item.task_source === task.task_source && item.task_id === task.task_id)
          if (!sameTask) return item
          return {
            ...item,
            cleaner_id: task.task_source === 'cleaning' ? (draft.cleaner_id || null) : item.cleaner_id,
            inspector_id: task.task_source === 'cleaning' ? (draft.inspector_id || null) : item.inspector_id,
            assignee_id: task.task_source === 'work' ? (draft.assignee_id || null) : item.assignee_id,
            status: task.task_source === 'cleaning' ? nextStatus : item.status,
            inspection_mode: task.task_source === 'cleaning' ? nextInspectionMode : item.inspection_mode,
            inspection_due_date: task.task_source === 'cleaning'
              ? ((draft.keys_hung || draft.inspection_mode !== 'deferred') ? null : (draft.inspection_due_date ? draft.inspection_due_date.format('YYYY-MM-DD') : null))
              : item.inspection_due_date,
            title: task.task_source === 'work' ? String(draft.title || '').trim() : item.title,
            summary: task.task_source === 'work' ? String(draft.summary || '').trim() : item.summary,
            detail: task.task_source === 'work'
              ? (String(draft.summary || '').trim() || item.detail)
              : item.detail,
            urgency: task.task_source === 'work' ? draft.urgency : item.urgency,
            temporarily_skipped: draft.temporarily_skipped,
            skip_reason: draft.temporarily_skipped ? (draft.skip_reason || '暂不安排') : null,
            skip_bucket: draft.temporarily_skipped ? 'deferred' : null,
          }
        }),
      })),
    }))
    if (task.task_source !== 'cleaning') return nextRows
    let movedTask: TaskCenterTask | null = null
    let sourceRowKey = ''
    for (const row of nextRows) {
      for (const subrow of row.subrows) {
        const idx = subrow.tasks.findIndex((item) => item.item_key === task.item_key || (item.task_source === task.task_source && item.task_id === task.task_id))
        if (idx < 0) continue
        movedTask = subrow.tasks[idx]
        sourceRowKey = row.row_key
        subrow.tasks.splice(idx, 1)
        break
      }
      if (movedTask) break
    }
    if (!movedTask) return nextRows
    if (task.task_source === 'cleaning' && nextInspectionMode === 'deferred') {
      const dueDate = draft.inspection_due_date ? draft.inspection_due_date.format('YYYY-MM-DD') : ''
      if (!dueDate || dueDate !== dateStr) return nextRows
      const targetRow = ensureBoardRow(nextRows, DEFERRED_INSPECTION_ROW_KEY)
      const targetSubrow = targetRow.subrows[0]
      if (!targetSubrow) return nextRows
      targetSubrow.tasks.push(movedTask)
      return nextRows
    }
    const targetRowKey = defaultBoardRowKeyForTask(movedTask)
    const targetRow = ensureBoardRow(nextRows, targetRowKey)
    const targetSubrow = targetRow.subrows[0]
    if (!targetSubrow) return nextRows
    targetSubrow.tasks.push(movedTask)
    if (sourceRowKey === targetRowKey) {
      targetSubrow.tasks.sort((a, b) => a.item_key.localeCompare(b.item_key))
    }
    return nextRows
  }, [dateStr, defaultBoardRowKeyForTask, ensureBoardRow, nextCleaningDetailStatus])

  const applyTaskDetailLocally = useCallback((task: TaskCenterTask, draft: TaskDetailDraft) => {
    setDayData((prev) => {
      if (!prev) return prev
      const rows = rowsAfterTaskDetail(prev.rows, task, draft)
      const readiness = buildReadinessFromRows(rows)
      return {
        ...prev,
        rows,
        region_rows: rows.filter((row) => row.row_type !== 'deferred'),
        final_group_rows: rows.filter((row) => row.row_type === 'final_group'),
        deferred_rows: rows.filter((row) => row.row_type === 'deferred'),
        entry_readiness: readiness,
      }
    })
  }, [buildReadinessFromRows, rowsAfterTaskDetail])

  const saveTaskDetail = useCallback(async () => {
    if (!detailTask || !detailDraft) return
    const rescheduleDate = detailTask.task_source === 'work' && detailDraft.temporarily_skipped && detailDraft.deferred_to_date
      ? detailDraft.deferred_to_date.format('YYYY-MM-DD')
      : null
    const shouldRescheduleWork = detailTask.task_source === 'work' && !!rescheduleDate
    const keysHungChanged = detailTask.task_source === 'cleaning' && detailDraft.keys_hung !== isKeysHungStatus(detailTask.status)
    const inspectionChanged =
      detailTask.task_source === 'cleaning' && (
        String(detailTask.inspection_mode || 'pending_decision') !== String((detailDraft.keys_hung ? 'self_complete' : detailDraft.inspection_mode) || 'pending_decision') ||
        String(detailTask.inspection_due_date || '') !== String(detailDraft.inspection_mode === 'deferred' && detailDraft.inspection_due_date ? detailDraft.inspection_due_date.format('YYYY-MM-DD') : '') ||
        String(detailTask.inspector_id || '') !== String((detailDraft.keys_hung || detailDraft.inspection_mode === 'pending_decision' || detailDraft.inspection_mode === 'self_complete') ? '' : (detailDraft.inspector_id || ''))
      )
    const pendingKeys = taskPendingKeys(detailTask)
    const previousRows = cloneRows(allRows)
    const skipChanged =
      detailTask.temporarily_skipped !== detailDraft.temporarily_skipped ||
      String(detailTask.skip_reason || '') !== String(detailDraft.skip_reason || '') ||
      shouldRescheduleWork
    addPending(pendingKeys)
    setDetailSaving(true)
    applyTaskDetailLocally(detailTask, detailDraft)
    setDetailTask(null)
    setDetailDraft(null)
    try {
      if (detailTask.task_source === 'cleaning') {
        const nextStatus = nextCleaningDetailStatus(detailTask, detailDraft)
        const nextInspectionMode = detailDraft.keys_hung ? 'self_complete' : detailDraft.inspection_mode
        await patchCleaningTasks(detailTask.task_ids, {
          cleaner_id: detailDraft.cleaner_id || null,
          inspector_id: nextInspectionMode === 'pending_decision' || nextInspectionMode === 'self_complete' ? null : (detailDraft.inspector_id || null),
          inspection_mode: nextInspectionMode,
          inspection_due_date: nextInspectionMode === 'deferred' ? (detailDraft.inspection_due_date ? detailDraft.inspection_due_date.format('YYYY-MM-DD') : null) : null,
          status: nextStatus,
        })
        if (keysHungChanged) {
          const rowsForPersist = rowsAfterTaskDetail(normalizeRowsForBoard(cloneRows(previousRows)), detailTask, detailDraft)
          await persistBoardLayout(rowsForPersist)
        }
      } else {
        await patchWorkTask(detailTask.task_id, {
          title: String(detailDraft.title || '').trim(),
          summary: String(detailDraft.summary || '').trim(),
          urgency: detailDraft.urgency,
          assignee_id: shouldRescheduleWork ? null : (detailDraft.assignee_id || null),
          scheduled_date: shouldRescheduleWork ? rescheduleDate : undefined,
          status: shouldRescheduleWork ? 'todo' : undefined,
        })
      }
      if (skipChanged || keysHungChanged || inspectionChanged) {
        await saveTaskFlags(
          detailTask,
          shouldRescheduleWork ? false : detailDraft.temporarily_skipped,
          shouldRescheduleWork ? '' : detailDraft.skip_reason,
        )
        await loadDay()
      }
      message.success(shouldRescheduleWork ? `任务已移到 ${rescheduleDate}` : '任务已更新')
    } catch (e: any) {
      replaceRowsLocally(previousRows)
      message.error(String(e?.message || '保存失败'))
    } finally {
      removePending(pendingKeys)
      setDetailSaving(false)
    }
  }, [addPending, allRows, applyTaskDetailLocally, cloneRows, detailDraft, detailTask, loadDay, nextCleaningDetailStatus, normalizeRowsForBoard, patchCleaningTasks, patchWorkTask, persistBoardLayout, removePending, replaceRowsLocally, rowsAfterTaskDetail, saveTaskFlags, taskPendingKeys])

  const rowTaskCollections = useCallback((row: TaskCenterRow) => {
    const tasks = row.subrows.flatMap((subrow) => subrow.tasks)
    const inspectionIds = Array.from(new Set(
      tasks
        .filter((task) => task.task_source === 'cleaning' && (task.can_configure_inspection || task.deferred_inspection_view || isCheckinOnlyCleaningTask(task)))
        .flatMap((task) => task.task_ids),
    ))
    const workIds = tasks.filter((task) => task.task_source === 'work').map((task) => task.task_id)
    return { inspectionIds, workIds }
  }, [])

  const applyRowAssignmentLocally = useCallback((params: {
    rowKey?: string
    field: 'inspector_id' | 'executor_id'
    value: string | null
    inspectionIds: string[]
    workIds: string[]
  }) => {
    const inspectionSet = new Set(params.inspectionIds.map((item) => String(item)))
    const workSet = new Set(params.workIds.map((item) => String(item)))
    setDayData((prev) => {
      if (!prev) return prev
      const rows: TaskCenterRow[] = prev.rows.map((row) => {
        const nextAssignments = params.rowKey && row.row_key === params.rowKey
          ? { ...(row.assignments || {}), [params.field]: params.value || null }
          : { ...(row.assignments || {}) }
        return {
          ...row,
          assignments: nextAssignments,
          subrows: row.subrows.map((subrow) => ({
            ...subrow,
            tasks: subrow.tasks.map((task): TaskCenterTask => {
              if (params.field === 'inspector_id') {
                const matched = task.task_source === 'cleaning' && task.task_ids.some((id) => inspectionSet.has(String(id)))
                if (!matched) return task
                const nextInspectionMode: TaskCenterTask['inspection_mode'] = params.value ? 'same_day' : 'pending_decision'
                return {
                  ...task,
                  inspector_id: params.value,
                  inspection_mode: nextInspectionMode,
                  status: autoCleaningStatus(task.status, task.cleaner_id || task.assignee_id || null, params.value),
                }
              }
              const matched = task.task_source === 'work' && workSet.has(String(task.task_id))
              if (!matched) return task
              return {
                ...task,
                assignee_id: params.value,
                status: autoWorkStatus(task.status, params.value),
              }
            }),
          })),
        }
      })
      return {
        ...prev,
        rows,
        region_rows: rows.filter((row) => row.row_type !== 'deferred'),
        final_group_rows: rows.filter((row) => row.row_type === 'final_group'),
        deferred_rows: rows.filter((row) => row.row_type === 'deferred'),
        entry_readiness: buildReadinessFromRows(rows),
      }
    })
  }, [autoCleaningStatus, autoWorkStatus, buildReadinessFromRows])

  const updateRowAssignment = useCallback(async (row: TaskCenterRow, field: 'inspector_id' | 'executor_id', value: string | null) => {
    const fullRow = allRows.find((item) => item.row_key === row.row_key) || row
    const nextAssignments = { ...(fullRow.assignments || {}), [field]: value || null }
    const previousRows = cloneRows(allRows)
    const collections = rowTaskCollections(fullRow)
    applyRowAssignmentLocally({
      rowKey: fullRow.row_key,
      field,
      value,
      inspectionIds: collections.inspectionIds,
      workIds: collections.workIds,
    })
    try {
      await postJSON('/task-center/row-assignments', {
        date: dateStr,
        mode: 'board',
        row_key: fullRow.row_key,
        row_type: fullRow.row_type,
        row_title: fullRow.row_title,
        row_order: fullRow.row_order,
        subrow_order: fullRow.subrows.map((item) => item.subrow_key),
        assignments: nextAssignments,
      }, { timeoutMs: 20000 })
      if (field === 'inspector_id' && collections.inspectionIds.length) {
        await patchCleaningTasks(collections.inspectionIds, {
          inspector_id: value || null,
          inspection_mode: value ? 'same_day' : 'pending_decision',
        })
      }
      if (field === 'executor_id' && collections.workIds.length) {
        await Promise.all(collections.workIds.map((taskId) => patchWorkTask(taskId, { assignee_id: value || null })))
      }
      await loadDay()
      message.success('整行指派已更新')
    } catch (e: any) {
      replaceRowsLocally(previousRows)
      message.error(String(e?.message || '更新失败'))
    }
  }, [allRows, applyRowAssignmentLocally, cloneRows, dateStr, loadDay, patchCleaningTasks, patchWorkTask, replaceRowsLocally, rowTaskCollections])

  const createRow = useCallback(async () => {
    const previousRows = cloneRows(allRows)
    const nextRowOrder = previousRows.reduce((max, row) => Math.max(max, Number(row.row_order || 0)), 0) + 100
    const tempRowKey = `group:pending:${Date.now()}`
    replaceRowsLocally([...previousRows, buildEmptyBoardRow(tempRowKey, nextRowOrder)])
    setCreatingRow(true)
    try {
      const payload = await postJSON<{ row_key?: string }>('/task-center/create-row', { date: dateStr }, { timeoutMs: 20000 })
      const persistedRowKey = String(payload?.row_key || '').trim()
      if (persistedRowKey) {
        setDayData((prev) => {
          if (!prev) return prev
          const rows = prev.rows.map((row) => (row.row_key === tempRowKey ? { ...row, row_key: persistedRowKey } : row))
          return {
            ...prev,
            rows,
            region_rows: rows.filter((row) => row.row_type !== 'deferred'),
            final_group_rows: rows.filter((row) => row.row_type === 'final_group'),
            deferred_rows: rows.filter((row) => row.row_type === 'deferred'),
            entry_readiness: buildReadinessFromRows(rows),
          }
        })
      }
      message.success('已新增一行')
    } catch (e: any) {
      replaceRowsLocally(previousRows)
      message.error(String(e?.message || '新增一行失败'))
    } finally {
      setCreatingRow(false)
    }
  }, [allRows, buildEmptyBoardRow, buildReadinessFromRows, cloneRows, dateStr, replaceRowsLocally])

  const deleteRow = useCallback(async (rowKey: string) => {
    const previousRows = cloneRows(allRows)
    const targetRow = previousRows.find((row) => row.row_key === rowKey)
    if (!targetRow) return
    const rowTaskCount = targetRow.subrows.reduce((sum, subrow) => sum + subrow.tasks.length, 0)
    if (rowTaskCount > 0) {
      message.warning('请先把这一行里的任务拖走，再删除该行')
      return
    }
    const nextRows = previousRows.filter((row) => row.row_key !== rowKey)
    replaceRowsLocally(nextRows)
    if (rowKey.startsWith('group:pending:')) {
      message.success('已删除空白行')
      return
    }
    try {
      await postJSON('/task-center/delete-row', { date: dateStr, row_key: rowKey }, { timeoutMs: 20000 })
      message.success('已删除空白行')
    } catch (e: any) {
      replaceRowsLocally(previousRows)
      message.error(String(e?.message || '删除行失败'))
    }
  }, [allRows, cloneRows, dateStr, replaceRowsLocally])

  const dragPayloadForTask = useCallback((task: TaskCenterTask) => ({
    task_source: task.task_source,
    task_id: task.task_id,
  }), [])

  const handleTaskDrop = useCallback(async (payload: any, targetLine: TaskCenterLine) => {
    const task = allBoardTasks.find((item) => item.task_source === payload.task_source && item.task_id === payload.task_id)
    if (!task) return
    const pendingKeys = taskPendingKeys(task)
    if (pendingKeys.some((key) => hasPendingKey(key))) return
    const previousRows = cloneRows(allRows)
    const nextRows = normalizeRowsForBoard(cloneRows(allRows))
    let movedTask: TaskCenterTask | null = null
    for (const row of nextRows) {
      for (const subrow of row.subrows) {
        const idx = subrow.tasks.findIndex((item) => item.task_source === payload.task_source && item.task_id === payload.task_id)
        if (idx >= 0) {
          movedTask = subrow.tasks[idx]
          subrow.tasks.splice(idx, 1)
          break
        }
      }
      if (movedTask) break
    }
    if (!movedTask) return
    const resolvedTargetRowKey = targetLine.row_key === 'work:bottom'
      ? (task.task_source === 'work' ? defaultBoardRowKeyForTask(task) : '')
      : targetLine.row_key
    if (!resolvedTargetRowKey) {
      setDragOverKey(null)
      return
    }
    const row = ensureBoardRow(nextRows, resolvedTargetRowKey)
    const subrow = row?.subrows[0]
    if (!row || !subrow) return
    const insertIndex = targetLine.row_key === 'work:bottom'
      ? subrow.tasks.length
      : (() => {
          const currentLength = targetLine.tasks.length
          const currentStart = targetLine.start_index
          return currentLength >= TASKS_PER_LINE
            ? Math.max(currentStart, Math.min(currentStart + TASKS_PER_LINE - 1, subrow.tasks.length))
            : Math.min(currentStart + currentLength, subrow.tasks.length)
        })()
    subrow.tasks.splice(insertIndex, 0, movedTask)
    addPending(pendingKeys)
    replaceRowsLocally(nextRows)
    setDragOverKey(null)
    try {
      if (row.row_key === DEFERRED_ROW_KEY) {
        await saveTaskFlags(task, true, task.skip_reason || '暂不安排')
      } else if (task.temporarily_skipped) {
        await saveTaskFlags(task, false, '')
      }
      await persistBoardLayout(nextRows)
    } catch (e: any) {
      replaceRowsLocally(previousRows)
      message.error(String(e?.message || '拖拽更新失败'))
    } finally {
      removePending(pendingKeys)
      setDragOverKey(null)
    }
  }, [addPending, allBoardTasks, allRows, cloneRows, defaultBoardRowKeyForTask, ensureBoardRow, hasPendingKey, normalizeRowsForBoard, persistBoardLayout, removePending, replaceRowsLocally, saveTaskFlags, taskPendingKeys])

  const lockDay = useCallback(async () => {
    if (!allCleaningTaskRefs.length) { message.warning('当日无可锁定任务'); return }
    if (!lockTaskIds.length) { message.info('当日已处于锁定状态'); return }
    Modal.confirm({
      title: '确认锁定当日安排？',
      content: '锁定后将禁用拖拽分配与快速指派，需手动解锁才能继续修改。',
      okText: '锁定',
      okButtonProps: { danger: true },
      onOk: async () => {
        await postJSON('/cleaning/tasks/bulk-lock-auto-sync', { ids: lockTaskIds }, { timeoutMs: 20000 })
        await loadDay()
        message.success('已锁定当日安排')
      },
    })
  }, [allCleaningTaskRefs.length, loadDay, lockTaskIds])

  const unlockDay = useCallback(async () => {
    if (!allCleaningTaskRefs.length) { message.warning('当日无可解锁任务'); return }
    if (!unlockTaskIds.length) { message.info('当日已处于解锁状态'); return }
    Modal.confirm({
      title: '确认解锁当日安排？',
      content: '解锁后允许拖拽与快速指派，并恢复自动同步。',
      okText: '解锁',
      onOk: async () => {
        await postJSON('/cleaning/tasks/bulk-restore-auto-sync', { ids: unlockTaskIds }, { timeoutMs: 20000 })
        await loadDay()
        message.success('已解锁当日安排')
      },
    })
  }, [allCleaningTaskRefs.length, loadDay, unlockTaskIds])

  const openCreateModal = useCallback(() => {
    setOfflineCreate({
      date,
      task_type: 'other',
      title: '',
      content: '',
      urgency: 'medium',
      property_id: null,
      assignee_id: null,
    })
    setCreateOpen(true)
  }, [date])

  const submitCreate = useCallback(async () => {
    if (!offlineCreate) return
    const title = String(offlineCreate.title || '').trim()
    if (!title) { message.warning('请输入任务标题'); return }
    setCreateLoading(true)
    try {
      const payload: any = {
        date: offlineCreate.date.format('YYYY-MM-DD'),
        task_type: offlineCreate.task_type,
        title,
        content: String(offlineCreate.content || '').trim(),
        kind: 'other',
        status: 'todo',
        urgency: offlineCreate.urgency,
        property_id: offlineCreate.task_type === 'property' ? (offlineCreate.property_id || undefined) : undefined,
        assignee_id: offlineCreate.assignee_id || undefined,
      }
      await postJSON('/cleaning/offline-tasks', payload, { timeoutMs: 20000 })
      setCreateOpen(false)
      await loadDay()
      message.success('任务已创建')
    } catch (e: any) {
      message.error(String(e?.message || '创建失败'))
    } finally {
      setCreateLoading(false)
    }
  }, [loadDay, offlineCreate])

  const renderTaskCard = useCallback((
    task: TaskCenterTask,
    row: TaskCenterRow,
    subrow: TaskCenterSubrow,
    line?: TaskCenterLine,
    onLineDragOver?: (e: any) => void,
    onLineDrop?: (e: any) => void,
  ) => {
    const pending = taskPendingKeys(task).some((key) => hasPendingKey(key))
    const dragKey = line?.line_key || `${row.row_key}:${subrow.subrow_key}`
    const textColor = textColorForTask(task)
    const lockedByDay = dayLocked && task.task_source === 'cleaning' && String(task.order_id || '').trim().length > 0
    const dragDisabled = pending || lockedByDay || filteringActive
    const timingTags = specialTimingTags(task)
    const detailText = task.skip_reason || (task.task_source === 'cleaning' ? cleaningSecondarySummary(task) : (task.detail || task.summary || ''))
    const assignedStaffId = String(task.cleaner_id || task.assignee_id || '').trim()
    const assignedStaffName = assignedStaffId ? String(staffById.get(assignedStaffId)?.name || '').trim() : ''
    return (
      <div
        key={task.item_key}
        className={`${styles.taskChip} ${styles.taskCenterCompactTask} ${dragDisabled ? styles.taskChipDisabled : styles.taskChipDraggable}`}
        style={cardStyleForTask(task)}
        draggable={!dragDisabled}
        onDragStart={(e) => {
          if (dragDisabled) return
          e.dataTransfer.setData('text/plain', JSON.stringify(dragPayloadForTask(task)))
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={onLineDragOver}
        onDragEnter={onLineDragOver}
        onDrop={onLineDrop}
        onDragEnd={() => setDragOverKey(null)}
        onClick={() => openTaskDetail(task, row, subrow)}
        title={`${task.title}\n${detailText || ''}${task.skip_reason ? `\n${task.skip_reason}` : ''}`}
      >
        <span className={`${styles.taskGrip} ${styles.taskCenterCompactGrip}`}><HolderOutlined /></span>
        <div className={styles.taskStripe} style={{ backgroundColor: stripeColorForTask(task) }} />
        <div className={styles.taskMain}>
          <div className={styles.taskCenterCompactMetaBar}>
            <span className={`${styles.statusChip} ${statusChipCls(task.status)} ${styles.taskCenterCompactStatus}`}>{statusText(task.status)}</span>
            {task.task_source === 'cleaning' && (task.can_configure_inspection || task.deferred_inspection_view) ? (
              <span className={styles.taskCenterCompactTag}>{inspectionModeText(task.inspection_mode)}</span>
            ) : null}
            {task.task_source === 'work' ? (
              <span className={styles.taskCenterCompactTag}>{task.task_kind || '线下任务'}</span>
            ) : null}
            {timingTags.map((item) => (
              <span
                key={`${task.item_key}:${item.key}`}
                className={`${styles.taskCenterCompactTag} ${
                  item.tone === 'success'
                    ? styles.taskCenterCompactTagSuccess
                    : (item.tone === 'purple' ? styles.taskCenterCompactTagPurple : styles.taskCenterCompactTagAlert)
                }`}
              >
                {item.label}
              </span>
            ))}
            {task.temporarily_skipped ? (
              <span className={`${styles.taskCenterCompactTag} ${styles.taskCenterCompactTagDanger}`}>暂不安排</span>
            ) : null}
          </div>
          <div className={styles.taskCenterCompactTitle} style={textColor ? { color: textColor } : undefined}>
            <span className={styles.taskCenterCompactTitleText}>{task.title}</span>
            {assignedStaffName ? <span className={styles.taskCenterCompactTitleMeta}>{assignedStaffName}</span> : null}
          </div>
          <div className={styles.taskCenterCompactDetail} style={textColor ? { color: textColor } : undefined}>
            {detailText || '\u00A0'}
          </div>
        </div>
        {dragOverKey === dragKey ? <div className={styles.taskCenterDropMarker} /> : null}
      </div>
    )
  }, [cardStyleForTask, dayLocked, dragOverKey, dragPayloadForTask, filteringActive, hasPendingKey, inspectionModeText, openTaskDetail, staffById, statusChipCls, statusText, stripeColorForTask, taskPendingKeys, textColorForTask])

  const displayRows = useMemo(() => {
    const output: TaskCenterDisplayRow[] = []
    const bottomWorkTasks: TaskCenterTask[] = []
    let globalLineIndex = 0
    for (const row of filteredRows) {
      const fullRow = allRows.find((item) => item.row_key === row.row_key) || row
      const tasks = row.subrows.flatMap((subrow) => subrow.tasks)
      const collections = rowTaskCollections(fullRow)
      const rowLines: TaskCenterLine[] = []
      const pushBucket = (bucketTasks: TaskCenterTask[], target: TaskCenterLine[], kind: 'cleaning' | 'work' | 'deferred') => {
        if (!bucketTasks.length) return
        const lineCount = Math.max(1, Math.ceil(bucketTasks.length / TASKS_PER_LINE))
        for (let index = 0; index < lineCount; index += 1) {
          globalLineIndex += 1
          const lineTasks = bucketTasks.slice(index * TASKS_PER_LINE, (index + 1) * TASKS_PER_LINE)
          target.push({
            line_key: `${row.row_key}:line:${kind}:${index + 1}`,
            row_key: row.row_key,
            row_type: row.row_type,
            assignments: row.assignments || {},
            tasks: lineTasks,
            start_index: Math.max(0, tasks.findIndex((task) => task.item_key === lineTasks[0]?.item_key)),
            line_index: globalLineIndex,
            inspectionIds: kind === 'cleaning' ? collections.inspectionIds : [],
            workIds: kind === 'work' ? collections.workIds : [],
          })
        }
      }
      if (row.row_type === 'deferred') {
        pushBucket(tasks, rowLines, 'deferred')
      } else {
        const cleaningTasks = tasks.filter((task) => task.task_source === 'cleaning')
        const workTasks = tasks.filter((task) => task.task_source !== 'cleaning')
        pushBucket(cleaningTasks, rowLines, 'cleaning')
        if (row.row_type === 'final_group') {
          pushBucket(workTasks, rowLines, 'work')
        } else if (workTasks.length) {
          bottomWorkTasks.push(...workTasks)
        }
      }
      if (rowLines.length) {
        output.push({
          row_key: row.row_key,
          row_title: fullRow.row_title,
          row_order: Number(fullRow.row_order || 0),
          row_type: row.row_type,
          assignments: row.assignments || {},
          inspectionIds: collections.inspectionIds,
          workIds: row.row_type === 'final_group' ? collections.workIds : [],
          lines: rowLines,
        })
      }
    }
    if (bottomWorkTasks.length) {
      const bottomLines: TaskCenterLine[] = []
      const lineCount = Math.max(1, Math.ceil(bottomWorkTasks.length / TASKS_PER_LINE))
      const sameAssignee = bottomWorkTasks.every((task) => String(task.assignee_id || '') === String(bottomWorkTasks[0]?.assignee_id || ''))
      for (let index = 0; index < lineCount; index += 1) {
        globalLineIndex += 1
        const lineTasks = bottomWorkTasks.slice(index * TASKS_PER_LINE, (index + 1) * TASKS_PER_LINE)
        bottomLines.push({
          line_key: `work:bottom:${index + 1}`,
          row_key: 'work:bottom',
          row_type: 'final_group',
          assignments: { executor_id: sameAssignee ? (bottomWorkTasks[0]?.assignee_id || null) : null },
          tasks: lineTasks,
          start_index: index * TASKS_PER_LINE,
          line_index: globalLineIndex,
          inspectionIds: [],
          workIds: lineTasks.map((task) => task.task_id),
        })
      }
      output.push({
        row_key: 'work:bottom',
        row_title: '',
        row_order: Number.MAX_SAFE_INTEGER,
        row_type: 'final_group',
        assignments: { executor_id: sameAssignee ? (bottomWorkTasks[0]?.assignee_id || null) : null },
        inspectionIds: [],
        workIds: bottomWorkTasks.map((task) => task.task_id),
        lines: bottomLines,
      })
    }
    output.sort((a, b) => {
      return displayRowOrder(a.row_key) - displayRowOrder(b.row_key)
        || a.row_order - b.row_order
        || a.row_key.localeCompare(b.row_key)
    })
    return output
  }, [allRows, filteredRows, rowTaskCollections])

  const renderLine = useCallback((line: TaskCenterLine) => {
    const dragKey = line.line_key
    const row: TaskCenterRow = {
      row_key: line.row_key,
      row_title: '',
      row_type: line.row_type,
      row_order: 0,
      assignments: line.assignments,
      subrow_order: [DEFAULT_SUBROW_KEY],
      subrows: [{ subrow_key: DEFAULT_SUBROW_KEY, tasks: line.tasks }],
    }
    const subrow = row.subrows[0]
    const activateDropTarget = (e: any) => {
      if (filteringActive) return
      e.preventDefault()
      setDragOverKey(dragKey)
    }
    const completeDrop = (e: any) => {
      if (filteringActive) return
      e.preventDefault()
      e.stopPropagation()
      try {
        const payload = JSON.parse(e.dataTransfer.getData('text/plain') || '{}')
        handleTaskDrop(payload, line).catch(() => {})
      } catch {}
    }
    return (
      <div
        key={line.line_key}
        className={`${styles.taskCenterSubrow} ${styles.taskCenterFlatLine} ${styles.taskCenterLineOnly} ${dragOverKey === dragKey ? styles.dropActive : ''}`}
        onDragOver={activateDropTarget}
        onDragLeave={() => setDragOverKey((prev) => (prev === dragKey ? null : prev))}
        onDrop={completeDrop}
      >
        <div
          className={styles.taskCenterSubrowGrid}
          onDragOver={activateDropTarget}
          onDrop={completeDrop}
        >
          {subrow.tasks.length ? subrow.tasks.map((task) => renderTaskCard(task, row, subrow, line, activateDropTarget, completeDrop)) : (
            <div
              className={`${styles.dropZone} ${styles.taskCenterSubrowEmpty}`}
              onDragOver={activateDropTarget}
              onDrop={completeDrop}
            >
              拖到这里
            </div>
          )}
        </div>
      </div>
    )
  }, [dragOverKey, filteringActive, handleTaskDrop, renderTaskCard])

  const renderDisplayRow = (displayRow: TaskCenterDisplayRow) => {
    const realRow = allRows.find((item) => item.row_key === displayRow.row_key)
    const rowTaskCount = realRow?.subrows.reduce((sum, subrow) => sum + subrow.tasks.length, 0) || 0
    const canDeleteRow = isCustomBoardRow(displayRow.row_key, displayRow.row_type) && rowTaskCount === 0
    return (
      <div key={displayRow.row_key} className={styles.taskCenterBoardRow}>
        <div className={styles.taskCenterBoardRowHead}>
          <div className={styles.taskCenterBoardRowActions}>
            {displayRow.row_type === 'final_group' && String(displayRow.row_title || '').trim() ? (
              <Tag color={displayRow.row_key === COMPLETED_ROW_KEY ? 'green' : 'default'}>
                {displayRow.row_title}
              </Tag>
            ) : null}
            {displayRow.row_type === 'deferred' ? (
              <Tag color={displayRow.row_key === DEFERRED_INSPECTION_ROW_KEY ? 'blue' : 'red'}>
                {displayRow.row_key === DEFERRED_INSPECTION_ROW_KEY ? '延后检查' : '后续处理'}
              </Tag>
            ) : null}
            {canDeleteRow ? (
              <Button
                type="text"
                danger
                size="small"
                icon={<DeleteOutlined />}
                onClick={() => deleteRow(displayRow.row_key).catch(() => {})}
              >
                删除行
              </Button>
            ) : null}
            {displayRow.inspectionIds.length ? (
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                value={displayRow.assignments?.inspector_id || undefined}
                onChange={(value) => updateRowAssignment(realRow || {
                  row_key: displayRow.row_key,
                  row_title: '',
                  row_type: displayRow.row_type,
                  row_order: 0,
                  assignments: displayRow.assignments,
                  subrow_order: [DEFAULT_SUBROW_KEY],
                  subrows: [],
                }, 'inspector_id', value ? String(value) : null)}
                className={styles.taskCenterRowSelect}
                placeholder="检查人员"
                options={inspectorOptions}
              />
            ) : null}
            {displayRow.workIds.length ? (
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                value={displayRow.assignments?.executor_id || undefined}
                onChange={(value) => {
                  if (realRow) {
                    updateRowAssignment(realRow, 'executor_id', value ? String(value) : null)
                    return
                  }
                  const nextValue = value ? String(value) : null
                  const previousRows = cloneRows(allRows)
                  applyRowAssignmentLocally({
                    field: 'executor_id',
                    value: nextValue,
                    inspectionIds: [],
                    workIds: displayRow.workIds,
                  })
                  Promise.all(displayRow.workIds.map((taskId) => patchWorkTask(taskId, { assignee_id: nextValue })))
                    .then(() => loadDay())
                    .catch((e: any) => {
                      replaceRowsLocally(previousRows)
                      message.error(String(e?.message || '更新失败'))
                    })
                }}
                className={styles.taskCenterRowSelect}
                placeholder="执行人"
                options={allStaffOptions}
              />
            ) : null}
          </div>
        </div>
      <div className={styles.taskCenterBoardRowBodyCompact}>
        {displayRow.lines.map((line) => renderLine(line))}
      </div>
      </div>
    )
  }

  const readiness = dayData?.entry_readiness || {
    ready_for_final_grouping: true,
    unresolved_primary_count: 0,
    pending_inspection_count: 0,
    skipped_count: 0,
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {error ? <Alert type="error" showIcon message="任务中心加载失败" description={error} /> : null}

        <div className={`${styles.card} ${styles.headerCard}`}>
          <div className={styles.navGroup}>
            <Button className={styles.navBtn} icon={<LeftOutlined />} onClick={() => setDate((value) => value.subtract(1, 'day'))} />
            <div className={styles.monthTitle}>{date.format('YYYY-MM-DD')}</div>
            <Button className={styles.navBtn} icon={<RightOutlined />} onClick={() => setDate((value) => value.add(1, 'day'))} />
          </div>
          <div className={styles.rightGroup}>
            <DatePicker value={date} onChange={(value) => value && setDate(value)} />
            <Button className={styles.secondaryBtn} icon={<ReloadOutlined />} onClick={() => loadDay().catch(() => {})} loading={loading}>
              刷新
            </Button>
            <Button className={styles.secondaryBtn} onClick={lockDay} disabled={!lockTaskIds.length}>
              锁定当日
            </Button>
            <Button className={styles.secondaryBtn} onClick={unlockDay} disabled={!unlockTaskIds.length}>
              解锁当日
            </Button>
            <Button className={styles.primaryBtn} icon={<PlusOutlined />} onClick={openCreateModal}>
              新增线下任务
            </Button>
          </div>
        </div>

        <div className={`${styles.card} ${styles.taskCenterCard}`}>
          <div className={styles.detailsHead}>
            <div className={styles.detailsTitle}>任务中心</div>
          </div>

          <div className={styles.taskCenterToolbar}>
            <Input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              allowClear
              placeholder="搜索房号或任务..."
              className={styles.taskCenterFilterInput}
            />
          </div>

          <div className={styles.taskCenterCompactHint}>
            <div className={styles.taskCenterSummaryStats}>
              <span className={styles.taskCenterSummaryPill}>
                <strong>未安排</strong>
                <em>{readiness.unresolved_primary_count} 个</em>
              </span>
              <span className={styles.taskCenterSummaryPill}>
                <strong>待确认</strong>
                <em>{readiness.pending_inspection_count} 个</em>
              </span>
              <span className={styles.taskCenterSummaryPill}>
                <strong>暂不安排</strong>
                <em>{readiness.skipped_count} 个</em>
              </span>
            </div>
            <Button className={styles.secondaryBtn} icon={<PlusOutlined />} onClick={() => createRow().catch(() => {})} loading={creatingRow}>
              新增一行
            </Button>
          </div>

          <div className={styles.taskCenterBoardWrapNew}>
            {loading ? (
              <div className={styles.taskCenterBoardSkeleton}>
                <Skeleton active paragraph={{ rows: 6 }} />
              </div>
            ) : displayRows.length ? (
              <div className={styles.taskCenterBoardRowsCompact}>
                {displayRows.map((displayRow) => renderDisplayRow(displayRow))}
              </div>
            ) : (
              <div className={styles.taskChip}><Empty description="暂无任务" /></div>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={!!detailTask}
        title={detailTask ? '任务详情' : '任务详情'}
        width={640}
        onCancel={closeTaskDetail}
        okText="保存"
        cancelText="取消"
        confirmLoading={detailSaving}
        onOk={() => saveTaskDetail().catch(() => {})}
        destroyOnClose
      >
        {detailTask && detailDraft ? (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <div className={styles.taskDetailHero}>
                <div className={styles.taskDetailHeroTop}>
                  <div className={styles.taskDetailHeroTitle}>{detailTask.title}</div>
                  <div className={styles.taskDetailHeroChips}>
                    <span className={styles.taskDetailChip}>{statusText(detailTask.status)}</span>
                    {detailTask.task_source === 'cleaning' ? (
                      <span className={styles.taskDetailChip}>{inspectionModeText(detailDraft.keys_hung ? 'self_complete' : detailDraft.inspection_mode)}</span>
                    ) : (
                      <span className={styles.taskDetailChip}>{detailTask.task_kind || '线下任务'}</span>
                    )}
                    {specialTimingTags(detailTask).map((item) => (
                      <span
                        key={`detail:${detailTask.item_key}:${item.key}`}
                        className={`${styles.taskDetailChip} ${
                          item.tone === 'success'
                            ? styles.taskDetailChipSuccess
                            : (item.tone === 'purple' ? styles.taskDetailChipPurple : styles.taskDetailChipDanger)
                        }`}
                      >
                        {item.label}
                      </span>
                    ))}
                    {detailTask.temporarily_skipped ? <span className={`${styles.taskDetailChip} ${styles.taskDetailChipDanger}`}>暂不安排</span> : null}
                  </div>
                </div>
              <div className={styles.taskDetailHeroSummary}>{detailHeroSummary(detailTask) || '暂无详情'}</div>
            </div>
            {detailTask.task_source === 'cleaning' ? (
              <>
                <div className={styles.taskDetailGrid}>
                  <div>
                    <div className={styles.fieldLabel}>清洁人员</div>
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      value={detailDraft.cleaner_id || undefined}
                      onChange={(value) => setDetailDraft((prev) => (prev ? { ...prev, cleaner_id: value ? String(value) : null } : prev))}
                      style={{ width: '100%' }}
                      options={cleanerOptions}
                    />
                  </div>
                  <div>
                    <div className={styles.fieldLabel}>检查安排</div>
                    <Select
                      value={detailDraft.inspection_mode}
                      onChange={(value) => setDetailDraft((prev) => {
                        if (!prev) return prev
                        const nextMode = value as TaskDetailDraft['inspection_mode']
                        return {
                          ...prev,
                          keys_hung: nextMode === 'self_complete' ? prev.keys_hung : false,
                          inspection_mode: nextMode,
                          inspection_due_date: nextMode === 'deferred' ? prev.inspection_due_date : null,
                          inspector_id: nextMode === 'pending_decision' || nextMode === 'self_complete' ? null : prev.inspector_id,
                        }
                      })}
                      style={{ width: '100%' }}
                      options={[
                        { label: '待确认', value: 'pending_decision' },
                        { label: '同日检查', value: 'same_day' },
                        { label: '自完成', value: 'self_complete' },
                        { label: '延后检查', value: 'deferred' },
                      ]}
                    />
                  </div>
                </div>
                {isCheckinOnlyCleaningTask(detailTask) ? (
                  <div className={styles.taskDetailHint}>
                    <div className={styles.taskDetailHintRow}>
                      <span>已挂钥匙</span>
                      <Switch
                        checked={detailDraft.keys_hung}
                        onChange={(checked) => setDetailDraft((prev) => {
                          if (!prev) return prev
                          if (checked) {
                            return {
                              ...prev,
                              keys_hung: true,
                              inspection_mode: 'self_complete',
                              inspection_due_date: null,
                              inspector_id: null,
                            }
                          }
                          return { ...prev, keys_hung: false }
                        })}
                      />
                    </div>
                    <div className={styles.taskDetailHintCopy}>适用于纯入住任务已经提前检查、钥匙也已经挂好的情况。</div>
                  </div>
                ) : null}
                {(!detailDraft.keys_hung && (detailDraft.inspection_mode === 'same_day' || detailDraft.inspection_mode === 'deferred')) ? (
                  <div className={styles.taskDetailGrid}>
                    <div>
                      <div className={styles.fieldLabel}>检查人员</div>
                      <Select
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        value={detailDraft.inspector_id || undefined}
                        onChange={(value) => setDetailDraft((prev) => (prev ? { ...prev, inspector_id: value ? String(value) : null } : prev))}
                        style={{ width: '100%' }}
                        options={inspectorOptions}
                      />
                    </div>
                    {detailDraft.inspection_mode === 'deferred' ? (
                      <div>
                        <div className={styles.fieldLabel}>检查日期</div>
                        <DatePicker value={detailDraft.inspection_due_date} onChange={(value) => setDetailDraft((prev) => (prev ? { ...prev, inspection_due_date: value } : prev))} style={{ width: '100%' }} />
                      </div>
                    ) : <div />}
                  </div>
                ) : null}
                {(() => {
                  const timing = cleaningTimingVisibility(detailTask)
                  const parts = cleaningSummaryParts(detailTask)
                  if (!timing.showCheckout && !timing.showCheckin) return null
                  return (
                    <div className={styles.taskDetailMetaStrip}>
                      {parts.map((part, index) => (
                        <span key={`meta:${detailTask.item_key}:${index}`} className={styles.taskDetailMetaPill}>{part}</span>
                      ))}
                    </div>
                  )
                })()}
              </>
            ) : (
              <>
                <div className={styles.taskDetailGrid}>
                  <div>
                    <div className={styles.fieldLabel}>任务标题</div>
                    <Input value={detailDraft.title} onChange={(e) => setDetailDraft((prev) => (prev ? { ...prev, title: e.target.value } : prev))} />
                  </div>
                  <div>
                    <div className={styles.fieldLabel}>执行人</div>
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      value={detailDraft.assignee_id || undefined}
                      onChange={(value) => setDetailDraft((prev) => (prev ? { ...prev, assignee_id: value ? String(value) : null } : prev))}
                      style={{ width: '100%' }}
                      options={allStaffOptions}
                    />
                  </div>
                </div>
                <div>
                  <div className={styles.fieldLabel}>任务详情</div>
                  <Input.TextArea rows={4} value={detailDraft.summary} onChange={(e) => setDetailDraft((prev) => (prev ? { ...prev, summary: e.target.value } : prev))} />
                </div>
                <div className={styles.taskDetailGrid}>
                  <div>
                    <div className={styles.fieldLabel}>紧急程度</div>
                    <Select
                      value={detailDraft.urgency}
                      onChange={(value) => setDetailDraft((prev) => (prev ? { ...prev, urgency: value as TaskDetailDraft['urgency'] } : prev))}
                      style={{ width: '100%' }}
                      options={[
                        { label: '低', value: 'low' },
                        { label: '中', value: 'medium' },
                        { label: '高', value: 'high' },
                        { label: '紧急', value: 'urgent' },
                      ]}
                    />
                  </div>
                  <div />
                </div>
              </>
            )}
            <div className={styles.taskCenterSkipCard}>
              <div className={styles.taskCenterSkipHead}>
                <div className={styles.taskDetailSkipTitle}>
                  <div className={styles.fieldLabel} style={{ marginBottom: 0 }}>暂不安排</div>
                  <span className={styles.taskDetailSkipHint}>
                    {detailTask.task_source === 'work'
                      ? '可留在当天后续处理，或选一个日期挪到那天变成未安排任务'
                      : '打开后可把任务移出当日安排'}
                  </span>
                </div>
                <Switch checked={detailDraft.temporarily_skipped} onChange={(checked) => setDetailDraft((prev) => (prev ? { ...prev, temporarily_skipped: checked } : prev))} />
              </div>
              {detailTask.task_source === 'work' && detailDraft.temporarily_skipped ? (
                <div>
                  <div className={styles.fieldLabel}>挪到日期</div>
                  <DatePicker
                    value={detailDraft.deferred_to_date}
                    onChange={(value) => setDetailDraft((prev) => (prev ? { ...prev, deferred_to_date: value } : prev))}
                    style={{ width: '100%' }}
                    placeholder="不选则留在当天后续处理"
                  />
                </div>
              ) : null}
              <Input.TextArea
                rows={3}
                value={detailDraft.skip_reason}
                onChange={(e) => setDetailDraft((prev) => (prev ? { ...prev, skip_reason: e.target.value } : prev))}
                placeholder="例如：今天不检查 / 下次退房再修 / 暂不跟清洁走"
              />
            </div>
          </Space>
        ) : null}
      </Modal>

      <Modal
        open={createOpen}
        title="新增线下任务"
        okText="创建"
        confirmLoading={createLoading}
        onOk={() => submitCreate().catch(() => {})}
        onCancel={() => setCreateOpen(false)}
      >
        {offlineCreate ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <div className={styles.fieldLabel}>日期</div>
              <DatePicker value={offlineCreate.date} onChange={(value) => value && setOfflineCreate((prev) => (prev ? { ...prev, date: value } : prev))} style={{ width: '100%' }} />
            </div>
            <div>
              <div className={styles.fieldLabel}>任务类型</div>
              <Select
                value={offlineCreate.task_type}
                onChange={(value) => setOfflineCreate((prev) => (prev ? { ...prev, task_type: value } : prev))}
                style={{ width: '100%' }}
                options={[
                  { label: '房源任务', value: 'property' },
                  { label: '公司任务', value: 'company' },
                  { label: '其他任务', value: 'other' },
                ]}
              />
            </div>
            {offlineCreate.task_type === 'property' ? (
              <div>
                <div className={styles.fieldLabel}>房号</div>
                <Select
                  showSearch
                  optionFilterProp="label"
                  value={offlineCreate.property_id || undefined}
                  onChange={(value) => setOfflineCreate((prev) => (prev ? { ...prev, property_id: value ? String(value) : null } : prev))}
                  style={{ width: '100%' }}
                  options={propertyOptions}
                />
              </div>
            ) : null}
            <div>
              <div className={styles.fieldLabel}>任务标题</div>
              <Input value={offlineCreate.title} onChange={(e) => setOfflineCreate((prev) => (prev ? { ...prev, title: e.target.value } : prev))} />
            </div>
            <div>
              <div className={styles.fieldLabel}>任务详情</div>
              <Input.TextArea rows={4} value={offlineCreate.content} onChange={(e) => setOfflineCreate((prev) => (prev ? { ...prev, content: e.target.value } : prev))} />
            </div>
            <div>
              <div className={styles.fieldLabel}>紧急程度</div>
              <Select
                value={offlineCreate.urgency}
                onChange={(value) => setOfflineCreate((prev) => (prev ? { ...prev, urgency: value } : prev))}
                style={{ width: '100%' }}
                options={[
                  { label: '低', value: 'low' },
                  { label: '中', value: 'medium' },
                  { label: '高', value: 'high' },
                  { label: '紧急', value: 'urgent' },
                ]}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>执行人</div>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                value={offlineCreate.assignee_id || undefined}
                onChange={(value) => setOfflineCreate((prev) => (prev ? { ...prev, assignee_id: value ? String(value) : null } : prev))}
                style={{ width: '100%' }}
                options={allStaffOptions}
              />
            </div>
          </Space>
        ) : null}
      </Modal>
    </div>
  )
}
