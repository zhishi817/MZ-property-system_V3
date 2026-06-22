"use client"

import { Alert, Button, DatePicker, Empty, Input, Modal, Select, Skeleton, Space, Switch, Tag, message } from 'antd'
import { DeleteOutlined, HolderOutlined, LeftOutlined, PlusOutlined, ReloadOutlined, RightOutlined, SaveOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { getJSON, postJSON } from '../../lib/api'
import { upsertAdminNotification } from '../../lib/adminNotifications'
import { getRole } from '../../lib/auth'
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
  checkin_sync_status?: 'pending' | 'synced' | null
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
  property_followups?: TaskCenterTask[]
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
  task_completed: boolean
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
const SAVE_BOARD_TIMEOUT_MS = 120000

function saveBoardErrorMessage(error: any) {
  const msg = String(error?.message || '').trim()
  if (/timeout|超时|abort|aborted/i.test(msg)) return '保存安排耗时较长，请稍后刷新确认结果；如果没有保存成功，再点一次保存'
  return msg || '保存安排失败'
}

function propertyFollowupMeta(task: Pick<TaskCenterTask, 'task_kind'>) {
  const kind = String(task.task_kind || '').trim().toLowerCase()
  if (kind === 'maintenance') return { label: '维修', color: 'orange' }
  if (kind === 'deep_cleaning') return { label: '深度清洁', color: 'blue' }
  if (kind === 'daily_necessities') return { label: '日用品更换', color: 'purple' }
  return { label: '房源待办', color: 'default' }
}

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

function requiresCleanerAssignment(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view'>) {
  if (task.task_source !== 'cleaning') return false
  return !isCheckinOnlyCleaningTask(task)
}

function preferredStaffIdForTask(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'cleaner_id' | 'assignee_id' | 'inspector_id'>) {
  if (isCheckinOnlyCleaningTask(task)) return String(task.inspector_id || '').trim()
  return String(task.cleaner_id || task.assignee_id || '').trim()
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
  if (task.task_source === 'work') return String(task.detail || task.summary || '线下任务').trim()
  const parts = cleaningSummaryParts(task)
  return parts.join(' · ')
}

function checkinSyncTag(task: Pick<TaskCenterTask, 'task_source' | 'checkin_sync_status'>) {
  if (task.task_source !== 'cleaning') return null
  if (task.checkin_sync_status === 'pending') return { label: '待同步', tone: 'alert' as const }
  if (task.checkin_sync_status === 'synced') return { label: '已同步', tone: 'success' as const }
  return null
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
  const [detailTask, setDetailTask] = useState<TaskCenterTask | null>(null)
  const [detailDraft, setDetailDraft] = useState<TaskDetailDraft | null>(null)
  const [viewerRole, setViewerRole] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)
  const [boardDirty, setBoardDirty] = useState(false)
  const [boardSaving, setBoardSaving] = useState(false)
  const boardDirtyRef = useRef(false)
  const loadDayRequestRef = useRef(0)
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
  const canSeeCheckinSyncTag = viewerRole === 'admin' || viewerRole === 'customer_service'

  useEffect(() => {
    setViewerRole(getRole())
  }, [])

  const loadStaff = useCallback(async () => {
    const rows = await getJSON<Staff[]>('/cleaning/staff').catch(() => [])
    setStaff(Array.isArray(rows) ? rows : [])
  }, [])

  const loadProps = useCallback(async () => {
    const rows = await getJSON<any[]>('/properties?include_archived=true').catch(() => [])
    setProperties(Array.isArray(rows) ? rows : [])
  }, [])

  const setBoardDraftDirty = useCallback((dirty: boolean) => {
    boardDirtyRef.current = dirty
    setBoardDirty(dirty)
    if (dirty) {
      upsertAdminNotification({
        id: 'task-center-save-status',
        type: 'warning',
        title: '任务中心',
        message: '有未保存修改',
        source: 'task-center',
      })
    }
  }, [])

  const loadDay = useCallback(async (options?: { discardDraft?: boolean }) => {
    const requestId = loadDayRequestRef.current + 1
    loadDayRequestRef.current = requestId
    setLoading(true)
    setError(null)
    try {
      const payload = await getJSON<TaskCenterDay>(`/task-center/day?date=${encodeURIComponent(dateStr)}&include_unscheduled=1`, { timeoutMs: 20000 })
      if (requestId !== loadDayRequestRef.current) return false
      if (boardDirtyRef.current && !options?.discardDraft) return false
      setDayData(payload || null)
      setBoardDraftDirty(false)
      return true
    } catch (e: any) {
      if (requestId !== loadDayRequestRef.current) return false
      setError(String(e?.message || '加载失败'))
      return false
    } finally {
      if (requestId === loadDayRequestRef.current) setLoading(false)
    }
  }, [dateStr, setBoardDraftDirty])

  useEffect(() => {
    loadStaff().catch(() => {})
    loadProps().catch(() => {})
  }, [loadProps, loadStaff])

  useEffect(() => {
    loadDay().catch(() => {})
  }, [loadDay])

  useEffect(() => {
    if (!boardDirty) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [boardDirty])

  const activeStaff = useMemo(() => staff.filter((item) => item.is_active !== false), [staff])
  const activeCleaners = useMemo(() => activeStaff.filter((item) => (item.kind || 'cleaner') === 'cleaner'), [activeStaff])
  const activeInspectors = useMemo(() => activeStaff.filter((item) => (item.kind || 'cleaner') === 'inspector'), [activeStaff])

  const staffById = useMemo(() => {
    const map = new Map<string, Staff>()
    for (const item of activeStaff) map.set(String(item.id), item)
    return map
  }, [activeStaff])

  const allRows = useMemo(() => dayData?.rows || [], [dayData?.rows])
  const propertyFollowups = useMemo(() => dayData?.property_followups || [], [dayData?.property_followups])

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

  const filteredPropertyFollowups = useMemo(() => {
    if (!filterQuery) return propertyFollowups
    return propertyFollowups.filter((task) => {
      const searchable = `${task.title} ${task.detail} ${task.property_region || ''} ${task.property_code || ''} ${task.summary || ''} ${task.task_kind || ''}`.toLowerCase()
      return searchable.includes(filterQuery)
    })
  }, [filterQuery, propertyFollowups])

  const allBoardTasks = useMemo(() => allRows.flatMap((row) => row.subrows.flatMap((subrow) => subrow.tasks)), [allRows])

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
    const staffId = preferredStaffIdForTask(task)
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
      if (isCompletedBoardStatus(task.status)) return false
      if (!requiresCleanerAssignment(task)) return false
      return !String(task.cleaner_id || task.assignee_id || '').trim()
    }).length
    const pendingInspectionCount = cleaningTasks.filter((task) => {
      if (task.temporarily_skipped || task.deferred_inspection_view) return false
      if (isCompletedBoardStatus(task.status)) return false
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
    if (task.temporarily_skipped) return DEFERRED_ROW_KEY
    if (task.task_source === 'cleaning' && isCompletedBoardStatus(task.status)) return COMPLETED_ROW_KEY
    if (task.deferred_inspection_view) return DEFERRED_INSPECTION_ROW_KEY
    if (task.task_source === 'cleaning' && String(task.inspection_mode || '').trim() === 'deferred') return DEFERRED_INSPECTION_ROW_KEY
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
    items: rows.flatMap((row) => row.subrows.flatMap((subrow) => subrow.tasks.flatMap((task, taskIndex) => {
      const taskIds = task.task_source === 'cleaning'
        ? Array.from(new Set(task.task_ids.map((taskId) => String(taskId)).filter(Boolean)))
        : [String(task.task_id)]
      return taskIds.map((taskId) => ({
        task_source: task.task_source,
        task_id: taskId,
        row_key: row.row_key,
        subrow_key: DEFAULT_SUBROW_KEY,
        item_order: taskIndex + 1,
      }))
    }))),
  }), [])

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
    if (draft.task_completed) return 'completed'
    if (isCheckinOnlyCleaningTask(task) && draft.keys_hung) return 'keys_hung'
    if (isKeysHungStatus(task.status) && !draft.keys_hung) {
      return String(draft.cleaner_id || draft.inspector_id || '').trim() ? 'assigned' : 'pending'
    }
    return autoCleaningStatus(task.status, draft.cleaner_id, draft.inspector_id)
  }, [autoCleaningStatus])

  const openTaskDetail = useCallback((task: TaskCenterTask, row: TaskCenterRow, subrow: TaskCenterSubrow) => {
    setDetailTask({ ...task, current_row_key: row.row_key, current_subrow_key: subrow.subrow_key })
    setDetailDraft({
      cleaner_id: requiresCleanerAssignment(task) ? (task.cleaner_id || null) : null,
      inspector_id: task.inspector_id || null,
      assignee_id: task.assignee_id || null,
      inspection_mode: (task.inspection_mode || 'pending_decision') as TaskDetailDraft['inspection_mode'],
      inspection_due_date: task.inspection_due_date ? dayjs(task.inspection_due_date) : null,
      keys_hung: isKeysHungStatus(task.status),
      task_completed: isCompletedBoardStatus(task.status),
      title: String(task.title || ''),
      summary: String(task.task_source === 'work' ? (task.detail || task.summary || '') : (task.summary || task.detail || '')),
      urgency: (['low', 'medium', 'high', 'urgent'].includes(String(task.urgency || '').trim().toLowerCase()) ? String(task.urgency).trim().toLowerCase() : 'medium') as TaskDetailDraft['urgency'],
      temporarily_skipped: task.temporarily_skipped === true,
      skip_reason: String(task.skip_reason || ''),
      deferred_to_date: null,
    })
  }, [])

  const closeTaskDetail = useCallback(() => {
    setDetailTask(null)
    setDetailDraft(null)
  }, [])

  const rowsAfterTaskDetail = useCallback((rows: TaskCenterRow[], task: TaskCenterTask, draft: TaskDetailDraft) => {
    const nextStatus = nextCleaningDetailStatus(task, draft)
    const nextInspectionMode = draft.keys_hung ? 'self_complete' : draft.inspection_mode
    const nextCleanerId = requiresCleanerAssignment(task) ? (draft.cleaner_id || null) : null
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
            cleaner_id: task.task_source === 'cleaning' ? nextCleanerId : item.cleaner_id,
            inspector_id: task.task_source === 'cleaning' ? (draft.inspector_id || null) : item.inspector_id,
            assignee_id: task.task_source === 'work' ? (draft.assignee_id || null) : item.assignee_id,
            status: task.task_source === 'cleaning'
              ? nextStatus
              : autoWorkStatus(item.status, draft.assignee_id || null),
            inspection_mode: task.task_source === 'cleaning' ? nextInspectionMode : item.inspection_mode,
            inspection_due_date: task.task_source === 'cleaning'
              ? ((draft.keys_hung || draft.task_completed || draft.inspection_mode !== 'deferred') ? null : (draft.inspection_due_date ? draft.inspection_due_date.format('YYYY-MM-DD') : null))
              : item.inspection_due_date,
            title: task.task_source === 'work' ? String(draft.title || '').trim() : item.title,
            summary: task.task_source === 'work' ? String(draft.summary || '').trim() : item.summary,
            detail: task.task_source === 'work'
              ? (String(draft.summary || '').trim() || item.detail)
              : item.detail,
            task_date: task.task_source === 'work' && draft.temporarily_skipped && draft.deferred_to_date
              ? draft.deferred_to_date.format('YYYY-MM-DD')
              : item.task_date,
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
    const shouldRebucket =
      movedTask.temporarily_skipped ||
      (task.task_source === 'cleaning' && nextInspectionMode === 'deferred') ||
      (sourceRowKey === DEFERRED_ROW_KEY && !movedTask.temporarily_skipped) ||
      (sourceRowKey === DEFERRED_INSPECTION_ROW_KEY && nextInspectionMode !== 'deferred') ||
      sourceRowKey === COMPLETED_ROW_KEY
    const targetRowKey = shouldRebucket || !sourceRowKey
      ? defaultBoardRowKeyForTask(movedTask)
      : sourceRowKey
    const targetRow = ensureBoardRow(nextRows, targetRowKey)
    const targetSubrow = targetRow.subrows[0]
    if (!targetSubrow) return nextRows
    targetSubrow.tasks.push(movedTask)
    if (sourceRowKey === targetRowKey) {
      targetSubrow.tasks.sort((a, b) => a.item_key.localeCompare(b.item_key))
    }
    return nextRows
  }, [defaultBoardRowKeyForTask, ensureBoardRow, nextCleaningDetailStatus])

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
    applyTaskDetailLocally(detailTask, detailDraft)
    setBoardDraftDirty(true)
    setDetailTask(null)
    setDetailDraft(null)
    message.success('修改已应用，请点击右上角“保存安排”统一保存')
  }, [applyTaskDetailLocally, detailDraft, detailTask, setBoardDraftDirty])

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

  const updateRowAssignment = useCallback((row: TaskCenterRow, field: 'inspector_id' | 'executor_id', value: string | null) => {
    const fullRow = allRows.find((item) => item.row_key === row.row_key) || row
    const collections = rowTaskCollections(fullRow)
    applyRowAssignmentLocally({
      rowKey: fullRow.row_key,
      field,
      value,
      inspectionIds: collections.inspectionIds,
      workIds: collections.workIds,
    })
    setBoardDraftDirty(true)
  }, [allRows, applyRowAssignmentLocally, rowTaskCollections, setBoardDraftDirty])

  const updatePropertyFollowupAssignee = useCallback((taskId: string, assigneeId: string | null) => {
    setDayData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        property_followups: (prev.property_followups || []).map((task) => (
          task.task_id === taskId
            ? { ...task, assignee_id: assigneeId, status: autoWorkStatus(task.status, assigneeId) }
            : task
        )),
      }
    })
    setBoardDraftDirty(true)
  }, [autoWorkStatus, setBoardDraftDirty])

  const createRow = useCallback(() => {
    const previousRows = cloneRows(allRows)
    const nextRowOrder = previousRows.reduce((max, row) => Math.max(max, Number(row.row_order || 0)), 0) + 100
    const tempRowKey = `group:pending:${Date.now()}`
    replaceRowsLocally([...previousRows, buildEmptyBoardRow(tempRowKey, nextRowOrder)])
    setBoardDraftDirty(true)
  }, [allRows, buildEmptyBoardRow, cloneRows, replaceRowsLocally, setBoardDraftDirty])

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

  const handleTaskDrop = useCallback((payload: any, targetLine: TaskCenterLine) => {
    const task = allBoardTasks.find((item) => item.task_source === payload.task_source && item.task_id === payload.task_id)
    if (!task) return
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
    if (row.row_key === DEFERRED_ROW_KEY) {
      movedTask = {
        ...movedTask,
        temporarily_skipped: true,
        skip_reason: movedTask.skip_reason || '暂不安排',
        skip_bucket: 'deferred',
      }
    } else if (movedTask.temporarily_skipped) {
      movedTask = {
        ...movedTask,
        temporarily_skipped: false,
        skip_reason: null,
        skip_bucket: null,
      }
    }
    const targetInspectorId = task.task_source === 'cleaning' && row.row_type !== 'deferred'
      ? String(row.assignments?.inspector_id || '').trim()
      : ''
    if (targetInspectorId) {
      movedTask = {
        ...movedTask,
        inspector_id: targetInspectorId,
        inspection_mode: 'same_day',
        inspection_due_date: null,
        status: autoCleaningStatus(movedTask.status, movedTask.cleaner_id || movedTask.assignee_id || null, targetInspectorId),
      }
    }
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
    replaceRowsLocally(nextRows)
    setBoardDraftDirty(true)
    setDragOverKey(null)
  }, [allBoardTasks, allRows, autoCleaningStatus, cloneRows, defaultBoardRowKeyForTask, ensureBoardRow, normalizeRowsForBoard, replaceRowsLocally, setBoardDraftDirty])

  const saveBoardDraft = useCallback(async () => {
    if (boardSaving) return
    if (!boardDirtyRef.current) {
      upsertAdminNotification({
        id: 'task-center-save-status',
        type: 'success',
        title: '任务中心',
        message: '当前安排已保存',
        source: 'task-center',
      })
      message.info('当前没有需要保存的修改')
      return
    }
    const rows = normalizeRowsForBoard(cloneRows(allRows))
    const layout = layoutPayloadFromRows(rows)
    const cleaningAssignments = new Map<string, {
      task_id: string
      cleaner_id: string | null
      inspector_id: string | null
      inspection_mode: TaskCenterTask['inspection_mode']
      inspection_due_date: string | null
      status: string
    }>()
    const workAssignments = new Map<string, {
      task_id: string
      assignee_id: string | null
      title: string
      summary: string | null
      scheduled_date: string | null
      status: string
      urgency: string | null
    }>()
    const taskFlags = new Map<string, {
      task_source: TaskCenterTask['task_source']
      task_id: string
      temporarily_skipped: boolean
      skip_reason: string | null
      bucket: string | null
    }>()
    for (const row of rows) {
      for (const task of row.subrows.flatMap((subrow) => subrow.tasks)) {
        const taskIds = task.task_source === 'cleaning' ? task.task_ids : [task.task_id]
        for (const taskId of taskIds) {
          const id = String(taskId)
          taskFlags.set(`${task.task_source}:${id}`, {
            task_source: task.task_source,
            task_id: id,
            temporarily_skipped: task.temporarily_skipped === true,
            skip_reason: task.temporarily_skipped ? (task.skip_reason || '暂不安排') : null,
            bucket: task.temporarily_skipped ? 'deferred' : null,
          })
          if (task.task_source === 'cleaning') {
            cleaningAssignments.set(id, {
              task_id: id,
              cleaner_id: task.cleaner_id || task.assignee_id || null,
              inspector_id: task.inspector_id || null,
              inspection_mode: task.inspection_mode || 'pending_decision',
              inspection_due_date: task.inspection_due_date || null,
              status: task.status,
            })
          } else {
            workAssignments.set(id, {
              task_id: id,
              assignee_id: task.assignee_id || null,
              title: String(task.title || '').trim(),
              summary: String(task.summary || task.detail || '').trim() || null,
              scheduled_date: task.task_date || null,
              status: task.status,
              urgency: task.urgency || null,
            })
          }
        }
      }
    }
    for (const task of propertyFollowups) {
      workAssignments.set(String(task.task_id), {
        task_id: String(task.task_id),
        assignee_id: task.assignee_id || null,
        title: String(task.title || '').trim(),
        summary: String(task.summary || task.detail || '').trim() || null,
        scheduled_date: task.task_date || null,
        status: task.status,
        urgency: task.urgency || null,
      })
    }
    setBoardSaving(true)
    upsertAdminNotification({
      id: 'task-center-save-status',
      type: 'info',
      title: '任务中心',
      message: '正在保存安排...',
      source: 'task-center',
    })
    try {
      const savedAt = dayjs().format('HH:mm:ss')
      const result = await postJSON<{
        ok?: boolean
        event_notifications?: number
      }>('/task-center/save-board', {
        date: dateStr,
        mode: 'board',
        ...layout,
        row_assignments: rows.map((row) => ({
          row_key: row.row_key,
          assignments: row.assignments || {},
        })),
        cleaning_assignments: Array.from(cleaningAssignments.values()),
        work_assignments: Array.from(workAssignments.values()),
        task_flags: Array.from(taskFlags.values()),
      }, { timeoutMs: SAVE_BOARD_TIMEOUT_MS })
      setBoardDraftDirty(false)
      upsertAdminNotification({
        id: 'task-center-save-status',
        type: 'success',
        title: '任务中心',
        message: `已保存 ${savedAt}${typeof result?.event_notifications === 'number' ? `，通知 ${result.event_notifications} 条后台发送中` : ''}，正在刷新最新数据...`,
        source: 'task-center',
      })
      message.success('任务安排已保存')
      const refreshed = await loadDay({ discardDraft: true })
      upsertAdminNotification({
        id: 'task-center-save-status',
        type: refreshed ? 'success' : 'warning',
        title: '任务中心',
        message: refreshed ? `已保存 ${savedAt}` : `已保存 ${savedAt}，但刷新最新数据失败，请手动刷新`,
        source: 'task-center',
      })
    } catch (e: any) {
      const text = saveBoardErrorMessage(e)
      upsertAdminNotification({
        id: 'task-center-save-status',
        type: 'error',
        title: '任务中心',
        message: text,
        source: 'task-center',
      })
      message.error(text)
    } finally {
      setBoardSaving(false)
    }
  }, [allRows, boardSaving, cloneRows, dateStr, layoutPayloadFromRows, loadDay, normalizeRowsForBoard, propertyFollowups, setBoardDraftDirty])

  const confirmDiscardBoardDraft = useCallback((action: () => void) => {
    if (!boardDirtyRef.current) {
      action()
      return
    }
    Modal.confirm({
      title: '放弃未保存的安排？',
      content: '检查人员或任务位置还有未保存的修改。',
      okText: '放弃修改',
      okButtonProps: { danger: true },
      cancelText: '继续编辑',
      onOk: () => {
        setBoardDraftDirty(false)
        action()
      },
    })
  }, [setBoardDraftDirty])

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
    const dragKey = line?.line_key || `${row.row_key}:${subrow.subrow_key}`
    const textColor = textColorForTask(task)
    const dragDisabled = filteringActive || boardSaving
    const timingTags = specialTimingTags(task)
    const syncTag = canSeeCheckinSyncTag ? checkinSyncTag(task) : null
    const detailText = task.skip_reason || (task.task_source === 'cleaning' ? cleaningSecondarySummary(task) : (task.detail || task.summary || ''))
    const assignedStaffId = preferredStaffIdForTask(task)
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
        onClick={() => {
          openTaskDetail(task, row, subrow)
        }}
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
            {syncTag ? (
              <span className={`${styles.taskCenterCompactTag} ${syncTag.tone === 'success' ? styles.taskCenterCompactTagSuccess : styles.taskCenterCompactTagAlert}`}>
                {syncTag.label}
              </span>
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
  }, [boardSaving, canSeeCheckinSyncTag, cardStyleForTask, dragOverKey, dragPayloadForTask, filteringActive, inspectionModeText, openTaskDetail, staffById, statusChipCls, statusText, stripeColorForTask, textColorForTask])

  const displayRows = useMemo(() => {
    const output: TaskCenterDisplayRow[] = []
    let globalLineIndex = 0
    for (const row of filteredRows) {
      const fullRow = allRows.find((item) => item.row_key === row.row_key) || row
      const tasks = row.subrows.flatMap((subrow) => subrow.tasks)
      const collections = rowTaskCollections(fullRow)
      const rowLines: TaskCenterLine[] = []
      const pushBucket = (bucketTasks: TaskCenterTask[], target: TaskCenterLine[], kind: 'mixed' | 'deferred') => {
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
            inspectionIds: kind === 'mixed' ? collections.inspectionIds : [],
            workIds: kind === 'mixed' ? collections.workIds : [],
          })
        }
      }
      if (row.row_type === 'deferred') {
        pushBucket(tasks, rowLines, 'deferred')
      } else {
        pushBucket(tasks, rowLines, 'mixed')
      }
      if (!rowLines.length && isCustomBoardRow(row.row_key, row.row_type)) {
        globalLineIndex += 1
        rowLines.push({
          line_key: `${row.row_key}:line:empty:1`,
          row_key: row.row_key,
          row_type: row.row_type,
          assignments: row.assignments || {},
          tasks: [],
          start_index: 0,
          line_index: globalLineIndex,
          inspectionIds: [],
          workIds: [],
        })
      }
      if (rowLines.length) {
        output.push({
          row_key: row.row_key,
          row_title: fullRow.row_title,
          row_order: Number(fullRow.row_order || 0),
          row_type: row.row_type,
          assignments: row.assignments || {},
          inspectionIds: collections.inspectionIds,
          workIds: collections.workIds,
          lines: rowLines,
        })
      }
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
        handleTaskDrop(payload, line)
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
    const isPendingRow = displayRow.row_key.startsWith('group:pending:')
    return (
      <div key={displayRow.row_key} className={styles.taskCenterBoardRow}>
        <div className={styles.taskCenterBoardRowHead}>
          <div className={styles.taskCenterBoardRowActions}>
            {displayRow.row_type === 'final_group' && displayRow.row_key === COMPLETED_ROW_KEY && String(displayRow.row_title || '').trim() ? (
              <Tag color="green">
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
                disabled={boardSaving || (boardDirty && !isPendingRow)}
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
                disabled={boardSaving}
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
                disabled={boardSaving}
                onChange={(value) => {
                  if (realRow) {
                    updateRowAssignment(realRow, 'executor_id', value ? String(value) : null)
                    return
                  }
                  const nextValue = value ? String(value) : null
                  applyRowAssignmentLocally({
                    field: 'executor_id',
                    value: nextValue,
                    inspectionIds: [],
                    workIds: displayRow.workIds,
                  })
                  setBoardDraftDirty(true)
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
  const detailSyncTag = canSeeCheckinSyncTag && detailTask ? checkinSyncTag(detailTask) : null

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {error ? <Alert type="error" showIcon message="任务中心加载失败" description={error} /> : null}

        <div className={`${styles.card} ${styles.headerCard}`}>
          <div className={styles.navGroup}>
            <Button className={styles.navBtn} icon={<LeftOutlined />} onClick={() => confirmDiscardBoardDraft(() => setDate((value) => value.subtract(1, 'day')))} />
            <div className={styles.monthTitle}>{date.format('YYYY-MM-DD')}</div>
            <Button className={styles.navBtn} icon={<RightOutlined />} onClick={() => confirmDiscardBoardDraft(() => setDate((value) => value.add(1, 'day')))} />
          </div>
          <div className={styles.rightGroup}>
            <DatePicker value={date} onChange={(value) => value && confirmDiscardBoardDraft(() => setDate(value))} />
            <Button className={styles.secondaryBtn} icon={<ReloadOutlined />} onClick={() => confirmDiscardBoardDraft(() => loadDay({ discardDraft: true }).catch(() => {}))} loading={loading}>
              刷新
            </Button>
            <Button className={styles.primaryBtn} icon={<PlusOutlined />} onClick={openCreateModal} disabled={boardSaving}>
              新增线下任务
            </Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={() => saveBoardDraft().catch(() => {})}
              loading={boardSaving}
              disabled={boardSaving || !boardDirty}
            >
              {boardSaving ? '保存中...' : '保存安排'}
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
            <Button className={styles.secondaryBtn} icon={<PlusOutlined />} onClick={createRow} disabled={boardSaving}>
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

          <div className={styles.propertyFollowupSection}>
            <div className={styles.propertyFollowupHeader}>
              <div>
                <div className={styles.propertyFollowupTitle}>退房日房源待办</div>
                <div className={styles.propertyFollowupSubtitle}>维修、深度清洁和日用品更换；当天不安排人员时，过日后自动顺延至下一次退房。</div>
              </div>
              <Tag color="geekblue">{filteredPropertyFollowups.length} 项</Tag>
            </div>
            {loading ? (
              <Skeleton active paragraph={{ rows: 2 }} />
            ) : filteredPropertyFollowups.length ? (
              <div className={styles.propertyFollowupGrid}>
                {filteredPropertyFollowups.map((task) => {
                  const meta = propertyFollowupMeta(task)
                  return (
                    <div key={task.item_key} className={styles.propertyFollowupCard}>
                      <div className={styles.propertyFollowupCardTop}>
                        <Tag color={meta.color}>{meta.label}</Tag>
                        <span className={`${styles.statusChip} ${statusChipCls(task.status)}`}>{statusText(task.status)}</span>
                      </div>
                      <div className={styles.propertyFollowupProperty}>{task.title}</div>
                      <div className={styles.propertyFollowupDetail}>{task.detail || task.summary || '暂无详情'}</div>
                      <Select
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        value={task.assignee_id || undefined}
                        disabled={boardSaving}
                        onChange={(value) => updatePropertyFollowupAssignee(task.task_id, value ? String(value) : null)}
                        placeholder="选择执行人（可不安排）"
                        options={allStaffOptions}
                        style={{ width: '100%' }}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filteringActive ? '没有匹配的房源待办' : '当天无待处理房源待办'} />
            )}
          </div>
        </div>
      </div>

      <Modal
        open={!!detailTask}
        title={detailTask ? '任务详情' : '任务详情'}
        width={640}
        onCancel={closeTaskDetail}
        okText="应用修改"
        cancelText="取消"
        onOk={() => saveTaskDetail().catch(() => {})}
        destroyOnClose
      >
        {detailTask && detailDraft ? (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <div className={styles.taskDetailHero}>
                <div className={styles.taskDetailHeroTop}>
                  <div className={styles.taskDetailHeroTitle}>{detailTask.title}</div>
                  <div className={styles.taskDetailHeroChips}>
                    <span className={styles.taskDetailChip}>{statusText(detailDraft.task_completed ? 'completed' : detailTask.status)}</span>
                    {detailSyncTag ? (
                      <span className={`${styles.taskDetailChip} ${detailSyncTag.tone === 'success' ? styles.taskDetailChipSuccess : styles.taskDetailChipDanger}`}>
                        {detailSyncTag.label}
                      </span>
                    ) : null}
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
                  {requiresCleanerAssignment(detailTask) ? (
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
                  ) : (
                    <div>
                      <div className={styles.fieldLabel}>清洁人员</div>
                      <Input value="纯入住任务无需分配清洁" disabled />
                    </div>
                  )}
                  <div>
                    <div className={styles.fieldLabel}>检查安排</div>
                    <Select
                      value={detailDraft.inspection_mode}
                      onChange={(value) => setDetailDraft((prev) => {
                        if (!prev) return prev
                        const nextMode = value as TaskDetailDraft['inspection_mode']
                        return {
                          ...prev,
                          task_completed: false,
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
                {(detailDraft.inspection_mode === 'deferred' || detailTask.deferred_inspection_view) ? (
                  <div className={styles.taskDetailHint}>
                    <div className={styles.taskDetailHintRow}>
                      <span>任务已结束</span>
                      <Switch
                        checked={detailDraft.task_completed}
                        onChange={(checked) => setDetailDraft((prev) => {
                          if (!prev) return prev
                          if (checked) {
                            return {
                              ...prev,
                              task_completed: true,
                              keys_hung: false,
                              inspector_id: null,
                            }
                          }
                          return { ...prev, task_completed: false }
                        })}
                      />
                    </div>
                    <div className={styles.taskDetailHintCopy}>打开后保存安排，这个延后检查会标记为已完成并从待检查列表移出。</div>
                  </div>
                ) : null}
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
                            }
                          }
                          return { ...prev, keys_hung: false }
                        })}
                      />
                    </div>
                    <div className={styles.taskDetailHintCopy}>适用于纯入住任务已经提前检查、钥匙也已经挂好的情况。</div>
                  </div>
                ) : null}
                {(!detailDraft.keys_hung && !detailDraft.task_completed && (detailDraft.inspection_mode === 'same_day' || detailDraft.inspection_mode === 'deferred')) ? (
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
