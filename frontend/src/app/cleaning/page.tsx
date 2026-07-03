"use client"

import { Alert, Button, Checkbox, Col, DatePicker, Divider, Drawer, Empty, Form, Image, Input, InputNumber, Modal, Row, Segmented, Select, Skeleton, Space, Upload, message } from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { DeleteOutlined, EditOutlined, LeftOutlined, PictureOutlined, ReloadOutlined, RightOutlined, UploadOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { API_BASE, authHeaders, deleteJSON, getJSON, patchJSON, postJSON } from '../../lib/api'
import { cleaningColorKind } from '../../lib/cleaningColor'
import { checkinTimingLabel, checkoutTimingLabel, dailyTaskStatusMeta, mergeDailyCapabilityGate, mergedDailyDisplayBadges, mergedDailyDisplayStatus, mergedDailyTaskStatus, visibleDailyDisplayBadges } from '../../lib/cleaningDailyTaskStatus'
import { type TaskSemanticTone, taskStatusMeta, taskTimingTone } from '../../lib/cleaningTaskUi'
import styles from './cleaningSchedule.module.scss'

type Staff = { id: string; name: string; capacity_per_day: number; kind?: 'cleaner' | 'inspector'; is_active?: boolean; color_hex?: string | null }

type TaskDisplayBadge = {
  id: string
  label: string
  tone: TaskSemanticTone
}

type TaskDisplayState = {
  status_key?: string
  status_label?: string
  status_tone?: TaskSemanticTone
  badges?: TaskDisplayBadge[]
  task_semantics?: Record<string, any>
}

type TaskExecutionSemantics =
  | 'cleaning_execution'
  | 'checkin_inspection'
  | 'inspection_execution'
  | 'key_or_password_action'
  | 'mixed_cleaning_inspection'
  | 'work_task'

type TaskDisplayScope = {
  key?: TaskExecutionSemantics | string
  label?: string
  tone?: TaskSemanticTone
}

type TaskParticipantSummary = {
  primary_role?: 'cleaner' | 'inspector' | 'executor' | 'assignee' | 'none' | string
  primary_user_id?: string | null
  cleaner_id?: string | null
  inspector_id?: string | null
  executor_id?: string | null
  show_cleaner?: boolean
  show_inspector?: boolean
  show_executor?: boolean
}

type TaskEditableField = {
  enabled: boolean
  disabled_reason?: string
}

type TaskManagementActionId =
  | 'edit_task'
  | 'assign_cleaner'
  | 'assign_inspector'
  | 'assign_executor'
  | 'set_inspection_mode'
  | 'set_inspection_scope'
  | 'set_keys_hung'
  | 'set_task_completed'
  | 'update_status'
  | 'cancel_task'
  | 'add_checkout'
  | 'add_checkin'

type TaskManagementAction = {
  id: TaskManagementActionId
  label?: string
  placement?: 'card' | 'drawer' | 'bulk' | 'more'
  enabled: boolean
  disabled_reason?: string
  intent?: 'assignment' | 'inspection' | 'status' | 'schedule' | 'participants'
}

type TaskCapabilityFields = {
  display_state?: TaskDisplayState | null
  execution_semantics?: TaskExecutionSemantics | string | null
  display_scope?: TaskDisplayScope | null
  participant_summary?: TaskParticipantSummary | null
  editable_fields?: Record<string, TaskEditableField> | null
  management_actions?: TaskManagementAction[] | null
}

type CalendarItem = {
  source: 'cleaning_tasks' | 'offline_tasks' | 'calendar_events'
  entity_id: string
  entity_ids?: string[]
  order_id: string | null
  order_code?: string | null
  checkin_sync_status?: 'pending' | 'synced' | null
  property_id: string | null
  property_code?: string | null
  property_region?: string | null
  task_type?: string | null
  label: string
  content?: string | null
  task_date: string
  status: string
  assignee_id: string | null
  urgency?: 'low' | 'medium' | 'high' | 'urgent' | string | null
  cleaner_id?: string | null
  inspector_id?: string | null
  inspection_scope?: 'inspect_and_hang' | 'password_only' | string | null
  scheduled_at: string | null
  key_photo_uploaded_at?: string | null
  has_key_photo?: boolean
  auto_sync_enabled?: boolean
  old_code?: string | null
  new_code?: string | null
  nights?: number | null
  summary_checkout_time?: string | null
  summary_checkin_time?: string | null
  guest_special_request?: string | null
  note?: string | null
  checkin_order_id?: string | null
  checkout_order_id?: string | null
  checkin_order_code?: string | null
  checkout_order_code?: string | null
  checkin_old_code?: string | null
  checkin_new_code?: string | null
  checkout_old_code?: string | null
  checkout_new_code?: string | null
  photo_urls?: string[] | null
} & TaskCapabilityFields

type CleaningTaskRow = {
  id: string
  order_id?: string | null
  property_id?: string | null
  task_type?: string | null
  task_date?: string | null
  date?: string | null
  status?: string | null
  assignee_id?: string | null
  cleaner_id?: string | null
  inspector_id?: string | null
  inspection_scope?: 'inspect_and_hang' | 'password_only' | string | null
  keys_required?: number | null
  scheduled_at?: string | null
  guest_special_request?: string | null
  note?: string | null
  auto_sync_enabled?: boolean | null
  old_code?: string | null
  new_code?: string | null
  checkout_time?: string | null
  checkin_time?: string | null
  nights_override?: number | null
}

type EditTaskForm = {
  mode: 'default' | 'stayover'
  ids: string[]
  task_date: Dayjs
  property_id: string | null
  status: string
  checkin_sync_status?: 'pending' | 'synced' | null
  cleaner_id: string | null
  inspector_id: string | null
  checkin_inspection_scope: 'inspect_and_hang' | 'password_only'
  keys_required_checkin: 1 | 2
  keys_required_checkout: 1 | 2
  checkin_order_id: string | null
  checkout_order_id: string | null
  checkin_manual_ids: string[]
  checkout_manual_ids: string[]
  guest_special_request: string
  nights_override: number | null
  checkout_ids: string[]
  checkin_ids: string[]
  checkout_password: string
  checkin_password: string
  checkout_time: string
  checkin_time: string
  checkin_task_date: Dayjs
  can_add_checkout: boolean
  can_add_checkin: boolean
  pending_add_checkout: boolean
  pending_add_checkin: boolean
  auto_sync_enabled: boolean
} & TaskCapabilityFields

type BulkEditForm = {
  ids: string[]
  status: string
  cleaner: string
  inspector: string
}

type ManualCreateForm = {
  area: string | null
  property_id: string | null
  create_mode: 'checkout' | 'checkin' | 'turnover' | 'stayover'
  checkout_password: string
  checkin_password: string
  nights_override: number | null
  checkout_time: string
  checkin_time: string
  guest_special_request: string
}

type OfflineTaskForm = {
  id: string
  date: Dayjs
  task_type: 'property' | 'company' | 'other'
  title: string
  content: string
  status: 'todo' | 'done'
  urgency: 'low' | 'medium' | 'high' | 'urgent'
  property_id: string | null
  assignee_id: string | null
  photo_urls: string[]
}

type OfflineCreateForm = {
  date: Dayjs
  task_type: 'property' | 'company' | 'other'
  title: string
  content: string
  urgency: 'low' | 'medium' | 'high' | 'urgent'
  property_id: string | null
  assignee_id: string | null
  photo_urls: string[]
}

function semanticToneClass(tone: TaskSemanticTone) {
  if (tone === 'special') return styles.semanticToneSpecial
  if (tone === 'pending') return styles.semanticTonePending
  if (tone === 'danger') return styles.semanticToneDanger
  if (tone === 'success') return styles.semanticToneSuccess
  if (tone === 'info') return styles.semanticToneInfo
  if (tone === 'neutral') return styles.semanticToneNeutral
  return styles.semanticToneNormal
}

function hasTaskCapability(it: Partial<TaskCapabilityFields>) {
  return !!it.display_state || !!it.execution_semantics || !!it.display_scope || !!it.participant_summary || !!it.editable_fields || Array.isArray(it.management_actions)
}

function legacyPureCheckinInspectionItem(it: Pick<CalendarItem, 'source' | 'task_type' | 'label'>) {
  if (it.source !== 'cleaning_tasks') return false
  const type = String(it.task_type || '').trim().toLowerCase()
  const label = String(it.label || '').trim()
  if (type === 'checkin_clean') return true
  return label.includes('入住') && !label.includes('退房') && !label.includes('入住中清洁')
}

function normalizeInspectionScope(value: any): 'inspect_and_hang' | 'password_only' {
  return String(value || '').trim().toLowerCase() === 'password_only' ? 'password_only' : 'inspect_and_hang'
}

function legacyExecutionSemantics(it: Pick<CalendarItem, 'source' | 'task_type' | 'label' | 'inspection_scope'>): TaskExecutionSemantics {
  if (it.source !== 'cleaning_tasks') return 'work_task'
  const pureCheckin = legacyPureCheckinInspectionItem(it)
  if (pureCheckin && normalizeInspectionScope(it.inspection_scope) === 'password_only') return 'key_or_password_action'
  if (pureCheckin) return 'checkin_inspection'
  return 'cleaning_execution'
}

function normalizeTaskExecutionSemantics(value: any): TaskExecutionSemantics | null {
  const raw = String(value || '').trim()
  if (raw === 'key_handover_execution') return 'key_or_password_action'
  if (
    raw === 'cleaning_execution' ||
    raw === 'checkin_inspection' ||
    raw === 'inspection_execution' ||
    raw === 'key_or_password_action' ||
    raw === 'mixed_cleaning_inspection' ||
    raw === 'work_task'
  ) return raw
  return null
}

function executionSemanticsOf(it: Partial<CalendarItem>): TaskExecutionSemantics {
  const value = normalizeTaskExecutionSemantics(it.execution_semantics)
  if (value) return value
  return legacyExecutionSemantics(it as CalendarItem)
}

function isPureCheckinInspectionItem(it: Pick<CalendarItem, 'source' | 'task_type' | 'label' | 'inspection_scope' | 'execution_semantics'>) {
  if (hasTaskCapability(it)) {
    const semantics = executionSemanticsOf(it)
    return semantics === 'checkin_inspection' || semantics === 'inspection_execution' || semantics === 'key_or_password_action'
  }
  return legacyPureCheckinInspectionItem(it)
}

function isCheckinKeyHandoverItem(it: Pick<CalendarItem, 'source' | 'task_type' | 'label' | 'inspection_scope' | 'execution_semantics'>) {
  if (hasTaskCapability(it)) return executionSemanticsOf(it) === 'key_or_password_action'
  return legacyPureCheckinInspectionItem(it) && normalizeInspectionScope(it.inspection_scope) === 'password_only'
}

function isCleaningExecutionItem(it: Pick<CalendarItem, 'source' | 'task_type' | 'label' | 'inspection_scope' | 'execution_semantics'>) {
  if (hasTaskCapability(it)) {
    const semantics = executionSemanticsOf(it)
    return semantics === 'cleaning_execution' || semantics === 'mixed_cleaning_inspection'
  }
  return it.source === 'cleaning_tasks' && !legacyPureCheckinInspectionItem(it)
}

function displayScopeForSemantics(semantics: TaskExecutionSemantics): TaskDisplayScope {
  if (semantics === 'key_or_password_action') return { key: semantics, label: '仅改密码/挂钥匙', tone: 'special' }
  if (semantics === 'checkin_inspection') return { key: semantics, label: '入住现场执行', tone: 'info' }
  if (semantics === 'inspection_execution') return { key: semantics, label: '检查执行', tone: 'info' }
  if (semantics === 'mixed_cleaning_inspection') return { key: semantics, label: '清洁 + 检查', tone: 'normal' }
  if (semantics === 'work_task') return { key: semantics, label: '线下任务', tone: 'special' }
  return { key: semantics, label: '清洁执行', tone: 'normal' }
}

function displayStatusMetaForItem(it: Pick<CalendarItem, 'status' | 'display_state'>) {
  return dailyTaskStatusMeta(it.status, it.display_state)
}

function displayBadgesForItem(it: Pick<CalendarItem, 'display_state'>): TaskDisplayBadge[] {
  return Array.isArray(it.display_state?.badges)
    ? it.display_state.badges.filter((badge) => String(badge?.label || '').trim())
    : []
}

function displayScopeForItem(it: Pick<CalendarItem, 'display_scope' | 'execution_semantics' | 'source' | 'task_type' | 'label' | 'inspection_scope'>): TaskDisplayScope | null {
  const label = String(it.display_scope?.label || '').trim()
  const tone = it.display_scope?.tone
  if (label && tone) return { ...it.display_scope, label, tone }
  if (hasTaskCapability(it)) return displayScopeForSemantics(executionSemanticsOf(it))
  return null
}

function managementActionForItem(it: Pick<CalendarItem, 'management_actions'> | Pick<EditTaskForm, 'management_actions'>, id: TaskManagementActionId): TaskManagementAction | null {
  const actions = it.management_actions
  if (!Array.isArray(actions)) return null
  return actions.find((action) => action.id === id) || null
}

function managementGateForItem(it: Pick<CalendarItem, 'management_actions'> | Pick<EditTaskForm, 'management_actions'>, id: TaskManagementActionId) {
  const actions = it.management_actions
  if (!Array.isArray(actions)) return { enabled: true, disabledReason: '' }
  const action = managementActionForItem(it, id)
  if (!action) return { enabled: false, disabledReason: 'not_applicable' }
  return { enabled: action.enabled !== false, disabledReason: action.enabled === false ? String(action.disabled_reason || '') : '' }
}

function editableFieldGateForItem(
  it: Pick<CalendarItem, 'editable_fields' | 'management_actions'> | Pick<EditTaskForm, 'editable_fields' | 'management_actions'>,
  field: string,
  fallbackAction: TaskManagementActionId,
) {
  const fieldGate = it.editable_fields?.[field]
  if (fieldGate) return { enabled: fieldGate.enabled !== false, disabledReason: fieldGate.enabled === false ? String(fieldGate.disabled_reason || '') : '' }
  return managementGateForItem(it, fallbackAction)
}

function disabledReasonText(reason: string | null | undefined) {
  const value = String(reason || '').trim()
  if (!value) return ''
  if (value === 'missing_management_permission') return '你没有修改这个字段的管理权限'
  if (value === 'auto_sync_locked') return '自动同步已锁定，不能在这里修改'
  if (value === 'not_applicable') return '这个动作不适用于当前任务'
  return value
}

function combineCapabilityForItems(items: CalendarItem[], status: string, semantics: TaskExecutionSemantics): TaskCapabilityFields {
  const displayStatus = mergedDailyDisplayStatus(items)
  const displayBadges = mergedDailyDisplayBadges(items, semantics)
  const actionIds = new Set<TaskManagementActionId>()
  for (const item of items) {
    if (!Array.isArray(item.management_actions)) continue
    for (const action of item.management_actions) actionIds.add(action.id)
  }
  const managementActions = Array.from(actionIds).map((id) => {
    const matches = items.flatMap((item) => Array.isArray(item.management_actions) ? item.management_actions.filter((action) => action.id === id) : [])
    const first = matches[0]
    const gate = mergeDailyCapabilityGate(matches)
    return {
      id,
      label: first?.label,
      placement: first?.placement,
      intent: first?.intent,
      enabled: gate.enabled,
      ...(gate.disabled_reason ? { disabled_reason: gate.disabled_reason } : {}),
    } as TaskManagementAction
  })
  const editableFields: Record<string, TaskEditableField> = {}
  const fieldNames = new Set<string>()
  for (const item of items) {
    Object.keys(item.editable_fields || {}).forEach((field) => fieldNames.add(field))
  }
  for (const field of fieldNames) {
    const fields = items.map((item) => item.editable_fields?.[field]).filter(Boolean) as TaskEditableField[]
    const gate = mergeDailyCapabilityGate(fields)
    editableFields[field] = gate.enabled
      ? { enabled: true }
      : { enabled: false, disabled_reason: gate.disabled_reason || 'not_applicable' }
  }
  return {
    display_state: {
      status_key: displayStatus.status_key || String(status || 'pending'),
      status_label: displayStatus.status_label,
      status_tone: displayStatus.status_tone,
      badges: displayBadges,
    },
    execution_semantics: semantics,
    display_scope: displayScopeForSemantics(semantics),
    participant_summary: {
      primary_role: semantics === 'key_or_password_action' || semantics === 'checkin_inspection' ? 'executor' : semantics === 'inspection_execution' ? 'inspector' : 'cleaner',
      primary_user_id: null,
      cleaner_id: null,
      inspector_id: null,
      executor_id: null,
      show_cleaner: semantics === 'cleaning_execution' || semantics === 'mixed_cleaning_inspection',
      show_inspector: semantics !== 'key_or_password_action' && semantics !== 'checkin_inspection',
      show_executor: semantics === 'key_or_password_action' || semantics === 'checkin_inspection',
    },
    ...(managementActions.length ? { management_actions: managementActions } : {}),
    ...(Object.keys(editableFields).length ? { editable_fields: editableFields } : {}),
  }
}

export default function CleaningPage() {
  const [view, setView] = useState<'day' | 'week' | 'month'>('month')
  const [month, setMonth] = useState<Dayjs>(() => dayjs())
  const [selectedDate, setSelectedDate] = useState<Dayjs>(() => dayjs())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<CalendarItem[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [filterRoom, setFilterRoom] = useState('')
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)
  const [filterCleaner, setFilterCleaner] = useState<string | undefined>(undefined)
  const [filterInspector, setFilterInspector] = useState<string | undefined>(undefined)
  const [taskListTab, setTaskListTab] = useState<'cleaning' | 'inspection' | 'offline'>('cleaning')
  const [bulkMode, setBulkMode] = useState(false)
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string; region?: string | null }[]>([])
  const [dbStatus, setDbStatus] = useState<any>(null)
  const [tasksMinMax, setTasksMinMax] = useState<{ min: string | null; max: string | null; from: string } | null>(null)
  const [tasksMinMaxError, setTasksMinMaxError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editForm, setEditForm] = useState<EditTaskForm | null>(null)
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [bulkEditForm, setBulkEditForm] = useState<BulkEditForm | null>(null)
  const [manualCreateOpen, setManualCreateOpen] = useState(false)
  const [manualCreateForm, setManualCreateForm] = useState<ManualCreateForm | null>(null)
  const [offlineCreateOpen, setOfflineCreateOpen] = useState(false)
  const [offlineCreateLoading, setOfflineCreateLoading] = useState(false)
  const [offlineCreateForm, setOfflineCreateForm] = useState<OfflineCreateForm | null>(null)
  const [offlineEditOpen, setOfflineEditOpen] = useState(false)
  const [offlineEditForm, setOfflineEditForm] = useState<OfflineTaskForm | null>(null)
  const [backfillOpen, setBackfillOpen] = useState(false)
  const [backfillFrom, setBackfillFrom] = useState<Dayjs>(() => dayjs().subtract(90, 'day'))
  const [backfillTo, setBackfillTo] = useState<Dayjs>(() => dayjs().add(365, 'day'))
  const [backfillLoading, setBackfillLoading] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugLoading, setDebugLoading] = useState(false)
  const [debugState, setDebugState] = useState<any>(null)
  const [showDevDebugInfo, setShowDevDebugInfo] = useState(false)
  const [weekSlideDir, setWeekSlideDir] = useState<'prev' | 'next' | null>(null)

  useEffect(() => {
    try {
      setShowDevDebugInfo(process.env.NODE_ENV === 'development' && new URLSearchParams(window.location.search).get('debug') === 'true')
    } catch {
      setShowDevDebugInfo(false)
    }
  }, [])

  const monthLabel = useMemo(() => `${month.year()}年${String(month.month() + 1).padStart(2, '0')}月`, [month])
  const selectedDateStr = useMemo(() => selectedDate.format('YYYY-MM-DD'), [selectedDate])

  const areaOptions = useMemo(() => {
    const uniq = Array.from(new Set((properties || []).map((p) => String(p.region || '').trim()).filter(Boolean)))
    uniq.sort((a, b) => a.localeCompare(b))
    return uniq.map((x) => ({ value: x, label: x }))
  }, [properties])

  const manualPropertyOptions = useMemo(() => {
    const area = String(manualCreateForm?.area || '').trim()
    const list = (properties || []).filter((p) => {
      if (!area) return true
      return String(p.region || '').trim() === area
    })
    return list
      .filter((p) => String(p.id || '').trim())
      .map((p) => {
        const code = String(p.code || '').trim()
        const addr = String(p.address || '').trim()
        const label = code ? (addr ? `${code} ${addr}` : code) : (addr || String(p.id))
        return { value: String(p.id), label }
      })
  }, [manualCreateForm?.area, properties])

  const visibleRange = useMemo(() => {
    if (view === 'day') {
      return { start: selectedDate.startOf('week'), end: selectedDate.endOf('week') }
    }
    if (view === 'week') {
      return { start: selectedDate.startOf('week'), end: selectedDate.endOf('week') }
    }
    const start = month.startOf('month').startOf('week')
    const end = month.endOf('month').endOf('week')
    return { start, end }
  }, [month, selectedDate, view])

  const days = useMemo(() => {
    const { start, end } = visibleRange
    const out: Dayjs[] = []
    let cur = start
    while (cur.isBefore(end) || cur.isSame(end, 'day')) {
      out.push(cur)
      cur = cur.add(1, 'day')
    }
    return out
  }, [visibleRange])

  const propertyLabelById = useCallback((id?: string | null) => {
    if (!id) return ''
    const p = properties.find((x) => String(x.id) === String(id))
    return p ? (p.code || p.address || p.id) : String(id)
  }, [properties])

  const propertyLabelForItem = useCallback((it: CalendarItem) => {
    const byId = propertyLabelById(it.property_id)
    if (byId && byId !== String(it.property_id || '')) return byId
    return (it.property_code || byId || (it.property_id ? String(it.property_id) : '')) || ''
  }, [propertyLabelById])

  const isLateCheckoutTime = useCallback((raw: string | null | undefined) => {
    const s = String(raw || '').trim().toLowerCase()
    if (!s) return false
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
    if (!m) return false
    let hour = Number(m[1] || 0)
    const minute = Number(m[2] || 0)
    const meridiem = String(m[3] || '').trim()
    if (meridiem === 'am') {
      if (hour === 12) hour = 0
    } else if (meridiem === 'pm') {
      if (hour < 12) hour += 12
    }
    return hour * 60 + minute > 10 * 60
  }, [])

  const isDefaultCheckoutTime = useCallback((raw: string | null | undefined) => {
    const s = String(raw || '').trim().toLowerCase()
    if (!s) return true
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
    if (!m) return false
    let hour = Number(m[1] || 0)
    const minute = Number(m[2] || 0)
    const meridiem = String(m[3] || '').trim()
    if (meridiem === 'am') {
      if (hour === 12) hour = 0
    } else if (meridiem === 'pm') {
      if (hour < 12) hour += 12
    }
    return hour * 60 + minute === 10 * 60
  }, [])

  const isDefaultCheckinTime = useCallback((raw: string | null | undefined) => {
    const s = String(raw || '').trim().toLowerCase()
    if (!s) return true
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
    if (!m) return false
    let hour = Number(m[1] || 0)
    const minute = Number(m[2] || 0)
    const meridiem = String(m[3] || '').trim()
    if (meridiem === 'am') {
      if (hour === 12) hour = 0
    } else if (meridiem === 'pm') {
      if (hour < 12) hour += 12
    }
    return hour * 60 + minute === 15 * 60
  }, [])

  const hasLateCheckout = useCallback((it: CalendarItem) => {
    const type = String(it.task_type || '').toLowerCase()
    const label = String(it.label || '')
    const isTurnover = type === 'turnover' || (label.includes('退房') && label.includes('入住'))
    const isCheckout = type === 'checkout_clean' || label.includes('退房')
    if (!isTurnover && !isCheckout) return false
    return isLateCheckoutTime(it.summary_checkout_time)
  }, [isLateCheckoutTime])

  const checkinSyncTag = useCallback((it: Pick<CalendarItem, 'source' | 'checkin_sync_status'>) => {
    if (it.source !== 'cleaning_tasks') return null
    if (it.checkin_sync_status === 'pending') return { label: '待同步', tone: 'pending' as const }
    if (it.checkin_sync_status === 'synced') return { label: '已同步', tone: 'success' as const }
    return null
  }, [])

  const summaryText = useCallback((it: CalendarItem) => {
    const region = String(it.property_region || '').trim()
    const code = String(it.property_code || '').trim() || propertyLabelForItem(it)
    const rawCheckoutT = String(it.summary_checkout_time || '').trim()
    const checkoutT = rawCheckoutT || '10am'
    const checkoutLabel = isDefaultCheckoutTime(checkoutT) ? '退房' : `${checkoutT}退房`
    const type = String(it.task_type || '').toLowerCase()
    const label = String(it.label || '')
    const isTurnover = type === 'turnover' || (label.includes('退房') && label.includes('入住'))
    const isStayover = type === 'stayover_clean' || label.includes('入住中清洁')
    const isCheckout = type === 'checkout_clean' || label.includes('退房')
    const isCheckin = (type === 'checkin_clean' || label.includes('入住')) && !isStayover
    const parts: string[] = []
    if (isTurnover) {
      const checkinT = String(it.summary_checkin_time || '').trim() || '3pm'
      const checkinLabel = isDefaultCheckinTime(checkinT) ? '入住' : `${checkinT}入住`
      parts.push(checkoutLabel, checkinLabel)
    }
    else if (isCheckout) parts.push(checkoutLabel)
    else if (isStayover) {
      const t = String((it as any).checkin_time || '').trim()
      parts.push(t ? `${t}清洁` : '清洁')
    } else if (isCheckin) {
      const checkinT = String(it.summary_checkin_time || '').trim() || '3pm'
      parts.push(isDefaultCheckinTime(checkinT) ? '入住' : `${checkinT}入住`)
    }
    if (hasLateCheckout(it)) parts.push('晚退房')
    return { region, code, detail: parts.join(' ') }
  }, [hasLateCheckout, isDefaultCheckinTime, isDefaultCheckoutTime, propertyLabelForItem])

  const entityIds = useCallback((it: CalendarItem) => {
    const ids = Array.isArray(it.entity_ids) && it.entity_ids.length ? it.entity_ids : [it.entity_id]
    return Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)))
  }, [])

  const rawCleaningItemById = useMemo(() => {
    const map = new Map<string, CalendarItem>()
    for (const item of items) {
      if (item.source !== 'cleaning_tasks') continue
      const ids = Array.isArray(item.entity_ids) && item.entity_ids.length ? item.entity_ids : [item.entity_id]
      if (ids.length !== 1) continue
      const id = String(ids[0] || '').trim()
      if (id) map.set(id, item)
    }
    return map
  }, [items])

  const editableEntityIds = useCallback((ids: string[], field: string, fallbackAction: TaskManagementActionId) => {
    return ids.filter((id) => {
      const raw = rawCleaningItemById.get(String(id))
      if (!raw) return true
      return editableFieldGateForItem(raw, field, fallbackAction).enabled
    })
  }, [rawCleaningItemById])

  const mergedStatus = useCallback((statuses: string[]) => {
    return mergedDailyTaskStatus(statuses.map((status) => ({ status })))
  }, [])

  const itemsByDate = useMemo(() => {
    const m = new Map<string, CalendarItem[]>()
    for (const it of items) {
      const d = String(it.task_date || '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
      const arr = m.get(d) || []
      arr.push(it)
      m.set(d, arr)
    }
    for (const [k, arr] of m.entries()) {
      const cleaning = arr.filter((x) => x.source === 'cleaning_tasks')
      const other = arr.filter((x) => x.source !== 'cleaning_tasks')
      const byProp = new Map<string, CalendarItem[]>()
      for (const it of cleaning) {
        const pid = String(it.property_id || '')
        const list = byProp.get(pid) || []
        list.push(it)
        byProp.set(pid, list)
      }
      const mergedCleaning: CalendarItem[] = []
      const isStayover = (x: CalendarItem) => String(x.task_type || '').toLowerCase() === 'stayover_clean' || String(x.label || '').includes('入住中清洁') || `${x.label}`.toLowerCase().includes('stayover')
      const isCheckin = (x: CalendarItem) => !isStayover(x) && (String(x.task_type || '').toLowerCase() === 'checkin_clean' || (String(x.label || '').includes('入住') && !String(x.label || '').includes('入住中清洁')) || `${x.label}`.toLowerCase().includes('checkin'))
      const isCheckout = (x: CalendarItem) => String(x.task_type || '').toLowerCase() === 'checkout_clean' || String(x.label || '').includes('退房') || `${x.label}`.toLowerCase().includes('checkout')
      const keyUploaded = (x: CalendarItem) => !!(x?.has_key_photo || x?.key_photo_uploaded_at)
      const anyKeyUploaded = (xs: CalendarItem[]) => xs.some((x) => keyUploaded(x))
      const firstKeyUploadedAt = (xs: CalendarItem[]) => {
        const hit = xs.find((x) => !!x?.key_photo_uploaded_at)
        return hit?.key_photo_uploaded_at || null
      }
      const preferOrderLinked = (xs: CalendarItem[]) => {
        const withOrder = xs.filter((x) => !!(x.order_id || x.order_code))
        return withOrder.length ? withOrder : xs
      }
      for (const list of byProp.values()) {
        const stayovers0 = list.filter(isStayover)
        const checkins0 = preferOrderLinked(list.filter(isCheckin))
        const checkouts0 = preferOrderLinked(list.filter(isCheckout))

        if (checkins0.length && checkouts0.length) {
          const all = [...checkins0, ...checkouts0]
          const ids = all.map((x) => String(x.entity_id))
          const assignee = all.every((x) => String(x.assignee_id || '') === String(all[0].assignee_id || '')) ? all[0].assignee_id : null
          const cleanerKey = (x: CalendarItem) => String(x.cleaner_id || x.assignee_id || '').trim()
          const inspectorKey = (x: CalendarItem) => String(x.inspector_id || '').trim()
          const cleanerId = all.every((x) => cleanerKey(x) === cleanerKey(all[0])) ? (cleanerKey(all[0]) || null) : null
          const inspectorId = all.every((x) => inspectorKey(x) === inspectorKey(all[0])) ? (inspectorKey(all[0]) || null) : null
          const sched = all.every((x) => String(x.scheduled_at || '') === String(all[0].scheduled_at || '')) ? all[0].scheduled_at : null
          const status = mergedStatus(all.map((x) => String(x.status || 'pending')))
          const autoSync = all.every((x) => x.auto_sync_enabled !== false)
          const checkout = checkouts0[0]
          const checkin = checkins0[0]
	          mergedCleaning.push({
	            source: 'cleaning_tasks',
	            entity_id: ids.join(','),
	            entity_ids: ids,
            order_id: null,
            order_code: null,
            property_id: all[0].property_id,
            property_code: all[0].property_code || null,
            property_region: all[0].property_region || null,
            task_type: 'turnover',
            label: '退房 入住',
            task_date: String(all[0].task_date || '').slice(0, 10),
            status,
            assignee_id: assignee,
            cleaner_id: cleanerId,
            inspector_id: inspectorId,
            scheduled_at: sched,
            key_photo_uploaded_at: firstKeyUploadedAt(all),
            has_key_photo: anyKeyUploaded(all),
            auto_sync_enabled: autoSync,
            nights: all.find((x) => x.nights != null)?.nights ?? null,
            summary_checkout_time: checkout?.summary_checkout_time || null,
            summary_checkin_time: checkin?.summary_checkin_time || null,
            checkout_order_id: checkout?.order_id ? String(checkout.order_id) : null,
            checkin_order_id: checkin?.order_id ? String(checkin.order_id) : null,
            checkin_sync_status: checkin?.checkin_sync_status || null,
            checkout_order_code: checkout?.order_code ? String(checkout.order_code) : null,
            checkin_order_code: checkin?.order_code ? String(checkin.order_code) : null,
            checkout_old_code: checkout?.old_code != null ? String(checkout.old_code || '') : null,
	            checkout_new_code: checkout?.new_code != null ? String(checkout.new_code || '') : null,
	            checkin_old_code: checkin?.old_code != null ? String(checkin.old_code || '') : null,
	            checkin_new_code: checkin?.new_code != null ? String(checkin.new_code || '') : null,
	            ...combineCapabilityForItems(all, status, 'mixed_cleaning_inspection'),
	          })
          const rest = list.filter((x) => !isCheckin(x) && !isCheckout(x))
          mergedCleaning.push(...rest)
        } else if (stayovers0.length > 1) {
          const ids = stayovers0.map((x) => String(x.entity_id))
          const status = mergedStatus(stayovers0.map((x) => String(x.status || 'pending')))
          const autoSync = stayovers0.every((x) => x.auto_sync_enabled !== false)
          const assignee = stayovers0.every((x) => String(x.assignee_id || '') === String(stayovers0[0].assignee_id || '')) ? stayovers0[0].assignee_id : null
          const cleanerId = stayovers0.every((x) => String(x.cleaner_id || x.assignee_id || '') === String(stayovers0[0].cleaner_id || stayovers0[0].assignee_id || '')) ? (String(stayovers0[0].cleaner_id || stayovers0[0].assignee_id || '').trim() || null) : null
          const inspectorId = stayovers0.every((x) => String(x.inspector_id || '') === String(stayovers0[0].inspector_id || '')) ? (String(stayovers0[0].inspector_id || '').trim() || null) : null
          const sched = stayovers0.every((x) => String(x.scheduled_at || '') === String(stayovers0[0].scheduled_at || '')) ? stayovers0[0].scheduled_at : null
	          mergedCleaning.push({
	            source: 'cleaning_tasks',
	            entity_id: ids.join(','),
	            entity_ids: ids,
            order_id: null,
            order_code: null,
            property_id: stayovers0[0].property_id,
            property_code: stayovers0[0].property_code || null,
            task_type: 'stayover_clean',
            label: `入住中清洁 x${stayovers0.length}`,
            task_date: String(stayovers0[0].task_date || '').slice(0, 10),
            status,
            assignee_id: assignee,
            cleaner_id: cleanerId,
            inspector_id: inspectorId,
            scheduled_at: sched,
            key_photo_uploaded_at: firstKeyUploadedAt(stayovers0),
            has_key_photo: anyKeyUploaded(stayovers0),
            auto_sync_enabled: autoSync,
            summary_checkin_time: stayovers0[0].summary_checkin_time || null,
            checkin_order_id: null,
            checkout_order_id: null,
            checkin_order_code: null,
            checkout_order_code: null,
	            checkin_old_code: stayovers0.map((x) => String(x.old_code || '')).filter(Boolean).join(','),
	            checkin_new_code: stayovers0.map((x) => String(x.new_code || '')).filter(Boolean).join(','),
	            checkout_old_code: null,
	            checkout_new_code: null,
	            ...combineCapabilityForItems(stayovers0, status, 'cleaning_execution'),
	          })
          const rest = list.filter((x) => !isStayover(x) && !isCheckin(x) && !isCheckout(x))
          mergedCleaning.push(...rest)
	        } else if (checkins0.length > 1) {
	          const ids = checkins0.map((x) => String(x.entity_id))
	          const status = mergedStatus(checkins0.map((x) => String(x.status || 'pending')))
	          const semantics = checkins0.every((x) => executionSemanticsOf(x) === 'key_or_password_action') ? 'key_or_password_action' : 'checkin_inspection'
	          const autoSync = checkins0.every((x) => x.auto_sync_enabled !== false)
          const assignee = checkins0.every((x) => String(x.assignee_id || '') === String(checkins0[0].assignee_id || '')) ? checkins0[0].assignee_id : null
          const cleanerId = checkins0.every((x) => String(x.cleaner_id || x.assignee_id || '') === String(checkins0[0].cleaner_id || checkins0[0].assignee_id || '')) ? (String(checkins0[0].cleaner_id || checkins0[0].assignee_id || '').trim() || null) : null
          const inspectorId = checkins0.every((x) => String(x.inspector_id || '') === String(checkins0[0].inspector_id || '')) ? (String(checkins0[0].inspector_id || '').trim() || null) : null
          const sched = checkins0.every((x) => String(x.scheduled_at || '') === String(checkins0[0].scheduled_at || '')) ? checkins0[0].scheduled_at : null
          mergedCleaning.push({
            source: 'cleaning_tasks',
            entity_id: ids.join(','),
            entity_ids: ids,
            order_id: null,
            order_code: null,
            property_id: checkins0[0].property_id,
            property_code: checkins0[0].property_code || null,
            task_type: 'checkin_clean',
            label: `入住 x${checkins0.length}`,
            task_date: String(checkins0[0].task_date || '').slice(0, 10),
            status,
            assignee_id: assignee,
            cleaner_id: cleanerId,
            inspector_id: inspectorId,
            scheduled_at: sched,
            key_photo_uploaded_at: firstKeyUploadedAt(checkins0),
            has_key_photo: anyKeyUploaded(checkins0),
            auto_sync_enabled: autoSync,
            summary_checkin_time: checkins0[0].summary_checkin_time || null,
            checkin_sync_status: checkins0.some((x) => x.checkin_sync_status === 'pending') ? 'pending' : (checkins0.some((x) => x.checkin_sync_status === 'synced') ? 'synced' : null),
            checkin_order_id: null,
            checkout_order_id: null,
            checkin_order_code: checkins0.map((x) => String(x.order_code || x.order_id || '')).filter(Boolean).join(','),
            checkout_order_code: null,
	            checkin_old_code: checkins0.map((x) => String(x.old_code || '')).filter(Boolean).join(','),
	            checkin_new_code: checkins0.map((x) => String(x.new_code || '')).filter(Boolean).join(','),
	            checkout_old_code: null,
	            checkout_new_code: null,
	            ...combineCapabilityForItems(checkins0, status, semantics),
	          })
          const rest = list.filter((x) => !isCheckin(x) && !isCheckout(x))
          mergedCleaning.push(...rest)
        } else if (checkouts0.length > 1) {
          const ids = checkouts0.map((x) => String(x.entity_id))
          const status = mergedStatus(checkouts0.map((x) => String(x.status || 'pending')))
          const autoSync = checkouts0.every((x) => x.auto_sync_enabled !== false)
          const assignee = checkouts0.every((x) => String(x.assignee_id || '') === String(checkouts0[0].assignee_id || '')) ? checkouts0[0].assignee_id : null
          const cleanerId = checkouts0.every((x) => String(x.cleaner_id || x.assignee_id || '') === String(checkouts0[0].cleaner_id || checkouts0[0].assignee_id || '')) ? (String(checkouts0[0].cleaner_id || checkouts0[0].assignee_id || '').trim() || null) : null
          const inspectorId = checkouts0.every((x) => String(x.inspector_id || '') === String(checkouts0[0].inspector_id || '')) ? (String(checkouts0[0].inspector_id || '').trim() || null) : null
          const sched = checkouts0.every((x) => String(x.scheduled_at || '') === String(checkouts0[0].scheduled_at || '')) ? checkouts0[0].scheduled_at : null
	          mergedCleaning.push({
	            source: 'cleaning_tasks',
	            entity_id: ids.join(','),
	            entity_ids: ids,
            order_id: null,
            order_code: null,
            property_id: checkouts0[0].property_id,
            property_code: checkouts0[0].property_code || null,
            task_type: 'checkout_clean',
            label: `退房 x${checkouts0.length}`,
            task_date: String(checkouts0[0].task_date || '').slice(0, 10),
            status,
            assignee_id: assignee,
            cleaner_id: cleanerId,
            inspector_id: inspectorId,
            scheduled_at: sched,
            key_photo_uploaded_at: firstKeyUploadedAt(checkouts0),
            has_key_photo: anyKeyUploaded(checkouts0),
            auto_sync_enabled: autoSync,
            summary_checkout_time: checkouts0[0].summary_checkout_time || null,
            checkout_order_id: null,
            checkin_order_id: null,
            checkout_order_code: checkouts0.map((x) => String(x.order_code || x.order_id || '')).filter(Boolean).join(','),
            checkin_order_code: null,
            checkout_old_code: checkouts0.map((x) => String(x.old_code || '')).filter(Boolean).join(','),
	            checkout_new_code: checkouts0.map((x) => String(x.new_code || '')).filter(Boolean).join(','),
	            checkin_old_code: null,
	            checkin_new_code: null,
	            ...combineCapabilityForItems(checkouts0, status, 'mixed_cleaning_inspection'),
	          })
          const rest = list.filter((x) => !isCheckin(x) && !isCheckout(x))
          mergedCleaning.push(...rest)
        } else {
          mergedCleaning.push(...list)
        }
      }
      const regionKey = (x: any) => {
        const r = String(x?.property_region || '').trim()
        return r ? r.toLowerCase() : '\uffff'
      }
      const codeKey = (x: any) => {
        const c = String(x?.property_code || '').trim()
        return c ? c.toLowerCase() : String(x?.property_id || '').trim().toLowerCase()
      }
      const next = [...mergedCleaning, ...other]
      next.sort((a, b) =>
        regionKey(a).localeCompare(regionKey(b)) ||
        codeKey(a).localeCompare(codeKey(b)) ||
        String(a.label || '').localeCompare(String(b.label || '')) ||
        String(a.source || '').localeCompare(String(b.source || '')) ||
        String(a.entity_id || '').localeCompare(String(b.entity_id || ''))
      )
      m.set(k, next)
    }
    for (const [k, arr] of m.entries()) {
      const regionKey = (x: any) => {
        const r = String(x?.property_region || '').trim()
        return r ? r.toLowerCase() : '\uffff'
      }
      const codeKey = (x: any) => {
        const c = String(x?.property_code || '').trim()
        return c ? c.toLowerCase() : String(x?.property_id || '').trim().toLowerCase()
      }
      arr.sort((a, b) =>
        regionKey(a).localeCompare(regionKey(b)) ||
        codeKey(a).localeCompare(codeKey(b)) ||
        String(a.label || '').localeCompare(String(b.label || '')) ||
        String(a.source || '').localeCompare(String(b.source || '')) ||
        String(a.entity_id || '').localeCompare(String(b.entity_id || ''))
      )
      m.set(k, arr)
    }
    return m
  }, [items, mergedStatus])

  const selectedList = useMemo(() => {
    const base = itemsByDate.get(selectedDateStr) || []
    const q = filterRoom.trim().toLowerCase()
    return base.filter((it) => {
      if (taskListTab === 'cleaning' && !isCleaningExecutionItem(it)) return false
      if (taskListTab === 'inspection' && !isPureCheckinInspectionItem(it)) return false
      if (taskListTab === 'offline' && it.source !== 'offline_tasks') return false
	      if (filterStatus && String(it.display_state?.status_key || it.status || '') !== filterStatus) return false
	      if (filterCleaner) {
	        const participant = it.participant_summary || null
	        const v = participant?.primary_user_id
	          ? String(participant.primary_user_id).trim()
	          : taskListTab === 'inspection'
	          ? isCheckinKeyHandoverItem(it)
	            ? String(it.assignee_id || it.inspector_id || '').trim()
	            : String(it.inspector_id || '').trim()
          : it.source === 'offline_tasks'
          ? String(it.assignee_id || '').trim()
          : String(it.cleaner_id || it.assignee_id || '').trim()
        if (!v || v !== String(filterCleaner)) return false
      }
	      if (filterInspector) {
	        if (it.source === 'offline_tasks') return false
	        const v = String(it.participant_summary?.inspector_id || it.inspector_id || '').trim()
	        if (!v || v !== String(filterInspector)) return false
	      }
      if (!q) return true
      const label = propertyLabelForItem(it).toLowerCase()
      return label.includes(q)
    })
  }, [filterCleaner, filterInspector, filterRoom, filterStatus, itemsByDate, propertyLabelForItem, selectedDateStr, taskListTab])

  const taskTabOptions = useMemo(() => {
    const dayItems = itemsByDate.get(selectedDateStr) || []
    const cleaningCount = dayItems.filter(isCleaningExecutionItem).length
    const inspectionCount = dayItems.filter(isPureCheckinInspectionItem).length
    const offlineCount = dayItems.filter((it) => it.source === 'offline_tasks').length
    return [
      { label: `清洁执行 ${cleaningCount}`, value: 'cleaning' },
      { label: `检查/执行 ${inspectionCount}`, value: 'inspection' },
      { label: `线下任务 ${offlineCount}`, value: 'offline' },
    ]
  }, [itemsByDate, selectedDateStr])

  const taskStatusOptions = useMemo(() => {
    if (taskListTab === 'offline') {
      return [
        { label: '待处理', value: 'todo' },
        { label: '已完成', value: 'done' },
      ]
    }
    return [
      { label: '待处理', value: 'pending' },
      { label: '已分配', value: 'assigned' },
      { label: '进行中', value: 'in_progress' },
      { label: '已完成', value: 'completed' },
      { label: '已取消', value: 'cancelled' },
    ]
  }, [taskListTab])

  const loadStaff = useCallback(async () => {
    const s = await getJSON<Staff[]>('/cleaning/staff').catch(() => [])
    setStaff(Array.isArray(s) ? s : [])
  }, [])

  const loadProps = useCallback(async () => {
    const p = await getJSON<any>('/properties?include_archived=true').catch(() => [])
    setProperties(Array.isArray(p) ? p : [])
  }, [])

  const loadRangeItems = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const from = visibleRange.start.format('YYYY-MM-DD')
      const to = visibleRange.end.format('YYYY-MM-DD')
      const rows = await getJSON<CalendarItem[]>(`/cleaning/calendar-range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      setItems(Array.isArray(rows) ? rows : [])
      setTasksMinMaxError(null)
      const today = dayjs().format('YYYY-MM-DD')
      getJSON<any>(`/cleaning/tasks/minmax?from=${encodeURIComponent(today)}`)
        .then((mm) => {
          if (mm && mm.ok) setTasksMinMax({ min: mm.min || null, max: mm.max || null, from: mm.from || today })
          else setTasksMinMax(null)
        })
        .catch((e: any) => {
          setTasksMinMax(null)
          setTasksMinMaxError(String(e?.message || 'minmax_failed'))
        })
    } catch (e: any) {
      setError(e?.message || '加载失败')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [visibleRange.end, visibleRange.start])

  useEffect(() => {
    loadStaff().catch(() => {})
    loadProps().catch(() => {})
    getJSON<any>('/health/db').then(setDbStatus).catch(() => setDbStatus(null))
  }, [loadProps, loadStaff])

  useEffect(() => {
    loadRangeItems().catch(() => {})
  }, [loadRangeItems])

  const openEdit = useCallback(async (it: CalendarItem) => {
    if (it.source !== 'cleaning_tasks') return
    const date = String(it.task_date || '').slice(0, 10)
    const rows = await getJSON<CleaningTaskRow[]>(`/cleaning/tasks?date=${encodeURIComponent(date)}`).catch(() => ([] as CleaningTaskRow[]))
    const clickedIds = entityIds(it)
    const clickedRow = (Array.isArray(rows) ? rows : []).find((r) => String(r.id) === String(clickedIds[0])) || null
    const propertyId = it.property_id ? String(it.property_id) : (clickedRow?.property_id ? String(clickedRow.property_id) : null)
    const rowsForProp = (Array.isArray(rows) ? rows : []).filter((r) => String(r?.property_id || '') && propertyId && String(r.property_id) === String(propertyId))
    const isCheckoutRow = (r: CleaningTaskRow | null) => String(r?.task_type || '').toLowerCase() === 'checkout_clean'
    const isCheckinRow = (r: CleaningTaskRow | null) => String(r?.task_type || '').toLowerCase() === 'checkin_clean'
    const isStayoverRow = (r: CleaningTaskRow | null) => String(r?.task_type || '').toLowerCase() === 'stayover_clean'
    const notCancelled = (r: CleaningTaskRow) => String(r?.status || '').toLowerCase() !== 'cancelled'
    const checkoutIdsAll = rowsForProp.filter((r) => notCancelled(r) && isCheckoutRow(r as any)).map((r) => String(r.id))
    const checkinIdsAll = rowsForProp.filter((r) => notCancelled(r) && isCheckinRow(r as any)).map((r) => String(r.id))
    const stayoverIdsAll = rowsForProp.filter((r) => notCancelled(r) && isStayoverRow(r as any)).map((r) => String(r.id))
    const stayoverMode =
      String(it.task_type || '').toLowerCase() === 'stayover_clean' ||
      (!!clickedRow && isStayoverRow(clickedRow))
    const ids = Array.from(new Set(stayoverMode ? [...clickedIds, ...stayoverIdsAll] : [...clickedIds, ...checkoutIdsAll, ...checkinIdsAll]))
    const selectedRows = ids.map((id) => (Array.isArray(rows) ? rows : []).find((r) => String(r.id) === String(id)) || null)
    const baseRow = selectedRows.find((r) => r && String(r.id) === String(clickedIds[0])) || selectedRows[0]
    const checkoutAllExists = checkoutIdsAll.length > 0
    const checkinAllExists = checkinIdsAll.length > 0
    const taskDetailText = (value: { guest_special_request?: string | null; note?: string | null } | null | undefined) => (
      String(value?.guest_special_request || value?.note || '').trim()
    )
    const guestSpecialRequest = [
      taskDetailText(clickedRow),
      taskDetailText(it),
      ...selectedRows.map((r) => taskDetailText(r)),
    ].find(Boolean) || ''
    const status = ids.length === 1 ? String(baseRow?.status || it.status || 'pending') : mergedStatus(selectedRows.map((r) => String(r?.status || it.status || 'pending')))
    const getCleaner = (r: CleaningTaskRow | null) => String(r?.cleaner_id || r?.assignee_id || '').trim()
    const getInspector = (r: CleaningTaskRow | null) => String(r?.inspector_id || '').trim()
    const getExecutor = (r: CleaningTaskRow | null) => String(r?.assignee_id || r?.inspector_id || r?.cleaner_id || '').trim()
    const cleanerId =
      ids.length === 1
        ? (getCleaner(baseRow) ? getCleaner(baseRow) : (String(it.cleaner_id || it.assignee_id || '').trim() || null))
        : (selectedRows.every((r) => getCleaner(r) === getCleaner(selectedRows[0])) ? (getCleaner(selectedRows[0]) || null) : null)
    const inspectorId =
      ids.length === 1
        ? (getInspector(baseRow) ? getInspector(baseRow) : (String(it.inspector_id || '').trim() || null))
        : (selectedRows.every((r) => getInspector(r) === getInspector(selectedRows[0])) ? (getInspector(selectedRows[0]) || null) : null)
    const checkoutRows = selectedRows.filter(isCheckoutRow)
    const checkinRows = selectedRows.filter(isCheckinRow)
    const stayoverRows = selectedRows.filter(isStayoverRow)
    const checkinScopeKey = (r: CleaningTaskRow | null) => normalizeInspectionScope(r?.inspection_scope)
    const checkinInspectionScope =
      checkinRows.length > 0 && checkinRows.every((r) => checkinScopeKey(r) === checkinScopeKey(checkinRows[0]))
        ? checkinScopeKey(checkinRows[0])
        : 'inspect_and_hang'
    const pureCheckinSiteExecution = checkinRows.length > 0 && checkoutRows.length === 0
    const resolvedCleanerId = pureCheckinSiteExecution
      ? (
          ids.length === 1
            ? (getExecutor(baseRow) || String(it.assignee_id || it.inspector_id || '').trim() || null)
            : (selectedRows.every((r) => getExecutor(r) === getExecutor(selectedRows[0])) ? (getExecutor(selectedRows[0]) || null) : null)
        )
      : cleanerId
    const nightsAllSame = checkinRows.length > 0 && checkinRows.every((r) => String(r?.nights_override ?? '') === String(checkinRows[0]?.nights_override ?? ''))
    const itemNights = it.nights == null ? null : Number(it.nights)
    const fallbackNightsOverride = Number.isFinite(itemNights) ? itemNights : null
    const nightsOverride =
      checkinRows.length === 1
        ? (checkinRows[0]?.nights_override != null ? Number(checkinRows[0]?.nights_override) : null)
        : (nightsAllSame ? (checkinRows[0]?.nights_override != null ? Number(checkinRows[0]?.nights_override) : null) : null)
    const resolvedNightsOverride = nightsOverride ?? fallbackNightsOverride
    const checkoutKey = (r: CleaningTaskRow | null) => String(r?.old_code ?? '').trim()
    const checkinKey = (r: CleaningTaskRow | null) => String(r?.new_code ?? '').trim()
    const checkoutPwd = checkoutRows.length > 0 && checkoutRows.every((r) => checkoutKey(r) === checkoutKey(checkoutRows[0])) ? (checkoutKey(checkoutRows[0]) || '') : ''
    const checkinPwd = checkinRows.length > 0 && checkinRows.every((r) => checkinKey(r) === checkinKey(checkinRows[0])) ? (checkinKey(checkinRows[0]) || '') : ''
    const checkoutTimeKey = (r: CleaningTaskRow | null) => String(r?.checkout_time ?? '').trim()
    const checkinTimeKey = (r: CleaningTaskRow | null) => String(r?.checkin_time ?? '').trim()
    const checkoutTime = checkoutRows.length > 0 && checkoutRows.every((r) => checkoutTimeKey(r) === checkoutTimeKey(checkoutRows[0])) ? (checkoutTimeKey(checkoutRows[0]) || '10am') : '10am'
    const checkinTime =
      stayoverMode
        ? (stayoverRows.length > 0 && stayoverRows.every((r) => checkinTimeKey(r) === checkinTimeKey(stayoverRows[0])) ? (checkinTimeKey(stayoverRows[0]) || '') : '')
        : (checkinRows.length > 0 && checkinRows.every((r) => checkinTimeKey(r) === checkinTimeKey(checkinRows[0])) ? (checkinTimeKey(checkinRows[0]) || '3pm') : '3pm')
    const checkinTaskDateKey = (r: CleaningTaskRow | null) => String(r?.task_date || r?.date || '').slice(0, 10)
    const checkinTaskDate =
      checkinRows.length > 0 && checkinRows.every((r) => checkinTaskDateKey(r) === checkinTaskDateKey(checkinRows[0]))
        ? dayjs(checkinTaskDateKey(checkinRows[0]) || date)
        : dayjs(date)
    const autoSync = selectedRows.every((r) => (r?.auto_sync_enabled !== false)) && it.auto_sync_enabled !== false
    const keysVal = (r: CleaningTaskRow | null): 1 | 2 => {
      const n = r?.keys_required == null ? 1 : Number(r.keys_required)
      if (!Number.isFinite(n)) return 1
      return n >= 2 ? 2 : 1
    }
    const keysRequiredCheckin: 1 | 2 = checkinRows.length ? (Math.max(...checkinRows.map(keysVal), 1) >= 2 ? 2 : 1) : 1
    const keysRequiredCheckout: 1 | 2 = checkoutRows.length ? (Math.max(...checkoutRows.map(keysVal), 1) >= 2 ? 2 : 1) : 1
    const uniq = (xs: (string | null | undefined)[]) => Array.from(new Set(xs.map((x) => String(x || '').trim()).filter(Boolean)))
    const checkinOrderIds = uniq(checkinRows.map((r) => (r as any)?.order_id))
    const checkoutOrderIds = uniq(checkoutRows.map((r) => (r as any)?.order_id))
    const checkinOrderId = checkinOrderIds.length === 1 ? checkinOrderIds[0] : null
    const checkoutOrderId = checkoutOrderIds.length === 1 ? checkoutOrderIds[0] : null
    const checkinManualIds = checkinRows.filter((r) => !String((r as any)?.order_id || '').trim()).map((r) => String((r as any)?.id || '').trim()).filter(Boolean)
    const checkoutManualIds = checkoutRows.filter((r) => !String((r as any)?.order_id || '').trim()).map((r) => String((r as any)?.id || '').trim()).filter(Boolean)
    const checkinSyncStatus: EditTaskForm['checkin_sync_status'] = stayoverMode || !checkinRows.length
      ? null
      : (checkinRows.some((r) => !String((r as any)?.order_id || '').trim()) ? 'pending' : 'synced')
    setEditForm({
      mode: stayoverMode ? 'stayover' : 'default',
      ids,
      task_date: dayjs(date),
      property_id: propertyId,
      status,
      checkin_sync_status: checkinSyncStatus,
      cleaner_id: resolvedCleanerId,
      inspector_id: pureCheckinSiteExecution ? null : inspectorId,
      checkin_inspection_scope: checkinInspectionScope,
      keys_required_checkin: keysRequiredCheckin,
      keys_required_checkout: keysRequiredCheckout,
      checkin_order_id: stayoverMode ? null : checkinOrderId,
      checkout_order_id: stayoverMode ? null : checkoutOrderId,
      checkin_manual_ids: stayoverMode ? [] : checkinManualIds,
      checkout_manual_ids: stayoverMode ? [] : checkoutManualIds,
      guest_special_request: guestSpecialRequest,
      nights_override: stayoverMode ? null : resolvedNightsOverride,
      checkout_ids: stayoverMode ? [] : checkoutIdsAll,
      checkin_ids: stayoverMode ? [] : checkinIdsAll,
      checkout_password: stayoverMode ? '' : checkoutPwd,
      checkin_password: stayoverMode ? '' : checkinPwd,
      checkout_time: checkoutTime,
      checkin_time: checkinTime,
      checkin_task_date: checkinTaskDate,
      can_add_checkout: stayoverMode ? false : (!!propertyId && !checkoutAllExists),
      can_add_checkin: stayoverMode ? false : (!!propertyId && !checkinAllExists),
	      pending_add_checkout: false,
	      pending_add_checkin: false,
	      auto_sync_enabled: autoSync,
	      display_state: it.display_state || null,
	      execution_semantics: it.execution_semantics || null,
	      display_scope: it.display_scope || null,
	      participant_summary: it.participant_summary || null,
	      editable_fields: it.editable_fields || null,
	      management_actions: it.management_actions || null,
	    })
    setEditOpen(true)
  }, [entityIds, mergedStatus])

  const submitEdit = useCallback(async () => {
    if (!editForm) return
    const toNull = (s: string) => (String(s || '').trim() ? String(s).trim() : null)
    const base: any = {
      task_date: editForm.task_date.format('YYYY-MM-DD'),
      status: editForm.status,
    }
    const pureCheckinSiteExecution =
      editForm.mode === 'default'
      && editForm.checkin_ids.length > 0
      && editForm.checkout_ids.length === 0
    if (pureCheckinSiteExecution) {
      base.assignee_id = editForm.cleaner_id
      base.cleaner_id = null
      base.inspector_id = null
      base.inspection_scope = editForm.checkin_inspection_scope
    } else {
      if (editForm.ids.length === 1 || editForm.cleaner_id !== null) base.cleaner_id = editForm.cleaner_id
      if (editForm.ids.length === 1 || editForm.inspector_id !== null) base.inspector_id = editForm.inspector_id
    }
    base.guest_special_request = editForm.guest_special_request || null

    if (editForm.mode === 'stayover') {
      const patches = editForm.ids.map((id) => {
        const p: any = { ...base, checkin_time: toNull(editForm.checkin_time) }
        return patchJSON(`/cleaning/tasks/${encodeURIComponent(id)}`, p)
      })
      await Promise.all(patches)
      setEditOpen(false)
      setEditForm(null)
      message.success('已更新')
      loadRangeItems().catch(() => {})
      return
    }

    const keyUpdates: Promise<any>[] = []
    if (editForm.checkin_order_id) {
      keyUpdates.push(postJSON('/mzapp/cleaning-tasks/order-keys-required', { order_id: editForm.checkin_order_id, keys_required: editForm.keys_required_checkin }))
    } else if (editForm.checkin_manual_ids.length) {
      for (const id of editForm.checkin_manual_ids) {
        keyUpdates.push(patchJSON(`/cleaning/tasks/${encodeURIComponent(id)}`, { keys_required: editForm.keys_required_checkin }))
      }
    }
    if (editForm.checkout_order_id) {
      keyUpdates.push(postJSON('/mzapp/cleaning-tasks/order-keys-required', { order_id: editForm.checkout_order_id, keys_required: editForm.keys_required_checkout }))
    } else if (editForm.checkout_manual_ids.length) {
      for (const id of editForm.checkout_manual_ids) {
        keyUpdates.push(patchJSON(`/cleaning/tasks/${encodeURIComponent(id)}`, { keys_required: editForm.keys_required_checkout }))
      }
    }

    if (editForm.pending_add_checkout && editForm.property_id) {
      await postJSON('/cleaning/tasks', {
        task_type: 'checkout_clean',
        task_date: editForm.task_date.format('YYYY-MM-DD'),
        property_id: editForm.property_id,
        status: editForm.status,
        cleaner_id: editForm.cleaner_id,
        inspector_id: editForm.inspector_id,
        keys_required: editForm.keys_required_checkout,
        old_code: toNull(editForm.checkout_password),
        checkout_time: toNull(editForm.checkout_time),
        guest_special_request: editForm.guest_special_request || null,
      })
    }
    if (editForm.pending_add_checkin && editForm.property_id) {
      await postJSON('/cleaning/tasks', {
        task_type: 'checkin_clean',
        task_date: editForm.checkin_task_date.format('YYYY-MM-DD'),
        property_id: editForm.property_id,
        status: editForm.status,
        cleaner_id: editForm.cleaner_id,
        inspector_id: editForm.inspector_id,
        keys_required: editForm.keys_required_checkin,
        new_code: toNull(editForm.checkin_password),
        nights_override: editForm.nights_override ?? null,
        checkin_time: toNull(editForm.checkin_time),
        guest_special_request: editForm.guest_special_request || null,
      })
    }

    const patches = editForm.ids.map((id) => {
      const p: any = { ...base }
      if (editForm.checkout_ids.some((x) => String(x) === String(id))) {
        p.old_code = toNull(editForm.checkout_password)
        p.checkout_time = toNull(editForm.checkout_time)
      }
      if (editForm.checkin_ids.some((x) => String(x) === String(id))) {
        p.task_date = editForm.checkin_task_date.format('YYYY-MM-DD')
        p.new_code = toNull(editForm.checkin_password)
        p.nights_override = editForm.nights_override ?? null
        p.checkin_time = toNull(editForm.checkin_time)
      }
      return patchJSON(`/cleaning/tasks/${encodeURIComponent(id)}`, p)
    })
    await Promise.all([...patches, ...keyUpdates])
    setEditOpen(false)
    setEditForm(null)
    message.success('已更新')
    loadRangeItems().catch(() => {})
  }, [editForm, loadRangeItems])

  const cancelTasksInEdit = useCallback(async (ids: string[], label: string) => {
    const uniq = Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)))
    if (!uniq.length) return
    await postJSON('/cleaning/tasks/bulk-delete', { ids: uniq })
    message.success(`${label}已取消`)
    setEditOpen(false)
    setEditForm(null)
    loadRangeItems().catch(() => {})
  }, [loadRangeItems])

  const submitBackfill = useCallback(async () => {
    const from = backfillFrom.format('YYYY-MM-DD')
    const to = backfillTo.format('YYYY-MM-DD')
    setBackfillLoading(true)
    try {
      const r = await postJSON<any>(`/cleaning/backfill?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}`, {})
      const created = Number(r?.created || 0)
      const updated = Number(r?.updated || 0)
      const cancelled = Number(r?.cancelled || 0)
      const skippedLocked = Number(r?.skipped_locked || 0)
      const failed = Number(r?.failed || 0)
      const tasksAfter = r?.tasks_after
      message.success(`Backfill 完成：created=${created} updated=${updated} cancelled=${cancelled} skipped_locked=${skippedLocked} failed=${failed} tasks_after=${tasksAfter ?? '-'}`)
      setBackfillOpen(false)
      loadRangeItems().catch(() => {})
    } catch (e: any) {
      message.error(e?.message || 'Backfill 失败')
    } finally {
      setBackfillLoading(false)
    }
  }, [backfillFrom, backfillTo, loadRangeItems])

  const openDebug = useCallback(async () => {
    setDebugOpen(true)
    setDebugLoading(true)
    try {
      const s = await getJSON<any>('/cleaning/debug/state')
      setDebugState(s)
    } catch (e: any) {
      setDebugState({ error: String(e?.message || 'debug_failed') })
    } finally {
      setDebugLoading(false)
    }
  }, [])

  const itemKind = useCallback((it: CalendarItem) => cleaningColorKind(it as any), [])

  const stripeColorForUrgency = useCallback((urgency: string) => {
    const u = String(urgency || '').toLowerCase()
    if (u === 'urgent') return 'rgba(239, 68, 68, 0.85)'
    if (u === 'high') return 'rgba(249, 115, 22, 0.85)'
    if (u === 'medium') return 'rgba(59, 130, 246, 0.85)'
    return 'rgba(148, 163, 184, 0.85)'
  }, [])

  const staffNameById = useCallback((id: string | null) => {
    if (!id) return '-'
    return staff.find((s) => String(s.id) === String(id))?.name || String(id)
  }, [staff])

  const staffById = useMemo(() => {
    const m = new Map<string, Staff>()
    for (const s of staff) m.set(String(s.id), s)
    return m
  }, [staff])

  const normalizeHex = useCallback((hex: any): string | null => {
    const v = String(hex || '').trim()
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return null
    return v.toUpperCase()
  }, [])

  const isDarkBg = useCallback((hex: string) => {
    const h = hex.replace('#', '')
    const r = parseInt(h.slice(0, 2), 16) / 255
    const g = parseInt(h.slice(2, 4), 16) / 255
    const b = parseInt(h.slice(4, 6), 16) / 255
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return lum < 0.6
  }, [])

  const cleanerColorOf = useCallback((it: CalendarItem) => {
    const id = String(it.cleaner_id || it.assignee_id || '').trim()
    const hex = id ? normalizeHex(staffById.get(id)?.color_hex) : null
    return hex || '#CBD5E1'
  }, [normalizeHex, staffById])

  const cleanerOptions = useMemo(() => (
    staff
      .filter((s) => (s.kind || 'cleaner') === 'cleaner' && s.is_active !== false)
      .reduce((acc, s) => {
        const k = String(s.id)
        if (!acc.some((x) => String(x.value) === k)) acc.push({ value: s.id, label: s.name })
        return acc
      }, [] as { value: string; label: string }[])
  ), [staff])

  const inspectorOptions = useMemo(() => (
    staff
      .filter((s) => (s.kind || 'cleaner') === 'inspector' && s.is_active !== false)
      .reduce((acc, s) => {
        const k = String(s.id)
        if (!acc.some((x) => String(x.value) === k)) acc.push({ value: s.id, label: s.name })
        return acc
      }, [] as { value: string; label: string }[])
  ), [staff])

  const statusOptions = useMemo(() => ([
    { label: '待处理', value: 'pending' },
    { label: '已分配', value: 'assigned' },
    { label: '进行中', value: 'in_progress' },
    { label: '已完成', value: 'completed' },
    { label: '已取消', value: 'cancelled' },
  ]), [])

  const allStaffOptions = useMemo(() => (
    staff
      .filter((s) => s.is_active !== false)
      .reduce((acc, s) => {
        const k = String(s.id)
        if (!acc.some((x) => String(x.value) === k)) acc.push({ value: s.id, label: s.name })
        return acc
      }, [] as { value: string; label: string }[])
  ), [staff])

  const propertyOptions = useMemo(() => (
    (properties || [])
      .filter((p) => String(p.id || '').trim())
      .map((p) => {
        const code = String(p.code || '').trim()
        const addr = String(p.address || '').trim()
        const label = code ? (addr ? `${code} ${addr}` : code) : (addr || String(p.id))
        return { value: String(p.id), label }
      })
  ), [properties])

  const offlineTaskTypeOptions = useMemo(() => ([
    { label: '房源任务', value: 'property' },
    { label: '公司任务', value: 'company' },
    { label: '其他任务', value: 'other' },
  ]), [])

  const offlineStatusOptions = useMemo(() => ([
    { label: '待处理', value: 'todo' },
    { label: '已完成', value: 'done' },
  ]), [])

  const urgencyOptions = useMemo(() => ([
    { label: '低', value: 'low' },
    { label: '中', value: 'medium' },
    { label: '高', value: 'high' },
    { label: '紧急', value: 'urgent' },
  ]), [])

  const statusText = useCallback((s: string | null | undefined) => {
    return taskStatusMeta(s).label
  }, [])

  const offlineTaskTypeText = useCallback((taskType: string | null | undefined) => {
    const v = String(taskType || '').trim().toLowerCase()
    if (v === 'property') return '房源任务'
    if (v === 'company') return '公司任务'
    if (v === 'other') return '其他任务'
    return v || '线下任务'
  }, [])

  const urgencyText = useCallback((urgency: string | null | undefined) => {
    const v = String(urgency || '').trim().toLowerCase()
    if (v === 'low') return '低'
    if (v === 'medium') return '中'
    if (v === 'high') return '高'
    if (v === 'urgent') return '紧急'
    return v || '-'
  }, [])

  const normalizeTaskPhotoUrls = useCallback((input: any) => {
    const arr = Array.isArray(input) ? input : []
    return Array.from(new Set(arr.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 20)
  }, [])

  const displayPhotoUrl = useCallback((url: string) => {
    const value = String(url || '').trim()
    if (!value) return ''
    if (/^https?:\/\//i.test(value)) return value
    if (value.startsWith('/')) return `${API_BASE}${value}`
    return value
  }, [])

  const photoUploadFiles = useCallback((urls: string[]): UploadFile[] => (
    normalizeTaskPhotoUrls(urls).map((url, index) => ({
      uid: `${url}:${index}`,
      name: `照片 ${index + 1}`,
      status: 'done',
      url: displayPhotoUrl(url),
      thumbUrl: displayPhotoUrl(url),
    }))
  ), [displayPhotoUrl, normalizeTaskPhotoUrls])

  const uploadOfflineTaskPhoto = useCallback(async (file: File) => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`${API_BASE}/cleaning-app/upload`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })
    const body = await res.json().catch(() => null) as any
    if (!res.ok) throw new Error(String(body?.message || body?.error || '上传失败'))
    const url = String(body?.url || '').trim()
    if (!url) throw new Error('上传成功但未返回照片地址')
    return url
  }, [])

  const statusChipCls = useCallback((s: string | null | undefined) => {
    return semanticToneClass(taskStatusMeta(s).tone)
  }, [])

  const timeOptions = useMemo(() => {
    const out: { value: string; label: string }[] = []
    const startMin = 0
    const endMin = 23 * 60 + 30
    for (let m = startMin; m <= endMin; m += 30) {
      const hour24 = Math.floor(m / 60)
      const min = m % 60
      const isAm = hour24 < 12
      let hour12 = hour24 % 12
      if (hour12 === 0) hour12 = 12
      const label =
        min === 0
          ? `${hour12}${isAm ? 'am' : 'pm'}`
          : `${hour12}:${String(min).padStart(2, '0')}${isAm ? 'am' : 'pm'}`
      out.push({ value: label, label })
    }
    return out
  }, [])

  const editModeText = useCallback((form: EditTaskForm) => {
    if (form.mode === 'stayover') return '入住中清洁'
    const hasCheckout = form.checkout_ids.length > 0 || form.pending_add_checkout
    const hasCheckin = form.checkin_ids.length > 0 || form.pending_add_checkin
    if (hasCheckout && hasCheckin) return '退房入住'
    if (hasCheckout) return '退房'
    if (hasCheckin) return '入住'
    return '清洁任务'
  }, [])

  const editTaskHeadline = useCallback((form: EditTaskForm) => {
    const room = propertyLabelById(form.property_id) || '未绑定房源'
    return `${room}`
  }, [propertyLabelById])

  const openManualCreate = useCallback(() => {
    setManualCreateForm({
      area: null,
      property_id: null,
      create_mode: 'turnover',
      checkout_password: '',
      checkin_password: '',
      nights_override: null,
      checkout_time: '10am',
      checkin_time: '3pm',
      guest_special_request: '',
    })
    setManualCreateOpen(true)
  }, [])

  const submitManualCreate = useCallback(async () => {
    if (!manualCreateForm) return
    if (!manualCreateForm.property_id) {
      message.warning('请选择房号')
      return
    }
    const isStayover = manualCreateForm.create_mode === 'stayover'
    const body: any = {
      create_mode: manualCreateForm.create_mode,
      task_date: selectedDateStr,
      property_id: String(manualCreateForm.property_id),
      old_code: isStayover ? null : (manualCreateForm.checkout_password.trim() ? manualCreateForm.checkout_password.trim() : null),
      new_code: isStayover ? null : (manualCreateForm.checkin_password.trim() ? manualCreateForm.checkin_password.trim() : null),
      nights_override: manualCreateForm.nights_override != null ? Number(manualCreateForm.nights_override) : null,
      checkout_time: manualCreateForm.checkout_time ? String(manualCreateForm.checkout_time) : null,
      checkin_time: isStayover ? null : (manualCreateForm.checkin_time ? String(manualCreateForm.checkin_time) : null),
      guest_special_request: manualCreateForm.guest_special_request.trim() ? manualCreateForm.guest_special_request.trim() : null,
    }
    await postJSON('/cleaning/tasks', body)
    message.success('已新增清洁任务')
    setManualCreateOpen(false)
    setManualCreateForm(null)
    loadRangeItems().catch(() => {})
  }, [loadRangeItems, manualCreateForm, selectedDateStr])

  const updateTaskQuick = useCallback(async (ids: string[], patch: any) => {
    const normIds = Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)))
    const idSet = new Set(normIds)

    setItems((prev) => prev.map((it) => {
      if (it.source !== 'cleaning_tasks') return it
      const itIds = Array.isArray(it.entity_ids) && it.entity_ids.length ? it.entity_ids : [it.entity_id]
      const hit = itIds.some((x) => idSet.has(String(x)))
      if (!hit) return it
      const next: any = { ...it }
      if (patch.status !== undefined) next.status = patch.status
      if (patch.task_date !== undefined) next.task_date = patch.task_date
      if (patch.scheduled_at !== undefined) next.scheduled_at = patch.scheduled_at
      if (patch.cleaner_id !== undefined) {
        next.cleaner_id = patch.cleaner_id
        if (patch.assignee_id === undefined) next.assignee_id = patch.cleaner_id
      }
      if (patch.assignee_id !== undefined) {
        next.assignee_id = patch.assignee_id
        if (patch.cleaner_id === undefined) next.cleaner_id = patch.assignee_id
      }
      if (patch.inspector_id !== undefined) next.inspector_id = patch.inspector_id
      if (patch.inspection_scope !== undefined) next.inspection_scope = patch.inspection_scope
      if (patch.status === undefined && (String(it.status || 'pending') === 'pending' || String(it.status || 'pending') === 'assigned')) {
        const cleaner = String(next.cleaner_id || next.assignee_id || '').trim()
        const inspector = String(next.inspector_id || '').trim()
        next.status = cleaner || inspector ? 'assigned' : 'pending'
      }
      return next
    }))

    try {
      await postJSON('/cleaning/tasks/bulk-patch', { ids: normIds, patch })
    } catch (e) {
      loadRangeItems().catch(() => {})
      throw e
    }
  }, [loadRangeItems])

  const selectedSet = useMemo(() => new Set(selectedTaskIds.map((x) => String(x))), [selectedTaskIds])

  useEffect(() => {
    setSelectedTaskIds([])
    setBulkMode(false)
    setBulkEditOpen(false)
    setBulkEditForm(null)
  }, [selectedDateStr])

  useEffect(() => {
    setFilterStatus(undefined)
    setFilterCleaner(undefined)
    setFilterInspector(undefined)
    setSelectedTaskIds([])
    setBulkMode(false)
    setBulkEditOpen(false)
    setBulkEditForm(null)
  }, [taskListTab])

  const toggleSelectItem = useCallback((it: CalendarItem, checked: boolean) => {
    const ids = entityIds(it)
    setSelectedTaskIds((prev) => {
      const set = new Set(prev.map((x) => String(x)))
      for (const id of ids) {
        if (checked) set.add(String(id))
        else set.delete(String(id))
      }
      return Array.from(set)
    })
  }, [entityIds])

  const deleteTasks = useCallback(async (ids: string[]) => {
    const uniq = Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)))
    if (!uniq.length) return
    await postJSON('/cleaning/tasks/bulk-delete', { ids: uniq })
    message.success('已删除')
    setSelectedTaskIds([])
    loadRangeItems().catch(() => {})
  }, [loadRangeItems])

  const openOfflineEdit = useCallback((it: CalendarItem) => {
    if (it.source !== 'offline_tasks') return
    setOfflineEditForm({
      id: String(it.entity_id || ''),
      date: dayjs(String(it.task_date || selectedDateStr).slice(0, 10)),
      task_type: (['property', 'company', 'other'].includes(String(it.task_type || '').trim()) ? String(it.task_type) : 'other') as 'property' | 'company' | 'other',
      title: String(it.label || ''),
      content: String(it.content || ''),
      status: String(it.status || 'todo').trim().toLowerCase() === 'done' ? 'done' : 'todo',
      urgency: (['low', 'medium', 'high', 'urgent'].includes(String(it.urgency || '').trim().toLowerCase()) ? String(it.urgency).trim().toLowerCase() : 'medium') as 'low' | 'medium' | 'high' | 'urgent',
      property_id: it.property_id ? String(it.property_id) : null,
      assignee_id: it.assignee_id ? String(it.assignee_id) : null,
      photo_urls: normalizeTaskPhotoUrls(it.photo_urls),
    })
    setOfflineEditOpen(true)
  }, [normalizeTaskPhotoUrls, selectedDateStr])

  const openOfflineCreate = useCallback(() => {
    setOfflineCreateForm({
      date: dayjs(selectedDateStr),
      task_type: 'other',
      title: '',
      content: '',
      urgency: 'medium',
      property_id: null,
      assignee_id: null,
      photo_urls: [],
    })
    setOfflineCreateOpen(true)
  }, [selectedDateStr])

  const submitOfflineCreate = useCallback(async () => {
    if (!offlineCreateForm) return
    const title = String(offlineCreateForm.title || '').trim()
    if (!title) {
      message.warning('请输入任务标题')
      return
    }
    if (offlineCreateForm.task_type === 'property' && !String(offlineCreateForm.property_id || '').trim()) {
      message.warning('房源任务请选择房号')
      return
    }
    setOfflineCreateLoading(true)
    try {
      const payload: any = {
        date: offlineCreateForm.date.format('YYYY-MM-DD'),
        task_type: offlineCreateForm.task_type,
        title,
        content: String(offlineCreateForm.content || '').trim(),
        kind: 'other',
        status: 'todo',
        urgency: offlineCreateForm.urgency,
        property_id: offlineCreateForm.task_type === 'property' ? (offlineCreateForm.property_id || undefined) : undefined,
        assignee_id: offlineCreateForm.assignee_id || undefined,
        photo_urls: normalizeTaskPhotoUrls(offlineCreateForm.photo_urls),
      }
      await postJSON('/cleaning/offline-tasks', payload, { timeoutMs: 20000 })
      setOfflineCreateOpen(false)
      setOfflineCreateForm(null)
      message.success('已创建线下任务')
      loadRangeItems().catch(() => {})
    } catch (e: any) {
      message.error(String(e?.message || '创建失败'))
    } finally {
      setOfflineCreateLoading(false)
    }
  }, [loadRangeItems, normalizeTaskPhotoUrls, offlineCreateForm])

  const submitOfflineEdit = useCallback(async () => {
    if (!offlineEditForm) return
    if (!String(offlineEditForm.title || '').trim()) {
      message.warning('请输入任务标题')
      return
    }
    if (offlineEditForm.task_type === 'property' && !String(offlineEditForm.property_id || '').trim()) {
      message.warning('房源任务需要选择房号')
      return
    }
    const payload = {
      date: offlineEditForm.date.format('YYYY-MM-DD'),
      task_type: offlineEditForm.task_type,
      title: String(offlineEditForm.title || '').trim(),
      content: String(offlineEditForm.content || '').trim(),
      status: offlineEditForm.status,
      urgency: offlineEditForm.urgency,
      property_id: offlineEditForm.task_type === 'property' ? (offlineEditForm.property_id || null) : null,
      assignee_id: offlineEditForm.assignee_id || null,
      photo_urls: normalizeTaskPhotoUrls(offlineEditForm.photo_urls),
    }
    await patchJSON(`/cleaning/offline-tasks/${encodeURIComponent(offlineEditForm.id)}`, payload)
    message.success('已更新线下任务')
    setOfflineEditOpen(false)
    setOfflineEditForm(null)
    loadRangeItems().catch(() => {})
  }, [loadRangeItems, normalizeTaskPhotoUrls, offlineEditForm])

  const deleteOfflineTask = useCallback(async (id: string) => {
    const taskId = String(id || '').trim()
    if (!taskId) return
    await deleteJSON(`/cleaning/offline-tasks/${encodeURIComponent(taskId)}`)
    message.success('已删除线下任务')
    setOfflineEditOpen(false)
    setOfflineEditForm(null)
    loadRangeItems().catch(() => {})
  }, [loadRangeItems])

  const openBulkEdit = useCallback(() => {
    const ids = Array.from(new Set(selectedTaskIds.map((x) => String(x)).filter(Boolean)))
    if (!ids.length) {
      message.warning('请先选择任务')
      return
    }
    setBulkEditForm({ ids, status: '__keep__', cleaner: '__keep__', inspector: '__keep__' })
    setBulkEditOpen(true)
  }, [selectedTaskIds])

  const submitBulkEdit = useCallback(async () => {
    if (!bulkEditForm) return
    const patch: any = {}
    if (bulkEditForm.status !== '__keep__') patch.status = bulkEditForm.status
    if (bulkEditForm.cleaner === '__clear__') patch.cleaner_id = null
    else if (bulkEditForm.cleaner !== '__keep__') patch.cleaner_id = bulkEditForm.cleaner
    if (bulkEditForm.inspector === '__clear__') patch.inspector_id = null
    else if (bulkEditForm.inspector !== '__keep__') patch.inspector_id = bulkEditForm.inspector
    if (!Object.keys(patch).length) {
      message.warning('未选择任何要批量修改的字段')
      return
    }
    await postJSON('/cleaning/tasks/bulk-patch', { ids: bulkEditForm.ids, patch })
    setBulkEditOpen(false)
    setBulkEditForm(null)
    message.success('已批量更新')
    loadRangeItems().catch(() => {})
  }, [bulkEditForm, loadRangeItems])

  const goPrev = useCallback(() => {
    if (view === 'month') setMonth((m) => m.subtract(1, 'month'))
    else if (view === 'week') {
      setWeekSlideDir('prev')
      setSelectedDate((d) => d.subtract(1, 'week'))
    } else setSelectedDate((d) => d.subtract(1, 'day'))
  }, [view])

  const goNext = useCallback(() => {
    if (view === 'month') setMonth((m) => m.add(1, 'month'))
    else if (view === 'week') {
      setWeekSlideDir('next')
      setSelectedDate((d) => d.add(1, 'week'))
    } else setSelectedDate((d) => d.add(1, 'day'))
  }, [view])

	  useEffect(() => {
	    if (view !== 'week' || !weekSlideDir) return
	    const timer = window.setTimeout(() => setWeekSlideDir(null), 220)
	    return () => window.clearTimeout(timer)
	  }, [view, weekSlideDir])

	  const editStatusMeta = editForm
	    ? (editForm.display_state?.status_label && editForm.display_state?.status_tone
	      ? { label: editForm.display_state.status_label, tone: editForm.display_state.status_tone }
	      : taskStatusMeta(editForm.status))
	    : taskStatusMeta(null)
	  const editScopeBadge = editForm ? displayScopeForItem(editForm as any) : null
	  const editDisplayBadges = editForm ? displayBadgesForItem(editForm as any) : []
	  const editSaveGate = editForm ? managementGateForItem(editForm, 'edit_task') : { enabled: true, disabledReason: '' }
	  const editTaskDateGate = editForm ? editableFieldGateForItem(editForm, 'task_date', 'edit_task') : { enabled: true, disabledReason: '' }
	  const editStatusGate = editForm ? editableFieldGateForItem(editForm, 'status', 'update_status') : { enabled: true, disabledReason: '' }
	  const editCleanerGate = editForm ? editableFieldGateForItem(editForm, 'cleaner_id', 'assign_cleaner') : { enabled: true, disabledReason: '' }
	  const editInspectorGate = editForm ? editableFieldGateForItem(editForm, 'inspector_id', 'assign_inspector') : { enabled: true, disabledReason: '' }
	  const editExecutorGate = editForm ? editableFieldGateForItem(editForm, 'assignee_id', 'assign_executor') : { enabled: true, disabledReason: '' }
	  const editDetailsGate = editForm ? editableFieldGateForItem(editForm, 'details', 'edit_task') : { enabled: true, disabledReason: '' }
	  const editDeleteGate = editForm ? editableFieldGateForItem(editForm, 'delete', 'cancel_task') : { enabled: true, disabledReason: '' }
	  const editAddCheckoutGate = editForm ? editableFieldGateForItem(editForm, 'add_checkout', 'add_checkout') : { enabled: true, disabledReason: '' }
	  const editAddCheckinGate = editForm ? editableFieldGateForItem(editForm, 'add_checkin', 'add_checkin') : { enabled: true, disabledReason: '' }
	  const editSaveDisabledReason = disabledReasonText(editSaveGate.disabledReason)
	  const editTaskDateDisabledReason = disabledReasonText(editTaskDateGate.disabledReason)
	  const editStatusDisabledReason = disabledReasonText(editStatusGate.disabledReason)
	  const editCleanerDisabledReason = disabledReasonText(editCleanerGate.disabledReason)
	  const editInspectorDisabledReason = disabledReasonText(editInspectorGate.disabledReason)
	  const editExecutorDisabledReason = disabledReasonText(editExecutorGate.disabledReason)
	  const editDetailsDisabledReason = disabledReasonText(editDetailsGate.disabledReason)
	  const editDeleteDisabledReason = disabledReasonText(editDeleteGate.disabledReason)
	  const editAddCheckoutDisabledReason = disabledReasonText(editAddCheckoutGate.disabledReason)
	  const editAddCheckinDisabledReason = disabledReasonText(editAddCheckinGate.disabledReason)

	  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {error ? <Alert type="error" showIcon message="清洁日历数据加载失败" description={error} /> : null}
        {dbStatus && dbStatus.pg === false ? <Alert type="warning" showIcon message="后端未连接数据库" description={String(dbStatus.pg_error || 'pg=false')} /> : null}

        <div className={`${styles.card} ${styles.headerCard}`}>
          <div className={styles.navGroup}>
            <Button className={styles.navBtn} icon={<LeftOutlined />} onClick={goPrev} />
            <div className={styles.monthTitle}>{monthLabel}</div>
            <Button className={styles.navBtn} icon={<RightOutlined />} onClick={goNext} />
            <Button
              className={styles.todayBtn}
              title={`回到今天（${dayjs().format('YYYY-MM-DD')}）`}
              onClick={() => { setSelectedDate(dayjs()); setMonth(dayjs()); }}
            >
              回到今天
            </Button>
          </div>
          <div className={styles.rightGroup}>
            <Segmented
              className={styles.viewSegment}
              options={[
                { label: '日', value: 'day' },
                { label: '周', value: 'week' },
                { label: '月', value: 'month' },
              ]}
              value={view}
              onChange={(v) => setView(v as any)}
            />
            <Button className={styles.secondaryBtn} icon={<ReloadOutlined />} onClick={() => loadRangeItems().catch(() => {})} loading={loading}>
              刷新
            </Button>
            <Button className={styles.primaryBtn} onClick={openManualCreate}>
              新增清洁任务
            </Button>
            <Button className={styles.primaryBtn} onClick={openOfflineCreate}>
              新增线下任务
            </Button>
            <Button className={styles.primaryBtn} onClick={() => setBackfillOpen(true)}>
              Backfill
            </Button>
            <Button className={styles.secondaryBtn} onClick={() => openDebug().catch(() => {})} loading={debugLoading}>
              调试
            </Button>
          </div>
        </div>

        {showDevDebugInfo ? (
          <>
            {API_BASE ? <Alert type="info" showIcon message={`API_BASE=${API_BASE}`} /> : <Alert type="warning" showIcon message="NEXT_PUBLIC_API_BASE_URL 未设置" />}
            {tasksMinMaxError ? <Alert type="warning" showIcon message="任务范围查询失败" description={tasksMinMaxError} /> : null}
            {tasksMinMax?.min || tasksMinMax?.max ? <Alert type="info" showIcon message={`任务范围：${tasksMinMax.min || '-'} ～ ${tasksMinMax.max || '-'}`} /> : null}
          </>
        ) : null}

        <div className={`${styles.card} ${styles.calendarCard}`}>
          <div className={view === 'week' ? styles.weekLayout : undefined}>
            {view === 'week' ? <div className={styles.weekSpacer} aria-hidden="true" /> : null}
            <div className={styles.weekHeader}>
              {['日', '一', '二', '三', '四', '五', '六'].map((w) => <div key={w}>{w}</div>)}
            </div>
            {view === 'week' ? <div className={styles.weekSpacer} aria-hidden="true" /> : null}
            {view === 'week' ? (
              <button
                type="button"
                className={`${styles.weekEdgeNav} ${styles.weekEdgeNavLeft}`}
                title="查看上周"
                aria-label="查看上周"
                onClick={goPrev}
              >
                <LeftOutlined />
              </button>
            ) : null}
            <div className={`${styles.calendarMain} ${view === 'week' && weekSlideDir ? (weekSlideDir === 'prev' ? styles.weekSlidePrev : styles.weekSlideNext) : ''}`}>
              <div className={styles.grid} aria-label="清洁日历">
                {days.map((d) => {
              const dateStr = d.format('YYYY-MM-DD')
              const inMonth = view !== 'month' ? true : d.month() === month.month()
              const isSelected = dateStr === selectedDateStr
              const arr = itemsByDate.get(dateStr) || []
              return (
                <div
                  key={dateStr}
                  className={`${styles.cell} ${inMonth ? '' : styles.cellMuted} ${isSelected ? styles.cellActive : ''}`}
                  onClick={() => {
                    setSelectedDate(d)
                    if (view === 'month' && d.month() !== month.month()) setMonth(d.startOf('month'))
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className={styles.dayNum}>{d.date()}</div>
                  <div className={styles.pills}>
                    {arr.slice(0, 3).map((it) => {
                      const k = itemKind(it)
                      const pillCls =
                        k === 'unassigned'
                          ? styles.pillUnassigned
                          : k === 'checkin'
                            ? styles.pillCheckin
                            : k === 'combined'
                              ? styles.pillCombined
                              : styles.pillCheckout
                      const room = propertyLabelForItem(it) || '-'
                      const title = `${room} ${it.label}`.trim()
                      const bg = cleanerColorOf(it)
                      const fg = isDarkBg(bg) ? '#ffffff' : '#0f172a'
                      return (
                        <div
                          key={`${it.source}:${it.entity_id}`}
                          className={`${styles.pill} ${pillCls}`}
                          title={title}
                          style={{ backgroundColor: bg, color: fg }}
                        >
                          {title}
                        </div>
                      )
                    })}
                    {arr.length > 3 ? (
                      <div className={`${styles.pill} ${styles.pillCombined}`}>+{arr.length - 3}</div>
                    ) : null}
                  </div>
                </div>
              )
                })}
              </div>
            </div>
            {view === 'week' ? (
              <button
                type="button"
                className={`${styles.weekEdgeNav} ${styles.weekEdgeNavRight}`}
                title="查看下周"
                aria-label="查看下周"
                onClick={goNext}
              >
                <RightOutlined />
              </button>
            ) : null}
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.detailsHead}>
            <div className={styles.detailsIntro}>
              <div className={styles.detailsTitle}>当日任务</div>
              <div className={styles.detailsDate}>{selectedDateStr}</div>
              <Segmented
                className={styles.taskListTabs}
                value={taskListTab}
                onChange={(v) => setTaskListTab(v as 'cleaning' | 'inspection' | 'offline')}
                options={taskTabOptions}
              />
            </div>
            <div className={styles.filters}>
              <Input
                value={filterRoom}
                onChange={(e) => setFilterRoom(e.target.value)}
                placeholder="筛选房源（code/id）"
                style={{ width: 220 }}
                allowClear
              />
              <Select
                value={filterCleaner}
                onChange={(v) => setFilterCleaner(v)}
                placeholder={taskListTab === 'offline' ? '筛选指派人' : taskListTab === 'inspection' ? '筛选检查/执行' : '筛选清洁'}
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: 180 }}
                options={taskListTab === 'offline' ? allStaffOptions : taskListTab === 'inspection' ? allStaffOptions : cleanerOptions}
              />
              {taskListTab === 'cleaning' ? (
                <Select
                  value={filterInspector}
                  onChange={(v) => setFilterInspector(v)}
                  placeholder="筛选检查"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  style={{ width: 180 }}
                  options={inspectorOptions}
                />
              ) : <div className={styles.filterSlot} />}
              <Select
                value={filterStatus}
                onChange={(v) => setFilterStatus(v)}
                placeholder="筛选状态"
                allowClear
                style={{ width: 180 }}
                options={taskStatusOptions}
              />
              {taskListTab === 'cleaning' ? (
                <Button
                  className={styles.secondaryBtn}
                  onClick={() => {
                    setBulkMode((v) => !v)
                    setSelectedTaskIds([])
                  }}
                >
                  {bulkMode ? '退出批量' : '批量操作'}
                </Button>
              ) : null}
              {taskListTab === 'cleaning' && bulkMode ? (
                <>
                  <Button className={styles.secondaryBtn} onClick={openBulkEdit} disabled={!selectedTaskIds.length}>
                    批量编辑（{selectedTaskIds.length}）
                  </Button>
                  <Button
                    danger
                    className={styles.secondaryBtn}
                    disabled={!selectedTaskIds.length}
                    onClick={() => {
                      Modal.confirm({
                        title: '确认删除所选任务？',
                        content: `将删除 ${selectedTaskIds.length} 个任务（会标记为 cancelled 并从列表移除）`,
                        okText: '删除',
                        okButtonProps: { danger: true },
                        onOk: () => deleteTasks(selectedTaskIds).catch((e) => message.error(e?.message || '删除失败')),
                      })
                    }}
                  >
                    批量删除
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          <div className={styles.missionList}>
              {loading ? (
                <>
                  <div className={styles.missionCard}><Skeleton active paragraph={{ rows: 2 }} /></div>
                  <div className={styles.missionCard}><Skeleton active paragraph={{ rows: 2 }} /></div>
                </>
            ) : selectedList.length ? selectedList.map((it) => {
              if (it.source === 'offline_tasks') {
                const room = propertyLabelForItem(it) || '-'
                const region = String(it.property_region || '').trim()
	                const detail = String(it.content || '').trim()
	                const typeLabel = offlineTaskTypeText(it.task_type)
	                const urgencyLabel = urgencyText(it.urgency)
	                const photoUrls = normalizeTaskPhotoUrls(it.photo_urls)
	                const statusMeta = displayStatusMetaForItem(it)
	                const scopeBadge = displayScopeForItem(it)
	                const executorGate = editableFieldGateForItem(it, 'assignee_id', 'assign_executor')
	                const statusGate = editableFieldGateForItem(it, 'status', 'update_status')
	                const executorDisabledReason = disabledReasonText(executorGate.disabledReason)
	                const statusDisabledReason = disabledReasonText(statusGate.disabledReason)
	                return (
	                  <div key={`${it.source}:${it.entity_id}`} className={styles.missionCard}>
                    <div className={`${styles.accent} ${styles.accentUnassigned}`} style={{ backgroundColor: stripeColorForUrgency(String(it.urgency || 'medium')) }} />
                    <div className={styles.missionTop}>
                      <div className={styles.headerLeft}>
	                        <span className={`${styles.statusChip} ${semanticToneClass(statusMeta.tone)}`}>{statusMeta.label}</span>
                        <div className={styles.headerTitle}>
                          {region ? <span className={styles.headerRegion}>{region}</span> : null}
                          {it.property_id ? <span className={styles.headerCode}>{room}</span> : null}
                          <span className={styles.headerDetail}>{String(it.label || '线下任务')}</span>
                        </div>
                      </div>
                      <div className={styles.taskActions}>
                        <Button className={`${styles.taskBtn} ${styles.taskBtnGhost}`} size="small" icon={<EditOutlined />} title="编辑" aria-label="编辑" onClick={() => openOfflineEdit(it)} />
                        <Button
                          className={`${styles.taskBtn} ${styles.taskBtnDanger}`}
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          title="删除"
                          aria-label="删除"
                          onClick={() => {
                            Modal.confirm({
                              title: '确认删除线下任务？',
                              content: '删除后会同步从任务安排中移除。',
                              okText: '删除',
                              okButtonProps: { danger: true },
                              onOk: () => deleteOfflineTask(String(it.entity_id || '')).catch((e) => message.error(e?.message || '删除失败')),
                            })
                          }}
                        />
                      </div>
                    </div>
	                    <div className={styles.metaRow}>
	                      {scopeBadge ? <span className={`${styles.metaChip} ${semanticToneClass(scopeBadge.tone || 'normal')}`}>{scopeBadge.label}</span> : null}
	                      <span className={styles.metaText}><span className={styles.metaKey}>类型</span>{typeLabel}</span>
                      <span className={styles.metaText}><span className={styles.metaKey}>紧急度</span>{urgencyLabel}</span>
                      <span className={styles.metaText}><span className={styles.metaKey}>指派</span>{staffNameById(it.assignee_id || null)}</span>
                    </div>
                    <div className={styles.metaRow}>
                      <span className={styles.metaText}>{detail || '暂无任务详情'}</span>
                    </div>
                    {photoUrls.length ? (
                      <div className={styles.metaRow}>
                        <span className={styles.metaText}><PictureOutlined /> 照片 {photoUrls.length} 张</span>
                        <Space size={6} wrap>
                          {photoUrls.slice(0, 4).map((url, index) => (
                            <Image
                              key={`${url}:${index}`}
                              src={displayPhotoUrl(url)}
                              alt={`线下任务照片 ${index + 1}`}
                              width={44}
                              height={44}
                              style={{ objectFit: 'cover', borderRadius: 6, border: '1px solid #E5E7EB' }}
                            />
                          ))}
                        </Space>
                      </div>
                    ) : null}
                    <div className={styles.controlsRow}>
                      <div className={styles.assigneeGroup}>
                        <div className={styles.assigneeLabel}>指派人</div>
                        <Select
                          className={styles.assigneeSelect}
                          allowClear
                          showSearch
                          optionFilterProp="label"
	                          value={it.assignee_id || undefined}
	                          options={allStaffOptions}
	                          disabled={!executorGate.enabled}
	                          title={executorDisabledReason || undefined}
	                          onChange={(v) => patchJSON(`/cleaning/offline-tasks/${encodeURIComponent(String(it.entity_id || ''))}`, { assignee_id: v ? String(v) : null })
                            .then(() => {
                              message.success('已更新指派人')
                              loadRangeItems().catch(() => {})
                            })
                            .catch((e) => message.error(e?.message || '更新失败'))}
                          placeholder={staffNameById(it.assignee_id || null)}
                        />
                      </div>
                      <div className={styles.assigneeGroup}>
                        <div className={styles.assigneeLabel}>状态</div>
                        <Select
	                          className={styles.assigneeSelect}
	                          value={String(it.status || 'todo')}
	                          options={offlineStatusOptions}
	                          disabled={!statusGate.enabled}
	                          title={statusDisabledReason || undefined}
	                          onChange={(v) => patchJSON(`/cleaning/offline-tasks/${encodeURIComponent(String(it.entity_id || ''))}`, { status: v })
                            .then(() => {
                              message.success('已更新状态')
                              loadRangeItems().catch(() => {})
                            })
                            .catch((e) => message.error(e?.message || '更新失败'))}
                        />
                      </div>
                      <div className={styles.assigneeGroup}>
                        <div className={styles.assigneeLabel}>紧急度</div>
                        <Select
                          className={styles.assigneeSelect}
                          value={String(it.urgency || 'medium')}
                          options={urgencyOptions}
                          onChange={(v) => patchJSON(`/cleaning/offline-tasks/${encodeURIComponent(String(it.entity_id || ''))}`, { urgency: v })
                            .then(() => {
                              message.success('已更新紧急度')
                              loadRangeItems().catch(() => {})
                            })
                            .catch((e) => message.error(e?.message || '更新失败'))}
                        />
                      </div>
                    </div>
                  </div>
                )
              }
              const kind = itemKind(it)
              const room = propertyLabelForItem(it) || '-'
              const sum = summaryText(it)
              const accentCls =
                kind === 'unassigned' ? styles.accentUnassigned : kind === 'checkout' ? styles.accentCheckout : kind === 'combined' ? styles.accentCombined : ''
              const accentColor = cleanerColorOf(it)
              const isMerged = Array.isArray(it.entity_ids) && it.entity_ids.length > 1
              const ids = entityIds(it)
              const selectChecked = it.source === 'cleaning_tasks' && ids.length > 0 && ids.every((x) => selectedSet.has(String(x)))
              const selectIndeterminate = it.source === 'cleaning_tasks' && !selectChecked && ids.some((x) => selectedSet.has(String(x)))
              const orderDisplay = (id: string | null | undefined, code: string | null | undefined) => {
                const v = String(code || id || '').trim()
                return v ? v : '-'
              }
              const isTurnover = String(it.task_type || '').toLowerCase() === 'turnover' || (String(it.label || '').includes('退房') && String(it.label || '').includes('入住'))
              const hasCheckinSide = isTurnover || isPureCheckinInspectionItem(it)
              const hasCheckoutSide = isTurnover || String(it.task_type || '').toLowerCase() === 'checkout_clean' || String(it.label || '').includes('退房')
              const checkoutCode = isTurnover ? orderDisplay(it.checkout_order_id, it.checkout_order_code) : orderDisplay(it.order_id, it.order_code)
              const checkinCode = orderDisplay(it.checkin_order_id, it.checkin_order_code)
              const checkoutPwd = String(isTurnover ? (it.checkout_old_code ?? it.old_code ?? '') : (it.old_code ?? '')).trim()
              const checkinPwd = String(isTurnover ? (it.checkin_new_code ?? it.new_code ?? '') : (it.new_code ?? '')).trim()
              const isCheckinOnly = !isTurnover && isPureCheckinInspectionItem(it)
              const checkoutTiming = hasCheckoutSide ? checkoutTimingLabel(it.summary_checkout_time) : null
              const checkinTiming = hasCheckinSide ? checkinTimingLabel(it.summary_checkin_time) : null
              const primaryOrderLabel = isCheckinOnly ? '入住' : '退房'
              const primaryPasswordLabel = isCheckinOnly ? '入住密码' : '退房密码'
              const primaryPassword = isCheckinOnly ? checkinPwd : checkoutPwd
              const isKeyHandover = isCheckinKeyHandoverItem(it)
              const isCheckinSiteExecution = isCheckinOnly
	              const hasKeyUploadAssignee = !!String(isKeyHandover
	                ? (it.assignee_id || it.inspector_id)
	                : isCheckinOnly
	                ? (it.assignee_id || it.inspector_id)
	                : (it.inspector_id || it.cleaner_id || it.assignee_id)).trim()
	              const isKeyUploaded = !!(it.has_key_photo || it.key_photo_uploaded_at)
	              const showKeyMissing = it.source === 'cleaning_tasks' && hasKeyUploadAssignee && !isKeyUploaded && String(it.status || '').toLowerCase() !== 'cancelled'
	              const syncTag = checkinSyncTag(it)
	              const statusMeta = displayStatusMetaForItem(it)
	              const scopeBadge = displayScopeForItem(it)
	              const displayBadges = visibleDailyDisplayBadges(displayBadgesForItem(it), [statusMeta.label, scopeBadge?.label])
	              const editGate = managementGateForItem(it, 'edit_task')
	              const deleteGate = editableFieldGateForItem(it, 'delete', 'cancel_task')
	              const cleanerGate = editableFieldGateForItem(it, 'cleaner_id', 'assign_cleaner')
	              const inspectorGate = editableFieldGateForItem(it, 'inspector_id', 'assign_inspector')
	              const executorGate = editableFieldGateForItem(it, 'assignee_id', 'assign_executor')
	              const statusGate = editableFieldGateForItem(it, 'status', 'update_status')
	              const cleanerTargetIds = editableEntityIds(ids, 'cleaner_id', 'assign_cleaner')
	              const inspectorTargetIds = editableEntityIds(ids, 'inspector_id', 'assign_inspector')
	              const executorTargetIds = editableEntityIds(ids, 'assignee_id', 'assign_executor')
	              const editDisabledReason = disabledReasonText(editGate.disabledReason)
	              const deleteDisabledReason = disabledReasonText(deleteGate.disabledReason)
	              const cleanerDisabledReason = disabledReasonText(cleanerGate.disabledReason)
	              const inspectorDisabledReason = disabledReasonText(inspectorGate.disabledReason)
	              const executorDisabledReason = disabledReasonText(executorGate.disabledReason)
	              const statusDisabledReason = disabledReasonText(statusGate.disabledReason)
	              const legacyLocked = !hasTaskCapability(it) && it.auto_sync_enabled === false
	              return (
                <div key={`${it.source}:${it.entity_id}`} className={styles.missionCard}>
                  <div className={`${styles.accent} ${accentCls}`} style={{ backgroundColor: accentColor }} />
                  <div className={styles.missionTop}>
                    <div className={styles.headerLeft}>
                      {bulkMode && it.source === 'cleaning_tasks' ? (
                        <Checkbox
                          checked={selectChecked}
                          indeterminate={selectIndeterminate}
                          onChange={(e) => toggleSelectItem(it, e.target.checked)}
                        />
                      ) : null}
	                      <span className={`${styles.statusChip} ${semanticToneClass(statusMeta.tone)}`}>{statusMeta.label}</span>
                      <div className={styles.headerTitle}>
                        {sum.region ? <span className={styles.headerRegion}>{sum.region}</span> : null}
                        <span className={styles.headerCode}>{sum.code || room}</span>
                        {sum.detail ? <span className={styles.headerDetail}>{sum.detail}</span> : null}
                      </div>
                    </div>
                    {it.source === 'cleaning_tasks' ? (
                      <div className={styles.taskActions}>
	                        <Button
	                          className={`${styles.taskBtn} ${styles.taskBtnGhost}`}
	                          size="small"
	                          icon={<EditOutlined />}
	                          title={editDisabledReason || '编辑'}
	                          aria-label="编辑"
	                          disabled={!editGate.enabled}
	                          onClick={() => openEdit(it).catch((e) => message.error(e?.message || '打开失败'))}
	                        />
	                        <Button
                          className={`${styles.taskBtn} ${styles.taskBtnDanger}`}
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
	                          title={deleteDisabledReason || '删除'}
	                          aria-label="删除"
	                          disabled={!deleteGate.enabled}
	                          onClick={() => {
                            Modal.confirm({
                              title: '确认删除任务？',
                              content: isMerged ? `将删除 ${ids.length} 个任务（会标记为 cancelled 并从列表移除）` : '将删除该任务（会标记为 cancelled 并从列表移除）',
                              okText: '删除',
                              okButtonProps: { danger: true },
                              onOk: () => deleteTasks(ids).catch((e) => message.error(e?.message || '删除失败')),
                            })
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                  <div className={styles.metaRow}>
	                    {it.nights != null ? <span className={`${styles.metaChip} ${semanticToneClass('neutral')}`}>{`${it.nights}晚`}</span> : null}
	                    {syncTag ? <span className={`${styles.metaChip} ${semanticToneClass(syncTag.tone)}`}>{syncTag.label}</span> : null}
	                    {scopeBadge ? <span className={`${styles.metaChip} ${semanticToneClass(scopeBadge.tone || 'normal')}`}>{scopeBadge.label}</span> : null}
	                    {displayBadges.map((badge) => (
	                      <span key={`${it.entity_id}:display:${badge.id}`} className={`${styles.metaChip} ${semanticToneClass(badge.tone)}`}>{badge.label}</span>
	                    ))}
	                    {checkoutTiming ? <span className={`${styles.metaChip} ${semanticToneClass(taskTimingTone(checkoutTiming))}`}>{checkoutTiming}</span> : null}
	                    {checkinTiming ? <span className={`${styles.metaChip} ${semanticToneClass(taskTimingTone(checkinTiming))}`}>{checkinTiming}</span> : null}
                    {showKeyMissing ? <span className={`${styles.metaChip} ${semanticToneClass('danger')}`}>钥匙未上传</span> : null}
                    {checkoutCode !== '-' ? <span className={styles.metaText}><span className={styles.metaKey}>{primaryOrderLabel}</span>{checkoutCode}</span> : null}
                    {isTurnover && checkinCode !== '-' ? <span className={styles.metaText}><span className={styles.metaKey}>入住</span>{checkinCode}</span> : null}
                    <span className={styles.metaText}><span className={styles.metaKey}>{primaryPasswordLabel}</span>{primaryPassword || '-'}</span>
                    {isTurnover ? <span className={styles.metaText}><span className={styles.metaKey}>入住密码</span>{checkinPwd || '-'}</span> : null}
                  </div>
                  <div className={styles.controlsRow}>
                    {it.source === 'cleaning_tasks' ? (
                      <>
                        {isKeyHandover || isCheckinSiteExecution ? (
                          <div className={styles.assigneeGroup}>
                            <div className={styles.assigneeLabel}>执行</div>
                            <Select
	                              className={styles.assigneeSelect}
	                              allowClear
	                              showSearch
	                              optionFilterProp="label"
	                              disabled={bulkMode || legacyLocked || !executorGate.enabled || !executorTargetIds.length}
	                              title={executorDisabledReason || undefined}
                              value={(it.assignee_id || it.inspector_id) || undefined}
                              options={allStaffOptions}
                              onChange={(v) => updateTaskQuick(executorTargetIds, {
                                assignee_id: v ? String(v) : null,
                                cleaner_id: null,
                                inspector_id: null,
                                inspection_scope: isKeyHandover ? 'password_only' : 'inspect_and_hang',
                              }).catch((e) => message.error(e?.message || '更新失败'))}
                              placeholder={staffNameById((it.assignee_id || it.inspector_id) || null)}
                            />
                          </div>
                        ) : (
                          <>
                            <div className={styles.assigneeGroup}>
                              <div className={styles.assigneeLabel}>清洁</div>
                              <Select
                                className={styles.assigneeSelect}
                                allowClear
                                showSearch
                                optionFilterProp="label"
	                                disabled={bulkMode || legacyLocked || !cleanerGate.enabled || !cleanerTargetIds.length}
	                                title={cleanerDisabledReason || undefined}
                                value={(it.cleaner_id || it.assignee_id) || undefined}
                                options={cleanerOptions}
                                onChange={(v) => updateTaskQuick(cleanerTargetIds, { cleaner_id: v ? String(v) : null }).catch((e) => message.error(e?.message || '更新失败'))}
                                placeholder={staffNameById((it.cleaner_id || it.assignee_id) || null)}
                              />
                            </div>
                            <div className={styles.assigneeGroup}>
                              <div className={styles.assigneeLabel}>检查</div>
                              <Select
                                className={styles.assigneeSelect}
                                allowClear
                                showSearch
                                optionFilterProp="label"
	                                disabled={bulkMode || legacyLocked || !inspectorGate.enabled || !inspectorTargetIds.length}
	                                title={inspectorDisabledReason || undefined}
                                value={it.inspector_id || undefined}
                                options={inspectorOptions}
                                onChange={(v) => updateTaskQuick(inspectorTargetIds, { inspector_id: v ? String(v) : null }).catch((e) => message.error(e?.message || '更新失败'))}
                                placeholder={staffNameById(it.inspector_id || null)}
                              />
                            </div>
                          </>
                        )}
                        <div className={styles.assigneeGroup}>
                          <div className={styles.assigneeLabel}>状态</div>
                          <Select
                            className={styles.assigneeSelect}
	                            disabled={bulkMode || legacyLocked || !statusGate.enabled}
	                            title={statusDisabledReason || undefined}
                            value={String(it.status || 'pending')}
                            options={statusOptions}
                            onChange={(v) => updateTaskQuick(ids, { status: v }).catch((e) => message.error(e?.message || '更新失败'))}
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              )
            }) : (
              <div className={styles.missionCard}>
                <Empty description="当日无任务" />
              </div>
            )}
            </div>
          </div>
        </div>

      <Drawer
        open={editOpen}
        title="编辑清洁任务"
        width={860}
        placement="right"
        className={styles.cleaningEditDrawer}
        onClose={() => { setEditOpen(false); setEditForm(null) }}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Space>
              <Button onClick={() => { setEditOpen(false); setEditForm(null) }}>取消</Button>
	              <Button
	                type="primary"
	                disabled={!editSaveGate.enabled}
	                title={editSaveDisabledReason || undefined}
	                onClick={() => submitEdit().catch((e) => message.error(e?.message || '保存失败'))}
	              >
	                保存
	              </Button>
            </Space>
          </div>
        }
      >
        {editForm ? (
          <Form layout="vertical" className={styles.cleaningEditForm}>
            <div className={styles.cleaningEditHero}>
              <div className={styles.cleaningEditHeroMain}>
                <div className={styles.cleaningEditHeroEyebrow}>任务摘要</div>
                <div className={styles.cleaningEditHeroTitle}>{editTaskHeadline(editForm)}</div>
                <div className={styles.cleaningEditHeroMeta}>
                  <span>{editForm.task_date.format('YYYY-MM-DD')}</span>
                  <span>{editModeText(editForm)}</span>
                  {editForm.mode !== 'stayover' && editForm.checkin_task_date && !editForm.checkin_task_date.isSame(editForm.task_date, 'day') ? (
                    <span>入住已改到 {editForm.checkin_task_date.format('YYYY-MM-DD')}</span>
                  ) : null}
                </div>
              </div>
              <div className={styles.cleaningEditHeroChips}>
	                <span className={`${styles.cleaningEditChip} ${semanticToneClass(editStatusMeta.tone)}`}>{editStatusMeta.label}</span>
	                {editScopeBadge ? <span className={`${styles.cleaningEditChip} ${semanticToneClass(editScopeBadge.tone || 'normal')}`}>{editScopeBadge.label}</span> : null}
	                {editDisplayBadges.map((badge) => (
	                  <span key={`edit:display:${badge.id}`} className={`${styles.cleaningEditChip} ${semanticToneClass(badge.tone)}`}>{badge.label}</span>
	                ))}
                {editForm.checkin_sync_status === 'pending' ? <span className={`${styles.cleaningEditChip} ${semanticToneClass('pending')}`}>待同步</span> : null}
                {editForm.checkin_sync_status === 'synced' ? <span className={`${styles.cleaningEditChip} ${semanticToneClass('success')}`}>已同步</span> : null}
                {!editForm.auto_sync_enabled ? <span className={`${styles.cleaningEditChip} ${semanticToneClass('pending')}`}>自动同步已锁定</span> : null}
                {editForm.mode === 'stayover' ? <span className={`${styles.cleaningEditChip} ${semanticToneClass('neutral')}`}>仅清洁安排</span> : null}
              </div>
            </div>

            <div className={styles.cleaningEditSection}>
              <div className={styles.cleaningEditSectionHead}>
                <div>
                  <div className={styles.cleaningEditSectionTitle}>基础信息</div>
                  <div className={styles.cleaningEditSectionHint}>先确认日期、状态和执行人员，下面再处理退房或入住细节。</div>
                </div>
              </div>
              <Row gutter={[16, 16]}>
                <Col xs={24} md={12} lg={8}>
                  <Form.Item label="清洁日期">
	                    <DatePicker
	                      value={editForm.task_date}
	                      disabled={!editTaskDateGate.enabled}
	                      title={editTaskDateDisabledReason || undefined}
	                      onChange={(v) => v && setEditForm((p) => (p ? { ...p, task_date: v } : p))}
	                      style={{ width: '100%' }}
	                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12} lg={8}>
                  <Form.Item label="状态">
	                    <Select
	                      value={editForm.status}
	                      disabled={!editStatusGate.enabled}
	                      title={editStatusDisabledReason || undefined}
	                      onChange={(v) => setEditForm((p) => (p ? { ...p, status: v } : p))}
	                      style={{ width: '100%' }}
	                      options={statusOptions}
	                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={editForm.mode === 'default' && editForm.checkin_ids.length > 0 && editForm.checkout_ids.length === 0 ? '执行人' : '清洁人员'}>
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
	                      value={editForm.cleaner_id || undefined}
	                      disabled={editForm.mode === 'default' && editForm.checkin_ids.length > 0 && editForm.checkout_ids.length === 0 ? !editExecutorGate.enabled : !editCleanerGate.enabled}
	                      title={(editForm.mode === 'default' && editForm.checkin_ids.length > 0 && editForm.checkout_ids.length === 0 ? editExecutorDisabledReason : editCleanerDisabledReason) || undefined}
	                      onChange={(v) => setEditForm((p) => (p ? { ...p, cleaner_id: v ? String(v) : null } : p))}
                      style={{ width: '100%' }}
                      options={editForm.mode === 'default' && editForm.checkin_ids.length > 0 && editForm.checkout_ids.length === 0 ? allStaffOptions : cleanerOptions}
                    />
                  </Form.Item>
                </Col>
                {editForm.mode === 'default' && editForm.checkin_ids.length > 0 && editForm.checkout_ids.length === 0 ? null : (
                  <Col xs={24} md={12}>
                    <Form.Item label="检查人员">
                      <Select
                        allowClear
                        showSearch
	                        optionFilterProp="label"
	                        value={editForm.inspector_id || undefined}
	                        disabled={!editInspectorGate.enabled}
	                        title={editInspectorDisabledReason || undefined}
	                        onChange={(v) => setEditForm((p) => (p ? { ...p, inspector_id: v ? String(v) : null } : p))}
                        style={{ width: '100%' }}
                        options={inspectorOptions}
                      />
                    </Form.Item>
                  </Col>
                )}
                {editForm.mode === 'stayover' ? (
                  <Col xs={24} md={12}>
                    <Form.Item label="清洁时间">
                      <Select
                        allowClear
                        showSearch
	                        optionFilterProp="label"
	                        value={editForm.checkin_time || undefined}
	                        disabled={!editDetailsGate.enabled}
	                        title={editDetailsDisabledReason || undefined}
	                        onChange={(v) => setEditForm((p) => (p ? { ...p, checkin_time: String(v || '') } : p))}
                        style={{ width: '100%' }}
                        options={timeOptions}
                      />
                    </Form.Item>
                  </Col>
                ) : null}
              </Row>
            </div>

            {editForm.mode !== 'stayover' ? (
              <>
                <div className={styles.cleaningEditSection}>
                  <div className={styles.cleaningEditSectionHead}>
                    <div>
                      <div className={styles.cleaningEditSectionTitle}>退房安排</div>
                      <div className={styles.cleaningEditSectionHint}>
                        {editForm.checkout_ids.length ? `当前已有 ${editForm.checkout_ids.length} 个退房任务。` : '当前没有退房任务。'}
                        {editForm.pending_add_checkout ? ' 保存后会新增退房。' : ''}
                      </div>
                    </div>
                    <div className={styles.cleaningEditSectionActions}>
                      {editForm.checkout_ids.length ? (
	                        <Button
	                          danger
	                          disabled={!editDeleteGate.enabled}
	                          title={editDeleteDisabledReason || undefined}
	                          onClick={() => {
                            Modal.confirm({
                              title: '确认取消退房任务？',
                              content: `将取消 ${editForm.checkout_ids.length} 个退房任务`,
                              okText: '取消退房',
                              okButtonProps: { danger: true },
                              onOk: () => cancelTasksInEdit(editForm.checkout_ids, '退房').catch((e) => message.error(e?.message || '取消失败')),
                            })
                          }}
                        >
                          取消退房
                        </Button>
                      ) : (
                        <Button
	                          disabled={(!editForm.can_add_checkout && !editForm.pending_add_checkout) || !editAddCheckoutGate.enabled}
	                          title={editAddCheckoutDisabledReason || undefined}
                          onClick={() =>
                            setEditForm((p) => {
                              if (!p) return p
                              const next = !p.pending_add_checkout
                              if (!next) return { ...p, pending_add_checkout: false, checkout_password: '', checkout_time: '10am' }
                              return { ...p, pending_add_checkout: true, checkout_time: p.checkout_time || '10am' }
                            })
                          }
                        >
                          {editForm.pending_add_checkout ? '取消新增退房' : '新增退房'}
                        </Button>
                      )}
                    </div>
                  </div>
                  {editForm.pending_add_checkout ? (
                    <Alert type="info" showIcon message="保存时将新增退房任务" className={styles.cleaningEditAlert} />
                  ) : null}
                  {!editForm.property_id ? (
                    <Alert type="warning" showIcon message="该任务缺少 property_id，无法新增退房/入住" className={styles.cleaningEditAlert} />
                  ) : null}
                  <Row gutter={[16, 16]}>
                    <Col xs={24} md={12}>
                      <Form.Item label="退房密码（旧密码）">
	                        <Input
	                          value={editForm.checkout_password}
	                          disabled={!editDetailsGate.enabled}
	                          title={editDetailsDisabledReason || undefined}
	                          onChange={(e) => setEditForm((p) => (p ? { ...p, checkout_password: e.target.value } : p))}
	                          placeholder="退房密码"
	                        />
                      </Form.Item>
                    </Col>
                    {editForm.checkout_ids.length || editForm.pending_add_checkout ? (
                      <Col xs={24} md={12}>
                        <Form.Item label="退房时间">
                          <Select
                            allowClear
                            showSearch
	                            optionFilterProp="label"
	                            value={editForm.checkout_time || undefined}
	                            disabled={!editDetailsGate.enabled}
	                            title={editDetailsDisabledReason || undefined}
	                            onChange={(v) => setEditForm((p) => (p ? { ...p, checkout_time: String(v || '') } : p))}
                            style={{ width: '100%' }}
                            options={timeOptions}
                          />
                        </Form.Item>
                      </Col>
                    ) : null}
                    <Col xs={24} md={12}>
                      <Form.Item label="需确认已退钥匙套数">
                        <Select
	                          value={editForm.keys_required_checkout}
	                          disabled={!editDetailsGate.enabled}
	                          title={editDetailsDisabledReason || undefined}
	                          onChange={(v) => setEditForm((p) => (p ? { ...p, keys_required_checkout: (Number(v) >= 2 ? 2 : 1) } : p))}
                          style={{ width: '100%' }}
                          options={[
                            { label: '1 套', value: 1 },
                            { label: '2 套', value: 2 },
                          ]}
                        />
                      </Form.Item>
                    </Col>
                  </Row>
                </div>

                <div className={styles.cleaningEditSection}>
                  <div className={styles.cleaningEditSectionHead}>
                    <div>
                      <div className={styles.cleaningEditSectionTitle}>入住安排</div>
                      <div className={styles.cleaningEditSectionHint}>
                        {editForm.checkin_ids.length ? `当前已有 ${editForm.checkin_ids.length} 个入住任务。` : '当前没有入住任务。'}
                        {editForm.pending_add_checkin ? ' 保存后会新增入住。' : ''}
                      </div>
                    </div>
                    <div className={styles.cleaningEditSectionActions}>
                      {editForm.checkin_ids.length ? (
	                        <Button
	                          danger
	                          disabled={!editDeleteGate.enabled}
	                          title={editDeleteDisabledReason || undefined}
	                          onClick={() => {
                            Modal.confirm({
                              title: '确认取消入住任务？',
                              content: `将取消 ${editForm.checkin_ids.length} 个入住任务`,
                              okText: '取消入住',
                              okButtonProps: { danger: true },
                              onOk: () => cancelTasksInEdit(editForm.checkin_ids, '入住').catch((e) => message.error(e?.message || '取消失败')),
                            })
                          }}
                        >
                          取消入住
                        </Button>
                      ) : (
                        <Button
	                          disabled={(!editForm.can_add_checkin && !editForm.pending_add_checkin) || !editAddCheckinGate.enabled}
	                          title={editAddCheckinDisabledReason || undefined}
                          onClick={() =>
                            setEditForm((p) => {
                              if (!p) return p
                              const next = !p.pending_add_checkin
                              if (!next) return { ...p, pending_add_checkin: false, checkin_password: '', nights_override: null, checkin_time: '3pm', checkin_task_date: p.task_date }
                              return { ...p, pending_add_checkin: true, checkin_time: p.checkin_time || '3pm', checkin_task_date: p.checkin_task_date || p.task_date }
                            })
                          }
                        >
                          {editForm.pending_add_checkin ? '取消新增入住' : '新增入住'}
                        </Button>
                      )}
                    </div>
                  </div>
                  {editForm.pending_add_checkin ? (
                    <Alert type="info" showIcon message="保存时将新增入住任务" className={styles.cleaningEditAlert} />
                  ) : null}
                  {!editForm.property_id ? (
                    <Alert type="warning" showIcon message="该任务缺少 property_id，无法新增退房/入住" className={styles.cleaningEditAlert} />
                  ) : null}
                  <Row gutter={[16, 16]}>
                    <Col xs={24} md={12}>
                      <Form.Item label="需挂钥匙套数">
                        <Select
	                          value={editForm.keys_required_checkin}
	                          disabled={!editDetailsGate.enabled}
	                          title={editDetailsDisabledReason || undefined}
	                          onChange={(v) => setEditForm((p) => (p ? { ...p, keys_required_checkin: (Number(v) >= 2 ? 2 : 1) } : p))}
                          style={{ width: '100%' }}
                          options={[
                            { label: '1 套', value: 1 },
                            { label: '2 套', value: 2 },
                          ]}
                        />
                      </Form.Item>
                    </Col>
                    {editForm.checkin_ids.length || editForm.pending_add_checkin ? (
                      <>
                        <Col xs={24} md={12}>
                          <Form.Item label="入住日期">
	                            <DatePicker
	                              value={editForm.checkin_task_date}
	                              disabled={!editTaskDateGate.enabled}
	                              title={editTaskDateDisabledReason || undefined}
	                              onChange={(v) => setEditForm((p) => (p ? { ...p, checkin_task_date: v || p.task_date } : p))}
	                              style={{ width: '100%' }}
	                            />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item label="入住时间">
                            <Select
                              allowClear
                              showSearch
	                              optionFilterProp="label"
	                              value={editForm.checkin_time || undefined}
	                              disabled={!editDetailsGate.enabled}
	                              title={editDetailsDisabledReason || undefined}
	                              onChange={(v) => setEditForm((p) => (p ? { ...p, checkin_time: String(v || '') } : p))}
                              style={{ width: '100%' }}
                              options={timeOptions}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item label="入住天数">
                            <InputNumber
                              style={{ width: '100%' }}
                              min={0}
	                              placeholder="例如 2"
	                              value={editForm.nights_override ?? undefined}
	                              disabled={!editDetailsGate.enabled}
	                              title={editDetailsDisabledReason || undefined}
	                              onChange={(v) => setEditForm((p) => (p ? { ...p, nights_override: v == null ? null : Number(v) } : p))}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item label="入住密码（新密码）">
	                            <Input
	                              value={editForm.checkin_password}
	                              disabled={!editDetailsGate.enabled}
	                              title={editDetailsDisabledReason || undefined}
	                              onChange={(e) => setEditForm((p) => (p ? { ...p, checkin_password: e.target.value } : p))}
	                              placeholder="入住密码"
	                            />
                          </Form.Item>
                        </Col>
                      </>
                    ) : null}
                  </Row>
                  {editForm.checkin_task_date && !editForm.checkin_task_date.isSame(editForm.task_date, 'day') ? (
                    <Alert type="info" showIcon message="已标记为隔天入住，保存后入住任务会移动到所选日期。" className={styles.cleaningEditAlert} />
                  ) : null}
                </div>
              </>
            ) : null}

            <div className={styles.cleaningEditSection}>
              <div className={styles.cleaningEditSectionHead}>
                <div>
                  <div className={styles.cleaningEditSectionTitle}>客人需求</div>
                  <div className={styles.cleaningEditSectionHint}>记录客人要求或其他需要同步给现场的信息。</div>
                </div>
              </div>
              <Form.Item label="客人需求" style={{ marginBottom: 0 }}>
	                <Input.TextArea
	                  rows={4}
	                  value={editForm.guest_special_request}
	                  disabled={!editDetailsGate.enabled}
	                  title={editDetailsDisabledReason || undefined}
	                  onChange={(e) => setEditForm((p) => (p ? { ...p, guest_special_request: e.target.value } : p))}
	                />
              </Form.Item>
            </div>
          </Form>
        ) : null}
      </Drawer>

      <Modal
        open={offlineCreateOpen}
        title="新增线下任务"
        okText="创建"
        confirmLoading={offlineCreateLoading}
        onOk={() => submitOfflineCreate().catch((e) => message.error(e?.message || '创建失败'))}
        onCancel={() => { setOfflineCreateOpen(false); setOfflineCreateForm(null) }}
      >
        {offlineCreateForm ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <div className={styles.fieldLabel}>日期</div>
              <DatePicker
                value={offlineCreateForm.date}
                onChange={(v) => v && setOfflineCreateForm((p) => (p ? { ...p, date: v } : p))}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>类型</div>
              <Select
                value={offlineCreateForm.task_type}
                onChange={(v) => setOfflineCreateForm((p) => (p ? { ...p, task_type: v as 'property' | 'company' | 'other', property_id: v === 'property' ? p.property_id : null } : p))}
                style={{ width: '100%' }}
                options={offlineTaskTypeOptions}
              />
            </div>
            {offlineCreateForm.task_type === 'property' ? (
              <div>
                <div className={styles.fieldLabel}>房号</div>
                <Select
                  showSearch
                  optionFilterProp="label"
                  value={offlineCreateForm.property_id || undefined}
                  onChange={(v) => setOfflineCreateForm((p) => (p ? { ...p, property_id: v ? String(v) : null } : p))}
                  style={{ width: '100%' }}
                  options={propertyOptions}
                />
              </div>
            ) : null}
            <div>
              <div className={styles.fieldLabel}>任务标题</div>
              <Input
                value={offlineCreateForm.title}
                onChange={(e) => setOfflineCreateForm((p) => (p ? { ...p, title: e.target.value } : p))}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>任务详情</div>
              <Input.TextArea
                value={offlineCreateForm.content}
                onChange={(e) => setOfflineCreateForm((p) => (p ? { ...p, content: e.target.value } : p))}
                style={{ width: '100%' }}
                autoSize={{ minRows: 3, maxRows: 8 }}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>任务照片</div>
              <Upload
                accept="image/*"
                listType="picture-card"
                multiple
                fileList={photoUploadFiles(offlineCreateForm.photo_urls)}
                customRequest={({ file, onError, onSuccess }) => {
                  uploadOfflineTaskPhoto(file as File)
                    .then((url) => {
                      setOfflineCreateForm((p) => (p ? { ...p, photo_urls: normalizeTaskPhotoUrls([...(p.photo_urls || []), url]) } : p))
                      onSuccess?.({ url })
                    })
                    .catch((e) => onError?.(e as Error))
                }}
                onRemove={(file) => {
                  const url = String(file.url || file.thumbUrl || '').trim()
                  setOfflineCreateForm((p) => (p ? { ...p, photo_urls: normalizeTaskPhotoUrls((p.photo_urls || []).filter((item) => item !== url && displayPhotoUrl(item) !== url)) } : p))
                  return true
                }}
              >
                {(offlineCreateForm.photo_urls || []).length >= 20 ? null : (
                  <div><UploadOutlined /><div style={{ marginTop: 8 }}>上传</div></div>
                )}
              </Upload>
            </div>
            <div>
              <div className={styles.fieldLabel}>紧急度</div>
              <Select
                value={offlineCreateForm.urgency}
                onChange={(v) => setOfflineCreateForm((p) => (p ? { ...p, urgency: v as 'low' | 'medium' | 'high' | 'urgent' } : p))}
                style={{ width: '100%' }}
                options={urgencyOptions}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>指派人</div>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                value={offlineCreateForm.assignee_id || undefined}
                onChange={(v) => setOfflineCreateForm((p) => (p ? { ...p, assignee_id: v ? String(v) : null } : p))}
                style={{ width: '100%' }}
                options={allStaffOptions}
              />
            </div>
          </Space>
        ) : null}
      </Modal>

      <Modal
        open={offlineEditOpen}
        title="编辑线下任务"
        okText="保存"
        onOk={() => submitOfflineEdit().catch((e) => message.error(e?.message || '保存失败'))}
        onCancel={() => { setOfflineEditOpen(false); setOfflineEditForm(null) }}
      >
        {offlineEditForm ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <div className={styles.fieldLabel}>日期</div>
              <DatePicker
                value={offlineEditForm.date}
                onChange={(v) => v && setOfflineEditForm((p) => (p ? { ...p, date: v } : p))}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>类型</div>
              <Select
                value={offlineEditForm.task_type}
                onChange={(v) => setOfflineEditForm((p) => (p ? { ...p, task_type: v as 'property' | 'company' | 'other', property_id: v === 'property' ? p.property_id : null } : p))}
                style={{ width: '100%' }}
                options={offlineTaskTypeOptions}
              />
            </div>
            {offlineEditForm.task_type === 'property' ? (
              <div>
                <div className={styles.fieldLabel}>房号</div>
                <Select
                  showSearch
                  optionFilterProp="label"
                  value={offlineEditForm.property_id || undefined}
                  onChange={(v) => setOfflineEditForm((p) => (p ? { ...p, property_id: v ? String(v) : null } : p))}
                  style={{ width: '100%' }}
                  options={propertyOptions}
                />
              </div>
            ) : null}
            <div>
              <div className={styles.fieldLabel}>任务标题</div>
              <Input
                value={offlineEditForm.title}
                onChange={(e) => setOfflineEditForm((p) => (p ? { ...p, title: e.target.value } : p))}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>任务详情</div>
              <Input.TextArea
                value={offlineEditForm.content}
                onChange={(e) => setOfflineEditForm((p) => (p ? { ...p, content: e.target.value } : p))}
                style={{ width: '100%' }}
                autoSize={{ minRows: 3, maxRows: 8 }}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>任务照片</div>
              <Upload
                accept="image/*"
                listType="picture-card"
                multiple
                fileList={photoUploadFiles(offlineEditForm.photo_urls)}
                customRequest={({ file, onError, onSuccess }) => {
                  uploadOfflineTaskPhoto(file as File)
                    .then((url) => {
                      setOfflineEditForm((p) => (p ? { ...p, photo_urls: normalizeTaskPhotoUrls([...(p.photo_urls || []), url]) } : p))
                      onSuccess?.({ url })
                    })
                    .catch((e) => onError?.(e as Error))
                }}
                onRemove={(file) => {
                  const url = String(file.url || file.thumbUrl || '').trim()
                  setOfflineEditForm((p) => (p ? { ...p, photo_urls: normalizeTaskPhotoUrls((p.photo_urls || []).filter((item) => item !== url && displayPhotoUrl(item) !== url)) } : p))
                  return true
                }}
              >
                {(offlineEditForm.photo_urls || []).length >= 20 ? null : (
                  <div><UploadOutlined /><div style={{ marginTop: 8 }}>上传</div></div>
                )}
              </Upload>
            </div>
            <div>
              <div className={styles.fieldLabel}>状态</div>
              <Select
                value={offlineEditForm.status}
                onChange={(v) => setOfflineEditForm((p) => (p ? { ...p, status: v as 'todo' | 'done' } : p))}
                style={{ width: '100%' }}
                options={offlineStatusOptions}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>紧急度</div>
              <Select
                value={offlineEditForm.urgency}
                onChange={(v) => setOfflineEditForm((p) => (p ? { ...p, urgency: v as 'low' | 'medium' | 'high' | 'urgent' } : p))}
                style={{ width: '100%' }}
                options={urgencyOptions}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>指派人</div>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                value={offlineEditForm.assignee_id || undefined}
                onChange={(v) => setOfflineEditForm((p) => (p ? { ...p, assignee_id: v ? String(v) : null } : p))}
                style={{ width: '100%' }}
                options={allStaffOptions}
              />
            </div>
          </Space>
        ) : null}
      </Modal>

      <Modal
        open={manualCreateOpen}
        title="新增清洁任务"
        okText="创建"
        onOk={() => submitManualCreate().catch((e) => message.error(e?.message || '创建失败'))}
        onCancel={() => { setManualCreateOpen(false); setManualCreateForm(null) }}
      >
        {manualCreateForm ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <div className={styles.fieldLabel}>日期</div>
              <DatePicker value={dayjs(selectedDateStr)} disabled style={{ width: '100%' }} />
            </div>
            <div>
              <div className={styles.fieldLabel}>区域（area）</div>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                value={manualCreateForm.area || undefined}
                onChange={(v) => setManualCreateForm((p) => (p ? { ...p, area: v ? String(v) : null, property_id: null } : p))}
                style={{ width: '100%' }}
                options={areaOptions}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>房号</div>
              <Select
                showSearch
                optionFilterProp="label"
                value={manualCreateForm.property_id || undefined}
                onChange={(v) => setManualCreateForm((p) => (p ? { ...p, property_id: v ? String(v) : null } : p))}
                style={{ width: '100%' }}
                options={manualPropertyOptions}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>类型</div>
              <Select
                value={manualCreateForm.create_mode}
                onChange={(v) => setManualCreateForm((p) => (p ? { ...p, create_mode: v as any } : p))}
                style={{ width: '100%' }}
                options={[
                  { label: '退房+入住', value: 'turnover' },
                  { label: '新增退房', value: 'checkout' },
                  { label: '新增入住', value: 'checkin' },
                  { label: '入住中清洁', value: 'stayover' },
                ]}
              />
            </div>
            {manualCreateForm.create_mode === 'checkout' || manualCreateForm.create_mode === 'turnover' ? (
              <div>
                <div className={styles.fieldLabel}>退房时间</div>
                <Select
                  value={manualCreateForm.checkout_time}
                  onChange={(v) => setManualCreateForm((p) => (p ? { ...p, checkout_time: String(v) } : p))}
                  style={{ width: '100%' }}
                  options={timeOptions}
                />
              </div>
            ) : null}
            {manualCreateForm.create_mode === 'checkin' || manualCreateForm.create_mode === 'turnover' ? (
              <div>
                <div className={styles.fieldLabel}>入住时间</div>
                <Select
                  value={manualCreateForm.checkin_time}
                  onChange={(v) => setManualCreateForm((p) => (p ? { ...p, checkin_time: String(v) } : p))}
                  style={{ width: '100%' }}
                  options={timeOptions}
                />
              </div>
            ) : null}
            {manualCreateForm.create_mode !== 'stayover' ? (
              <>
                <div>
                  <div className={styles.fieldLabel}>退房密码</div>
                  <Input
                    value={manualCreateForm.checkout_password}
                    onChange={(e) => setManualCreateForm((p) => (p ? { ...p, checkout_password: e.target.value } : p))}
                    style={{ width: '100%' }}
                    placeholder="可为空"
                  />
                </div>
                <div>
                  <div className={styles.fieldLabel}>入住密码</div>
                  <Input
                    value={manualCreateForm.checkin_password}
                    onChange={(e) => setManualCreateForm((p) => (p ? { ...p, checkin_password: e.target.value } : p))}
                    style={{ width: '100%' }}
                    placeholder="可为空"
                  />
                </div>
              </>
            ) : null}
            <div>
              <div className={styles.fieldLabel}>客人需求</div>
              <Input.TextArea
                value={manualCreateForm.guest_special_request}
                onChange={(e) => setManualCreateForm((p) => (p ? { ...p, guest_special_request: e.target.value } : p))}
                style={{ width: '100%' }}
                autoSize={{ minRows: 2, maxRows: 6 }}
              />
            </div>
          </Space>
        ) : null}
      </Modal>

      <Modal
        open={bulkEditOpen}
        title="批量编辑清洁任务"
        okText="保存"
        onOk={() => submitBulkEdit().catch((e) => message.error(e?.message || '保存失败'))}
        onCancel={() => { setBulkEditOpen(false); setBulkEditForm(null) }}
      >
        {bulkEditForm ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert type="info" showIcon message={`已选择 ${bulkEditForm.ids.length} 个任务`} />
            <div>
              <div className={styles.fieldLabel}>状态</div>
              <Select
                value={bulkEditForm.status}
                onChange={(v) => setBulkEditForm((p) => (p ? { ...p, status: v } : p))}
                style={{ width: '100%' }}
                options={[
                  { label: '不修改', value: '__keep__' },
                  ...statusOptions,
                ]}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>清洁人员</div>
              <Select
                showSearch
                optionFilterProp="label"
                value={bulkEditForm.cleaner}
                onChange={(v) => setBulkEditForm((p) => (p ? { ...p, cleaner: v } : p))}
                style={{ width: '100%' }}
                options={[
                  { label: '不修改', value: '__keep__' },
                  { label: '清空', value: '__clear__' },
                  ...cleanerOptions,
                ]}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>检查人员</div>
              <Select
                showSearch
                optionFilterProp="label"
                value={bulkEditForm.inspector}
                onChange={(v) => setBulkEditForm((p) => (p ? { ...p, inspector: v } : p))}
                style={{ width: '100%' }}
                options={[
                  { label: '不修改', value: '__keep__' },
                  { label: '清空', value: '__clear__' },
                  ...inspectorOptions,
                ]}
              />
            </div>
          </Space>
        ) : null}
      </Modal>

      <Modal
        open={backfillOpen}
        title="Backfill 清洁任务"
        okText="执行"
        confirmLoading={backfillLoading}
        onOk={() => submitBackfill().catch(() => {})}
        onCancel={() => setBackfillOpen(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <div className={styles.fieldLabel}>date_from</div>
            <DatePicker value={backfillFrom} onChange={(v) => v && setBackfillFrom(v)} style={{ width: '100%' }} />
          </div>
          <div>
            <div className={styles.fieldLabel}>date_to</div>
            <DatePicker value={backfillTo} onChange={(v) => v && setBackfillTo(v)} style={{ width: '100%' }} />
          </div>
        </Space>
      </Modal>

      <Modal
        open={debugOpen}
        title="清洁模块调试信息"
        footer={null}
        onCancel={() => setDebugOpen(false)}
        width={860}
      >
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
          {JSON.stringify(debugState, null, 2)}
        </pre>
      </Modal>
    </div>
  )
}
