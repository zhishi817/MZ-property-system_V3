"use client"

import { Alert, Button, DatePicker, Empty, Input, Modal, Select, Skeleton, Space, Switch, message } from 'antd'
import { DeleteOutlined, HolderOutlined, LeftOutlined, PlusOutlined, ReloadOutlined, RightOutlined, SaveOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { getJSON, postJSON } from '../../lib/api'
import { upsertAdminNotification } from '../../lib/adminNotifications'
import { getRole } from '../../lib/auth'
import {
  type TaskSemanticTone,
  inspectionScopeLabel,
  isCompletedTaskStatus,
  isInspectionModeAllowedForTask,
  isTaskCompletionToggleStatus,
  normalizeInspectionScope,
  normalizeKeysHungInspectionMode,
  propertyFollowupKindMeta,
  resolveTaskDetailCompletionStatus,
  shouldShowInspectionModeTag,
  taskCenterInspectionModeOptions,
  taskInspectionModeMeta,
  taskInspectionScopeMeta,
  taskStatusMeta,
  taskTimingTone,
} from '../../lib/cleaningTaskUi'
import { cleaningTaskFlowLabelText, isDeferredInspectionDisplayTask } from './taskCenterDisplay'
import styles from '../cleaning/cleaningSchedule.module.scss'

type Staff = {
  id: string
  name: string
  kind?: 'cleaner' | 'inspector' | 'maintenance'
  is_active?: boolean
  color_hex?: string | null
}

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
  task_semantics?: {
    is_pure_checkin?: boolean
    is_cleaning_execution?: boolean
    is_key_handover?: boolean
    is_password_only?: boolean
    requires_cleaner?: boolean
    can_configure_inspection?: boolean
    is_deferred_inspection?: boolean
    is_keys_hung?: boolean
    is_self_complete?: boolean
    is_checked_done?: boolean
    is_task_ended?: boolean
    inspection_mode?: string | null
    inspection_mode_label?: string | null
    inspection_scope?: string | null
    inspection_scope_label?: string | null
  }
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

type TaskCenterTask = {
  item_key: string
  task_source: 'cleaning' | 'work'
  task_id: string
  task_ids: string[]
  active_source_ids?: string[]
  superseded_source_ids?: string[]
  all_related_source_ids?: string[]
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
  checkout_task_date?: string | null
  checkout_task_dates?: string[]
  keys_required?: number | null
  keys_required_checkout?: number | null
  keys_required_checkin?: number | null
  guest_special_request?: string | null
  guest_request_checkout?: string | null
  guest_request_checkin?: string | null
  guest_request_summary?: string | null
  order_id_checkout?: string | null
  order_id_checkin?: string | null
  is_late_checkout?: boolean
  is_early_checkin?: boolean
  is_late_checkin?: boolean
  display_conflicts?: Record<string, any>[]
  turnover_display?: {
    checkout_order_id?: string | null
    checkin_order_id?: string | null
    checkout_time?: string | null
    checkin_time?: string | null
    is_late_checkout?: boolean
    is_early_checkin?: boolean
    is_late_checkin?: boolean
    guest_request_checkout?: string | null
    guest_request_checkin?: string | null
    guest_request_summary?: string | null
    old_code?: string | null
    new_code?: string | null
    keys_required_checkout?: number | null
    keys_required_checkin?: number | null
    stayed_nights?: number | null
    remaining_nights?: number | null
    active_source_ids?: string[]
    superseded_source_ids?: string[]
    all_related_source_ids?: string[]
    conflicts?: Record<string, any>[]
  } | null
  temporarily_skipped?: boolean
  skip_reason?: string | null
  skip_bucket?: string | null
  current_row_key?: string
  current_subrow_key?: string
  status_action?: CleaningStatusAction | null
  display_state?: TaskDisplayState | null
  management_actions?: TaskManagementAction[] | null
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

type CleaningStatusAction = 'set_keys_hung' | 'clear_keys_hung' | 'set_completed' | 'clear_completed'

type CleaningAssignmentSnapshot = {
  assignee_id: string | null
  cleaner_id: string | null
  inspector_id: string | null
  inspection_mode: TaskCenterTask['inspection_mode']
  inspection_scope: TaskCenterTask['inspection_scope']
  inspection_due_date: string | null
  status_action: CleaningStatusAction | null
  status: string | null
}

type WorkAssignmentSnapshot = {
  assignee_id: string | null
  title: string
  summary: string | null
  scheduled_date: string | null
  urgency: string | null
}

type AssignmentBaseline = {
  cleaning: Map<string, CleaningAssignmentSnapshot>
  work: Map<string, WorkAssignmentSnapshot>
}

type TaskDetailDraft = {
  cleaner_id: string | null
  inspector_id: string | null
  assignee_id: string | null
  inspection_mode: 'pending_decision' | 'same_day' | 'deferred' | 'self_complete' | 'checked_done'
  inspection_scope: 'inspect_and_hang' | 'password_only'
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

function semanticToneClass(tone: TaskSemanticTone) {
  if (tone === 'special') return styles.semanticToneSpecial
  if (tone === 'pending') return styles.semanticTonePending
  if (tone === 'danger') return styles.semanticToneDanger
  if (tone === 'success') return styles.semanticToneSuccess
  if (tone === 'info') return styles.semanticToneInfo
  if (tone === 'neutral') return styles.semanticToneNeutral
  return styles.semanticToneNormal
}

function displayStatusMetaForTask(task: Pick<TaskCenterTask, 'status' | 'display_state'>, fallbackStatus?: string | null) {
  const label = String(task.display_state?.status_label || '').trim()
  const tone = task.display_state?.status_tone
  if (label && tone) return { label, tone }
  return taskStatusMeta(fallbackStatus ?? task.status)
}

function displayBadgesForTask(task: Pick<TaskCenterTask, 'display_state'>): TaskDisplayBadge[] {
  return Array.isArray(task.display_state?.badges)
    ? task.display_state.badges.filter((badge) => String(badge?.label || '').trim())
    : []
}

function managementActionForTask(task: Pick<TaskCenterTask, 'management_actions'>, id: TaskManagementActionId): TaskManagementAction | null {
  const actions = task.management_actions
  if (!Array.isArray(actions)) return null
  return actions.find((action) => action.id === id) || null
}

function managementGateForTask(task: Pick<TaskCenterTask, 'management_actions'>, id: TaskManagementActionId) {
  const actions = task.management_actions
  if (!Array.isArray(actions)) return { enabled: true, disabledReason: '' }
  const action = managementActionForTask(task, id)
  if (!action) return { enabled: false, disabledReason: 'not_applicable' }
  return { enabled: action.enabled !== false, disabledReason: action.enabled === false ? String(action.disabled_reason || '') : '' }
}

function disabledReasonText(reason: string | null | undefined) {
  const value = String(reason || '').trim()
  if (!value) return ''
  if (value === 'missing_management_permission') return '你没有修改这个字段的管理权限'
  if (value === 'auto_sync_locked') return '自动同步已锁定，不能在这里修改'
  if (value === 'not_applicable') return '这个动作不适用于当前任务'
  return value
}

function taskSemanticBool(
  task: TaskCenterTask,
  key: keyof NonNullable<TaskDisplayState['task_semantics']>,
  fallback: boolean,
) {
  const value = task.display_state?.task_semantics?.[key]
  return typeof value === 'boolean' ? value : fallback
}

function combinedManagementGate(tasks: TaskCenterTask[], id: TaskManagementActionId) {
  const relevant = tasks.filter((task) => Array.isArray(task.management_actions))
  if (!relevant.length) return { enabled: true, disabledReason: '' }
  const blocked = relevant
    .map((task) => managementGateForTask(task, id))
    .find((gate) => !gate.enabled)
  return blocked || { enabled: true, disabledReason: '' }
}

const UNASSIGNED_VISIBLE_SUMMARY_TITLE = '统计当前页面显示的清洁任务和线下其他任务里，尚未完成安排的任务；清洁任务需清洁人员和检查人员都为空，线下其他任务需执行人为空；不含退房日房源待办'
const PENDING_INSPECTION_SUMMARY_TITLE = '统计检查安排待确认，或已设为同日/延期检查但还没有检查人员的清洁任务'

function saveBoardErrorMessage(error: any) {
  const msg = String(error?.message || '').trim()
  if (/timeout|超时|abort|aborted/i.test(msg)) return '保存安排耗时较长，请稍后刷新确认结果；如果没有保存成功，再点一次保存'
  return msg || '保存安排失败'
}

function propertyFollowupMeta(task: Pick<TaskCenterTask, 'task_kind'>) {
  return propertyFollowupKindMeta(task.task_kind)
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
  if (isDeferredInspectionDisplayTask(task)) return { showCheckout: false, showCheckin: false }
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

function uniqueTextList(values: any[]) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
}

function turnoverDisplayOf(task: Pick<TaskCenterTask, 'turnover_display'>) {
  return task.turnover_display && typeof task.turnover_display === 'object' ? task.turnover_display : null
}

function activeCleaningTaskIds(task: Pick<TaskCenterTask, 'task_source' | 'task_id' | 'task_ids' | 'active_source_ids' | 'turnover_display'>) {
  if (task.task_source !== 'cleaning') return [String(task.task_id || '').trim()].filter(Boolean)
  const display = turnoverDisplayOf(task)
  const active = uniqueTextList([
    ...(Array.isArray(display?.active_source_ids) ? display.active_source_ids : []),
    ...(Array.isArray(task.active_source_ids) ? task.active_source_ids : []),
  ])
  return active.length ? active : uniqueTextList(Array.isArray(task.task_ids) ? task.task_ids : [task.task_id])
}

function cleaningAssignmentSnapshot(task: TaskCenterTask): CleaningAssignmentSnapshot {
  const timing = cleaningTimingVisibility(task)
  const pureCheckin =
    task.task_source === 'cleaning'
    && timing.showCheckin
    && !timing.showCheckout
  return {
    assignee_id: pureCheckin ? (task.assignee_id || task.inspector_id || task.cleaner_id || null) : (task.assignee_id || null),
    cleaner_id: pureCheckin ? null : (task.cleaner_id || task.assignee_id || null),
    inspector_id: pureCheckin ? null : (task.inspector_id || null),
    inspection_mode: task.inspection_mode || 'pending_decision',
    inspection_scope: task.inspection_scope || null,
    inspection_due_date: task.inspection_due_date || null,
    status_action: task.status_action || null,
    status: task.status_action ? task.status : null,
  }
}

function workAssignmentSnapshot(task: Pick<TaskCenterTask, 'assignee_id' | 'title' | 'summary' | 'detail' | 'task_date' | 'urgency'>): WorkAssignmentSnapshot {
  return {
    assignee_id: task.assignee_id || null,
    title: String(task.title || '').trim(),
    summary: String(task.summary || task.detail || '').trim() || null,
    scheduled_date: task.task_date || null,
    urgency: task.urgency || null,
  }
}

function buildAssignmentBaseline(payload: TaskCenterDay | null): AssignmentBaseline {
  const baseline: AssignmentBaseline = { cleaning: new Map(), work: new Map() }
  for (const task of (payload?.rows || []).flatMap((row) => row.subrows.flatMap((subrow) => subrow.tasks))) {
    if (task.task_source === 'cleaning') {
      const snapshot = cleaningAssignmentSnapshot(task)
      for (const taskId of activeCleaningTaskIds(task)) baseline.cleaning.set(String(taskId), snapshot)
    } else {
      baseline.work.set(String(task.task_id), workAssignmentSnapshot(task))
    }
  }
  for (const task of payload?.property_followups || []) {
    baseline.work.set(String(task.task_id), workAssignmentSnapshot(task))
  }
  return baseline
}

function supersededCleaningTaskIds(task: Pick<TaskCenterTask, 'task_source' | 'superseded_source_ids' | 'turnover_display'>) {
  if (task.task_source !== 'cleaning') return []
  const display = turnoverDisplayOf(task)
  return uniqueTextList([
    ...(Array.isArray(display?.superseded_source_ids) ? display.superseded_source_ids : []),
    ...(Array.isArray(task.superseded_source_ids) ? task.superseded_source_ids : []),
  ])
}

function checkoutTimeForDisplay(task: Pick<TaskCenterTask, 'turnover_display' | 'summary_checkout_time'>) {
  return normalizedSummaryTime(turnoverDisplayOf(task)?.checkout_time || task.summary_checkout_time)
}

function checkinTimeForDisplay(task: Pick<TaskCenterTask, 'turnover_display' | 'summary_checkin_time'>) {
  return normalizedSummaryTime(turnoverDisplayOf(task)?.checkin_time || task.summary_checkin_time)
}

function guestRequestForDisplay(task: Pick<TaskCenterTask, 'turnover_display' | 'guest_request_summary' | 'guest_special_request'>) {
  const display = turnoverDisplayOf(task)
  return String(display?.guest_request_summary || task.guest_request_summary || task.guest_special_request || '').trim()
}

function isLateCheckoutDisplay(task: Pick<TaskCenterTask, 'turnover_display' | 'is_late_checkout' | 'summary_checkout_time'>) {
  const display = turnoverDisplayOf(task)
  if (typeof display?.is_late_checkout === 'boolean') return display.is_late_checkout
  if (typeof task.is_late_checkout === 'boolean') return task.is_late_checkout
  const checkoutMin = parseSummaryTime(task.summary_checkout_time)
  const defaultMin = parseSummaryTime(DEFAULT_SUMMARY_CHECKOUT_TIME)
  return checkoutMin != null && defaultMin != null && checkoutMin > defaultMin
}

function isEarlyCheckinDisplay(task: Pick<TaskCenterTask, 'turnover_display' | 'is_early_checkin' | 'summary_checkin_time'>) {
  const display = turnoverDisplayOf(task)
  if (typeof display?.is_early_checkin === 'boolean') return display.is_early_checkin
  if (typeof task.is_early_checkin === 'boolean') return task.is_early_checkin
  const checkinMin = parseSummaryTime(task.summary_checkin_time)
  const defaultMin = parseSummaryTime(DEFAULT_SUMMARY_CHECKIN_TIME)
  return checkinMin != null && defaultMin != null && checkinMin < defaultMin
}

function isLateCheckinDisplay(task: Pick<TaskCenterTask, 'turnover_display' | 'is_late_checkin' | 'summary_checkin_time'>) {
  const display = turnoverDisplayOf(task)
  if (typeof display?.is_late_checkin === 'boolean') return display.is_late_checkin
  if (typeof task.is_late_checkin === 'boolean') return task.is_late_checkin
  const checkinMin = parseSummaryTime(task.summary_checkin_time)
  return checkinMin != null && checkinMin > 18 * 60
}

function isDefaultSummaryTime(raw: string | null | undefined, defaultValue: string) {
  const actual = parseSummaryTime(raw)
  const expected = parseSummaryTime(defaultValue)
  if (actual != null && expected != null) return actual === expected
  return normalizedSummaryTime(raw).toLowerCase() === defaultValue.toLowerCase()
}

function specialTimingTags(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'summary_checkout_time' | 'summary_checkin_time' | 'turnover_display' | 'is_late_checkout' | 'is_early_checkin' | 'is_late_checkin'>) {
  if (task.task_source !== 'cleaning') return [] as Array<{ key: string; label: string; time: string; tone: TaskSemanticTone }>
  const timing = cleaningTimingVisibility(task)
  const tags: Array<{ key: string; label: string; time: string; tone: TaskSemanticTone }> = []
  const checkoutTime = checkoutTimeForDisplay(task)
  const checkinTime = checkinTimeForDisplay(task)
  if (timing.showCheckout && checkoutTime && !isDefaultSummaryTime(checkoutTime, DEFAULT_SUMMARY_CHECKOUT_TIME)) {
    let label = '退房'
    if (isLateCheckoutDisplay(task)) label = '晚退房'
    else {
      const checkoutMin = parseSummaryTime(checkoutTime)
      const defaultMin = parseSummaryTime(DEFAULT_SUMMARY_CHECKOUT_TIME)
      if (checkoutMin != null && defaultMin != null && checkoutMin < defaultMin) label = '早退房'
    }
    tags.push({ key: 'checkout', label, time: checkoutTime, tone: taskTimingTone(label) })
  }
  if (timing.showCheckin && checkinTime && !isDefaultSummaryTime(checkinTime, DEFAULT_SUMMARY_CHECKIN_TIME)) {
    let label = '入住'
    if (isEarlyCheckinDisplay(task)) label = '早入住'
    else if (isLateCheckinDisplay(task)) label = '晚入住'
    tags.push({ key: 'checkin', label, time: checkinTime, tone: taskTimingTone(label) })
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

function isPasswordOnlyCheckinTask(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'inspection_scope'>) {
  return isCheckinOnlyCleaningTask(task) && normalizeInspectionScope(task.inspection_scope) === 'password_only'
}

function canAutoReassignInspectorOnDrop(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'inspection_scope' | 'status' | 'can_configure_inspection'>) {
  if (task.task_source !== 'cleaning') return false
  if (isPasswordOnlyCheckinTask(task)) return false
  if (isCompletedBoardStatus(task.status)) return false
  return !!task.can_configure_inspection || !!task.deferred_inspection_view || isCheckinOnlyCleaningTask(task)
}

function preferredStaffIdForTask(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'inspection_scope' | 'cleaner_id' | 'assignee_id' | 'inspector_id'>) {
  if (isCheckinOnlyCleaningTask(task)) return String(task.assignee_id || task.inspector_id || task.cleaner_id || '').trim()
  return String(task.cleaner_id || task.assignee_id || '').trim()
}

function inspectionScopeTagMeta(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'inspection_scope'>) {
  if (!isCheckinOnlyCleaningTask(task)) return null
  return taskInspectionScopeMeta(task.inspection_scope)
}

function resolvedInspectionModeForTask(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'inspection_mode' | 'inspection_scope' | 'status'>) {
  return normalizeKeysHungInspectionMode({
    inspectionMode: task.inspection_mode,
    inspectionScope: task.inspection_scope,
    status: task.status,
    isCheckinOnly: isCheckinOnlyCleaningTask(task),
  })
}

function shouldRenderInspectionModeTag(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'inspection_scope'>) {
  return shouldShowInspectionModeTag({
    inspectionScope: task.inspection_scope,
    isCheckinOnly: isCheckinOnlyCleaningTask(task),
  })
}

function isKeysHungStatus(status: string | null | undefined) {
  return String(status || '').trim().toLowerCase() === 'keys_hung'
}

function cleaningStatusActionForDetail(task: TaskCenterTask, draft: TaskDetailDraft): CleaningStatusAction | null {
  if (task.task_source !== 'cleaning') return null
  const wasKeysHung = isKeysHungStatus(task.status)
  if (draft.keys_hung && !wasKeysHung) return 'set_keys_hung'
  if (!draft.keys_hung && wasKeysHung) return 'clear_keys_hung'
  const wasCompleted = isTaskCompletionToggleStatus(task.status)
  if (draft.task_completed && !wasCompleted) return 'set_completed'
  if (!draft.task_completed && wasCompleted) return 'clear_completed'
  return null
}

function isCompletedBoardStatus(status: string | null | undefined) {
  return isKeysHungStatus(status) || isCompletedTaskStatus(status)
}

function cleaningSummaryParts(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'inspection_mode' | 'summary_checkout_time' | 'summary_checkin_time' | 'checkout_task_date' | 'checkout_task_dates' | 'nights' | 'turnover_display' | 'guest_request_summary' | 'guest_special_request'>) {
  if (task.task_source !== 'cleaning') return [String(task.detail || '').trim()].filter(Boolean)
  const parts: string[] = []
  const timing = cleaningTimingVisibility(task)
  const checkoutTime = checkoutTimeForDisplay(task)
  const checkinTime = checkinTimeForDisplay(task)
  if (timing.showCheckout) {
    parts.push(isDefaultSummaryTime(checkoutTime, DEFAULT_SUMMARY_CHECKOUT_TIME) || !checkoutTime ? '退房' : `${checkoutTime}退房`)
  }
  if (timing.showCheckin) {
    parts.push(isDefaultSummaryTime(checkinTime, DEFAULT_SUMMARY_CHECKIN_TIME) || !checkinTime ? '入住' : `${checkinTime}入住`)
  }
  if (!parts.length) parts.push(cleaningTaskFlowLabel(task))
  if (shouldShowNights(task) && task.nights != null && Number(task.nights) > 0) parts.push(`住${Number(task.nights)}晚`)
  const guestRequest = guestRequestForDisplay(task)
  if (guestRequest) parts.push(`客人需求：${guestRequest}`)
  return parts
}

function cleaningSecondarySummary(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'task_ids' | 'title' | 'detail' | 'deferred_inspection_view' | 'inspection_mode' | 'summary_checkout_time' | 'summary_checkin_time' | 'checkout_task_date' | 'checkout_task_dates' | 'nights' | 'turnover_display' | 'guest_request_summary' | 'guest_special_request'>) {
  if (task.task_source !== 'cleaning') return String(task.detail || '').trim()
  const parts = cleaningSummaryParts(task)
  return parts.join('，') || String(task.detail || '').trim()
}

function cleaningTaskFlowLabel(task: Pick<TaskCenterTask, 'task_source' | 'task_kind' | 'title' | 'detail' | 'deferred_inspection_view' | 'inspection_mode' | 'checkout_task_date' | 'checkout_task_dates'>) {
  return cleaningTaskFlowLabelText(task)
}

function detailHeroSummary(task: TaskCenterTask) {
  if (task.task_source === 'work') return String(task.detail || task.summary || '线下任务').trim()
  const parts = cleaningSummaryParts(task)
  return parts.join(' · ')
}

function checkinSyncTag(task: Pick<TaskCenterTask, 'task_source' | 'checkin_sync_status'>) {
  if (task.task_source !== 'cleaning') return null
  if (task.checkin_sync_status === 'pending') return { label: '待同步', tone: 'pending' as const }
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
  const [boardDirty, setBoardDirty] = useState(false)
  const [boardSaving, setBoardSaving] = useState(false)
  const boardDirtyRef = useRef(false)
  const loadDayRequestRef = useRef(0)
  const invalidInspectionModeNoticeRef = useRef<Record<string, boolean>>({})
  const assignmentBaselineRef = useRef<AssignmentBaseline>({ cleaning: new Map(), work: new Map() })

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
      assignmentBaselineRef.current = buildAssignmentBaseline(payload || null)
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

  const visibleUnassignedTasks = useMemo(() => {
    const items: Array<{
      task: TaskCenterTask
      row: TaskCenterRow
      subrow: TaskCenterSubrow
      label: string
    }> = []
    for (const row of filteredRows) {
      for (const subrow of row.subrows) {
        for (const task of subrow.tasks) {
          if (task.task_source === 'cleaning') {
            const cleanerId = String(task.cleaner_id || task.assignee_id || '').trim()
            const inspectorId = String(task.inspector_id || '').trim()
            if (cleanerId || inspectorId) continue
          } else if (task.task_source === 'work') {
            const assigneeId = String(task.assignee_id || '').trim()
            if (assigneeId) continue
          } else {
            continue
          }
          const summary = detailHeroSummary(task) || cleaningTaskFlowLabel(task) || String(task.detail || '').trim()
          items.push({
            task,
            row,
            subrow,
            label: summary ? `${task.title} · ${summary}` : task.title,
          })
        }
      }
    }
    return items
  }, [filteredRows])

  const allBoardTasks = useMemo(() => allRows.flatMap((row) => row.subrows.flatMap((subrow) => subrow.tasks)), [allRows])

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
      const mode = resolvedInspectionModeForTask(task)
      if (!mode || mode === 'pending_decision') return true
      if ((mode === 'same_day' || mode === 'deferred') && isCheckinOnlyCleaningTask(task)) {
        return !String(task.assignee_id || task.inspector_id || task.cleaner_id || '').trim()
      }
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
    if (task.task_source === 'cleaning' && resolvedInspectionModeForTask(task) === 'deferred') return DEFERRED_INSPECTION_ROW_KEY
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
        ? '延期检查'
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
      const taskIds = task.task_source === 'cleaning' ? activeCleaningTaskIds(task) : [String(task.task_id)]
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
    if (isCheckinOnlyCleaningTask(task)) {
      return autoCleaningStatus(task.status, draft.assignee_id || null, null)
    }
    const completionStatus = resolveTaskDetailCompletionStatus({
      isCheckinOnly: isCheckinOnlyCleaningTask(task),
      keysHung: draft.keys_hung,
      taskCompleted: draft.task_completed,
    })
    if (completionStatus) return completionStatus
    if (isKeysHungStatus(task.status) && !draft.keys_hung) {
      return String(draft.cleaner_id || draft.inspector_id || '').trim() ? 'assigned' : 'pending'
    }
    return autoCleaningStatus(task.status, draft.cleaner_id, draft.inspector_id)
  }, [autoCleaningStatus])

  const openTaskDetail = useCallback((task: TaskCenterTask, row: TaskCenterRow, subrow: TaskCenterSubrow) => {
    const inspectionMode = normalizeKeysHungInspectionMode({
      inspectionMode: task.inspection_mode,
      inspectionScope: task.inspection_scope,
      status: task.status,
      isCheckinOnly: isCheckinOnlyCleaningTask(task),
    })
    if (
      isCheckinOnlyCleaningTask(task)
      && normalizeInspectionScope(task.inspection_scope) === 'password_only'
      && task.inspection_mode
      && inspectionMode !== task.inspection_mode
      && !invalidInspectionModeNoticeRef.current[task.item_key]
    ) {
      invalidInspectionModeNoticeRef.current[task.item_key] = true
      message.warning('仅改密码任务不能使用“自完成/已检查”，已自动回退为同日检查')
    }
    setDetailTask({ ...task, current_row_key: row.row_key, current_subrow_key: subrow.subrow_key })
    const pureCheckin = isCheckinOnlyCleaningTask(task)
    setDetailDraft({
      cleaner_id: pureCheckin ? null : (requiresCleanerAssignment(task) ? (task.cleaner_id || null) : null),
      inspector_id: pureCheckin ? null : (task.inspector_id || null),
      assignee_id: pureCheckin ? (task.assignee_id || task.inspector_id || task.cleaner_id || null) : (task.assignee_id || null),
      inspection_mode: inspectionMode,
      inspection_scope: normalizeInspectionScope(task.inspection_scope),
      inspection_due_date: task.inspection_due_date ? dayjs(task.inspection_due_date) : null,
      keys_hung: isKeysHungStatus(task.status),
      task_completed: isTaskCompletionToggleStatus(task.status),
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
    const nextStatusAction = cleaningStatusActionForDetail(task, draft)
    const nextInspectionMode = draft.inspection_mode
    const nextCleanerId = requiresCleanerAssignment(task) ? (draft.cleaner_id || null) : null
    const pureCheckin = isCheckinOnlyCleaningTask(task)
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
            cleaner_id: task.task_source === 'cleaning' ? (pureCheckin ? null : nextCleanerId) : item.cleaner_id,
            inspector_id: task.task_source === 'cleaning' ? (pureCheckin ? null : (draft.inspector_id || null)) : item.inspector_id,
            assignee_id: task.task_source === 'cleaning'
              ? (pureCheckin ? (draft.assignee_id || null) : item.assignee_id)
              : (draft.assignee_id || null),
            status: task.task_source === 'cleaning'
              ? nextStatus
              : autoWorkStatus(item.status, draft.assignee_id || null),
            status_action: task.task_source === 'cleaning' ? nextStatusAction : item.status_action,
            inspection_mode: task.task_source === 'cleaning' ? nextInspectionMode : item.inspection_mode,
            inspection_scope: task.task_source === 'cleaning' ? draft.inspection_scope : item.inspection_scope,
            inspection_due_date: task.task_source === 'cleaning'
              ? ((draft.task_completed && !draft.keys_hung) || draft.inspection_mode !== 'deferred' ? null : (draft.inspection_due_date ? draft.inspection_due_date.format('YYYY-MM-DD') : null))
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
  }, [autoWorkStatus, defaultBoardRowKeyForTask, ensureBoardRow, nextCleaningDetailStatus])

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
    if (!isInspectionModeAllowedForTask({
      inspectionMode: detailDraft.inspection_mode,
      inspectionScope: detailDraft.inspection_scope,
      isCheckinOnly: isCheckinOnlyCleaningTask(detailTask),
    })) {
      message.error('仅改密码任务不能设置为自完成或已检查')
      return
    }
    if (
      isCheckinOnlyCleaningTask(detailTask) &&
      detailDraft.inspection_mode !== 'self_complete' &&
      detailDraft.inspection_mode !== 'checked_done' &&
      detailDraft.keys_hung &&
      !detailDraft.assignee_id
    ) {
      message.error('标记已挂钥匙前请保留或选择执行人')
      return
    }
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
        .flatMap((task) => activeCleaningTaskIds(task)),
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
                const matched = task.task_source === 'cleaning' && activeCleaningTaskIds(task).some((id) => inspectionSet.has(String(id)))
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
    let sourceRowKey = ''
    let sourceInspectorId = ''
    for (const row of nextRows) {
      for (const subrow of row.subrows) {
        const idx = subrow.tasks.findIndex((item) => item.task_source === payload.task_source && item.task_id === payload.task_id)
        if (idx >= 0) {
          movedTask = subrow.tasks[idx]
          sourceRowKey = row.row_key
          sourceInspectorId = String(row.assignments?.inspector_id || '').trim()
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
    } else {
      const currentInspectorId = String(movedTask.inspector_id || '').trim()
      const movedOutOfInspectorRow = !!sourceInspectorId && sourceInspectorId === currentInspectorId && sourceRowKey !== row.row_key
      if (movedOutOfInspectorRow && canAutoReassignInspectorOnDrop(movedTask)) {
        movedTask = {
          ...movedTask,
          inspector_id: null,
          inspection_mode: 'pending_decision',
          inspection_due_date: null,
          status: autoCleaningStatus(movedTask.status, movedTask.cleaner_id || movedTask.assignee_id || null, null),
        }
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
      assignee_id?: string | null
      assignee_assignment_action?: 'assign' | 'unassign'
      cleaner_id?: string | null
      cleaner_assignment_action?: 'assign' | 'unassign'
      inspector_id?: string | null
      inspector_assignment_action?: 'assign' | 'unassign'
      inspection_mode: TaskCenterTask['inspection_mode']
      inspection_scope: TaskCenterTask['inspection_scope']
      inspection_due_date: string | null
      status_action?: CleaningStatusAction
      status?: string
    }>()
    const workAssignments = new Map<string, {
      task_id: string
      assignee_id?: string | null
      assignee_assignment_action?: 'assign' | 'unassign'
      title: string
      summary: string | null
      scheduled_date: string | null
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
        const taskIds = task.task_source === 'cleaning' ? activeCleaningTaskIds(task) : [task.task_id]
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
            const pureCheckin = isCheckinOnlyCleaningTask(task)
            const current = cleaningAssignmentSnapshot(task)
            const previous = assignmentBaselineRef.current.cleaning.get(id) || null
              const assigneeChanged = previous ? previous.assignee_id !== current.assignee_id : !!current.assignee_id
              const cleanerChanged = previous ? previous.cleaner_id !== current.cleaner_id : !!current.cleaner_id
              const inspectorChanged = previous ? previous.inspector_id !== current.inspector_id : !!current.inspector_id
              const statusAction = current.status_action || null
              const changed = !previous
                || assigneeChanged
                || cleanerChanged
                || inspectorChanged
                || previous.inspection_mode !== current.inspection_mode
                || previous.inspection_scope !== current.inspection_scope
                || previous.inspection_due_date !== current.inspection_due_date
                || !!statusAction
              if (changed) {
                const item: {
                  task_id: string
                  assignee_id?: string | null
                assignee_assignment_action?: 'assign' | 'unassign'
                cleaner_id?: string | null
                cleaner_assignment_action?: 'assign' | 'unassign'
                inspector_id?: string | null
                  inspector_assignment_action?: 'assign' | 'unassign'
                  inspection_mode: TaskCenterTask['inspection_mode']
                  inspection_scope: TaskCenterTask['inspection_scope']
                  inspection_due_date: string | null
                  status_action?: CleaningStatusAction
                  status?: string
                } = {
                  task_id: id,
                  inspection_mode: current.inspection_mode,
                  inspection_scope: current.inspection_scope,
                  inspection_due_date: current.inspection_due_date,
                }
                if (statusAction && current.status) {
                  item.status_action = statusAction
                  item.status = current.status
                }
              if (assigneeChanged && pureCheckin) {
                item.assignee_id = current.assignee_id
                item.assignee_assignment_action = current.assignee_id ? 'assign' : 'unassign'
                item.cleaner_id = null
                item.cleaner_assignment_action = 'unassign'
                item.inspector_id = null
                item.inspector_assignment_action = 'unassign'
              }
              if (cleanerChanged && !pureCheckin) {
                item.cleaner_id = current.cleaner_id
                item.cleaner_assignment_action = current.cleaner_id ? 'assign' : 'unassign'
              }
              if (inspectorChanged && !pureCheckin) {
                item.inspector_id = current.inspector_id
                item.inspector_assignment_action = current.inspector_id ? 'assign' : 'unassign'
              }
              cleaningAssignments.set(id, item)
            }
          } else {
            const current = workAssignmentSnapshot(task)
            const previous = assignmentBaselineRef.current.work.get(id) || null
            const assigneeChanged = previous ? previous.assignee_id !== current.assignee_id : !!current.assignee_id
            const changed = !previous
              || assigneeChanged
              || previous.title !== current.title
              || previous.summary !== current.summary
              || previous.scheduled_date !== current.scheduled_date
              || previous.urgency !== current.urgency
            if (changed) {
              const item: {
                task_id: string
                assignee_id?: string | null
                assignee_assignment_action?: 'assign' | 'unassign'
                title: string
                summary: string | null
                scheduled_date: string | null
                urgency: string | null
              } = {
                task_id: id,
                title: current.title,
                summary: current.summary,
                scheduled_date: current.scheduled_date,
                urgency: current.urgency,
              }
              if (assigneeChanged) {
                item.assignee_id = current.assignee_id
                item.assignee_assignment_action = current.assignee_id ? 'assign' : 'unassign'
              }
              workAssignments.set(id, item)
            }
          }
        }
      }
    }
    for (const task of propertyFollowups) {
      const id = String(task.task_id)
      const current = workAssignmentSnapshot(task)
      const previous = assignmentBaselineRef.current.work.get(id) || null
      const assigneeChanged = previous ? previous.assignee_id !== current.assignee_id : !!current.assignee_id
      const changed = !previous
        || assigneeChanged
        || previous.title !== current.title
        || previous.summary !== current.summary
        || previous.scheduled_date !== current.scheduled_date
        || previous.urgency !== current.urgency
      if (!changed) continue
      const item: {
        task_id: string
        assignee_id?: string | null
        assignee_assignment_action?: 'assign' | 'unassign'
        title: string
        summary: string | null
        scheduled_date: string | null
        urgency: string | null
      } = {
        task_id: id,
        title: current.title,
        summary: current.summary,
        scheduled_date: current.scheduled_date,
        urgency: current.urgency,
      }
      if (assigneeChanged) {
        item.assignee_id = current.assignee_id
        item.assignee_assignment_action = current.assignee_id ? 'assign' : 'unassign'
      }
      workAssignments.set(id, item)
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
        changed_tasks?: { cleaning?: number; work?: number; total?: number }
        push_notifications?: { events?: number; recipients?: number }
        realtime_events?: number
        layout_changed?: boolean
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
      const changedTaskCount = Number(result?.changed_tasks?.total || 0)
      const notifiedRecipients = Number(result?.push_notifications?.recipients || 0)
      const saveSummary = changedTaskCount > 0
        ? `，${changedTaskCount} 个任务有实际变化${notifiedRecipients > 0 ? `，已通知 ${notifiedRecipients} 人` : '，没有发送人员通知'}`
        : (result?.layout_changed ? '，已保存看板排序，没有发送人员通知' : '')
      upsertAdminNotification({
        id: 'task-center-save-status',
        type: 'success',
        title: '任务中心',
        message: `已保存 ${savedAt}${saveSummary}，正在刷新最新数据...`,
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
    const statusMeta = displayStatusMetaForTask(task)
    const displayBadges = displayBadgesForTask(task)
    const inspectionModeTag = task.task_source === 'cleaning'
      && (task.can_configure_inspection || task.deferred_inspection_view)
      && shouldRenderInspectionModeTag(task)
      ? taskInspectionModeMeta(resolvedInspectionModeForTask(task))
      : null
    const inspectionScopeTag = inspectionScopeTagMeta(task)
    const workTaskKindTag = task.task_source === 'work'
      ? { label: task.task_kind || '线下任务', tone: 'special' as const }
      : null
    const detailText = task.skip_reason || (task.task_source === 'cleaning' ? cleaningSecondarySummary(task) : (task.detail || task.summary || ''))
    const assignedStaffId = preferredStaffIdForTask(task)
    const assignedStaffName = assignedStaffId ? String(staffById.get(assignedStaffId)?.name || '').trim() : ''
    const supersededCount = supersededCleaningTaskIds(task).length
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
            <span className={`${styles.statusChip} ${semanticToneClass(statusMeta.tone)} ${styles.taskCenterCompactStatus}`}>{statusMeta.label}</span>
            {displayBadges.length ? (
              <span className={styles.taskCenterCompactMetaGroup}>
                {displayBadges.map((badge) => (
                  <span key={`${task.item_key}:display:${badge.id}`} className={`${styles.taskCenterCompactTag} ${semanticToneClass(badge.tone)}`}>{badge.label}</span>
                ))}
              </span>
            ) : (inspectionModeTag || inspectionScopeTag) ? (
              <span className={styles.taskCenterCompactMetaGroup}>
                {inspectionModeTag ? <span className={`${styles.taskCenterCompactTag} ${semanticToneClass(inspectionModeTag.tone)}`}>{inspectionModeTag.label}</span> : null}
                {inspectionScopeTag ? <span className={`${styles.taskCenterCompactTag} ${semanticToneClass(inspectionScopeTag.tone)}`}>{inspectionScopeTag.label}</span> : null}
              </span>
            ) : null}
            {workTaskKindTag ? (
              <span className={`${styles.taskCenterCompactTag} ${semanticToneClass(workTaskKindTag.tone)}`}>{workTaskKindTag.label}</span>
            ) : null}
            {syncTag ? (
              <span className={`${styles.taskCenterCompactTag} ${semanticToneClass(syncTag.tone)}`}>
                {syncTag.label}
              </span>
            ) : null}
            {timingTags.map((item) => (
              <span
                key={`${task.item_key}:${item.key}`}
                className={`${styles.taskCenterCompactTag} ${semanticToneClass(item.tone)}`}
              >
                {item.label}
              </span>
            ))}
            {task.temporarily_skipped ? (
              <span className={`${styles.taskCenterCompactTag} ${semanticToneClass('pending')}`}>暂不安排</span>
            ) : null}
            {supersededCount > 0 ? (
              <span className={`${styles.taskCenterCompactTag} ${semanticToneClass('info')}`}>已合并{supersededCount}条手动补位</span>
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
  }, [boardSaving, canSeeCheckinSyncTag, cardStyleForTask, dragOverKey, dragPayloadForTask, filteringActive, openTaskDetail, staffById, stripeColorForTask, textColorForTask])

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
    const displayRowTasks = displayRow.lines.flatMap((line) => line.tasks)
    const rowInspectionGate = combinedManagementGate(displayRowTasks.filter((task) => task.task_source === 'cleaning'), 'assign_inspector')
    const rowExecutorGate = combinedManagementGate(displayRowTasks.filter((task) => task.task_source === 'work'), 'assign_executor')
    const rowInspectionDisabledReason = disabledReasonText(rowInspectionGate.disabledReason)
    const rowExecutorDisabledReason = disabledReasonText(rowExecutorGate.disabledReason)
    return (
      <div key={displayRow.row_key} className={styles.taskCenterBoardRow}>
        <div className={styles.taskCenterBoardRowHead}>
          <div className={styles.taskCenterBoardRowActions}>
            {displayRow.row_type === 'final_group' && displayRow.row_key === COMPLETED_ROW_KEY && String(displayRow.row_title || '').trim() ? (
              <span className={`${styles.inlineSemanticPill} ${semanticToneClass('success')}`}>
                {displayRow.row_title}
              </span>
            ) : null}
            {displayRow.row_type === 'deferred' ? (
              <span className={`${styles.inlineSemanticPill} ${semanticToneClass('pending')}`}>
                {displayRow.row_key === DEFERRED_INSPECTION_ROW_KEY ? '延期检查' : '后续处理'}
              </span>
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
	                disabled={boardSaving || !rowInspectionGate.enabled}
	                title={rowInspectionDisabledReason || undefined}
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
	                disabled={boardSaving || !rowExecutorGate.enabled}
	                title={rowExecutorDisabledReason || undefined}
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
  const detailDisplayStatus = detailTask && detailDraft
    ? (detailTask.task_source === 'cleaning'
      ? nextCleaningDetailStatus(detailTask, detailDraft)
      : autoWorkStatus(detailTask.status, detailDraft.assignee_id || null))
    : null
  const detailStatusMeta = detailTask ? displayStatusMetaForTask(detailTask, detailDisplayStatus) : taskStatusMeta(detailDisplayStatus)
  const detailDisplayBadges = detailTask ? displayBadgesForTask(detailTask) : []
  const detailEditGate = detailTask ? managementGateForTask(detailTask, 'edit_task') : { enabled: true, disabledReason: '' }
  const detailAssignCleanerGate = detailTask ? managementGateForTask(detailTask, 'assign_cleaner') : { enabled: true, disabledReason: '' }
  const detailAssignInspectorGate = detailTask ? managementGateForTask(detailTask, 'assign_inspector') : { enabled: true, disabledReason: '' }
  const detailAssignExecutorGate = detailTask ? managementGateForTask(detailTask, 'assign_executor') : { enabled: true, disabledReason: '' }
  const detailInspectionModeGate = detailTask ? managementGateForTask(detailTask, 'set_inspection_mode') : { enabled: true, disabledReason: '' }
  const detailInspectionScopeGate = detailTask ? managementGateForTask(detailTask, 'set_inspection_scope') : { enabled: true, disabledReason: '' }
  const detailKeysHungGate = detailTask ? managementGateForTask(detailTask, 'set_keys_hung') : { enabled: true, disabledReason: '' }
  const detailTaskCompletedGate = detailTask ? managementGateForTask(detailTask, 'set_task_completed') : { enabled: true, disabledReason: '' }
  const detailEditDisabledReason = disabledReasonText(detailEditGate.disabledReason)
  const detailAssignCleanerDisabledReason = disabledReasonText(detailAssignCleanerGate.disabledReason)
  const detailAssignInspectorDisabledReason = disabledReasonText(detailAssignInspectorGate.disabledReason)
  const detailAssignExecutorDisabledReason = disabledReasonText(detailAssignExecutorGate.disabledReason)
  const detailInspectionModeDisabledReason = disabledReasonText(detailInspectionModeGate.disabledReason)
  const detailInspectionScopeDisabledReason = disabledReasonText(detailInspectionScopeGate.disabledReason)
  const detailKeysHungDisabledReason = disabledReasonText(detailKeysHungGate.disabledReason)
  const detailTaskCompletedDisabledReason = disabledReasonText(detailTaskCompletedGate.disabledReason)
  const detailRequiresCleaner = detailTask ? taskSemanticBool(detailTask, 'requires_cleaner', requiresCleanerAssignment(detailTask)) : false
  const detailIsPureCheckin = detailTask ? taskSemanticBool(detailTask, 'is_pure_checkin', isCheckinOnlyCleaningTask(detailTask)) : false
  const detailIsPasswordOnly = detailTask ? taskSemanticBool(detailTask, 'is_password_only', isPasswordOnlyCheckinTask({ ...detailTask, inspection_scope: detailDraft?.inspection_scope || detailTask.inspection_scope })) : false
  const detailUsesExecutorAssignment = detailIsPureCheckin || detailIsPasswordOnly
  const detailSupersededCount = detailTask ? supersededCleaningTaskIds(detailTask).length : 0

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
                <strong title={UNASSIGNED_VISIBLE_SUMMARY_TITLE}>未安排</strong>
                <em>{visibleUnassignedTasks.length} 个</em>
              </span>
              <span className={styles.taskCenterSummaryPill}>
                <strong title={PENDING_INSPECTION_SUMMARY_TITLE}>待确认检查</strong>
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

          {visibleUnassignedTasks.length ? (
            <div className={styles.taskCenterSummaryList}>
              <div className={styles.taskCenterSummaryListLabel}>未安排任务</div>
              <div className={styles.taskCenterSummaryListItems}>
                {visibleUnassignedTasks.map((item) => (
                  <button
                    key={`unassigned:${item.task.item_key}`}
                    type="button"
                    className={styles.taskCenterSummaryListItem}
                    onClick={() => openTaskDetail(item.task, item.row, item.subrow)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

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
              <span className={`${styles.inlineSemanticPill} ${semanticToneClass('normal')}`}>{filteredPropertyFollowups.length} 项</span>
            </div>
            {loading ? (
              <Skeleton active paragraph={{ rows: 2 }} />
            ) : filteredPropertyFollowups.length ? (
              <div className={styles.propertyFollowupGrid}>
                {filteredPropertyFollowups.map((task) => {
                  const meta = propertyFollowupMeta(task)
                  const statusMeta = displayStatusMetaForTask(task)
                  const executorGate = managementGateForTask(task, 'assign_executor')
                  const executorDisabledReason = disabledReasonText(executorGate.disabledReason)
                  return (
                    <div key={task.item_key} className={styles.propertyFollowupCard}>
                      <div className={styles.propertyFollowupCardTop}>
                        <span className={`${styles.inlineSemanticPill} ${semanticToneClass(meta.tone)}`}>{meta.label}</span>
                        <span className={`${styles.statusChip} ${semanticToneClass(statusMeta.tone)}`}>{statusMeta.label}</span>
                      </div>
                      <div className={styles.propertyFollowupProperty}>{task.title}</div>
                      <div className={styles.propertyFollowupDetail}>{task.detail || task.summary || '暂无详情'}</div>
	                      <Select
	                        allowClear
	                        showSearch
	                        optionFilterProp="label"
	                        value={task.assignee_id || undefined}
	                        disabled={boardSaving || !executorGate.enabled}
	                        title={executorDisabledReason || undefined}
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
        okButtonProps={{
          disabled: !detailEditGate.enabled,
          title: detailEditDisabledReason || undefined,
        }}
        destroyOnClose
      >
        {detailTask && detailDraft ? (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <div className={styles.taskDetailHero}>
                <div className={styles.taskDetailHeroTop}>
                  <div className={styles.taskDetailHeroTitle}>{detailTask.title}</div>
                  <div className={styles.taskDetailHeroChips}>
	                    <span className={`${styles.taskDetailChip} ${semanticToneClass(detailStatusMeta.tone)}`}>{detailStatusMeta.label}</span>
	                    {detailSyncTag ? (
	                      <span className={`${styles.taskDetailChip} ${semanticToneClass(detailSyncTag.tone)}`}>
	                        {detailSyncTag.label}
	                      </span>
	                    ) : null}
	                    {detailDisplayBadges.length ? detailDisplayBadges.map((badge) => (
	                      <span key={`detail:${detailTask.item_key}:display:${badge.id}`} className={`${styles.taskDetailChip} ${semanticToneClass(badge.tone)}`}>{badge.label}</span>
	                    )) : detailTask.task_source === 'cleaning'
	                      ? (shouldShowInspectionModeTag({
	                          inspectionScope: detailDraft.inspection_scope,
	                          isCheckinOnly: isCheckinOnlyCleaningTask(detailTask),
                        })
                        ? <span className={`${styles.taskDetailChip} ${semanticToneClass(taskInspectionModeMeta(detailDraft.inspection_mode).tone)}`}>{taskInspectionModeMeta(detailDraft.inspection_mode).label}</span>
                        : null)
                      : (
                        <span className={`${styles.taskDetailChip} ${semanticToneClass('special')}`}>{detailTask.task_kind || '线下任务'}</span>
                      )}
                    {detailTask.task_source === 'cleaning' && isCheckinOnlyCleaningTask(detailTask) ? (
                      <span className={`${styles.taskDetailChip} ${semanticToneClass(taskInspectionScopeMeta(detailDraft.inspection_scope).tone)}`}>{inspectionScopeLabel(detailDraft.inspection_scope)}</span>
                    ) : null}
                    {specialTimingTags(detailTask).map((item) => (
                      <span
                        key={`detail:${detailTask.item_key}:${item.key}`}
                        className={`${styles.taskDetailChip} ${semanticToneClass(item.tone)}`}
                      >
                        {item.label}
                      </span>
                    ))}
                    {detailTask.temporarily_skipped ? <span className={`${styles.taskDetailChip} ${semanticToneClass('pending')}`}>暂不安排</span> : null}
                    {detailSupersededCount > 0 ? <span className={`${styles.taskDetailChip} ${semanticToneClass('info')}`}>已合并{detailSupersededCount}条手动补位</span> : null}
                  </div>
                </div>
              <div className={styles.taskDetailHeroSummary}>{detailHeroSummary(detailTask) || '暂无详情'}</div>
            </div>
            {detailTask.task_source === 'cleaning' ? (
              <>
                <div className={styles.taskDetailGrid}>
	                  {detailRequiresCleaner ? (
	                    <div>
	                      <div className={styles.fieldLabel}>清洁人员</div>
	                      <Select
                        allowClear
                        showSearch
	                        optionFilterProp="label"
	                        value={detailDraft.cleaner_id || undefined}
	                        disabled={!detailAssignCleanerGate.enabled}
	                        title={detailAssignCleanerDisabledReason || undefined}
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
	                      disabled={!detailInspectionModeGate.enabled}
	                      title={detailInspectionModeDisabledReason || undefined}
	                      onChange={(value) => setDetailDraft((prev) => {
                        if (!prev) return prev
                        const nextMode = value as TaskDetailDraft['inspection_mode']
                        return {
                          ...prev,
                          task_completed: false,
                          keys_hung: false,
                          inspection_mode: nextMode,
                          inspection_scope: nextMode === 'self_complete' ? 'inspect_and_hang' : prev.inspection_scope,
                          inspection_due_date: nextMode === 'deferred' ? prev.inspection_due_date : null,
                          inspector_id: nextMode === 'pending_decision' || nextMode === 'self_complete' || nextMode === 'checked_done' ? null : prev.inspector_id,
                        }
                      })}
                      style={{ width: '100%' }}
                      options={taskCenterInspectionModeOptions({
                        inspectionScope: detailDraft.inspection_scope,
                        isCheckinOnly: isCheckinOnlyCleaningTask(detailTask),
                      })}
                    />
                  </div>
	                  {detailIsPureCheckin ? (
	                    <div>
	                      <div className={styles.fieldLabel}>检查执行方式</div>
	                      <Select
	                        value={detailDraft.inspection_scope}
	                        disabled={!detailInspectionScopeGate.enabled}
	                        title={detailInspectionScopeDisabledReason || undefined}
	                        onChange={(value) => setDetailDraft((prev) => {
                          if (!prev) return prev
                          const nextScope = normalizeInspectionScope(String(value || ''))
                          const nextMode = isInspectionModeAllowedForTask({
                            inspectionMode: prev.inspection_mode,
                            inspectionScope: nextScope,
                            isCheckinOnly: true,
                          })
                            ? prev.inspection_mode
                            : 'same_day'
                          return {
                            ...prev,
                            inspection_scope: nextScope,
                            inspection_mode: nextMode,
                            assignee_id: prev.assignee_id || prev.inspector_id || prev.cleaner_id || null,
                            inspector_id: null,
                            cleaner_id: null,
                            inspection_due_date: nextMode === 'deferred' ? prev.inspection_due_date : null,
                          }
                        })}
                        style={{ width: '100%' }}
                        options={[
                          { label: '检查后挂钥匙', value: 'inspect_and_hang' },
                          { label: '仅改密码', value: 'password_only' },
                        ]}
                      />
                    </div>
                  ) : <div />}
                </div>
                {(detailDraft.inspection_mode === 'deferred' || detailTask.deferred_inspection_view) ? (
                  <div className={`${styles.taskDetailHint} ${semanticToneClass('pending')}`}>
                    <div className={styles.taskDetailHintRow}>
                      <span>任务已结束</span>
	                      <Switch
	                        checked={detailDraft.task_completed}
	                        disabled={!detailTaskCompletedGate.enabled}
	                        title={detailTaskCompletedDisabledReason || undefined}
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
                    <div className={styles.taskDetailHintCopy}>打开后保存安排，这个延期检查会标记为已完成并从待检查列表移出。</div>
                  </div>
                ) : null}
	                {detailIsPureCheckin ? (
	                  <div className={`${styles.taskDetailHint} ${semanticToneClass('success')}`}>
                    <div className={styles.taskDetailHintRow}>
                      <span>已挂钥匙</span>
	                      <Switch
	                        checked={detailDraft.keys_hung}
	                        disabled={!detailKeysHungGate.enabled}
	                        title={detailKeysHungDisabledReason || undefined}
	                        onChange={(checked) => setDetailDraft((prev) => {
                          if (!prev) return prev
                          if (checked) {
                            return {
                              ...prev,
                              keys_hung: true,
                              task_completed: false,
                            }
                          }
                          return { ...prev, keys_hung: false }
                        })}
                      />
                    </div>
                    <div className={styles.taskDetailHintCopy}>适用于纯入住任务已经提前检查、钥匙也已经挂好的情况。</div>
                  </div>
                ) : null}
                {detailDraft.inspection_mode === 'self_complete' ? (
                  <div className={`${styles.taskDetailHint} ${semanticToneClass('special')}`}>
                    <div className={styles.taskDetailHintRow}>
                      <span>自完成</span>
                    </div>
                    <div className={styles.taskDetailHintCopy}>无需检查人员，现场自行完成补货、拍照和钥匙上传。</div>
                  </div>
                ) : null}
                {detailDraft.inspection_mode === 'checked_done' ? (
                  <div className={`${styles.taskDetailHint} ${semanticToneClass('success')}`}>
                    <div className={styles.taskDetailHintRow}>
                      <span>已检查</span>
                    </div>
                    <div className={styles.taskDetailHintCopy}>房源已检查完毕，不再安排检查人员。</div>
                  </div>
                ) : null}
                {((!detailDraft.task_completed || detailDraft.keys_hung) && (detailDraft.inspection_mode === 'same_day' || detailDraft.inspection_mode === 'deferred')) ? (
                  <div className={styles.taskDetailGrid}>
                    <div>
	                      <div className={styles.fieldLabel}>{detailUsesExecutorAssignment ? '执行人' : '检查人员'}</div>
	                      <Select
                        allowClear
                        showSearch
                        optionFilterProp="label"
	                        value={detailUsesExecutorAssignment ? (detailDraft.assignee_id || undefined) : (detailDraft.inspector_id || undefined)}
	                        disabled={detailUsesExecutorAssignment ? !detailAssignExecutorGate.enabled : !detailAssignInspectorGate.enabled}
	                        title={(detailUsesExecutorAssignment ? detailAssignExecutorDisabledReason : detailAssignInspectorDisabledReason) || undefined}
	                        onChange={(value) => setDetailDraft((prev) => {
	                          if (!prev) return prev
	                          const nextValue = value ? String(value) : null
	                          if (detailUsesExecutorAssignment) {
	                            return { ...prev, assignee_id: nextValue, inspector_id: null, cleaner_id: null }
	                          }
	                          return { ...prev, inspector_id: nextValue }
	                        })}
	                        style={{ width: '100%' }}
	                        options={detailUsesExecutorAssignment ? allStaffOptions : inspectorOptions}
	                      />
                    </div>
                    {detailDraft.inspection_mode === 'deferred' ? (
                      <div>
                        <div className={styles.fieldLabel}>检查日期</div>
	                        <DatePicker
	                          value={detailDraft.inspection_due_date}
	                          disabled={!detailInspectionModeGate.enabled}
	                          title={detailInspectionModeDisabledReason || undefined}
	                          onChange={(value) => setDetailDraft((prev) => (prev ? { ...prev, inspection_due_date: value } : prev))}
	                          style={{ width: '100%' }}
	                        />
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
	                    <Input
	                      value={detailDraft.title}
	                      disabled={!detailEditGate.enabled}
	                      title={detailEditDisabledReason || undefined}
	                      onChange={(e) => setDetailDraft((prev) => (prev ? { ...prev, title: e.target.value } : prev))}
	                    />
	                  </div>
                  <div>
                    <div className={styles.fieldLabel}>执行人</div>
                    <Select
                      allowClear
                      showSearch
	                      optionFilterProp="label"
	                      value={detailDraft.assignee_id || undefined}
	                      disabled={!detailAssignExecutorGate.enabled}
	                      title={detailAssignExecutorDisabledReason || undefined}
	                      onChange={(value) => setDetailDraft((prev) => (prev ? { ...prev, assignee_id: value ? String(value) : null } : prev))}
                      style={{ width: '100%' }}
                      options={allStaffOptions}
                    />
                  </div>
                </div>
	                <div>
	                  <div className={styles.fieldLabel}>任务详情</div>
	                  <Input.TextArea
	                    rows={4}
	                    value={detailDraft.summary}
	                    disabled={!detailEditGate.enabled}
	                    title={detailEditDisabledReason || undefined}
	                    onChange={(e) => setDetailDraft((prev) => (prev ? { ...prev, summary: e.target.value } : prev))}
	                  />
	                </div>
                <div className={styles.taskDetailGrid}>
                  <div>
                    <div className={styles.fieldLabel}>紧急程度</div>
	                    <Select
	                      value={detailDraft.urgency}
	                      disabled={!detailEditGate.enabled}
	                      title={detailEditDisabledReason || undefined}
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
            <div className={`${styles.taskCenterSkipCard} ${semanticToneClass('pending')}`}>
              <div className={styles.taskCenterSkipHead}>
                <div className={styles.taskDetailSkipTitle}>
                  <div className={styles.fieldLabel} style={{ marginBottom: 0 }}>暂不安排</div>
                  <span className={styles.taskDetailSkipHint}>
                    {detailTask.task_source === 'work'
                      ? '可留在当天后续处理，或选一个日期挪到那天变成未安排任务'
                      : '打开后可把任务移出当日安排'}
                  </span>
                </div>
	                <Switch
	                  checked={detailDraft.temporarily_skipped}
	                  disabled={!detailEditGate.enabled}
	                  title={detailEditDisabledReason || undefined}
	                  onChange={(checked) => setDetailDraft((prev) => (prev ? { ...prev, temporarily_skipped: checked } : prev))}
	                />
              </div>
              {detailTask.task_source === 'work' && detailDraft.temporarily_skipped ? (
                <div>
                  <div className={styles.fieldLabel}>挪到日期</div>
	                  <DatePicker
	                    value={detailDraft.deferred_to_date}
	                    disabled={!detailEditGate.enabled}
	                    title={detailEditDisabledReason || undefined}
	                    onChange={(value) => setDetailDraft((prev) => (prev ? { ...prev, deferred_to_date: value } : prev))}
                    style={{ width: '100%' }}
                    placeholder="不选则留在当天后续处理"
                  />
                </div>
              ) : null}
	              <Input.TextArea
	                rows={3}
	                value={detailDraft.skip_reason}
	                disabled={!detailEditGate.enabled}
	                title={detailEditDisabledReason || undefined}
	                onChange={(e) => setDetailDraft((prev) => (prev ? { ...prev, skip_reason: e.target.value } : prev))}
                placeholder="例如：今天不检查 / 下次退房再修 / 暂不跟清洁走"
              />
            </div>
          </Space>
        ) : null}
      </Modal>

    </div>
  )
}
