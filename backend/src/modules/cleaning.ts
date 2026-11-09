import { Router } from 'express'
import { z } from 'zod'
import { requireAnyPerm, requirePerm, userHasAnyPerm } from '../auth'
import { addAudit, db } from '../store'
import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'
import { activeCleaningTaskWhereSql, assertPasswordAuthorityTaskMutable, backfillCleaningTasks, claimTaskPasswordAuthorityFields, confirmTaskPasswordAuthority, ensureCleaningSchemaV2, invalidatePasswordDependentsForSourceTask, isCancelledCleaningTaskStatus, isInactiveCleaningOrderStatus, lockCleaningPasswordChainKey, lockCleaningTurnoverKey, lockCleaningTurnoverKeys, normalizeCleaningPasswordChainKeys, normalizeCleaningTurnoverTargetKeys, reconcilePasswordAuthorityAfterTaskTopologyChange, syncCheckoutOldCodeFromCheckinNewCode, syncNextCheckinOldCodeFromSourceOrder, syncOrderToCleaningTasks, validCleaningTaskOrderWhereSql, type PasswordAuthorityAuditContext } from '../services/cleaningSync'
import { v4 as uuid, v5 as uuidv5 } from 'uuid'
import { emitNotificationEvent } from '../services/notificationEvents'
import { buildCleaningTaskVisibilityHints, buildMz031CleaningArrangementRevision, buildWorkTaskVisibilityHints, emitWorkTaskEvent } from '../services/workTaskEvents'
import { canonicalCleaningTurnoverPairs, canonicalKeyHandoverSourceIds, defaultInspectionModeForTaskType, deferredProjectionDate, effectiveInspectionMode, normalizeInspectionMode, normalizeInspectionScope } from '../lib/cleaningInspection'
import { buildWebTaskCapabilityPayload } from '../lib/webTaskCapabilities'
import { assignedStatusFromAssignees, isCheckinSiteExecutionTask } from '../lib/cleaningAssignmentStatus'
import { buildCleaningTurnoverDisplay, cleaningTaskNewCodeForDisplay, cleaningTaskOldCodeForDisplay } from '../lib/cleaningTurnoverDisplay'
import { shouldIgnoreNightsOverrideForAutoCheckinTask } from '../lib/cleaningTaskNightOverride'
import { isTaskExecutorEligibleRoleNames } from '../services/taskExecutorEligibility'
import { emitDeferredInspectionCheckinConflictAlerts, isDeferredInspectionCheckinConflictRelevantChange, reconcileDeferredInspectionCheckinReplacement } from '../services/deferredInspectionCheckinConflict'
import { requireR5TaskRuntimeSchema } from '../lib/r5RequestSchema'
import { isPasswordAuthoritySchemaReady } from '../lib/passwordAuthoritySchema'
import { inspectionAssignmentConflictPayload } from '../lib/inspectionAssignmentConflict'
import { redactPasswordAuditValues } from '../lib/passwordAudit'
import { createHmac } from 'crypto'
import {
  IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH,
  IdempotentStepReceiptsNotReady,
  assertIdempotentStepReceiptsReady,
  buildCanonicalIdempotencyPayloadHmac,
  buildIdempotencyPayloadHash,
  loadIdempotentStepReceipt,
  saveIdempotentStepReceipt,
} from '../lib/idempotentStepReceipts'
import { isTerminalCleaningStatus } from '../lib/workTaskActionAudit'

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

const TURNOVER_INSPECTION_SCOPE_CONFLICT = 'turnover_requires_inspect_and_hang'
const MANUAL_CHECKIN_LINK_CONFLICT = 'manual_checkin_checkout_link_conflict'
const MANUAL_CHECKIN_LINK_DECISION_REQUIRED = 'manual_checkin_checkout_link_decision_required'
const CHECKIN_LINK_CANDIDATES_UNAVAILABLE = 'checkin_link_candidates_unavailable'
const MANUAL_CHECKOUT_LINK_CONFLICT = 'manual_checkout_checkin_link_conflict'
const CHECKOUT_LINK_CANDIDATES_UNAVAILABLE = 'checkout_link_candidates_unavailable'
const TURNOVER_LINK_TOPOLOGY_CONFLICT = 'turnover_link_topology_conflict'
const MANUAL_CREATE_REPLAY_CONFLICT = 'manual_cleaning_create_replay_conflict'
const MANUAL_CREATE_REPLAY_INACTIVE = 'manual_cleaning_create_replay_inactive'
const MANUAL_CREATE_REQUEST_NAMESPACE = '88d8cd80-31f8-4e21-9d2e-5ed7cb83caaa'

type ManualCheckinLinkDecision = 'link' | 'independent' | null
type ManualCheckoutLinkDecision = 'link' | 'independent' | null

function memoryCanonicalCleaningPropertyId(value: any): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  const properties = Array.isArray((db as any)?.properties) ? (db as any).properties : []
  const property = properties.find((candidate: any) => (
    String(candidate?.id || '').trim().toLowerCase() === lower
    || String(candidate?.code || '').trim().toLowerCase() === lower
  ))
  return String(property?.id || raw).trim() || raw
}

function turnoverPropertyId(value: any): string {
  const raw = value && typeof value === 'object'
    ? String(value?.canonical_property_id ?? value?.normalized_property_id ?? value?.property_id ?? '').trim()
    : String(value || '').trim()
  return hasPg ? raw : memoryCanonicalCleaningPropertyId(raw)
}

function linkedOrderTurnoverPropertyId(row: any): string {
  return String(row?.linked_order_canonical_property_id ?? row?.linked_order_property_id ?? '').trim()
}

type ManualCreateMemoryReceipt = {
  requestHash: string
  taskIds: string[]
  taskTypes: string[]
}

const manualCreateMemoryReceipts = new Map<string, ManualCreateMemoryReceipt>()

function stableManualCreateValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableManualCreateValue)
  if (!value || typeof value !== 'object') return value === undefined ? null : value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableManualCreateValue(value[key])]))
}

function manualCreateRequestHash(value: any): string {
  const secret = String(process.env.JWT_SECRET || 'dev-secret')
  return createHmac('sha256', secret).update(JSON.stringify(stableManualCreateValue(value))).digest('hex')
}

function isActiveManualCreateReplayRow(row: any): boolean {
  return isActiveTurnoverLinkRow(row)
}

class ManualCreateReplayConflict extends Error {
  readonly code: string
  readonly status = 409
  constructor(message: string, code = MANUAL_CREATE_REPLAY_CONFLICT) {
    super(message)
    this.name = 'ManualCreateReplayConflict'
    this.code = code
  }
}

class ManualCheckinLinkConflict extends Error {
  readonly code = MANUAL_CHECKIN_LINK_CONFLICT
  readonly status = 409
  constructor(message: string) {
    super(message)
    this.name = 'ManualCheckinLinkConflict'
  }
}

class ManualCheckinLinkDecisionRequired extends Error {
  readonly code = MANUAL_CHECKIN_LINK_DECISION_REQUIRED
  readonly status = 409
  readonly candidateCount: number
  constructor(message: string, candidateCount: number) {
    super(message)
    this.name = 'ManualCheckinLinkDecisionRequired'
    this.candidateCount = candidateCount
  }
}

class ManualCheckoutLinkConflict extends Error {
  readonly code = MANUAL_CHECKOUT_LINK_CONFLICT
  readonly status = 409
  constructor(message: string) {
    super(message)
    this.name = 'ManualCheckoutLinkConflict'
  }
}

class TurnoverLinkTopologyConflict extends Error {
  readonly code = TURNOVER_LINK_TOPOLOGY_CONFLICT
  readonly status = 409
  constructor(message: string) {
    super(message)
    this.name = 'TurnoverLinkTopologyConflict'
  }
}

function assertManualCheckinCheckoutLink(params: {
  linkedCheckoutTaskId: string | null
  createdTypes: string[]
  propertyId: string
  taskDate: string
  checkoutTask: any | null
  activeCheckinRows: any[]
}) {
  const linkedCheckoutTaskId = String(params.linkedCheckoutTaskId || '').trim()
  if (!linkedCheckoutTaskId) return null
  if (params.createdTypes.length !== 1 || params.createdTypes[0] !== 'checkin_clean') {
    throw new ManualCheckinLinkConflict('只有单独新增入住任务可以关联退房任务')
  }
  const checkout = params.checkoutTask
  if (!checkout || !String(checkout.id || '').trim()) throw new ManualCheckinLinkConflict('关联的退房任务不存在或已失效')
  const checkoutType = String(checkout.task_type ?? checkout.type ?? '').trim().toLowerCase()
  const checkoutState = String(checkout.execution_state || '').trim().toLowerCase()
  const checkoutStatus = String(checkout.status || '').trim().toLowerCase()
  if (checkoutType !== 'checkout_clean'
    || ['cancelled', 'canceled', 'superseded', 'deleted'].includes(checkoutState)
    || ['cancelled', 'canceled'].includes(checkoutStatus)) {
    throw new ManualCheckinLinkConflict('关联的退房任务不是有效的退房任务')
  }
  if (turnoverPropertyId(checkout) !== turnoverPropertyId(params.propertyId)
    || dayOnly(checkout.task_date ?? checkout.date) !== dayOnly(params.taskDate)) {
    throw new ManualCheckinLinkConflict('入住与退房必须属于同一房源和同一业务日期')
  }
  const conflicts = (Array.isArray(params.activeCheckinRows) ? params.activeCheckinRows : [])
    .filter((row) => String(row.id || '').trim())
  if (conflicts.length) throw new ManualCheckinLinkConflict('该退房任务已有有效入住任务，不能重复关联')
  return linkedCheckoutTaskId
}

function activeManualTurnoverRows(rows0: any[], propertyId: string, taskDate: string): any[] {
  return (Array.isArray(rows0) ? rows0 : []).filter((row) => {
    const executionState = String(row?.execution_state || '').trim().toLowerCase()
    const lifecycleState = String(row?.lifecycle_state || '').trim().toLowerCase()
    const status = String(row?.status || '').trim().toLowerCase()
    return turnoverPropertyId(row) === turnoverPropertyId(propertyId)
      && dayOnly(row?.task_date ?? row?.date) === dayOnly(taskDate)
      && (!executionState || executionState === 'active')
      && lifecycleState !== 'deleted'
      && !['cancelled', 'canceled', 'superseded', 'deleted'].includes(status)
  })
}

function isActiveTurnoverLinkRow(row: any): boolean {
  const executionState = String(row?.execution_state || '').trim().toLowerCase()
  const lifecycleState = String(row?.lifecycle_state || '').trim().toLowerCase()
  const status = String(row?.status || '').trim().toLowerCase()
  return (!executionState || executionState === 'active')
    && lifecycleState !== 'deleted'
    && !['cancelled', 'canceled', 'superseded', 'deleted'].includes(status)
}

function manualTurnoverTaskOrderIsEligible(row: any, propertyId: string, taskDate: string): boolean {
  const orderId = String(row?.order_id || '').trim()
  if (!orderId) return true
  const linkedOrderId = String(row?.linked_order_id || '').trim()
  const linkedOrderPropertyId = linkedOrderTurnoverPropertyId(row)
  if (!linkedOrderId || linkedOrderId !== orderId) return false
  if (isInactiveCleaningOrderStatus(row?.linked_order_status)) return false
  if (!linkedOrderPropertyId || linkedOrderPropertyId !== turnoverPropertyId(propertyId)) return false
  const taskType = String(row?.task_type ?? row?.type ?? '').trim().toLowerCase()
  const boundary = taskType === 'checkout_clean'
    ? row?.order_checkout
    : taskType === 'checkin_clean'
      ? row?.order_checkin
      : null
  return !!boundary && dayOnly(boundary) === dayOnly(taskDate)
}

function reliableManualCheckinCheckoutCandidates(rows0: any[], propertyId: string, taskDate: string): any[] {
  const rows = activeManualTurnoverRows(rows0, propertyId, taskDate)
  const alreadyPairedCheckoutIds = new Set<string>()
  for (const row of rows) {
    if (String(row?.task_type ?? row?.type ?? '').trim().toLowerCase() !== 'checkin_clean') continue
    const linkedCheckoutTaskId = String(row?.linked_checkout_task_id || '').trim()
    if (linkedCheckoutTaskId) alreadyPairedCheckoutIds.add(linkedCheckoutTaskId)
  }
  const canonicalRows = rows.filter((row) => manualTurnoverTaskOrderIsEligible(row, propertyId, taskDate))
  const canonicalCheckouts = canonicalRows.filter((row) => String(row?.task_type ?? row?.type ?? '').trim().toLowerCase() === 'checkout_clean')
  const canonicalCheckins = canonicalRows.filter((row) => String(row?.task_type ?? row?.type ?? '').trim().toLowerCase() === 'checkin_clean')
  for (const checkout of canonicalCheckouts) {
    for (const checkin of canonicalCheckins) {
      if (canonicalKeyHandoverSourceIds([checkout, checkin]).length !== 2) continue
      const checkoutId = String(checkout?.id || checkout?.__raw_id || '').trim()
      if (checkoutId) alreadyPairedCheckoutIds.add(checkoutId)
    }
  }
  return rows.filter((row) => {
    const taskType = String(row?.task_type ?? row?.type ?? '').trim().toLowerCase()
    const id = String(row?.id || '').trim()
    return taskType === 'checkout_clean'
      && !!id
      && manualTurnoverTaskOrderIsEligible(row, propertyId, taskDate)
      && !alreadyPairedCheckoutIds.has(id)
  })
}

function reliableManualCheckoutCheckinCandidates(rows0: any[], propertyId: string, taskDate: string): any[] {
  const rows = activeManualTurnoverRows(rows0, propertyId, taskDate)
  const activeCheckoutIds = new Set(rows
    .filter((row) => String(row?.task_type ?? row?.type ?? '').trim().toLowerCase() === 'checkout_clean')
    .map((row) => String(row?.id || row?.__raw_id || '').trim())
    .filter(Boolean))
  const occupiedCheckinIds = new Set<string>()
  for (const row of rows) {
    if (String(row?.task_type ?? row?.type ?? '').trim().toLowerCase() !== 'checkin_clean') continue
    const linkedCheckoutTaskId = String(row?.linked_checkout_task_id || '').trim()
    const checkinId = String(row?.id || row?.__raw_id || '').trim()
    if (checkinId && linkedCheckoutTaskId && activeCheckoutIds.has(linkedCheckoutTaskId)) occupiedCheckinIds.add(checkinId)
  }
  const canonicalRows = rows.filter((row) => manualTurnoverTaskOrderIsEligible(row, propertyId, taskDate))
  const canonicalCheckouts = canonicalRows.filter((row) => String(row?.task_type ?? row?.type ?? '').trim().toLowerCase() === 'checkout_clean')
  const canonicalCheckins = canonicalRows.filter((row) => String(row?.task_type ?? row?.type ?? '').trim().toLowerCase() === 'checkin_clean')
  for (const checkout of canonicalCheckouts) {
    for (const checkin of canonicalCheckins) {
      if (canonicalKeyHandoverSourceIds([checkout, checkin]).length !== 2) continue
      const checkinId = String(checkin?.id || checkin?.__raw_id || '').trim()
      if (checkinId) occupiedCheckinIds.add(checkinId)
    }
  }
  return rows.filter((row) => {
    const taskType = String(row?.task_type ?? row?.type ?? '').trim().toLowerCase()
    const id = String(row?.id || row?.__raw_id || '').trim()
    return taskType === 'checkin_clean'
      && !!id
      && normalizeInspectionScope(row?.inspection_scope) !== 'password_only'
      && manualTurnoverTaskOrderIsEligible(row, propertyId, taskDate)
      && !occupiedCheckinIds.has(id)
  })
}

function resolveManualCheckoutCheckinSelection(params: {
  linkedCheckinTaskId: string | null
  decision: ManualCheckoutLinkDecision
  createdTypes: string[]
  propertyId: string
  taskDate: string
  sameDayRows: any[]
}): string | null {
  const linkedCheckinTaskId = String(params.linkedCheckinTaskId || '').trim() || null
  const isSingleCheckout = params.createdTypes.length === 1 && params.createdTypes[0] === 'checkout_clean'
  if (!isSingleCheckout) {
    if (linkedCheckinTaskId || params.decision) throw new ManualCheckoutLinkConflict('只有单独新增退房任务可以选择关联或独立创建')
    return null
  }

  // Missing fields mean an older checkout client. Preserve its historical
  // independent-create behaviour; only updated clients make a relationship
  // decision. The server never guesses from room/date alone.
  if (!linkedCheckinTaskId && !params.decision) return null

  const activeRows = activeManualTurnoverRows(params.sameDayRows, params.propertyId, params.taskDate)
  const candidates = reliableManualCheckoutCheckinCandidates(activeRows, params.propertyId, params.taskDate)
  if (linkedCheckinTaskId) {
    if (params.decision === 'independent') throw new ManualCheckoutLinkConflict('已选择独立退房，不能同时关联入住任务')
    const checkinTask = activeRows.find((row) => String(row?.id || '').trim() === linkedCheckinTaskId) || null
    if (!checkinTask || String(checkinTask?.task_type ?? checkinTask?.type ?? '').trim().toLowerCase() !== 'checkin_clean') {
      throw new ManualCheckoutLinkConflict('关联的入住任务不存在或已失效')
    }
    if (normalizeInspectionScope(checkinTask?.inspection_scope) === 'password_only') {
      throw new ManualCheckoutLinkConflict('仅挂钥匙入住不能静默改为周转检查，请先明确改为检查后挂钥匙')
    }
    if (!candidates.some((candidate) => String(candidate?.id || '').trim() === linkedCheckinTaskId)) {
      throw new ManualCheckoutLinkConflict('所选入住任务已有可靠退房或不再可合并，请刷新后重新选择')
    }
    return linkedCheckinTaskId
  }
  if (params.decision === 'link') throw new ManualCheckoutLinkConflict('请选择要合并的入住任务')
  return null
}

function memoryTaskWithOrderBoundaries(task: any): any {
  const orderId = String(task?.order_id || '').trim()
  const canonicalPropertyId = memoryCanonicalCleaningPropertyId(task?.property_id)
  if (!orderId) return { ...task, property_id: canonicalPropertyId, canonical_property_id: canonicalPropertyId }
  const order = ((db as any)?.orders || []).find((candidate: any) => String(candidate?.id || '').trim() === orderId)
  return order
    ? {
        ...task,
        property_id: canonicalPropertyId,
        canonical_property_id: canonicalPropertyId,
        linked_order_id: String(order.id || ''),
        linked_order_property_id: memoryCanonicalCleaningPropertyId(order.property_id) || null,
        linked_order_canonical_property_id: memoryCanonicalCleaningPropertyId(order.property_id) || null,
        linked_order_status: order.status ?? null,
        order_checkin: order.checkin ?? null,
        order_checkout: order.checkout ?? null,
      }
    : {
        ...task,
        property_id: canonicalPropertyId,
        canonical_property_id: canonicalPropertyId,
        linked_order_id: null,
        linked_order_property_id: null,
        linked_order_status: null,
        order_checkin: null,
        order_checkout: null,
      }
}

function reliableTurnoverCounterparts(current0: any, rows0: any[]): any[] {
  const current = current0 || {}
  const currentId = String(current?.id || current?.__raw_id || '').trim()
  const rows = (Array.isArray(rows0) ? rows0 : []).filter((row) => {
    const rowId = String(row?.id || row?.__raw_id || '').trim()
    return rowId && rowId !== currentId
  })
  const allRows = [current, ...rows]
  const canonicalPairs = canonicalCleaningTurnoverPairs(allRows)
  const canonicalIds = new Set(canonicalPairs
    .filter((pair) => pair.source_ids.includes(currentId))
    .flatMap((pair) => pair.source_ids))

  return rows.filter((candidate) => {
    const candidateId = String(candidate?.id || candidate?.__raw_id || '').trim()
    if (canonicalIds.has(candidateId)) return true
    // An explicit manual link remains authoritative even when another valid
    // booking exists for the same room/date; it must not be weakened by the
    // canonical ambiguity fail-closed rule.
    return canonicalKeyHandoverSourceIds([current, candidate]).length === 2
      && (String(current?.linked_checkout_task_id || '').trim() === candidateId
        || String(candidate?.linked_checkout_task_id || '').trim() === currentId)
  })
}

function resolveManualCheckinCheckoutSelection(params: {
  linkedCheckoutTaskId: string | null
  decision: ManualCheckinLinkDecision
  createdTypes: string[]
  propertyId: string
  taskDate: string
  sameDayRows: any[]
}): string | null {
  const linkedCheckoutTaskId = String(params.linkedCheckoutTaskId || '').trim() || null
  const decision = params.decision
  const isSingleCheckin = params.createdTypes.length === 1 && params.createdTypes[0] === 'checkin_clean'
  if (!isSingleCheckin) {
    if (linkedCheckoutTaskId || decision) throw new ManualCheckinLinkConflict('只有单独新增入住任务可以选择关联或独立创建')
    return null
  }

  const activeRows = activeManualTurnoverRows(params.sameDayRows, params.propertyId, params.taskDate)
  const candidates = reliableManualCheckinCheckoutCandidates(activeRows, params.propertyId, params.taskDate)

  if (linkedCheckoutTaskId) {
    if (decision === 'independent') throw new ManualCheckinLinkConflict('已选择独立入住，不能同时关联退房任务')
    const checkoutTask = activeRows.find((row) => String(row?.id || '').trim() === linkedCheckoutTaskId) || null
    const activeLinked = activeRows.filter((row) => (
      String(row?.linked_checkout_task_id || '').trim() === linkedCheckoutTaskId
      && String(row?.task_type ?? row?.type ?? '').trim().toLowerCase() === 'checkin_clean'
    ))
    assertManualCheckinCheckoutLink({
      linkedCheckoutTaskId,
      createdTypes: params.createdTypes,
      propertyId: params.propertyId,
      taskDate: params.taskDate,
      checkoutTask,
      activeCheckinRows: activeLinked,
    })
    if (!candidates.some((candidate) => String(candidate?.id || '').trim() === linkedCheckoutTaskId)) {
      throw new ManualCheckinLinkConflict('所选退房任务已有关联入住或不再可合并，请刷新后重新选择')
    }
    return linkedCheckoutTaskId
  }

  if (decision === 'link') {
    throw new ManualCheckinLinkDecisionRequired('请选择要合并的退房任务', candidates.length)
  }
  if (decision === 'independent') return null
  if (candidates.length > 0) {
    const message = candidates.length === 1
      ? '检测到一个可关联退房任务，请确认合并或明确创建独立入住'
      : `检测到 ${candidates.length} 个可关联退房任务，请选择其中一个或明确创建独立入住`
    throw new ManualCheckinLinkDecisionRequired(message, candidates.length)
  }
  return null
}

function turnoverInspectionScopeTarget(current: any, patch: any = {}) {
  const taskKind = String(patch?.task_type ?? current?.task_type ?? current?.type ?? '').trim().toLowerCase()
  const source = String(patch?.source ?? current?.source ?? '').trim().toLowerCase()
  const linkedCheckoutTaskId = String(patch?.linked_checkout_task_id ?? current?.linked_checkout_task_id ?? '').trim()
  // An explicitly independent manual check-in is not a turnover merely
  // because another task shares its room and date. Only the persisted link
  // may place that manual check-in under the turnover scope rule.
  if (taskKind === 'checkin_clean' && source === 'manual' && !linkedCheckoutTaskId) return null
  const oppositeKind = taskKind === 'checkout_clean'
    ? 'checkin_clean'
    : taskKind === 'checkin_clean'
      ? 'checkout_clean'
      : ''
  const propertyId = String(patch?.property_id ?? current?.property_id ?? '').trim()
  const taskDate = dayOnly(patch?.task_date ?? patch?.date ?? current?.task_date ?? current?.date)
  if (!oppositeKind || !propertyId || !taskDate) return null
  return {
    oppositeKind,
    propertyId,
    taskDate,
    inspectionScope: normalizeInspectionScope(patch?.inspection_scope ?? current?.inspection_scope),
  }
}

async function lockCleaningTurnoverTopologyTargets(client: any, current: any, patch: any = {}) {
  const targets = [
    turnoverInspectionScopeTarget(current, {}),
    turnoverInspectionScopeTarget(current, patch),
  ].filter(Boolean) as Array<{ propertyId: string; taskDate: string }>
  // Return the exact canonical `property\0date` keys that were locked.  The
  // verification below must not rebuild a raw `property|date` set or a legacy
  // code/UUID representation change will look like an unlocked topology.
  return lockCleaningTurnoverKeys(client, targets)
}

async function assertPgTurnoverInspectionScope(client: any, taskId: string, current: any, patch: any = {}) {
  const target = turnoverInspectionScopeTarget(current, patch)
  if (!target) return
  const canonicalTargetKeys = await normalizeCleaningTurnoverTargetKeys(client, [target])
  const canonicalTargetPropertyId = String(canonicalTargetKeys[0] || '').split('\u0000')[0] || target.propertyId
  const candidateResult = await client.query(
    `SELECT task.*,
            COALESCE(task_property_id.id::text, task_property_code.id::text, task.property_id::text) AS property_id,
            o.id::text AS linked_order_id,
            COALESCE(order_property_id.id::text, order_property_code.id::text, o.property_id::text) AS linked_order_property_id,
            o.status AS linked_order_status,
            o.checkin AS order_checkin,
            o.checkout AS order_checkout
     FROM cleaning_tasks AS task
     LEFT JOIN orders o ON o.id::text = task.order_id::text
     LEFT JOIN properties task_property_id ON task_property_id.id::text = task.property_id::text
     LEFT JOIN properties task_property_code ON upper(task_property_code.code) = upper(task.property_id::text)
     LEFT JOIN properties order_property_id ON order_property_id.id::text = o.property_id::text
     LEFT JOIN properties order_property_code ON upper(order_property_code.code) = upper(o.property_id::text)
     WHERE (
       task.id::text = $1
       OR (
         COALESCE(task_property_id.id::text, task_property_code.id::text, task.property_id::text) = $2
         AND COALESCE(task.task_date, task.date)::date = $3::date
         AND lower(COALESCE(task.task_type, task.type, '')) = $4
         AND ${activeCleaningTaskWhereSql('task')}
       )
     )
     FOR UPDATE OF task`,
    [String(taskId), canonicalTargetPropertyId, target.taskDate, target.oppositeKind],
  )
  const persistedCurrent = candidateResult.rows?.find((row: any) => String(row?.id || '') === String(taskId)) || current
  const patchedCurrent = {
    ...persistedCurrent,
    ...patch,
    ...(patch?.property_id !== undefined ? { property_id: canonicalTargetPropertyId } : {}),
  }
  const counterparts = reliableTurnoverCounterparts(patchedCurrent, candidateResult.rows || [])
  if (
    counterparts.length
    && (target.inspectionScope === 'password_only'
      || counterparts.some((counterpart) => normalizeInspectionScope(counterpart?.inspection_scope) === 'password_only'))
  ) {
    throw new Error(TURNOVER_INSPECTION_SCOPE_CONFLICT)
  }
}

function assertMemoryTurnoverInspectionScope(taskId: string, current: any, patch: any = {}) {
  const target = turnoverInspectionScopeTarget(current, patch)
  if (!target) return
  const persistedCurrent = (db.cleaningTasks as any[]).find((candidate: any) => String(candidate?.id || '') === String(taskId)) || current
  const patchedCurrent = memoryTaskWithOrderBoundaries({ ...persistedCurrent, ...patch })
  const candidates = (db.cleaningTasks as any[]).filter((candidate: any) => (
    String(candidate.id || '') !== String(taskId)
    && memoryCanonicalCleaningPropertyId(candidate.property_id) === memoryCanonicalCleaningPropertyId(target.propertyId)
    && dayOnly(candidate.task_date ?? candidate.date) === target.taskDate
    && String(candidate.task_type ?? candidate.type ?? '').trim().toLowerCase() === target.oppositeKind
    && !isCancelledCleaningTaskStatus(candidate.status)
    && String(candidate.execution_state || 'active').trim().toLowerCase() === 'active'
  )).map(memoryTaskWithOrderBoundaries)
  const counterparts = reliableTurnoverCounterparts(patchedCurrent, candidates)
  if (
    counterparts.length
    && (target.inspectionScope === 'password_only'
      || counterparts.some((counterpart) => normalizeInspectionScope(counterpart?.inspection_scope) === 'password_only'))
  ) {
    throw new Error(TURNOVER_INSPECTION_SCOPE_CONFLICT)
  }
}

function assertExplicitTurnoverLinkTopology(current0: any, patch: any, rows0: any[]) {
  if (patch?.property_id === undefined && patch?.task_date === undefined && patch?.date === undefined && patch?.status === undefined) return
  const current = current0 || {}
  const next = { ...current, ...patch }
  if (!isActiveTurnoverLinkRow(next)) return
  const taskId = String(current?.id || '').trim()
  const taskType = String(current?.task_type ?? current?.type ?? '').trim().toLowerCase()
  const propertyId = turnoverPropertyId(next)
  const taskDate = dayOnly(next?.task_date ?? next?.date)
  const rows = Array.isArray(rows0) ? rows0 : []
  let counterparts: any[] = []
  if (taskType === 'checkin_clean') {
    const linkedCheckoutTaskId = String(current?.linked_checkout_task_id || '').trim()
    if (!linkedCheckoutTaskId) return
    counterparts = rows.filter((row) => String(row?.id || '').trim() === linkedCheckoutTaskId && isActiveTurnoverLinkRow(row))
  } else if (taskType === 'checkout_clean') {
    counterparts = rows.filter((row) => (
      String(row?.task_type ?? row?.type ?? '').trim().toLowerCase() === 'checkin_clean'
      && String(row?.linked_checkout_task_id || '').trim() === taskId
      && isActiveTurnoverLinkRow(row)
    ))
  } else {
    return
  }
  if (counterparts.some((row) => (
    turnoverPropertyId(row) !== turnoverPropertyId(propertyId)
    || dayOnly(row?.task_date ?? row?.date) !== taskDate
  ))) {
    throw new TurnoverLinkTopologyConflict('该任务已有有效周转关联，请先处理关联后再修改房源或日期')
  }
}

export async function assertPgExplicitTurnoverLinkTopology(client: any, taskId: string, current: any, patch: any = {}) {
  if (patch?.property_id === undefined && patch?.task_date === undefined && patch?.date === undefined && patch?.status === undefined) return
  const taskType = String(current?.task_type ?? current?.type ?? '').trim().toLowerCase()
  if (taskType !== 'checkout_clean' && taskType !== 'checkin_clean') return
  const counterpartResult = taskType === 'checkin_clean'
    ? await client.query(
        `SELECT task.*,
                COALESCE(property_id_row.id::text, property_code_row.id::text, task.property_id::text) AS property_id
           FROM cleaning_tasks task
           LEFT JOIN properties property_id_row ON property_id_row.id::text=task.property_id::text
           LEFT JOIN properties property_code_row ON upper(property_code_row.code)=upper(task.property_id::text)
          WHERE task.id::text=$1
          FOR UPDATE OF task`,
        [String(current?.linked_checkout_task_id || '').trim() || '__none__'],
      )
    : await client.query(
        `SELECT task.*,
                COALESCE(property_id_row.id::text, property_code_row.id::text, task.property_id::text) AS property_id
           FROM cleaning_tasks task
           LEFT JOIN properties property_id_row ON property_id_row.id::text=task.property_id::text
           LEFT JOIN properties property_code_row ON upper(property_code_row.code)=upper(task.property_id::text)
          WHERE task.linked_checkout_task_id::text=$1
            AND lower(COALESCE(task.task_type, task.type, ''))='checkin_clean'
          FOR UPDATE OF task`,
        [String(taskId)],
      )
  const currentPropertyKeys = await normalizeCleaningTurnoverTargetKeys(client, [{
    propertyId: patch?.property_id ?? current?.property_id,
    taskDate: patch?.task_date ?? patch?.date ?? current?.task_date ?? current?.date,
  }])
  const canonicalCurrentPropertyId = String(currentPropertyKeys[0] || '').split('\u0000')[0]
  assertExplicitTurnoverLinkTopology(
    { ...current, property_id: canonicalCurrentPropertyId || current?.property_id },
    patch?.property_id !== undefined ? { ...patch, property_id: canonicalCurrentPropertyId || patch.property_id } : patch,
    counterpartResult?.rows || [],
  )
}

function sendTurnoverInspectionScopeConflict(res: any, error: any): boolean {
  if (error?.message !== TURNOVER_INSPECTION_SCOPE_CONFLICT) return false
  res.status(400).json({ code: TURNOVER_INSPECTION_SCOPE_CONFLICT, message: '同日退房入住任务必须检查后挂钥匙' })
  return true
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
  const passwordInboxLines = new Map<string, string>()

  const add = (change: string, label: string, beforeValue: any, afterValue: any) => {
    if (cleanNotificationText(beforeValue) === cleanNotificationText(afterValue)) return
    changes.push(change)
    lines.push(formatCleaningTaskFieldChange(label, afterValue, beforeValue))
  }

  if (cleanNotificationText(before?.old_code) !== cleanNotificationText(after?.old_code)) {
    changes.push('password')
    lines.push('旧密码：已更新（值已隐藏）')
    passwordInboxLines.set('旧密码：已更新（值已隐藏）', formatCleaningTaskFieldChange('旧密码', after?.old_code, before?.old_code))
  }
  if (cleanNotificationText(before?.new_code) !== cleanNotificationText(after?.new_code)) {
    changes.push('password')
    lines.push('新密码：已更新（值已隐藏）')
    passwordInboxLines.set('新密码：已更新（值已隐藏）', formatCleaningTaskFieldChange('新密码', after?.new_code, before?.new_code))
  }
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
    inboxLines: (taskDate && lines.length ? [`任务日期：${taskDate}`, ...lines] : lines).map((line) => passwordInboxLines.get(line) || line),
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
  const passwordInboxLines = new Map<string, string>()
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
    if (cleanNotificationText(after?.old_code)) {
      changes.push('password')
      lines.push('旧密码：已填写（值已隐藏）')
      passwordInboxLines.set('旧密码：已填写（值已隐藏）', `旧密码：${cleanNotificationText(after?.old_code)}`)
    }
  } else if (taskType === 'checkin_clean') {
    add('time', '入住时间', after?.checkin_time)
    if (cleanNotificationText(after?.new_code)) {
      changes.push('password')
      lines.push('新密码：已填写（值已隐藏）')
      passwordInboxLines.set('新密码：已填写（值已隐藏）', `新密码：${cleanNotificationText(after?.new_code)}`)
    }
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
    inboxLines: changes.length ? lines.map((line) => passwordInboxLines.get(line) || line) : [],
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

function logNotificationEmissionOutcome(source: string, entityId: string, result: any) {
  if (result?.ok && Number(result?.sent || 0) > 0) return
  try {
    console.error(
      `[notifications][emit_incomplete] source=${source} entity_id=${entityId} sent=${Number(result?.sent || 0)} error_code=${String(result?.error_code || '')}`,
    )
  } catch {}
}

function logNotificationEmissionFailure(source: string, entityId: string, error: any) {
  try {
    console.error(`[notifications][emit_failed] source=${source} entity_id=${entityId} error=${String(error?.message || 'unknown')}`)
  } catch {}
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

function offlineWorkStatus(value: any, assigneeId?: any) {
  const status = String(value || '').trim().toLowerCase()
  if (status === 'done') return 'done'
  return String(assigneeId || '').trim() ? 'assigned' : 'todo'
}

function normalizePhotoUrls(input: any) {
  const arr = Array.isArray(input) ? input : []
  return Array.from(new Set(arr.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 20)
}

function stripOfflineTaskUrgency(row: any) {
  if (!row || typeof row !== 'object') return row
  const out = { ...row }
  delete out.urgency
  return out
}

export async function upsertWorkTaskFromOfflineTask(
  row: any,
  requestedStatus?: any,
  options: { client?: any; syncAssignmentStatus?: boolean } = {},
) {
  if (!hasPg || !pgPool) return
  const id = String(row?.id || '').trim()
  if (!id) return
  if (!options.client) await ensureWorkTasksTable()
  const executor = options.client || pgPool
  const workId = `cleaning_offline_tasks:${id}`
  const scheduled = row?.date ? String(row.date).slice(0, 10) : null
  const assignee = String(row?.assignee_id || '').trim() || null
  const status = offlineWorkStatus(requestedStatus === undefined ? row?.status : requestedStatus, assignee)
  const updateStatus = requestedStatus !== undefined
  const syncAssignmentStatus = !!options.syncAssignmentStatus
  const photoUrls = normalizePhotoUrls(row?.photo_urls)
  await executor.query(
    `INSERT INTO work_tasks(id, task_kind, source_type, source_id, property_id, title, summary, scheduled_date, assignee_id, status, photo_urls, created_at, updated_at)
     VALUES($1,'offline','cleaning_offline_tasks',$2,$3,$4,$5,$6::date,$7,$8,$9::jsonb,COALESCE($10::timestamptz, now()), now())
     ON CONFLICT (source_type, source_id) DO UPDATE SET
       property_id=EXCLUDED.property_id,
       title=EXCLUDED.title,
       summary=EXCLUDED.summary,
       scheduled_date=EXCLUDED.scheduled_date,
       assignee_id=CASE WHEN $12::boolean THEN EXCLUDED.assignee_id ELSE work_tasks.assignee_id END,
       status=CASE
         WHEN $11::boolean THEN EXCLUDED.status
         WHEN $12::boolean AND lower(COALESCE(work_tasks.status, 'todo')) IN ('todo', 'assigned') THEN EXCLUDED.status
         ELSE work_tasks.status
       END,
       photo_urls=EXCLUDED.photo_urls,
       updated_at=now()
     RETURNING *`,
    [workId, id, row?.property_id || null, String(row?.title || ''), String(row?.content || '') || null, scheduled, assignee, status, JSON.stringify(photoUrls), row?.created_at || null, updateStatus, syncAssignmentStatus]
  )
}

async function backfillOfflineWorkTasks() {
  if (!hasPg || !pgPool) return
  await ensureWorkTasksTable()
  // Legacy status is consulted only when creating the canonical work task for the first time.
  await pgPool.query(
    `INSERT INTO work_tasks(
       id, task_kind, source_type, source_id, property_id, title, summary,
       scheduled_date, assignee_id, status, photo_urls, created_at, updated_at
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
       CASE
         WHEN lower(COALESCE(t.status, 'todo')) = 'done' THEN 'done'
         WHEN NULLIF(COALESCE(t.assignee_id, ''), '') IS NOT NULL THEN 'assigned'
         ELSE 'todo'
       END,
       COALESCE(t.photo_urls, '[]'::jsonb),
       COALESCE(t.created_at, t.updated_at, now()),
       COALESCE(t.updated_at, t.created_at, now())
     FROM cleaning_offline_tasks t
     ON CONFLICT (source_type, source_id) DO NOTHING`,
  )
}

router.get('/staff', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const kind = String((req.query as any)?.kind || '').trim().toLowerCase()
  const staffScope = String((req.query as any)?.scope || '').trim().toLowerCase()
  const taskExecutorScope = staffScope === 'task_executor'
  const maintenanceExecutorScope = staffScope === 'maintenance_executor'
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
        const name = String(u.username || u.email || u.id || '').trim() || String(u.id)
        const base = { id: String(u.id), name, capacity_per_day: 0, is_active: true, color_hex: String(u.color_hex || '#3B82F6') }
        if (maintenanceExecutorScope) {
          out.push({ ...base, kind: 'executor' })
          continue
        }
        if (taskExecutorScope) {
          if (!isTaskExecutorEligibleRoleNames(roleNames)) continue
          const executorKinds = kindsForRoles(roleNames, '')
          if (executorKinds.length) {
            for (const resolvedKind of executorKinds) out.push({ ...base, kind: resolvedKind })
          } else {
            out.push({ ...base, kind: 'executor' })
          }
          continue
        }
        if (!roleNames.some((role) => roles.includes(role))) continue
        for (const resolvedKind of kindsForRoles(roleNames, kind)) {
          out.push({ ...base, kind: resolvedKind })
        }
      }
      return res.json(out)
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'staff_failed' })
  }
  const out: any[] = []
  for (const u of (db.users || [])) {
    const roleNames = Array.from(new Set([
      String(u.role || '').trim(),
      ...((Array.isArray((u as any).roles) ? (u as any).roles : []).map((x: any) => String(x || '').trim())),
    ].filter(Boolean)))
    const role = String(u.role || '')
    const name = String(u.username || u.email || u.id || '').trim() || String(u.id)
    const base = { id: String(u.id), name, capacity_per_day: 0, is_active: true, color_hex: String((u as any).color_hex || '#3B82F6') }
    if (maintenanceExecutorScope) {
      out.push({ ...base, kind: 'executor' })
      continue
    }
    if (taskExecutorScope) {
      if (!isTaskExecutorEligibleRoleNames(roleNames)) continue
      const executorKinds = kindsForRoles(roleNames, '')
      if (executorKinds.length) {
        for (const resolvedKind of executorKinds) out.push({ ...base, kind: resolvedKind })
      } else {
        out.push({ ...base, kind: 'executor' })
      }
      continue
    }
    if (!roleNames.some((item) => roles.includes(item))) continue
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

export const offlineTaskSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  task_type: z.enum(['property', 'company', 'other']),
  title: z.string().min(1),
  content: z.string().optional(),
  kind: z.string().min(1),
  status: z.enum(['todo', 'done']),
  // Kept as an optional legacy input for older clients; offline tasks no longer use it.
  urgency: z.unknown().optional(),
  property_id: z.string().nullable().optional(),
  assignee_id: z.string().nullable().optional(),
  photo_urls: z.array(z.string().trim().min(1).max(1200)).max(20).optional(),
}).strict()

// Legacy database compatibility only: offline urgency is not exposed or used by business logic.
export const OFFLINE_TASK_STORAGE_URGENCY = 'medium'

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
          `SELECT t.*,
                  CASE
                    WHEN lower(COALESCE(w.status, 'todo')) = 'todo' AND NULLIF(COALESCE(w.assignee_id, ''), '') IS NOT NULL THEN 'assigned'
                    ELSE COALESCE(w.status, 'todo')
                  END AS status,
                  w.assignee_id AS assignee_id
             FROM cleaning_offline_tasks t
             JOIN work_tasks w ON w.source_type = 'cleaning_offline_tasks' AND w.source_id = t.id::text
            ORDER BY t.date DESC, t.updated_at DESC, t.id DESC`,
        )
        return res.json((r?.rows || []).map(stripOfflineTaskUrgency))
      }
      if (includeOverdue) {
        const r = await pgPool.query(
          `SELECT t.*,
                  CASE
                    WHEN lower(COALESCE(w.status, 'todo')) = 'todo' AND NULLIF(COALESCE(w.assignee_id, ''), '') IS NOT NULL THEN 'assigned'
                    ELSE COALESCE(w.status, 'todo')
                  END AS status,
                  w.assignee_id AS assignee_id
             FROM cleaning_offline_tasks t
             JOIN work_tasks w ON w.source_type = 'cleaning_offline_tasks' AND w.source_id = t.id::text
            WHERE (t.date::date = $1::date)
               OR (t.date::date < $1::date AND lower(COALESCE(w.status, 'todo')) <> 'done')
            ORDER BY t.date ASC, t.updated_at DESC, t.id DESC`,
          [date]
        )
        return res.json((r?.rows || []).map(stripOfflineTaskUrgency))
      }
      const r = await pgPool.query(
        `SELECT t.*,
                CASE
                  WHEN lower(COALESCE(w.status, 'todo')) = 'todo' AND NULLIF(COALESCE(w.assignee_id, ''), '') IS NOT NULL THEN 'assigned'
                  ELSE COALESCE(w.status, 'todo')
                END AS status,
                w.assignee_id AS assignee_id
           FROM cleaning_offline_tasks t
           JOIN work_tasks w ON w.source_type = 'cleaning_offline_tasks' AND w.source_id = t.id::text
          WHERE t.date::date = $1::date
          ORDER BY t.updated_at DESC, t.id DESC`,
        [date]
      )
      return res.json((r?.rows || []).map(stripOfflineTaskUrgency))
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
    return res.json(filtered.map(stripOfflineTaskUrgency))
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
      status: 'todo',
      urgency: OFFLINE_TASK_STORAGE_URGENCY,
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
      await upsertWorkTaskFromOfflineTask(out, payload.status, { syncAssignmentStatus: true })
      out.status = offlineWorkStatus(payload.status, out.assignee_id)
      out.photo_urls = normalizePhotoUrls(out.photo_urls)
      delete out.urgency
      const workTaskId = offlineWorkTaskId(String(out.id || row.id))
      if (String(out.status || '').trim().toLowerCase() !== 'done') {
        try {
          await emitWorkTaskEvent({
            taskId: `work_task:${workTaskId}`,
            sourceType: 'work_tasks',
            sourceRefIds: [workTaskId],
            eventType: 'TASK_CREATED',
            changeScope: 'membership',
            changedFields: ['id', 'title', 'summary', 'scheduled_date', 'status', 'property_id', 'assignee_id', 'photo_urls'],
            patch: {
              id: workTaskId,
              title: out.title,
              summary: out.content || null,
              scheduled_date: out.date,
              status: out.status,
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

router.patch('/offline-tasks/:id', requireCleaningManualCreateAccess, async (req, res) => {
  const { id } = req.params
  const parsed = offlineTaskSchema.partial().safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const patch = parsed.data
  const hasAssigneePatch = Object.prototype.hasOwnProperty.call(req.body || {}, 'assignee_id')
  const normalizedAssigneeId = hasAssigneePatch
    ? (String(patch.assignee_id || '').trim() || null)
    : undefined
  if (normalizedAssigneeId && !(await isValidAnyStaffId(normalizedAssigneeId))) {
    return res.status(400).json({ message: '无效的执行人' })
  }
  if (hasAssigneePatch) (patch as any).assignee_id = normalizedAssigneeId
  const contentFieldAllowlist = new Set(['date', 'task_type', 'title', 'content', 'kind', 'property_id', 'assignee_id', 'photo_urls'])
  const assignmentRequested = hasAssigneePatch
  try {
    if (hasPg && pgPool) {
      await ensureOfflineTasksTable()
      await ensureWorkTasksTable()
      const result = await pgRunInTransaction(async (client) => {
        const beforeRes = await client.query('SELECT * FROM cleaning_offline_tasks WHERE id=$1 LIMIT 1 FOR UPDATE', [String(id)])
        const before = beforeRes?.rows?.[0] || null
        if (!before) return { kind: 'missing' as const }
        const beforeWorkResult = await client.query(
          `SELECT status, assignee_id
             FROM work_tasks
            WHERE source_type = 'cleaning_offline_tasks' AND source_id = $1
            LIMIT 1
            FOR UPDATE`,
          [String(id)],
        )
        const beforeWork = beforeWorkResult?.rows?.[0] || null
        const keys = Object.keys(patch || {}).filter((k) => (
          k !== 'status'
          && contentFieldAllowlist.has(k)
          && (patch as any)[k] !== undefined
        ))
        let row = before
        if (keys.length) {
          const set = keys.map((k, i) => (k === 'photo_urls' ? `"${k}" = $${i + 1}::jsonb` : `"${k}" = $${i + 1}`)).join(', ')
          const values = keys.map((k) => k === 'photo_urls' ? JSON.stringify(normalizePhotoUrls((patch as any)[k])) : (patch as any)[k])
          const sql = `UPDATE cleaning_offline_tasks SET ${set}, updated_at=now() WHERE id=$${keys.length + 1} RETURNING *`
          const updated = await client.query(sql, [...values, String(id)])
          row = updated?.rows?.[0] || null
        }
        if (!row) return { kind: 'missing' as const }
        await upsertWorkTaskFromOfflineTask(row, (patch as any).status, { client, syncAssignmentStatus: hasAssigneePatch })
        const statusResult = await client.query(
          `SELECT id, status, assignee_id, updated_at
             FROM work_tasks
            WHERE source_type = 'cleaning_offline_tasks' AND source_id = $1
            LIMIT 1
            FOR UPDATE`,
          [String(id)],
        )
        const workTask = statusResult?.rows?.[0] || null
        if (!workTask) throw new Error('offline_work_task_missing')
        const canonicalAssigneeId = String(workTask.assignee_id || '').trim() || null
        const canonicalStatus = offlineWorkStatus(workTask.status, canonicalAssigneeId)
        return {
          kind: 'updated' as const,
          row: { ...row, status: canonicalStatus, assignee_id: canonicalAssigneeId, photo_urls: normalizePhotoUrls(row.photo_urls) },
          workTask,
          keys,
          canonicalAssigneeId,
          beforeCanonicalAssigneeId: beforeWork?.assignee_id ? String(beforeWork.assignee_id) : null,
          beforeStatus: offlineWorkStatus(beforeWork?.status ?? before.status, beforeWork?.assignee_id ?? before.assignee_id),
        }
      })
      if (!result || result.kind === 'missing') return res.status(404).json({ message: 'task not found' })
      const row = result.row
      const keys = result.keys
      const canonicalAssigneeId = result.canonicalAssigneeId
      const beforeCanonicalAssigneeId = result.beforeCanonicalAssigneeId
      const beforeStatus = result.beforeStatus
      const completedChanged = beforeStatus !== 'done' && row.status === 'done'
      if ((keys.length || assignmentRequested) && !completedChanged) {
        const workTaskId = offlineWorkTaskId(String(row.id || id))
        const changedFields = [...keys, ...(assignmentRequested ? ['assignee_id'] : [])].map((k) => {
          if (k === 'date') return 'scheduled_date'
          if (k === 'content') return 'summary'
          return k
        })
        const patchForEvent: any = {}
        for (const field of changedFields) {
          if (field === 'scheduled_date') patchForEvent.scheduled_date = row.date ? String(row.date).slice(0, 10) : null
          else if (field === 'summary') patchForEvent.summary = row.content || null
          else if (field === 'photo_urls') patchForEvent.photo_urls = row.photo_urls
          else if (field === 'assignee_id') patchForEvent.assignee_id = canonicalAssigneeId
          else patchForEvent[field] = (row as any)[field]
        }
        const assignmentChanged = assignmentRequested && beforeCanonicalAssigneeId !== (canonicalAssigneeId ? String(canonicalAssigneeId) : null)
        try {
          await emitWorkTaskEvent({
            taskId: `work_task:${workTaskId}`,
            sourceType: 'work_tasks',
            sourceRefIds: [workTaskId],
            eventType: assignmentChanged ? 'TASK_ASSIGNMENT_CHANGED' : 'TASK_UPDATED',
            changeScope: assignmentChanged ? 'membership' : 'list',
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
      return res.json({
        ...stripOfflineTaskUrgency(row),
        work_task_id: String(result.workTask.id || offlineWorkTaskId(String(row.id || id))),
        assignment_status: canonicalAssigneeId ? 'assigned' : 'unassigned',
        updated_at: result.workTask.updated_at || row.updated_at || null,
      })
    }
    const rows = ((db as any).cleaningOfflineTasks || []) as any[]
    const t = rows.find((x: any) => String(x.id) === String(id))
    if (!t) return res.status(404).json({ message: 'task not found' })
    for (const key of contentFieldAllowlist) {
      if ((patch as any)[key] !== undefined) (t as any)[key] = (patch as any)[key]
    }
    if (assignmentRequested) (t as any).assignee_id = String((patch as any).assignee_id || '').trim() || null
    if ((patch as any).status !== undefined) t.status = (patch as any).status
    return res.json(stripOfflineTaskUrgency(t))
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

function projectCleaningTaskPasswordDisplay(row: any) {
  const taskType = String(row?.task_type || row?.type || '').trim().toLowerCase()
  const turnoverDisplay = buildCleaningTurnoverDisplay({
    checkoutTask: taskType === 'checkout_clean' || taskType === 'checkout' ? row : null,
    checkinTask: taskType === 'checkin_clean' || taskType === 'checkin' ? row : null,
  })
  return {
    ...row,
    old_code: turnoverDisplay.old_code,
    new_code: cleaningTaskNewCodeForDisplay(row),
    old_code_authority_status: taskType === 'checkout_clean' || taskType === 'checkout'
      ? (turnoverDisplay.old_code_authority_status || 'needs_review')
      : 'not_applicable',
    new_code_authority_status: taskType === 'checkin_clean' || taskType === 'checkin'
      ? (row?.new_code_authority_status || row?.password_authority?.new_code_status || 'needs_review')
      : 'not_applicable',
    old_code_source_task_id: turnoverDisplay.old_code_source_task_id,
    old_code_source_order_id: turnoverDisplay.old_code_source_order_id,
    old_code_source_field: turnoverDisplay.old_code_source_field,
  }
}

const checkinLinkCandidateQuerySchema = z.object({
  property_id: z.string().trim().min(1),
  task_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

function checkinLinkCandidateDto(row: any, propertyCode: string) {
  return {
    id: String(row?.id || ''),
    property_id: String(row?.property_id || ''),
    property_code: String(propertyCode || ''),
    task_date: dayOnly(row?.task_date ?? row?.date),
    checkout_time: String(row?.checkout_time || '').trim() || null,
    status: String(row?.status || '').trim() || null,
  }
}

function checkoutLinkCandidateDto(row: any, propertyCode: string) {
  return {
    id: String(row?.id || ''),
    property_id: String(row?.property_id || ''),
    property_code: String(propertyCode || ''),
    task_date: dayOnly(row?.task_date ?? row?.date),
    checkin_time: String(row?.checkin_time || '').trim() || null,
    status: String(row?.status || '').trim() || null,
    inspection_scope: normalizeInspectionScope(row?.inspection_scope),
  }
}

router.get('/tasks/checkin-link-candidates', requireCleaningManualCreateAccess, requireR5TaskRuntimeSchema, async (req, res) => {
  const parsed = checkinLinkCandidateQuerySchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_checkin_link_candidate_query' })
  const propertyId = parsed.data.property_id
  const taskDate = parsed.data.task_date
  try {
    if (hasPg && pgPool) {
      // This endpoint is intentionally SELECT-only. Runtime migrations own
      // schema changes; a missing task/order column must fail closed below.
      const propertyResult = await pgPool.query(
        'SELECT id::text AS id, code FROM properties WHERE id::text=$1 OR upper(code)=upper($1) LIMIT 1',
        [propertyId],
      )
      const property = propertyResult?.rows?.[0] || null
      if (!property?.id) return res.status(400).json({ code: 'invalid_checkin_link_candidate_query' })
      const taskResult = await pgPool.query(
        `SELECT t.id::text AS id,
                COALESCE(task_property_id.id::text, task_property_code.id::text, t.property_id::text) AS property_id,
                t.task_date,
                t.date,
                t.task_type,
                t.type,
                t.status,
                t.execution_state,
                t.linked_checkout_task_id,
                t.order_id::text AS order_id,
                t.checkout_time,
                o.id::text AS linked_order_id,
                COALESCE(order_property_id.id::text, order_property_code.id::text, o.property_id::text) AS linked_order_property_id,
                o.status AS linked_order_status,
                o.checkin AS order_checkin,
                o.checkout AS order_checkout
         FROM cleaning_tasks t
         LEFT JOIN orders o ON o.id::text=t.order_id::text
         LEFT JOIN properties task_property_id ON task_property_id.id::text=t.property_id::text
         LEFT JOIN properties task_property_code ON upper(task_property_code.code)=upper(t.property_id::text)
         LEFT JOIN properties order_property_id ON order_property_id.id::text=o.property_id::text
         LEFT JOIN properties order_property_code ON upper(order_property_code.code)=upper(o.property_id::text)
         WHERE COALESCE(task_property_id.id::text, task_property_code.id::text, t.property_id::text)=$1
           AND COALESCE(t.task_date, t.date)::date=$2::date
           AND ${activeCleaningTaskWhereSql('t')}
         ORDER BY COALESCE(t.checkout_time, ''), t.id`,
        [String(property.id), taskDate],
      )
      const candidates = reliableManualCheckinCheckoutCandidates(taskResult?.rows || [], String(property.id), taskDate)
      return res.json({ items: candidates.map((row) => checkinLinkCandidateDto(row, String(property.code || ''))) })
    }

    const properties = Array.isArray((db as any)?.properties) ? (db as any).properties : []
    const property = properties.find((candidate: any) => (
      String(candidate?.id || '').trim().toLowerCase() === propertyId.toLowerCase()
      || String(candidate?.code || '').trim().toLowerCase() === propertyId.toLowerCase()
    )) || null
    if (!property?.id) return res.status(400).json({ code: 'invalid_checkin_link_candidate_query' })
    const rows = (Array.isArray((db as any)?.cleaningTasks) ? (db as any).cleaningTasks : [])
      .map(memoryTaskWithOrderBoundaries)
    const candidates = reliableManualCheckinCheckoutCandidates(rows, String(property.id), taskDate)
      .sort((a, b) => {
        const aKey = `${String(a?.checkout_time || '')}|${String(a?.id || '')}`
        const bKey = `${String(b?.checkout_time || '')}|${String(b?.id || '')}`
        return aKey.localeCompare(bKey)
      })
    return res.json({ items: candidates.map((row) => checkinLinkCandidateDto(row, String(property.code || ''))) })
  } catch {
    return res.status(503).json({ code: CHECKIN_LINK_CANDIDATES_UNAVAILABLE })
  }
})

router.get('/tasks/checkout-link-candidates', requireCleaningManualCreateAccess, requireR5TaskRuntimeSchema, async (req, res) => {
  const parsed = checkinLinkCandidateQuerySchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_checkout_link_candidate_query' })
  const propertyId = parsed.data.property_id
  const taskDate = parsed.data.task_date
  try {
    if (hasPg && pgPool) {
      // SELECT-only by design: relationship discovery must not run schema,
      // sync, notification or task mutation side effects.
      const propertyResult = await pgPool.query(
        'SELECT id::text AS id, code FROM properties WHERE id::text=$1 OR upper(code)=upper($1) LIMIT 1',
        [propertyId],
      )
      const property = propertyResult?.rows?.[0] || null
      if (!property?.id) return res.status(400).json({ code: 'invalid_checkout_link_candidate_query' })
      const taskResult = await pgPool.query(
        `SELECT t.id::text AS id,
                COALESCE(task_property_id.id::text, task_property_code.id::text, t.property_id::text) AS property_id,
                t.task_date,
                t.date,
                t.task_type,
                t.type,
                t.status,
                t.execution_state,
                t.linked_checkout_task_id,
                t.inspection_scope,
                t.order_id::text AS order_id,
                t.checkin_time,
                o.id::text AS linked_order_id,
                COALESCE(order_property_id.id::text, order_property_code.id::text, o.property_id::text) AS linked_order_property_id,
                o.status AS linked_order_status,
                o.checkin AS order_checkin,
                o.checkout AS order_checkout
         FROM cleaning_tasks t
         LEFT JOIN orders o ON o.id::text=t.order_id::text
         LEFT JOIN properties task_property_id ON task_property_id.id::text=t.property_id::text
         LEFT JOIN properties task_property_code ON upper(task_property_code.code)=upper(t.property_id::text)
         LEFT JOIN properties order_property_id ON order_property_id.id::text=o.property_id::text
         LEFT JOIN properties order_property_code ON upper(order_property_code.code)=upper(o.property_id::text)
         WHERE COALESCE(task_property_id.id::text, task_property_code.id::text, t.property_id::text)=$1
           AND COALESCE(t.task_date, t.date)::date=$2::date
           AND ${activeCleaningTaskWhereSql('t')}
         ORDER BY COALESCE(t.checkin_time, ''), t.id`,
        [String(property.id), taskDate],
      )
      const candidates = reliableManualCheckoutCheckinCandidates(taskResult?.rows || [], String(property.id), taskDate)
      return res.json({ items: candidates.map((row) => checkoutLinkCandidateDto(row, String(property.code || ''))) })
    }

    const properties = Array.isArray((db as any)?.properties) ? (db as any).properties : []
    const property = properties.find((candidate: any) => (
      String(candidate?.id || '').trim().toLowerCase() === propertyId.toLowerCase()
      || String(candidate?.code || '').trim().toLowerCase() === propertyId.toLowerCase()
    )) || null
    if (!property?.id) return res.status(400).json({ code: 'invalid_checkout_link_candidate_query' })
    const rows = (Array.isArray((db as any)?.cleaningTasks) ? (db as any).cleaningTasks : [])
      .map(memoryTaskWithOrderBoundaries)
    const candidates = reliableManualCheckoutCheckinCandidates(rows, String(property.id), taskDate)
      .sort((a, b) => `${String(a?.checkin_time || '')}|${String(a?.id || '')}`.localeCompare(`${String(b?.checkin_time || '')}|${String(b?.id || '')}`))
    return res.json({ items: candidates.map((row) => checkoutLinkCandidateDto(row, String(property.code || ''))) })
  } catch {
    return res.status(503).json({ code: CHECKOUT_LINK_CANDIDATES_UNAVAILABLE })
  }
})

const turnoverLinkSchema = z.object({
  checkout_task_id: z.string().trim().min(1),
  checkin_task_id: z.string().trim().min(1),
}).strict()

function buildCleaningPairVisibilityHints(left: any, right: any) {
  const leftVisibility = buildCleaningTaskVisibilityHints(left)
  const rightVisibility = buildCleaningTaskVisibilityHints(right)
  return {
    user_ids: Array.from(new Set([
      ...(leftVisibility.user_ids || []),
      ...(rightVisibility.user_ids || []),
    ])),
    role_names: Array.from(new Set([
      ...(leftVisibility.role_names || []),
      ...(rightVisibility.role_names || []),
    ])),
  }
}

function validateExplicitTurnoverLink(rows0: any[], checkoutTaskId: string, checkinTaskId: string) {
  const rows = Array.isArray(rows0) ? rows0 : []
  const checkout = rows.find((row) => String(row?.id || '').trim() === checkoutTaskId) || null
  const checkin = rows.find((row) => String(row?.id || '').trim() === checkinTaskId) || null
  if (!checkout || !checkin) throw new ManualCheckoutLinkConflict('退房或入住任务不存在或已失效')
  if (String(checkout?.task_type ?? checkout?.type ?? '').trim().toLowerCase() !== 'checkout_clean'
    || String(checkin?.task_type ?? checkin?.type ?? '').trim().toLowerCase() !== 'checkin_clean') {
    throw new ManualCheckoutLinkConflict('只能关联一个有效退房任务和一个有效入住任务')
  }
  const propertyId = turnoverPropertyId(checkout)
  const taskDate = dayOnly(checkout?.task_date ?? checkout?.date)
  if (!propertyId || !taskDate
    || propertyId !== turnoverPropertyId(checkin)
    || taskDate !== dayOnly(checkin?.task_date ?? checkin?.date)) {
    throw new ManualCheckoutLinkConflict('入住与退房必须属于同一房源和同一业务日期')
  }
  const activeRows = activeManualTurnoverRows(rows, propertyId, taskDate)
  if (!activeRows.some((row) => String(row?.id || '').trim() === checkoutTaskId)
    || !activeRows.some((row) => String(row?.id || '').trim() === checkinTaskId)) {
    throw new ManualCheckoutLinkConflict('取消、删除、被替代或失效任务不能建立周转关联')
  }
  if (normalizeInspectionScope(checkin?.inspection_scope) === 'password_only') {
    throw new ManualCheckoutLinkConflict('仅挂钥匙入住不能静默改为周转检查，请先明确改为检查后挂钥匙')
  }
  const currentLink = String(checkin?.linked_checkout_task_id || '').trim()
  if (currentLink === checkoutTaskId) {
    return { checkout, checkin, propertyId, taskDate, idempotent: true }
  }
  const availableCheckout = reliableManualCheckinCheckoutCandidates(activeRows, propertyId, taskDate)
    .some((row) => String(row?.id || '').trim() === checkoutTaskId)
  const availableCheckin = reliableManualCheckoutCheckinCandidates(activeRows, propertyId, taskDate)
    .some((row) => String(row?.id || '').trim() === checkinTaskId)
  if (!availableCheckout || !availableCheckin) {
    throw new ManualCheckoutLinkConflict('所选任务已有其他可靠周转关系，请刷新后重新选择')
  }
  return { checkout, checkin, propertyId, taskDate, idempotent: false }
}

router.post('/tasks/turnover-links', requireCleaningManualCreateAccess, requireR5TaskRuntimeSchema, async (req, res) => {
  if (!isPasswordAuthoritySchemaReady()) return res.status(503).json({ code: 'password_authority_schema_not_ready' })
  const parsed = turnoverLinkSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const checkoutTaskId = parsed.data.checkout_task_id
  const checkinTaskId = parsed.data.checkin_task_id
  if (checkoutTaskId === checkinTaskId) return res.status(400).json({ code: MANUAL_CHECKOUT_LINK_CONFLICT, message: '退房与入住任务不能相同' })
  try {
    if (hasPg && pgPool) {
      await ensureCleaningSchemaV2()
      const result = await pgRunInTransaction(async (client) => {
        const initial = await client.query(
          `SELECT task.id::text AS id,
                  COALESCE(property_id_row.id::text, property_code_row.id::text, task.property_id::text) AS property_id,
                  COALESCE(task.task_date, task.date)::date AS task_date
             FROM cleaning_tasks task
             LEFT JOIN properties property_id_row ON property_id_row.id::text=task.property_id::text
             LEFT JOIN properties property_code_row ON upper(property_code_row.code)=upper(task.property_id::text)
            WHERE task.id::text = ANY($1::text[])`,
          [[checkoutTaskId, checkinTaskId]],
        )
        if ((initial?.rows || []).length !== 2) throw new ManualCheckoutLinkConflict('退房或入住任务不存在或已失效')
        const propertyIds = Array.from(new Set((initial.rows || []).map((row: any) => String(row?.property_id || '').trim()).filter(Boolean)))
        const taskDates = Array.from(new Set((initial.rows || []).map((row: any) => dayOnly(row?.task_date)).filter(Boolean)))
        if (propertyIds.length !== 1 || taskDates.length !== 1) throw new ManualCheckoutLinkConflict('入住与退房必须属于同一房源和同一业务日期')
        const propertyId = propertyIds[0]
        const taskDate = taskDates[0] as string
        await lockCleaningPasswordChainKey(client, propertyId)
        await lockCleaningTurnoverKey(client, propertyId, taskDate)
        const sameDayResult = await client.query(
          `SELECT t.id::text AS id,
                  COALESCE(task_property_id.id::text, task_property_code.id::text, t.property_id::text) AS property_id,
                  t.task_date,
                  t.date,
                  t.task_type,
                  t.type,
                  t.status,
                  t.execution_state,
                  t.linked_checkout_task_id,
                  t.inspection_scope,
                  t.assignee_id,
                  t.cleaner_id,
                  t.inspector_id,
                  t.order_id::text AS order_id,
                  o.id::text AS linked_order_id,
                  COALESCE(order_property_id.id::text, order_property_code.id::text, o.property_id::text) AS linked_order_property_id,
                  o.status AS linked_order_status,
                  o.checkin AS order_checkin,
                  o.checkout AS order_checkout
             FROM cleaning_tasks t
             LEFT JOIN orders o ON o.id::text=t.order_id::text
             LEFT JOIN properties task_property_id ON task_property_id.id::text=t.property_id::text
             LEFT JOIN properties task_property_code ON upper(task_property_code.code)=upper(t.property_id::text)
             LEFT JOIN properties order_property_id ON order_property_id.id::text=o.property_id::text
             LEFT JOIN properties order_property_code ON upper(order_property_code.code)=upper(o.property_id::text)
            WHERE COALESCE(task_property_id.id::text, task_property_code.id::text, t.property_id::text)=$1
              AND COALESCE(t.task_date, t.date)::date=$2::date
            FOR UPDATE OF t`,
          [propertyId, taskDate],
        )
        const validation = validateExplicitTurnoverLink(sameDayResult?.rows || [], checkoutTaskId, checkinTaskId)
        if (validation.idempotent) return { checkin: validation.checkin, idempotent: true }
        const updatedResult = await client.query(
          `UPDATE cleaning_tasks
              SET linked_checkout_task_id=$1, updated_at=now()
            WHERE id::text=$2
            RETURNING *`,
          [checkoutTaskId, checkinTaskId],
        )
        const updated = updatedResult?.rows?.[0] || null
        if (!updated) throw new ManualCheckoutLinkConflict('入住任务已变化，请刷新后重试')
        await emitWorkTaskEvent({
          taskId: `cleaning_task:${checkinTaskId}`,
          sourceType: 'cleaning_tasks',
          sourceRefIds: [checkoutTaskId, checkinTaskId],
          eventType: 'TASK_UPDATED',
          changeScope: 'list',
          changedFields: ['linked_checkout_task_id'],
          patch: { linked_checkout_task_id: checkoutTaskId },
          causedByUserId: String((req as any)?.user?.sub || '').trim() || null,
          visibilityHints: buildCleaningPairVisibilityHints(updated, validation.checkout),
        }, client)
        await reconcileDeferredInspectionCheckinReplacement({
          taskIds: [checkoutTaskId, checkinTaskId],
          actorUserId: String((req as any)?.user?.sub || '').trim() || null,
          pgClient: client,
        })
        return { checkin: updated, idempotent: false }
      })
      if (!result) throw new Error('pg not available')
      return res.json({
        ok: true,
        checkout_task_id: checkoutTaskId,
        checkin_task_id: checkinTaskId,
        linked_checkout_task_id: String(result.checkin?.linked_checkout_task_id || checkoutTaskId),
        idempotent: result.idempotent,
      })
    }

    const rows = (db.cleaningTasks as any[]).map(memoryTaskWithOrderBoundaries)
    const validation = validateExplicitTurnoverLink(rows, checkoutTaskId, checkinTaskId)
    const mutableCheckin = (db.cleaningTasks as any[]).find((row) => String(row?.id || '').trim() === checkinTaskId) || null
    if (!mutableCheckin) throw new ManualCheckoutLinkConflict('入住任务已变化，请刷新后重试')
    if (!validation.idempotent) {
      mutableCheckin.linked_checkout_task_id = checkoutTaskId
      mutableCheckin.updated_at = new Date().toISOString()
    }
    return res.json({
      ok: true,
      checkout_task_id: checkoutTaskId,
      checkin_task_id: checkinTaskId,
      linked_checkout_task_id: checkoutTaskId,
      idempotent: validation.idempotent,
    })
  } catch (e: any) {
    if (e instanceof ManualCheckoutLinkConflict) return res.status(e.status).json({ code: e.code, message: e.message })
    return res.status(Number(e?.status || 500)).json({ message: e?.message || 'turnover_link_failed' })
  }
})

router.get('/tasks', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), requireR5TaskRuntimeSchema, async (req, res) => {
  if (!isPasswordAuthoritySchemaReady()) return res.status(503).json({ code: 'password_authority_schema_not_ready' })
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
             AND ${validCleaningTaskOrderWhereSql('t', 'o')}
           ORDER BY t.property_id NULLS LAST, t.id`,
          [date]
        )
        return res.json((r?.rows || []).map((x: any) => {
          if (x?.order_id && x?.order_keys_required != null) x.keys_required = Number(x.order_keys_required)
          delete x.order_keys_required
          return projectCleaningTaskPasswordDisplay(x)
        }))
      }
      const r = await pgPool.query(
        `SELECT t.*, o.keys_required AS order_keys_required
         FROM cleaning_tasks t
         LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
         WHERE ${activeCleaningTaskWhereSql('t')}
           AND ${validCleaningTaskOrderWhereSql('t', 'o')}
         ORDER BY COALESCE(t.task_date, t.date) NULLS LAST, t.property_id NULLS LAST, t.id`,
      )
      return res.json((r?.rows || []).map((x: any) => {
        if (x?.order_id && x?.order_keys_required != null) x.keys_required = Number(x.order_keys_required)
        delete x.order_keys_required
        return projectCleaningTaskPasswordDisplay(x)
      }))
    }
    const rows = (db.cleaningTasks as any[]).slice()
    const activeRows = rows.filter((t: any) => {
      const executionState = String(t?.execution_state || '').trim().toLowerCase()
      if (isCancelledCleaningTaskStatus(t?.status)) return false
      if (executionState && executionState !== 'active') return false
      return true
    })
    if (!date) return res.json(activeRows.map(projectCleaningTaskPasswordDisplay))
    const orders = (db.orders || []) as any[]
    const byId = new Map<string, any>()
    for (const o of orders) byId.set(String(o.id), o)
    return res.json(activeRows.filter((t: any) => String(t.task_date || t.date || '').slice(0, 10) === date).map((t: any) => {
      const out = { ...t }
      const oid = String(out.order_id || '').trim()
      const o = oid ? byId.get(oid) : null
      if (o && o.keys_required != null) out.keys_required = Number(o.keys_required) >= 2 ? 2 : 1
      return projectCleaningTaskPasswordDisplay(out)
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
      return res.json((r?.rows || []).map(projectCleaningTaskPasswordDisplay))
    }
    const rows = (db.cleaningTasks as any[]).slice().filter((t: any) => String(t.property_id || '') === propertyId)
    const filtered = rows.filter((t: any) => {
      const d = String(t.task_date || t.date || '').slice(0, 10)
      return d && d >= from && d <= to
    })
    filtered.sort((a: any, b: any) => String(b.task_date || b.date || '').localeCompare(String(a.task_date || a.date || '')) || String(b.id || '').localeCompare(String(a.id || '')))
    const props = ((db as any).properties || []) as any[]
    const p = props.find((x: any) => String(x.id) === propertyId) || null
    const out = filtered.slice(0, limit).map((t: any) => projectCleaningTaskPasswordDisplay({ ...t, property_code: p?.code || t?.property_code || null, property_region: p?.region || t?.property_region || null }))
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'history_failed' })
  }
})

const cleaningTaskStatusSchema = z.enum([
  'todo',
  'pending',
  'unassigned',
  'assigned',
  'in_progress',
  'cleaning',
  'to_complete',
  'to_inspect',
  'cleaned',
  'restock_pending',
  'to_hang_keys',
  'restocked',
  'inspected',
  'ready',
  'completed',
  'done',
  'canceled',
  'cancelled',
  'keys_hung',
])

const MZ031_MANAGEMENT_CLOSED_STATUSES = new Set(['done', 'completed', 'ready'])
const MZ031_CANCELLED_STATUSES = new Set(['cancelled', 'canceled'])

function mz031ManagementStatusArrangementReasons(before: any, after: any, statusWasExplicitlyPatched: boolean) {
  if (!statusWasExplicitlyPatched) return []
  const beforeStatus = String(before?.status || '').trim().toLowerCase()
  const afterStatus = String(after?.status || '').trim().toLowerCase()
  const beforeClosed = MZ031_MANAGEMENT_CLOSED_STATUSES.has(beforeStatus)
  const afterClosed = MZ031_MANAGEMENT_CLOSED_STATUSES.has(afterStatus)
  if (!beforeClosed && afterClosed) return ['management_closed']
  if (beforeClosed && !afterClosed && !MZ031_CANCELLED_STATUSES.has(afterStatus)) return ['management_reopened']
  return []
}

const patchTaskSchema = z.object({
  property_id: z.string().nullable().optional(),
  task_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: cleaningTaskStatusSchema.optional(),
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
  password_verification: z.object({
    fields: z.array(z.enum(['old_code', 'new_code'])).min(1).max(2),
    request_id: z.string().trim().min(1).max(100),
    client: z.enum(['web', 'mobile', 'api']),
  }).strict().optional(),
}).strict()

type CleaningPasswordField = 'old_code' | 'new_code'

function cleaningPasswordFieldApplies(taskTypeValue: any, field: CleaningPasswordField) {
  const taskType = String(taskTypeValue || '').trim().toLowerCase()
  return (taskType === 'checkout_clean' && field === 'old_code')
    || (taskType === 'checkin_clean' && field === 'new_code')
}

function assertCleaningPasswordFieldsApplicable(taskType: any, fields: CleaningPasswordField[]) {
  const unique = Array.from(new Set(fields))
  if (unique.some((field) => !cleaningPasswordFieldApplies(taskType, field))) {
    const error: any = new Error('password_field_not_applicable')
    error.status = 400
    throw error
  }
  return unique
}

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

router.patch('/tasks/:id', requirePerm('cleaning.task.assign'), requireR5TaskRuntimeSchema, async (req, res) => {
  if (!isPasswordAuthoritySchemaReady()) return res.status(503).json({ code: 'password_authority_schema_not_ready' })
  const { id } = req.params
  const operationId = uuid()
  const opNow = new Date().toISOString()
  const parsed = patchTaskSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!(await isValidStaffId((parsed.data as any).cleaner_id ?? null, 'cleaner'))) return res.status(400).json({ message: '无效的清洁人员' })
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
      const passwordVerification = patch.password_verification
      delete patch.password_verification
      if (patch.guest_special_request === undefined && patch.note !== undefined) patch.guest_special_request = patch.note
      delete patch.note
      if (patch.keys_required === null) patch.keys_required = 1
      if (patch.nights_override !== undefined && patch.nights_override !== null && shouldIgnoreNightsOverrideForAutoCheckinTask(before)) {
        delete patch.nights_override
      }
      const isCheckinSiteExecution = isCheckinSiteExecutionTask({
        task_type: patch.task_type ?? before.task_type,
        inspection_scope: patch.inspection_scope ?? before.inspection_scope,
      })
      if (!isCheckinSiteExecution && !(await isValidStaffId((parsed.data as any).inspector_id ?? null, 'inspector'))) return res.status(400).json({ message: '无效的检查人员' })
      if (isCheckinSiteExecution) {
        if (!(await isValidAnyStaffId(patch.assignee_id ?? null))) return res.status(400).json({ message: '无效的执行人' })
        if (!(await isValidAnyStaffId(patch.inspector_id ?? null))) return res.status(400).json({ message: '无效的执行人' })
        if (patch.assignee_id !== undefined && patch.cleaner_id === undefined) patch.cleaner_id = null
      } else {
        if (patch.cleaner_id !== undefined && patch.assignee_id === undefined) patch.assignee_id = patch.cleaner_id
        if (patch.assignee_id !== undefined && patch.cleaner_id === undefined) patch.cleaner_id = patch.assignee_id
      }
      if (patch.task_date != null) patch.date = patch.task_date
      if (patch.inspection_mode !== undefined || patch.inspection_due_date !== undefined) {
        patch.inspection_replaced_by_checkin_task_id = null
        patch.inspection_replaced_original_due_date = null
      }
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
          const nextCleanerId = isCheckinSiteExecution
            ? (patch.assignee_id !== undefined ? (patch.assignee_id ?? null) : (before.assignee_id ?? before.inspector_id ?? null))
            : (patch.cleaner_id !== undefined ? (patch.cleaner_id ?? null) : (before.cleaner_id ?? before.assignee_id ?? null))
          const nextInspectorId = (parsed.data as any).inspector_id !== undefined ? ((parsed.data as any).inspector_id ?? null) : (before.inspector_id ?? null)
          patch.status = assignedStatusFromAssignees(nextCleanerId, nextInspectorId)
        }
      }
      patch.updated_at = new Date().toISOString()

      const transactionResult = await pgRunInTransaction(async (client) => {
        const hasPasswordWrite = parsed.data.old_code !== undefined || parsed.data.new_code !== undefined || !!passwordVerification?.fields?.length
        const topologyTouched = patch.property_id !== undefined || patch.task_date !== undefined || patch.status !== undefined
        let lockedPasswordProperties: string[] = []
        if (hasPasswordWrite || topologyTouched) {
          lockedPasswordProperties = await normalizeCleaningPasswordChainKeys(client, [
            String(before.property_id || '').trim(),
            String(patch.property_id || '').trim(),
          ])
          for (const propertyId of lockedPasswordProperties) await lockCleaningPasswordChainKey(client, propertyId)
        }
        const lockedTurnoverTopologyKeys = await lockCleaningTurnoverTopologyTargets(client, before, patch)
        const locked = await client.query('SELECT * FROM cleaning_tasks WHERE id = $1 LIMIT 1 FOR UPDATE', [String(id)])
        const lockedBefore = locked?.rows?.[0] || before
        if (hasPasswordWrite || topologyTouched) {
          const verifiedProperties = await normalizeCleaningPasswordChainKeys(client, [lockedBefore.property_id, patch.property_id])
          if (verifiedProperties.some((propertyId) => !lockedPasswordProperties.includes(propertyId))) {
            const error: any = new Error('password_chain_topology_changed_retry')
            error.status = 409
            throw error
          }
          if (patch.property_id !== undefined && String(lockedBefore.order_id || '').trim()) {
            const currentProperty = String(lockedBefore.property_id || '').trim()
            const requestedProperty = String(patch.property_id || '').trim()
            const propertyIdentityChanged = !currentProperty || !requestedProperty
              ? currentProperty !== requestedProperty
              : verifiedProperties.length !== 1
            if (propertyIdentityChanged) {
              const error: any = new Error('order_linked_task_property_managed_by_order')
              error.status = 400
              throw error
            }
          }
        }
        const lockedTurnoverTarget = turnoverInspectionScopeTarget(lockedBefore, patch)
        if (lockedTurnoverTarget) {
          const verifiedTurnoverKeys = await normalizeCleaningTurnoverTargetKeys(client, [lockedTurnoverTarget])
          if (verifiedTurnoverKeys.some((key) => !lockedTurnoverTopologyKeys.has(key))) {
            const error: any = new Error('turnover_link_topology_changed_retry')
            error.status = 409
            throw error
          }
        }
        await assertPgExplicitTurnoverLinkTopology(client, String(id), lockedBefore, patch)
        await assertPgTurnoverInspectionScope(client, String(id), lockedBefore, patch)
        const requestedPasswordFields = Array.from(new Set([
          ...(parsed.data.old_code !== undefined ? ['old_code' as const] : []),
          ...(parsed.data.new_code !== undefined ? ['new_code' as const] : []),
          ...((passwordVerification?.fields || []) as Array<'old_code' | 'new_code'>),
        ]))
        const lockedTaskType = String(lockedBefore?.task_type || lockedBefore?.type || '').trim().toLowerCase()
        const passwordFields = assertCleaningPasswordFieldsApplicable(lockedTaskType, requestedPasswordFields)
        if (passwordFields.length) assertPasswordAuthorityTaskMutable({ ...lockedBefore, ...patch })
        const passwordAudit: PasswordAuthorityAuditContext = {
          requestId: passwordVerification?.request_id || operationId,
          actorUserId: String((req as any)?.user?.sub || '').trim() || null,
          actorRole: roleNamesOfRequest(req).join(',') || null,
          client: passwordVerification?.client || 'web',
        }
        const claimedPasswordFields = passwordFields.length
          ? await claimTaskPasswordAuthorityFields({ taskId: String(id), fields: passwordFields, client, audit: passwordAudit })
          : []
        const transactionPatch: any = { ...patch }
        for (const field of requestedPasswordFields) {
          if (!claimedPasswordFields.includes(field)) delete transactionPatch[field]
        }
        const substantiveKeys = Object.keys(transactionPatch).filter((key) => key !== 'updated_at' && transactionPatch[key] !== undefined)
        if (!substantiveKeys.length) delete transactionPatch.updated_at
        const keys = Object.keys(transactionPatch).filter((key) => transactionPatch[key] !== undefined)
        let updated = lockedBefore
        if (keys.length) {
          const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
          const values = keys.map((k) => (transactionPatch[k] === undefined ? null : transactionPatch[k]))
          const sql = `UPDATE cleaning_tasks SET ${set} WHERE id = $${keys.length + 1} RETURNING *`
          const r1 = await client.query(sql, [...values, String(id)])
          updated = r1?.rows?.[0] || lockedBefore
        }
        let confirmedPasswordFields: Array<'old_code' | 'new_code'> = []
        if (claimedPasswordFields.length) {
          const confirmed = await confirmTaskPasswordAuthority({
            taskId: String(id),
            fields: claimedPasswordFields,
            claimedFields: claimedPasswordFields,
            client,
            audit: passwordAudit,
          })
          confirmedPasswordFields = confirmed.updatedFields
          updated = confirmed.task || updated
        }
        if (
          confirmedPasswordFields.includes('new_code') &&
          String(updated?.order_id || '').trim() &&
          String(updated?.task_type || updated?.type || '').trim().toLowerCase() === 'checkin_clean'
        ) {
          await syncCheckoutOldCodeFromCheckinNewCode({ orderId: String(updated.order_id), client, audit: passwordAudit })
          await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: String(updated.order_id), client, audit: passwordAudit })
        }
        if (topologyTouched) {
          await reconcilePasswordAuthorityAfterTaskTopologyChange({ before: lockedBefore, after: updated, client, audit: passwordAudit })
          const refreshed = await client.query('SELECT * FROM cleaning_tasks WHERE id = $1 LIMIT 1', [String(id)])
          updated = refreshed?.rows?.[0] || updated
        }
        if (parsed.data.keys_required !== undefined) {
          const orderId = String(updated?.order_id || '').trim()
          const nextK0 = updated?.keys_required == null ? null : Number(updated.keys_required)
          const nextK = Number.isFinite(nextK0 as any) ? Math.max(1, Math.min(2, Math.trunc(nextK0 as any))) : null
          if (orderId && nextK != null) {
            await client.query(
              `UPDATE cleaning_tasks
               SET keys_required = $1, updated_at = now()
               WHERE order_id::text = $2::text
                 AND ${activeCleaningTaskWhereSql('')}
                 AND COALESCE(keys_required, 1) <> $1`,
              [nextK, orderId],
            )
          }
        }
        const actualChangedFields = actualCleaningTaskChangedFields(lockedBefore, updated, keys)
        if (actualChangedFields.length) {
          const workPatch = buildCleaningTaskWorkPatch(updated, actualChangedFields)
          const arrangementRevision = buildMz031CleaningArrangementRevision(
            lockedBefore,
            updated,
            mz031ManagementStatusArrangementReasons(lockedBefore, updated, parsed.data.status !== undefined),
          )
          await emitWorkTaskEvent({
            taskId: `cleaning_task:${String(id)}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: [String(id)],
            eventType: 'TASK_UPDATED',
            changeScope: workPatch.changedFields.some((field) => field === 'checkout_time' || field === 'checkin_time' || field === 'start_time' || field === 'end_time' || field === 'summary') ? 'list' : 'detail',
            changedFields: workPatch.changedFields,
            patch: workPatch.patch,
            payload: arrangementRevision ? { arrangement_revision: arrangementRevision } : undefined,
            causedByUserId: String((req as any)?.user?.sub || '').trim() || null,
            visibilityHints: buildCleaningTaskVisibilityHints(updated),
          }, client)
        }
        return { updated, actualChangedFields }
      })
      if (!transactionResult) throw new Error('pg not available')
      const { updated, actualChangedFields } = transactionResult
      if (actualChangedFields.length && isDeferredInspectionCheckinConflictRelevantChange(actualChangedFields)) {
        await reconcileDeferredInspectionCheckinReplacement({
          taskIds: [String(id)],
          actorUserId: String((req as any)?.user?.sub || '').trim() || null,
        })
      }
      if (actualChangedFields.length && isDeferredInspectionCheckinConflictRelevantChange(actualChangedFields)) {
        enqueueNotification(() => emitDeferredInspectionCheckinConflictAlerts({
          taskIds: [String(id)],
          actorUserId: String((req as any)?.user?.sub || '').trim() || null,
        }))
      }
      if (actualChangedFields.length) {
        try {
          const { changes, lines, inboxLines } = buildCleaningTaskUpdateNoticeDetails(before, updated)
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
                  inboxBody: inboxLines.join('\n'),
                  data,
                  actorUserId: (req as any).user?.sub,
                },
                { operationId },
              ),
            )
          }
        } catch {}
      }
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
    const localPasswordVerification = localPatch.password_verification
    delete localPatch.password_verification
    if (localPatch.guest_special_request === undefined && localPatch.note !== undefined) localPatch.guest_special_request = localPatch.note
    delete localPatch.note
    if (localPatch.property_id !== undefined
      && String((task as any).order_id || '').trim()
      && memoryCanonicalCleaningPropertyId(localPatch.property_id) !== memoryCanonicalCleaningPropertyId((task as any).property_id)) {
      const error: any = new Error('order_linked_task_property_managed_by_order')
      error.status = 400
      throw error
    }
    assertExplicitTurnoverLinkTopology(task, localPatch, db.cleaningTasks as any[])
    assertMemoryTurnoverInspectionScope(String(id), task, localPatch)
    const isCheckinSiteExecution = isCheckinSiteExecutionTask({
      task_type: localPatch.task_type ?? task.task_type,
      inspection_scope: localPatch.inspection_scope ?? task.inspection_scope,
    })
    if (!isCheckinSiteExecution && !(await isValidStaffId((parsed.data as any).inspector_id ?? null, 'inspector'))) return res.status(400).json({ message: '无效的检查人员' })
    if (isCheckinSiteExecution && !(await isValidAnyStaffId(localPatch.assignee_id ?? null))) return res.status(400).json({ message: '无效的执行人' })
    if (isCheckinSiteExecution && !(await isValidAnyStaffId(localPatch.inspector_id ?? null))) return res.status(400).json({ message: '无效的执行人' })
    validateAndApplyInspectionPatch({ patch: localPatch as any, current: task })
    const localRequestedPasswordFields = Array.from(new Set([
      ...(localPatch.old_code !== undefined ? ['old_code' as const] : []),
      ...(localPatch.new_code !== undefined ? ['new_code' as const] : []),
      ...((localPasswordVerification?.fields || []) as Array<'old_code' | 'new_code'>),
    ]))
    const localTaskType = String(localPatch.task_type || localPatch.type || (task as any).task_type || (task as any).type || '').trim().toLowerCase()
    const localPasswordFields = assertCleaningPasswordFieldsApplicable(localTaskType, localRequestedPasswordFields)
    if (localPasswordFields.length) assertPasswordAuthorityTaskMutable({ ...task, ...localPatch })
    const localPasswordAudit: PasswordAuthorityAuditContext = {
      requestId: localPasswordVerification?.request_id || operationId,
      actorUserId: String((req as any)?.user?.sub || '').trim() || null,
      actorRole: roleNamesOfRequest(req).join(',') || null,
      client: localPasswordVerification?.client || 'web',
    }
    const localClaimedPasswordFields = localPasswordFields.length
      ? await claimTaskPasswordAuthorityFields({ taskId: String(id), fields: localPasswordFields, audit: localPasswordAudit })
      : []
    for (const field of localRequestedPasswordFields) {
      if (!localClaimedPasswordFields.includes(field)) delete localPatch[field]
    }
    if (localPatch.property_id !== undefined) task.property_id = localPatch.property_id
    if (localPatch.task_date !== undefined) { task.task_date = localPatch.task_date; task.date = localPatch.task_date }
    if (localPatch.status !== undefined) task.status = localPatch.status
    if (localPatch.cleaner_id !== undefined) task.cleaner_id = localPatch.cleaner_id
    if (localPatch.inspector_id !== undefined) task.inspector_id = localPatch.inspector_id
    if (localPatch.inspection_scope !== undefined) task.inspection_scope = normalizeInspectionScope(localPatch.inspection_scope)
    if (localPatch.inspection_mode !== undefined) task.inspection_mode = localPatch.inspection_mode
    if (localPatch.inspection_due_date !== undefined) task.inspection_due_date = localPatch.inspection_due_date
    if (localPatch.keys_required !== undefined) task.keys_required = localPatch.keys_required
    if (localPatch.nights_override !== undefined && localPatch.nights_override !== null && shouldIgnoreNightsOverrideForAutoCheckinTask(task)) {
      delete localPatch.nights_override
    }
    if (localPatch.nights_override !== undefined) task.nights_override = localPatch.nights_override
    if (localPatch.old_code !== undefined) task.old_code = localPatch.old_code
    if (localPatch.new_code !== undefined) task.new_code = localPatch.new_code
    if (localPatch.checkout_time !== undefined) task.checkout_time = localPatch.checkout_time
    if (localPatch.checkin_time !== undefined) task.checkin_time = localPatch.checkin_time
    if (localPatch.assignee_id !== undefined) task.assignee_id = localPatch.assignee_id
    if (isCheckinSiteExecution) {
      if (localPatch.assignee_id !== undefined && localPatch.cleaner_id === undefined) task.cleaner_id = null
    } else {
      if (localPatch.cleaner_id !== undefined && localPatch.assignee_id === undefined) task.assignee_id = localPatch.cleaner_id
      if (localPatch.assignee_id !== undefined && localPatch.cleaner_id === undefined) task.cleaner_id = localPatch.assignee_id
    }
    if (localPatch.scheduled_at !== undefined) task.scheduled_at = localPatch.scheduled_at
    if (localPatch.guest_special_request !== undefined) task.guest_special_request = localPatch.guest_special_request
    let localConfirmedPasswordFields: Array<'old_code' | 'new_code'> = []
    if (localClaimedPasswordFields.length) {
      const confirmed = await confirmTaskPasswordAuthority({
        taskId: String(id),
        fields: localClaimedPasswordFields,
        claimedFields: localClaimedPasswordFields,
        audit: localPasswordAudit,
      })
      localConfirmedPasswordFields = confirmed.updatedFields
    }
    if (
      localConfirmedPasswordFields.includes('new_code') &&
      String((task as any).order_id || '').trim() &&
      String((task as any).task_type || (task as any).type || '').trim().toLowerCase() === 'checkin_clean'
    ) {
      await syncCheckoutOldCodeFromCheckinNewCode({ orderId: String((task as any).order_id), audit: localPasswordAudit })
      await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: String((task as any).order_id), audit: localPasswordAudit })
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
        const cleaner = String(isCheckinSiteExecution ? (task.assignee_id || task.inspector_id || '') : (task.cleaner_id || task.assignee_id || '')).trim()
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
    if (localPatch.property_id !== undefined || localPatch.task_date !== undefined || localPatch.status !== undefined) {
      await reconcilePasswordAuthorityAfterTaskTopologyChange({ before, after: task, audit: localPasswordAudit })
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
      const { changes, lines, inboxLines } = buildCleaningTaskUpdateNoticeDetails(before, task)
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
              inboxBody: inboxLines.join('\n'),
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
    if (e instanceof TurnoverLinkTopologyConflict) return res.status(e.status).json({ code: e.code, message: e.message })
    if (sendTurnoverInspectionScopeConflict(res, e)) return
    const conflict = inspectionAssignmentConflictPayload(e)
    if (conflict) return res.status(409).json(conflict)
    return res.status(Number(e?.status || 500)).json({ message: e?.message || 'update_failed' })
  }
})

const createTaskSchema = z.object({
  request_id: z.string().trim().min(1).max(100).optional(),
  task_type: z.enum(['checkout_clean', 'checkin_clean', 'stayover_clean']).optional(),
  create_mode: z.enum(['checkout', 'checkin', 'turnover', 'stayover']).optional(),
  task_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  property_id: z.string().min(1),
  status: cleaningTaskStatusSchema.optional(),
  assignee_id: z.union([z.string().min(1), z.null()]).optional(),
  cleaner_id: z.union([z.string().min(1), z.null()]).optional(),
  inspector_id: z.union([z.string().min(1), z.null()]).optional(),
  inspection_scope: z.enum(['inspect_and_hang', 'password_only']).optional().nullable(),
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
  linked_checkout_task_id: z.union([z.string().min(1), z.null()]).optional(),
  checkin_link_decision: z.enum(['link', 'independent']).optional().nullable(),
  linked_checkin_task_id: z.union([z.string().min(1), z.null()]).optional(),
  checkout_link_decision: z.enum(['link', 'independent']).optional().nullable(),
}).strict()

router.post('/tasks', requireCleaningManualCreateAccess, requireR5TaskRuntimeSchema, async (req, res) => {
  if (!isPasswordAuthoritySchemaReady()) return res.status(503).json({ code: 'password_authority_schema_not_ready' })
  const parsed = createTaskSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const operationId = uuid()
  try {
    const mode = (parsed.data as any).create_mode
    const taskType = parsed.data.task_type
    const singleTypeForMode = mode === 'checkout' ? 'checkout_clean'
      : mode === 'checkin' ? 'checkin_clean'
      : mode === 'stayover' ? 'stayover_clean'
      : null
    if (mode && taskType && singleTypeForMode !== taskType) {
      return res.status(400).json({ code: 'ambiguous_manual_create_mode', message: 'create_mode 与 task_type 的任务类型不一致' })
    }
    if (!mode && !taskType) return res.status(400).json({ message: 'missing task_type' })
    const types =
      mode === 'turnover' ? ['checkout_clean', 'checkin_clean'] :
      mode === 'checkout' ? ['checkout_clean'] :
      mode === 'checkin' ? ['checkin_clean'] :
      mode === 'stayover' ? ['stayover_clean'] :
      [String(taskType)]
    const createIsCheckinSiteExecution = types.length === 1
      && types[0] === 'checkin_clean'
      && (parsed.data as any).assignee_id !== undefined
    if (!(await isValidStaffId((parsed.data as any).cleaner_id ?? null, 'cleaner'))) return res.status(400).json({ message: '无效的清洁人员' })
    if (!createIsCheckinSiteExecution && !(await isValidStaffId((parsed.data as any).inspector_id ?? null, 'inspector'))) return res.status(400).json({ message: '无效的检查人员' })
    if (createIsCheckinSiteExecution && !(await isValidAnyStaffId((parsed.data as any).assignee_id ?? null))) return res.status(400).json({ message: '无效的执行人' })
    if (types.includes('checkout_clean') && types.includes('checkin_clean') && (parsed.data as any).inspection_scope === 'password_only') {
      return res.status(400).json({ code: TURNOVER_INSPECTION_SCOPE_CONFLICT, message: '同日退房入住任务必须检查后挂钥匙' })
    }
    if (parsed.data.old_code !== undefined && !types.includes('checkout_clean')) {
      return res.status(400).json({ message: 'password_field_not_applicable' })
    }
    if (parsed.data.new_code !== undefined && !types.includes('checkin_clean')) {
      return res.status(400).json({ message: 'password_field_not_applicable' })
    }

    const createdRows: any[] = []
    const actorUserId = String((req as any)?.user?.sub || '').trim()
    const createRequestId = String((parsed.data as any).request_id || '').trim() || null
    if (createRequestId && !actorUserId) throw new ManualCreateReplayConflict('无法确认创建请求的操作人')
    const requestedTaskId = (taskTypeValue: string) => createRequestId
      ? uuidv5(`${actorUserId}:${createRequestId}:${String(taskTypeValue || '').trim().toLowerCase()}`, MANUAL_CREATE_REQUEST_NAMESPACE)
      : uuid()
    const linkedCheckoutTaskId = String((parsed.data as any).linked_checkout_task_id || '').trim() || null
    const checkinLinkDecision = ((parsed.data as any).checkin_link_decision || null) as ManualCheckinLinkDecision
    const linkedCheckinTaskId = String((parsed.data as any).linked_checkin_task_id || '').trim() || null
    const checkoutLinkDecision = ((parsed.data as any).checkout_link_decision || null) as ManualCheckoutLinkDecision
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
    const baseAssigneeId = (parsed.data as any).assignee_id !== undefined ? ((parsed.data as any).assignee_id ?? null) : (parsed.data.cleaner_id ?? null)
    const base: any = {
      order_id: null,
      property_id: normalizedPropertyId,
      task_date: parsed.data.task_date,
      date: parsed.data.task_date,
      status: parsed.data.status || assignedStatusFromAssignees(baseAssigneeId ?? parsed.data.cleaner_id ?? null, (parsed.data as any).inspector_id ?? null),
      assignee_id: baseAssigneeId,
      cleaner_id: createIsCheckinSiteExecution ? null : (parsed.data.cleaner_id ?? null),
      inspector_id: (parsed.data.inspector_id ?? null),
      inspection_scope: types.includes('checkout_clean') && types.includes('checkin_clean')
        ? 'inspect_and_hang'
        : ((parsed.data as any).inspection_scope ?? null),
      scheduled_at: parsed.data.scheduled_at ?? null,
      old_code_source_task_id: null,
      old_code_source_order_id: null,
      old_code_source_field: null,
      checkout_time: parsed.data.checkout_time ?? null,
      checkin_time: parsed.data.checkin_time ?? null,
      keys_required: parsed.data.keys_required == null ? 1 : parsed.data.keys_required,
      nights_override: (parsed.data as any).nights_override ?? null,
      guest_special_request: (parsed.data as any).guest_special_request ?? (parsed.data as any).note ?? null,
      auto_sync_enabled: true,
      source: 'manual',
      execution_state: 'active',
      manual_task_purpose: null,
      linked_checkout_task_id: null,
    }
    const createRequestHash = createRequestId
      ? manualCreateRequestHash({
          actor_user_id: actorUserId,
          task_types: types,
          property_id: normalizedPropertyId,
          task_date: parsed.data.task_date,
          status: base.status,
          assignee_id: base.assignee_id,
          cleaner_id: base.cleaner_id,
          inspector_id: base.inspector_id,
          inspection_scope: base.inspection_scope,
          inspection_mode: (parsed.data as any).inspection_mode ?? null,
          inspection_due_date: (parsed.data as any).inspection_due_date ?? null,
          scheduled_at: base.scheduled_at,
          old_code: parsed.data.old_code ?? null,
          new_code: parsed.data.new_code ?? null,
          checkout_time: base.checkout_time,
          checkin_time: base.checkin_time,
          keys_required: base.keys_required,
          nights_override: base.nights_override,
          guest_special_request: base.guest_special_request,
          linked_checkout_task_id: linkedCheckoutTaskId,
          checkin_link_decision: checkinLinkDecision,
          linked_checkin_task_id: linkedCheckinTaskId,
          checkout_link_decision: checkoutLinkDecision,
        })
      : null
    if (hasPg && pgPool) {
      await ensureCleaningSchemaV2()
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        // Creating a task changes the property's password-source topology.
        // Serialize it with every save/sync/cancel path before taking any
        // cleaning-task row or turnover lock.
        await lockCleaningPasswordChainKey(client, normalizedPropertyId)
        if (types.some((type) => type === 'checkout_clean' || type === 'checkin_clean')) {
          await lockCleaningTurnoverKey(client, normalizedPropertyId, parsed.data.task_date)
        }
        if (createRequestId) {
          const expectedIds = types.map(requestedTaskId)
          const receiptInsert = await client.query(
            `INSERT INTO manual_cleaning_task_create_receipts(
               actor_user_id, request_id, request_hash, task_ids, task_types, status
             ) VALUES($1, $2, $3, $4::text[], $5::text[], 'pending')
             ON CONFLICT (actor_user_id, request_id) DO NOTHING
             RETURNING actor_user_id`,
            [actorUserId, createRequestId, createRequestHash, expectedIds, types],
          )
          if (!receiptInsert?.rows?.length) {
            const receiptResult = await client.query(
              `SELECT request_hash, task_ids, task_types, status
                 FROM manual_cleaning_task_create_receipts
                WHERE actor_user_id=$1 AND request_id=$2
                FOR UPDATE`,
              [actorUserId, createRequestId],
            )
            const receipt = receiptResult?.rows?.[0] || null
            if (!receipt || String(receipt.request_hash || '') !== String(createRequestHash || '')) {
              throw new ManualCreateReplayConflict('原请求结果需要核对，请刷新任务列表确认后重新开始新的创建操作')
            }
            if (String(receipt.status || '') !== 'completed') {
              throw new ManualCreateReplayConflict('该创建请求仍在处理中，请稍后重试')
            }
            const receiptIds = Array.isArray(receipt.task_ids) ? receipt.task_ids.map(String) : []
            const receiptTypes = Array.isArray(receipt.task_types) ? receipt.task_types.map(String) : []
            const replayResult = await client.query(
              `SELECT * FROM cleaning_tasks WHERE id::text = ANY($1::text[]) FOR UPDATE`,
              [receiptIds],
            )
            const replayRows = replayResult?.rows || []
            const exactReplay = replayRows.length === receiptIds.length
              && receiptIds.length === expectedIds.length
              && receiptTypes.length === types.length
              && receiptIds.every((id: string) => replayRows.some((row: any) => String(row?.id || '') === id))
              && types.every((type, index) => receiptTypes[index] === type && receiptIds[index] === requestedTaskId(type))
            if (!exactReplay) throw new ManualCreateReplayConflict('创建回执与任务不一致，请刷新后联系管理员')
            if (replayRows.some((row: any) => !isActiveManualCreateReplayRow(row))) {
              throw new ManualCreateReplayConflict('原创建任务已取消或失效，不能把旧请求当作新建成功', MANUAL_CREATE_REPLAY_INACTIVE)
            }
            await client.query('COMMIT')
            if (replayRows.length === 1) return res.json({ ...replayRows[0], idempotent: true })
            return res.json({ ok: true, created: replayRows.length, idempotent: true })
          }
        }
        let selectedExistingCheckinId: string | null = null
        let selectedExistingCheckoutRow: any = null
        if (types.length === 1 && (types[0] === 'checkin_clean' || types[0] === 'checkout_clean')) {
          // All turnover mutations take the same advisory lock before any
          // cleaning_tasks row lock. This matches order sync and prevents a
          // row->advisory / advisory->row deadlock during concurrent linking.
          // The lock is also required for an explicit independent decision so
          // a concurrent checkout cannot appear between validation and insert.
          await lockCleaningTurnoverKey(client, normalizedPropertyId, parsed.data.task_date)
          const sameDayRes = await client.query(
            `SELECT t.id::text AS id,
                    COALESCE(task_property_id.id::text, task_property_code.id::text, t.property_id::text) AS property_id,
                    t.task_date,
                    t.date,
                    t.task_type,
                    t.type,
                    t.status,
                    t.execution_state,
                    t.linked_checkout_task_id,
                    t.inspection_scope,
                    t.assignee_id,
                    t.cleaner_id,
                    t.inspector_id,
                    t.order_id::text AS order_id,
                    t.checkout_time,
                    t.checkin_time,
                    o.id::text AS linked_order_id,
                    COALESCE(order_property_id.id::text, order_property_code.id::text, o.property_id::text) AS linked_order_property_id,
                    o.status AS linked_order_status,
                    o.checkin AS order_checkin,
                    o.checkout AS order_checkout
             FROM cleaning_tasks t
             LEFT JOIN orders o ON o.id::text=t.order_id::text
             LEFT JOIN properties task_property_id ON task_property_id.id::text=t.property_id::text
             LEFT JOIN properties task_property_code ON upper(task_property_code.code)=upper(t.property_id::text)
             LEFT JOIN properties order_property_id ON order_property_id.id::text=o.property_id::text
             LEFT JOIN properties order_property_code ON upper(order_property_code.code)=upper(o.property_id::text)
             WHERE COALESCE(task_property_id.id::text, task_property_code.id::text, t.property_id::text)=$1
               AND COALESCE(t.task_date, t.date)::date=$2::date
               AND ${activeCleaningTaskWhereSql('t')}
             FOR UPDATE OF t`,
            [normalizedPropertyId, parsed.data.task_date],
          )
          const sameDayRows = sameDayRes?.rows || []
          if (types[0] === 'checkin_clean') {
            if (linkedCheckinTaskId || checkoutLinkDecision) throw new ManualCheckoutLinkConflict('新增入住不能提交退房侧关联字段')
            const selectedExistingCheckoutId = resolveManualCheckinCheckoutSelection({
              linkedCheckoutTaskId,
              decision: checkinLinkDecision,
              createdTypes: types,
              propertyId: normalizedPropertyId,
              taskDate: parsed.data.task_date,
              sameDayRows,
            })
            base.linked_checkout_task_id = selectedExistingCheckoutId
            selectedExistingCheckoutRow = selectedExistingCheckoutId
              ? sameDayRows.find((row: any) => String(row?.id || '').trim() === selectedExistingCheckoutId) || null
              : null
          } else {
            if (linkedCheckoutTaskId || checkinLinkDecision) throw new ManualCheckinLinkConflict('新增退房不能提交入住侧关联字段')
            selectedExistingCheckinId = resolveManualCheckoutCheckinSelection({
              linkedCheckinTaskId,
              decision: checkoutLinkDecision,
              createdTypes: types,
              propertyId: normalizedPropertyId,
              taskDate: parsed.data.task_date,
              sameDayRows,
            })
          }
        } else if (linkedCheckoutTaskId || checkinLinkDecision || linkedCheckinTaskId || checkoutLinkDecision) {
          throw new ManualCheckinLinkConflict('只有单独新增任务可以选择关联或独立创建')
        }
        for (const tt of types) {
          const pairedCheckoutId = tt === 'checkin_clean' && types.includes('checkout_clean')
            ? String(createdRows.find((candidate) => String(candidate?.task_type || '').trim().toLowerCase() === 'checkout_clean')?.id || '').trim() || null
            : null
          const row: any = {
            id: requestedTaskId(tt),
            ...base,
            task_type: tt,
            type: tt,
            old_code: tt === 'checkout_clean' ? (parsed.data.old_code ?? null) : null,
            new_code: tt === 'checkin_clean' ? (parsed.data.new_code ?? null) : null,
            old_code_authority_status: tt === 'checkout_clean' ? 'needs_review' : 'not_applicable',
            new_code_authority_status: tt === 'checkin_clean' ? 'needs_review' : 'not_applicable',
            inspection_mode: normalizeInspectionMode((parsed.data as any).inspection_mode) || defaultInspectionModeForTaskType(tt),
            inspection_due_date: (parsed.data as any).inspection_due_date ?? null,
            linked_checkout_task_id: pairedCheckoutId ?? base.linked_checkout_task_id,
          }
          validateAndApplyInspectionPatch({ patch: row, taskType: tt })
          const turnoverTarget = turnoverInspectionScopeTarget(row)
          if (turnoverTarget) await lockCleaningTurnoverKey(client, turnoverTarget.propertyId, turnoverTarget.taskDate)
          await assertPgTurnoverInspectionScope(client, String(row.id), row)
          const keys = Object.keys(row).filter((k) => row[k] !== undefined)
          const cols = keys.map((k) => `"${k}"`).join(', ')
          const args = keys.map((_, i) => `$${i + 1}`).join(', ')
          const values = keys.map((k) => row[k])
          const sql = `INSERT INTO cleaning_tasks(${cols}) VALUES(${args}) RETURNING *`
          const r = await client.query(sql, values)
          const created = r?.rows?.[0] || row
          createdRows.push(created)
          const linkedCheckoutId = tt === 'checkin_clean'
            ? String(created?.linked_checkout_task_id || '').trim()
            : ''
          const linkedCheckoutRow = linkedCheckoutId
            ? createdRows.find((candidate) => String(candidate?.id || '').trim() === linkedCheckoutId)
              || (String(selectedExistingCheckoutRow?.id || '').trim() === linkedCheckoutId ? selectedExistingCheckoutRow : null)
            : null
          if (linkedCheckoutId && !linkedCheckoutRow) throw new ManualCheckinLinkConflict('所选退房任务已失效，请刷新后重试')
          await emitWorkTaskEvent({
            taskId: `cleaning_task:${String(created.id)}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: linkedCheckoutId ? [linkedCheckoutId, String(created.id)] : [String(created.id)],
            eventType: 'TASK_CREATED',
            changeScope: 'list',
            changedFields: ['task_type', 'task_date', 'date', 'status', 'assignee_id', 'cleaner_id', 'inspector_id', 'scheduled_at', 'property_id', 'linked_checkout_task_id'],
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
              linked_checkout_task_id: created.linked_checkout_task_id ?? null,
            },
            causedByUserId: String((req as any)?.user?.sub || '').trim() || null,
            visibilityHints: linkedCheckoutRow
              ? buildCleaningPairVisibilityHints(created, linkedCheckoutRow)
              : buildCleaningTaskVisibilityHints(created),
          }, client)
        }
        if (selectedExistingCheckinId) {
          const createdCheckout = createdRows.find((row) => String(row?.task_type || '').trim().toLowerCase() === 'checkout_clean') || null
          const checkoutId = String(createdCheckout?.id || '').trim()
          if (!checkoutId) throw new ManualCheckoutLinkConflict('退房任务创建失败，未建立关联')
          const updatedCheckinResult = await client.query(
            `UPDATE cleaning_tasks
                SET linked_checkout_task_id=$1, updated_at=now()
              WHERE id::text=$2
              RETURNING *`,
            [checkoutId, selectedExistingCheckinId],
          )
          const updatedCheckin = updatedCheckinResult?.rows?.[0] || null
          if (!updatedCheckin) throw new ManualCheckoutLinkConflict('所选入住任务已失效，请刷新后重试')
          await emitWorkTaskEvent({
            taskId: `cleaning_task:${selectedExistingCheckinId}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: [checkoutId, selectedExistingCheckinId],
            eventType: 'TASK_UPDATED',
            changeScope: 'list',
            changedFields: ['linked_checkout_task_id'],
            patch: { linked_checkout_task_id: checkoutId },
            causedByUserId: String((req as any)?.user?.sub || '').trim() || null,
            visibilityHints: buildCleaningPairVisibilityHints(updatedCheckin, createdCheckout),
          }, client)
        }
        if (createdRows.length) {
          await reconcileDeferredInspectionCheckinReplacement({
            taskIds: Array.from(new Set([
              ...createdRows.map((row) => String(row.id || '')).filter(Boolean),
              ...(selectedExistingCheckinId ? [selectedExistingCheckinId] : []),
            ])),
            actorUserId: String((req as any)?.user?.sub || '').trim() || null,
            pgClient: client,
          })
        }
        if (createRequestId) {
          await client.query(
            `UPDATE manual_cleaning_task_create_receipts
                SET status='completed', completed_at=now()
              WHERE actor_user_id=$1 AND request_id=$2 AND request_hash=$3`,
            [actorUserId, createRequestId, createRequestHash],
          )
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
          const { changes, lines, inboxLines } = buildCleaningTaskCreateNoticeDetails(created)
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
                inboxBody: inboxLines.join('\n'),
                data: { entity: 'cleaning_task', entityId: String(created.id), action: 'open_task', kind: 'cleaning_task_manager_fields_updated' },
                actorUserId: (req as any).user?.sub,
              },
              { operationId },
            ),
          )
        } catch {}
      }
      if (createdRows.length) {
        enqueueNotification(() => emitDeferredInspectionCheckinConflictAlerts({
          taskIds: createdRows.map((row) => String(row.id || '')).filter(Boolean),
          actorUserId: String((req as any)?.user?.sub || '').trim() || null,
        }))
      }
      if (createdRows.length === 1) return res.json(createdRows[0])
      return res.json({ ok: true, created: createdRows.length })
    }
    let selectedExistingCheckinId: string | null = null
    if (createRequestId) {
      const expectedIds = types.map(requestedTaskId)
      const receiptKey = `${actorUserId}:${createRequestId}`
      const receipt = manualCreateMemoryReceipts.get(receiptKey) || null
      if (receipt) {
        if (receipt.requestHash !== createRequestHash) throw new ManualCreateReplayConflict('原请求结果需要核对，请刷新任务列表确认后重新开始新的创建操作')
        const replayRows = (db.cleaningTasks as any[]).filter((row) => receipt.taskIds.includes(String(row?.id || '')))
        const exactReplay = replayRows.length === receipt.taskIds.length
          && receipt.taskIds.length === expectedIds.length
          && receipt.taskTypes.length === types.length
          && types.every((type, index) => receipt.taskTypes[index] === type && receipt.taskIds[index] === requestedTaskId(type))
        if (!exactReplay) throw new ManualCreateReplayConflict('创建回执与任务不一致，请刷新后联系管理员')
        if (replayRows.some((row) => !isActiveManualCreateReplayRow(row))) {
          throw new ManualCreateReplayConflict('原创建任务已取消或失效，不能把旧请求当作新建成功', MANUAL_CREATE_REPLAY_INACTIVE)
        }
        if (replayRows.length === 1) return res.json({ ...replayRows[0], idempotent: true })
        return res.json({ ok: true, created: replayRows.length, idempotent: true })
      }
    }
    if (types.length === 1 && types[0] === 'checkin_clean') {
      if (linkedCheckinTaskId || checkoutLinkDecision) throw new ManualCheckoutLinkConflict('新增入住不能提交退房侧关联字段')
      base.linked_checkout_task_id = resolveManualCheckinCheckoutSelection({
        linkedCheckoutTaskId,
        decision: checkinLinkDecision,
        createdTypes: types,
        propertyId: normalizedPropertyId,
        taskDate: parsed.data.task_date,
        sameDayRows: (db.cleaningTasks as any[]).map(memoryTaskWithOrderBoundaries),
      })
    } else if (types.length === 1 && types[0] === 'checkout_clean') {
      if (linkedCheckoutTaskId || checkinLinkDecision) throw new ManualCheckinLinkConflict('新增退房不能提交入住侧关联字段')
      selectedExistingCheckinId = resolveManualCheckoutCheckinSelection({
        linkedCheckinTaskId,
        decision: checkoutLinkDecision,
        createdTypes: types,
        propertyId: normalizedPropertyId,
        taskDate: parsed.data.task_date,
        sameDayRows: (db.cleaningTasks as any[]).map(memoryTaskWithOrderBoundaries),
      })
    } else if (linkedCheckoutTaskId || checkinLinkDecision || linkedCheckinTaskId || checkoutLinkDecision) {
      throw new ManualCheckinLinkConflict('只有单独新增任务可以选择关联或独立创建')
    }
    for (const tt of types) {
      const pairedCheckoutId = tt === 'checkin_clean' && types.includes('checkout_clean')
        ? String(createdRows.find((candidate) => String(candidate?.task_type || '').trim().toLowerCase() === 'checkout_clean')?.id || '').trim() || null
        : null
      const row: any = {
        id: requestedTaskId(tt),
        ...base,
        task_type: tt,
        type: tt,
        old_code: tt === 'checkout_clean' ? (parsed.data.old_code ?? null) : null,
        new_code: tt === 'checkin_clean' ? (parsed.data.new_code ?? null) : null,
        old_code_authority_status: tt === 'checkout_clean' ? 'needs_review' : 'not_applicable',
        new_code_authority_status: tt === 'checkin_clean' ? 'needs_review' : 'not_applicable',
        inspection_mode: normalizeInspectionMode((parsed.data as any).inspection_mode) || defaultInspectionModeForTaskType(tt),
        inspection_due_date: (parsed.data as any).inspection_due_date ?? null,
        linked_checkout_task_id: pairedCheckoutId ?? base.linked_checkout_task_id,
      }
      validateAndApplyInspectionPatch({ patch: row, taskType: tt })
      assertMemoryTurnoverInspectionScope(String(row.id), row)
      ;(db.cleaningTasks as any[]).push(row)
      createdRows.push(row)
    }
    if (selectedExistingCheckinId) {
      const checkoutId = String(createdRows.find((row) => String(row?.task_type || '').trim().toLowerCase() === 'checkout_clean')?.id || '').trim()
      const selectedCheckin = (db.cleaningTasks as any[]).find((row) => String(row?.id || '').trim() === selectedExistingCheckinId) || null
      if (!checkoutId || !selectedCheckin) throw new ManualCheckoutLinkConflict('所选入住任务已失效，请刷新后重试')
      selectedCheckin.linked_checkout_task_id = checkoutId
      selectedCheckin.updated_at = new Date().toISOString()
    }
    if (createRequestId) {
      manualCreateMemoryReceipts.set(`${actorUserId}:${createRequestId}`, {
        requestHash: String(createRequestHash || ''),
        taskIds: createdRows.map((row) => String(row.id || '')),
        taskTypes: types.slice(),
      })
    }
    if (createdRows.length === 1) return res.json(createdRows[0])
    return res.json({ ok: true, created: createdRows.length })
  } catch (e: any) {
    if (e instanceof ManualCheckinLinkDecisionRequired) {
      return res.status(e.status).json({ code: e.code, message: e.message, candidate_count: e.candidateCount })
    }
    if (e instanceof ManualCheckinLinkConflict) return res.status(e.status).json({ code: e.code, message: e.message })
    if (e instanceof ManualCheckoutLinkConflict) return res.status(e.status).json({ code: e.code, message: e.message })
    if (e instanceof ManualCreateReplayConflict) return res.status(e.status).json({ code: e.code, message: e.message })
    if (String(e?.code || '') === '42P01' && String(e?.message || '').includes('manual_cleaning_task_create_receipts')) {
      return res.status(503).json({ code: 'manual_create_receipt_schema_not_ready' })
    }
    if (sendTurnoverInspectionScopeConflict(res, e)) return
    const conflict = inspectionAssignmentConflictPayload(e)
    if (conflict) return res.status(409).json(conflict)
    return res.status(500).json({ message: e?.message || 'create_failed' })
  }
})

router.delete('/tasks/:id', requirePerm('cleaning.task.assign'), requireR5TaskRuntimeSchema, async (req, res) => {
  const { id } = req.params
  const actor = (req as any).user
  const actorId = actor?.sub ? String(actor.sub) : undefined
  const operationId = uuid()
  try {
    if (hasPg && pgPool) {
      const deleted = await pgRunInTransaction(async (client) => {
        const snapshotResult = await client.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [String(id)])
        const snapshot = snapshotResult?.rows?.[0] || null
        if (!snapshot) return null
        const lockedPropertyIds = await normalizeCleaningPasswordChainKeys(client, [snapshot.property_id])
        for (const propertyId of lockedPropertyIds) await lockCleaningPasswordChainKey(client, propertyId)
        const r0 = await client.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1 FOR UPDATE', [String(id)])
        const before = r0?.rows?.[0] || null
        if (!before) return null
        const verifiedPropertyIds = await normalizeCleaningPasswordChainKeys(client, [before.property_id])
        if (verifiedPropertyIds.some((propertyId) => !lockedPropertyIds.includes(propertyId))) {
          const error: any = new Error('password_chain_topology_changed_retry')
          error.status = 409
          throw error
        }
        const r1 = await client.query(`UPDATE cleaning_tasks SET status='cancelled', execution_state='cancelled', auto_sync_enabled=false, updated_at=now() WHERE id=$1 RETURNING *`, [String(id)])
        const after = r1?.rows?.[0] || null
        const taskType = String(before.task_type || before.type || '').trim().toLowerCase()
        const orderId = String(before.order_id || '').trim()
        if (taskType === 'checkin_clean' && orderId) {
          const audit: PasswordAuthorityAuditContext = {
            requestId: operationId,
            actorUserId: actorId || null,
            actorRole: roleNamesOfRequest(req).join(',') || null,
            client: 'web',
          }
          await invalidatePasswordDependentsForSourceTask({
            sourceTaskId: String(id),
            sourceOrderId: orderId,
            reason: 'source_task_cancelled',
            client,
            audit,
          })
          await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: orderId, client, audit })
        }
        await emitWorkTaskEvent({
          taskId: `cleaning_task:${String(id)}`,
          sourceType: 'cleaning_tasks',
          sourceRefIds: [String(id)],
          eventType: 'TASK_REMOVED',
          changeScope: 'membership',
          changedFields: ['status', 'execution_state', 'lifecycle_state'],
          patch: { status: 'cancelled', execution_state: 'cancelled', lifecycle_state: 'deleted' },
          causedByUserId: actorId || null,
          visibilityHints: buildCleaningTaskVisibilityHints(after || before),
        }, client)
        return { before, after }
      })
      if (!deleted) return res.status(404).json({ message: 'task not found' })
      const { before, after } = deleted
      await reconcileDeferredInspectionCheckinReplacement({
        taskIds: [String(id)],
        actorUserId: actorId || null,
      })
      try {
        const propertyId = String((after || before)?.property_id || '').trim()
        if (propertyId) {
          const { title, body } = buildCleaningTaskDeletionNotice(after || before)
          const notificationResult = await emitNotificationEvent(
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
            { operationId },
          )
          logNotificationEmissionOutcome('cleaning_task_deleted', String(id), notificationResult)
        }
      } catch (error: any) {
        logNotificationEmissionFailure('cleaning_task_deleted', String(id), error)
      }
      addAudit('cleaning_task', String(id), 'delete', redactPasswordAuditValues(before).value, redactPasswordAuditValues(after).value, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') })
      return res.json({ ok: true })
    }
    const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
    if (!task) return res.status(404).json({ message: 'task not found' })
    const before = { ...task }
    task.status = 'cancelled'
    task.execution_state = 'cancelled'
    task.auto_sync_enabled = false
    if (String(task.task_type || task.type || '').trim().toLowerCase() === 'checkin_clean' && String(task.order_id || '').trim()) {
      const audit: PasswordAuthorityAuditContext = {
        requestId: operationId,
        actorUserId: actorId || null,
        actorRole: roleNamesOfRequest(req).join(',') || null,
        client: 'web',
      }
      await invalidatePasswordDependentsForSourceTask({
        sourceTaskId: String(id),
        sourceOrderId: String(task.order_id),
        reason: 'source_task_cancelled',
        audit,
      })
      await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: String(task.order_id), audit })
    }
    addAudit('cleaning_task', String(id), 'delete', redactPasswordAuditValues(before).value, redactPasswordAuditValues({ ...task }).value, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') })
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(Number(e?.status || 500)).json({ message: e?.message || 'delete_failed' })
  }
})

const bulkDeleteSchema = z.object({ ids: z.array(z.string().min(1)).min(1) }).strict()
router.post('/tasks/bulk-delete', requirePerm('cleaning.task.assign'), requireR5TaskRuntimeSchema, async (req, res) => {
  const parsed = bulkDeleteSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const actor = (req as any).user
  const actorId = actor?.sub ? String(actor.sub) : undefined
  const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)))
  const operationId = uuid()
  try {
    if (hasPg && pgPool) {
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        const snapshots = await client.query(
          `SELECT t.*, COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS normalized_property_id
           FROM cleaning_tasks t
           LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
           WHERE t.id::text = ANY($1::text[])`,
          [ids],
        )
        const propertyIds = Array.from(new Set((snapshots?.rows || [])
          .map((row: any) => String(row.normalized_property_id || '').trim())
          .filter(Boolean))).sort()
        for (const propertyId of propertyIds) await lockCleaningPasswordChainKey(client, propertyId)
        for (const id of ids) {
          const r0 = await client.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1 FOR UPDATE', [id])
          const before = r0?.rows?.[0] || null
          if (!before) continue
          const verifiedPropertyIds = await normalizeCleaningPasswordChainKeys(client, [before.property_id])
          if (verifiedPropertyIds.some((propertyId) => !propertyIds.includes(propertyId))) {
            const error: any = new Error('password_chain_topology_changed_retry')
            error.status = 409
            throw error
          }
          const r1 = await client.query(`UPDATE cleaning_tasks SET status='cancelled', execution_state='cancelled', auto_sync_enabled=false, updated_at=now() WHERE id=$1 RETURNING *`, [id])
          const after = r1?.rows?.[0] || null
          const taskType = String(before.task_type || before.type || '').trim().toLowerCase()
          const orderId = String(before.order_id || '').trim()
          if (taskType === 'checkin_clean' && orderId) {
            const audit: PasswordAuthorityAuditContext = {
              requestId: operationId,
              actorUserId: actorId || null,
              actorRole: roleNamesOfRequest(req).join(',') || null,
              client: 'web',
            }
            await invalidatePasswordDependentsForSourceTask({
              sourceTaskId: id,
              sourceOrderId: orderId,
              reason: 'source_task_cancelled',
              client,
              audit,
            })
            await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: orderId, client, audit })
          }
          await emitWorkTaskEvent({
            taskId: `cleaning_task:${String(id)}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: [String(id)],
            eventType: 'TASK_REMOVED',
            changeScope: 'membership',
            changedFields: ['status', 'execution_state', 'lifecycle_state'],
            patch: { status: 'cancelled', execution_state: 'cancelled', lifecycle_state: 'deleted' },
            causedByUserId: actorId || null,
            visibilityHints: buildCleaningTaskVisibilityHints(after || before),
          }, client)
          try {
            const propertyId = String((after || before)?.property_id || '').trim()
            if (propertyId) {
              const { title, body } = buildCleaningTaskDeletionNotice(after || before)
              const notificationResult = await emitNotificationEvent(
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
              logNotificationEmissionOutcome('cleaning_task_bulk_deleted', String(id), notificationResult)
            }
          } catch (error: any) {
            logNotificationEmissionFailure('cleaning_task_bulk_deleted', String(id), error)
          }
          addAudit('cleaning_task', String(id), 'delete', redactPasswordAuditValues(before).value, redactPasswordAuditValues(after).value, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') })
        }
        await reconcileDeferredInspectionCheckinReplacement({
          taskIds: ids,
          actorUserId: actorId || null,
          pgClient: client,
        })
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
      if (String(task.task_type || task.type || '').trim().toLowerCase() === 'checkin_clean' && String(task.order_id || '').trim()) {
        const audit: PasswordAuthorityAuditContext = {
          requestId: operationId,
          actorUserId: actorId || null,
          actorRole: roleNamesOfRequest(req).join(',') || null,
          client: 'web',
        }
        await invalidatePasswordDependentsForSourceTask({
          sourceTaskId: id,
          sourceOrderId: String(task.order_id),
          reason: 'source_task_cancelled',
          audit,
        })
        await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: String(task.order_id), audit })
      }
      addAudit('cleaning_task', String(id), 'delete', redactPasswordAuditValues(before).value, redactPasswordAuditValues({ ...task }).value, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') })
      cnt++
    }
    return res.json({ ok: true, deleted: cnt })
  } catch (e: any) {
    return res.status(Number(e?.status || 500)).json({ message: e?.message || 'bulk_delete_failed' })
  }
})

const passwordAuthorityVerifySchema = z.object({
  items: z.array(z.object({
    task_id: z.string().trim().min(1),
    fields: z.array(z.enum(['old_code', 'new_code'])).min(1).max(2),
  }).strict()).min(1).max(50),
  request_id: z.string().trim().min(1).max(100),
  client: z.literal('web'),
}).strict()

router.post('/tasks/password-verify', requirePerm('cleaning.task.assign'), requireR5TaskRuntimeSchema, async (req, res) => {
  if (!isPasswordAuthoritySchemaReady()) return res.status(503).json({ code: 'password_authority_schema_not_ready' })
  const parsed = passwordAuthorityVerifySchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const itemMap = new Map<string, Set<'old_code' | 'new_code'>>()
  for (const item of parsed.data.items) {
    const fields = itemMap.get(item.task_id) || new Set<'old_code' | 'new_code'>()
    for (const field of item.fields) fields.add(field)
    itemMap.set(item.task_id, fields)
  }
  const ids = Array.from(itemMap.keys()).sort()
  try {
    const result = await pgRunInTransaction(async (client) => {
      const snapshotResult = await client.query(
        `SELECT t.*, COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS normalized_property_id
         FROM cleaning_tasks t
         LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
         WHERE t.id::text = ANY($1::text[])
           AND ${activeCleaningTaskWhereSql('t')}`,
        [ids],
      )
      const snapshots = snapshotResult?.rows || []
      if (snapshots.length !== ids.length) {
        const error: any = new Error('password_authority_task_not_found')
        error.status = 404
        throw error
      }
      const propertyIds = Array.from(new Set(snapshots.map((row: any) => String(row.normalized_property_id || '').trim()).filter(Boolean))).sort()
      for (const propertyId of propertyIds) await lockCleaningPasswordChainKey(client, propertyId)
      const lockedResult = await client.query(
        `SELECT * FROM cleaning_tasks
         WHERE id::text = ANY($1::text[])
           AND ${activeCleaningTaskWhereSql('')}
         ORDER BY id
         FOR UPDATE`,
        [ids],
      )
      const lockedById = new Map((lockedResult?.rows || []).map((row: any) => [String(row.id), row]))
      if (lockedById.size !== ids.length) {
        const error: any = new Error('password_authority_task_changed')
        error.status = 409
        throw error
      }
      const verifiedPropertyIds = await normalizeCleaningPasswordChainKeys(
        client,
        Array.from(lockedById.values()).map((row: any) => row?.property_id),
      )
      if (verifiedPropertyIds.some((propertyId) => !propertyIds.includes(propertyId))) {
        const error: any = new Error('password_chain_topology_changed_retry')
        error.status = 409
        throw error
      }
      const audit: PasswordAuthorityAuditContext = {
        requestId: parsed.data.request_id,
        actorUserId: String((req as any)?.user?.sub || '').trim() || null,
        actorRole: roleNamesOfRequest(req).join(',') || null,
        client: 'web',
      }
      const updatedTaskIds: string[] = []
      const sourceOrderIds = new Set<string>()
      for (const id of ids) {
        const task: any = lockedById.get(id)
        const taskType = String(task?.task_type || task?.type || '').trim().toLowerCase()
        const requested = Array.from(itemMap.get(id) || [])
        const fields = assertCleaningPasswordFieldsApplicable(taskType, requested)
        const confirmed = await confirmTaskPasswordAuthority({ taskId: id, fields, client, audit })
        if (confirmed.updatedFields.length) updatedTaskIds.push(id)
        if (taskType === 'checkin_clean' && confirmed.updatedFields.includes('new_code') && String(task.order_id || '').trim()) {
          sourceOrderIds.add(String(task.order_id))
        }
      }
      for (const orderId of Array.from(sourceOrderIds).sort()) {
        await syncCheckoutOldCodeFromCheckinNewCode({ orderId, client, audit })
        await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: orderId, client, audit })
      }
      return { updated_task_ids: updatedTaskIds, replayed: updatedTaskIds.length === 0 }
    })
    return res.json({ ok: true, ...result })
  } catch (error: any) {
    return res.status(Number(error?.status || 500)).json({ message: String(error?.message || 'password_authority_verify_failed') })
  }
})

const atomicTaskPatchSchema = z.object({
  id: z.string().trim().min(1),
  patch: patchTaskSchema,
}).strict()

const atomicOrderKeysPatchSchema = z.object({
  order_id: z.string().trim().min(1),
  keys_required: z.number().int().min(1).max(2),
}).strict()

const atomicPatchSchema = z.object({
  operation_id: z.string().trim().min(8).max(IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH),
  items: z.array(atomicTaskPatchSchema).min(1).max(50),
  order_key_updates: z.array(atomicOrderKeysPatchSchema).max(50).optional().default([]),
}).strict()

type AtomicTaskPatchResult = {
  id: string
  before: any
  after: any
  actualChangedFields: string[]
}

async function applyAtomicTaskPatchPg(params: {
  client: any
  id: string
  inputPatch: z.infer<typeof patchTaskSchema>
  operationId: string
  req: any
}): Promise<AtomicTaskPatchResult> {
  const { client, id, operationId, req } = params
  const snapshotResult = await client.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
  const snapshot = snapshotResult?.rows?.[0] || null
  if (!snapshot) {
    const error: any = new Error('task not found')
    error.status = 404
    throw error
  }

  const patch: any = { ...params.inputPatch }
  const passwordVerification = patch.password_verification
  delete patch.password_verification
  if (patch.guest_special_request === undefined && patch.note !== undefined) patch.guest_special_request = patch.note
  delete patch.note
  if (patch.keys_required === null) patch.keys_required = 1
  if (patch.keys_required !== undefined && String(snapshot.order_id || '').trim()) {
    const error: any = new Error('该任务关联订单，钥匙套数请按订单更新（orders.keys_required）')
    error.status = 400
    throw error
  }
  if (!(await isValidStaffId(patch.cleaner_id ?? null, 'cleaner'))) {
    const error: any = new Error('无效的清洁人员')
    error.status = 400
    throw error
  }

  const hasPasswordWrite = patch.old_code !== undefined || patch.new_code !== undefined || !!passwordVerification?.fields?.length
  const topologyTouched = patch.property_id !== undefined || patch.task_date !== undefined || patch.status !== undefined
  let lockedPasswordProperties: string[] = []
  if (hasPasswordWrite || topologyTouched) {
    lockedPasswordProperties = await normalizeCleaningPasswordChainKeys(client, [
      String(snapshot.property_id || '').trim(),
      String(patch.property_id || '').trim(),
    ])
    for (const propertyId of lockedPasswordProperties) await lockCleaningPasswordChainKey(client, propertyId)
  }
  const lockedTurnoverTopologyKeys = await lockCleaningTurnoverTopologyTargets(client, snapshot, patch)
  const lockedResult = await client.query(
    `SELECT * FROM cleaning_tasks
     WHERE id=$1
       AND ${activeCleaningTaskWhereSql('')}
     LIMIT 1
     FOR UPDATE`,
    [id],
  )
  const before = lockedResult?.rows?.[0] || null
  if (!before || isTerminalCleaningStatus(before.status)) {
    const error: any = new Error('atomic_patch_task_inactive')
    error.status = 409
    throw error
  }
  if (patch.keys_required !== undefined && String(before.order_id || '').trim()) {
    const error: any = new Error('该任务关联订单，钥匙套数请按订单更新（orders.keys_required）')
    error.status = 400
    throw error
  }

  if (hasPasswordWrite || topologyTouched) {
    const verifiedProperties = await normalizeCleaningPasswordChainKeys(client, [before.property_id, patch.property_id])
    if (verifiedProperties.some((propertyId) => !lockedPasswordProperties.includes(propertyId))) {
      const error: any = new Error('password_chain_topology_changed_retry')
      error.status = 409
      throw error
    }
    if (patch.property_id !== undefined && String(before.order_id || '').trim()) {
      const currentProperty = String(before.property_id || '').trim()
      const requestedProperty = String(patch.property_id || '').trim()
      const propertyIdentityChanged = !currentProperty || !requestedProperty
        ? currentProperty !== requestedProperty
        : verifiedProperties.length !== 1
      if (propertyIdentityChanged) {
        const error: any = new Error('order_linked_task_property_managed_by_order')
        error.status = 400
        throw error
      }
    }
  }

  if (patch.nights_override !== undefined && patch.nights_override !== null && shouldIgnoreNightsOverrideForAutoCheckinTask(before)) {
    delete patch.nights_override
  }
  const isCheckinSiteExecution = isCheckinSiteExecutionTask({
    task_type: patch.task_type ?? before.task_type,
    inspection_scope: patch.inspection_scope ?? before.inspection_scope,
  })
  if (isCheckinSiteExecution) {
    if (!(await isValidAnyStaffId(patch.assignee_id ?? null)) || !(await isValidAnyStaffId(patch.inspector_id ?? null))) {
      const error: any = new Error('无效的执行人')
      error.status = 400
      throw error
    }
    if (patch.assignee_id !== undefined && patch.cleaner_id === undefined) patch.cleaner_id = null
  } else {
    if (!(await isValidStaffId(patch.inspector_id ?? null, 'inspector'))) {
      const error: any = new Error('无效的检查人员')
      error.status = 400
      throw error
    }
    if (patch.cleaner_id !== undefined && patch.assignee_id === undefined) patch.assignee_id = patch.cleaner_id
    if (patch.assignee_id !== undefined && patch.cleaner_id === undefined) patch.cleaner_id = patch.assignee_id
  }
  if (patch.task_date != null) patch.date = patch.task_date
  if (patch.inspection_mode !== undefined || patch.inspection_due_date !== undefined) {
    patch.inspection_replaced_by_checkin_task_id = null
    patch.inspection_replaced_original_due_date = null
  }
  validateAndApplyInspectionPatch({ patch, current: before })
  const lockedTurnoverTarget = turnoverInspectionScopeTarget(before, patch)
  if (lockedTurnoverTarget) {
    const verifiedTurnoverKeys = await normalizeCleaningTurnoverTargetKeys(client, [lockedTurnoverTarget])
    if (verifiedTurnoverKeys.some((key) => !lockedTurnoverTopologyKeys.has(key))) {
      const error: any = new Error('turnover_link_topology_changed_retry')
      error.status = 409
      throw error
    }
  }
  await assertPgExplicitTurnoverLinkTopology(client, id, before, patch)
  await assertPgTurnoverInspectionScope(client, id, before, patch)

  const beforeStatus = String(before.status || 'pending')
  const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned'
  const incomingStatus = params.inputPatch.status
  const incomingStatusEligible = incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned'
  const touchingAssignees = params.inputPatch.cleaner_id !== undefined
    || params.inputPatch.inspector_id !== undefined
    || params.inputPatch.assignee_id !== undefined
    || params.inputPatch.inspection_mode !== undefined
    || params.inputPatch.inspection_due_date !== undefined
  if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
    const nextCleanerId = isCheckinSiteExecution
      ? (patch.assignee_id !== undefined ? (patch.assignee_id ?? null) : (before.assignee_id ?? before.inspector_id ?? null))
      : (patch.cleaner_id !== undefined ? (patch.cleaner_id ?? null) : (before.cleaner_id ?? before.assignee_id ?? null))
    const nextInspectorId = patch.inspector_id !== undefined ? (patch.inspector_id ?? null) : (before.inspector_id ?? null)
    patch.status = assignedStatusFromAssignees(nextCleanerId, nextInspectorId)
  }

  const requestedPasswordFields = Array.from(new Set([
    ...(params.inputPatch.old_code !== undefined ? ['old_code' as const] : []),
    ...(params.inputPatch.new_code !== undefined ? ['new_code' as const] : []),
    ...((passwordVerification?.fields || []) as Array<'old_code' | 'new_code'>),
  ]))
  const nextTaskType = String(patch.task_type || patch.type || before?.task_type || before?.type || '').trim().toLowerCase()
  const passwordFields = assertCleaningPasswordFieldsApplicable(nextTaskType, requestedPasswordFields)
  if (passwordFields.length) assertPasswordAuthorityTaskMutable({ ...before, ...patch })
  const passwordAudit: PasswordAuthorityAuditContext = {
    requestId: passwordVerification?.request_id || operationId,
    actorUserId: String(req?.user?.sub || '').trim() || null,
    actorRole: roleNamesOfRequest(req).join(',') || null,
    client: passwordVerification?.client || 'web',
  }
  const claimedPasswordFields = passwordFields.length
    ? await claimTaskPasswordAuthorityFields({ taskId: id, fields: passwordFields, client, audit: passwordAudit })
    : []
  for (const field of requestedPasswordFields) {
    if (!claimedPasswordFields.includes(field)) delete patch[field]
  }

  const substantiveKeys = Object.keys(patch).filter((key) => key !== 'updated_at' && patch[key] !== undefined)
  if (substantiveKeys.length) patch.updated_at = new Date().toISOString()
  else delete patch.updated_at
  const keys = Object.keys(patch).filter((key) => patch[key] !== undefined)
  let after = before
  if (keys.length) {
    const set = keys.map((key, index) => `"${key}"=$${index + 1}`).join(', ')
    const values = keys.map((key) => patch[key] === undefined ? null : patch[key])
    const result = await client.query(`UPDATE cleaning_tasks SET ${set} WHERE id=$${keys.length + 1} RETURNING *`, [...values, id])
    after = result?.rows?.[0] || before
  }

  let confirmedPasswordFields: Array<'old_code' | 'new_code'> = []
  if (claimedPasswordFields.length) {
    const confirmed = await confirmTaskPasswordAuthority({
      taskId: id,
      fields: claimedPasswordFields,
      claimedFields: claimedPasswordFields,
      client,
      audit: passwordAudit,
    })
    confirmedPasswordFields = confirmed.updatedFields
    after = confirmed.task || after
  }
  if (confirmedPasswordFields.includes('new_code')
    && String(after?.order_id || '').trim()
    && String(after?.task_type || after?.type || '').trim().toLowerCase() === 'checkin_clean') {
    await syncCheckoutOldCodeFromCheckinNewCode({ orderId: String(after.order_id), client, audit: passwordAudit })
    await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: String(after.order_id), client, audit: passwordAudit })
  }
  if (topologyTouched) {
    await reconcilePasswordAuthorityAfterTaskTopologyChange({ before, after, client, audit: passwordAudit })
    const refreshed = await client.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    after = refreshed?.rows?.[0] || after
  }

  const actualChangedFields = actualCleaningTaskChangedFields(before, after, keys)
  if (actualChangedFields.length) {
    const workPatch = buildCleaningTaskWorkPatch(after, actualChangedFields)
    const assignmentChanged = ['assignee_id', 'cleaner_id', 'inspector_id'].some((key) => actualChangedFields.includes(key))
    const removed = String(after?.status || '').trim().toLowerCase() === 'cancelled'
    const arrangementRevision = buildMz031CleaningArrangementRevision(
      before,
      after,
      mz031ManagementStatusArrangementReasons(before, after, params.inputPatch.status !== undefined),
    )
    await emitWorkTaskEvent({
      taskId: `cleaning_task:${id}`,
      sourceType: 'cleaning_tasks',
      sourceRefIds: [id],
      eventType: assignmentChanged ? 'TASK_ASSIGNMENT_CHANGED' : (removed ? 'TASK_REMOVED' : 'TASK_UPDATED'),
      changeScope: assignmentChanged || removed
        ? 'membership'
        : (workPatch.changedFields.some((field) => ['checkout_time', 'checkin_time', 'start_time', 'end_time', 'summary'].includes(field)) ? 'list' : 'detail'),
      changedFields: workPatch.changedFields,
      patch: workPatch.patch,
      payload: arrangementRevision ? { arrangement_revision: arrangementRevision } : undefined,
      causedByUserId: String(req?.user?.sub || '').trim() || null,
      visibilityHints: buildCleaningTaskVisibilityHints(after || before),
    }, client)
  }
  return { id, before, after, actualChangedFields }
}

async function applyAtomicOrderKeysPg(
  client: any,
  updates: Array<{ order_id: string; keys_required: number }>,
  submittedTaskIds: string[],
  req: any,
) {
  const affectedTaskIds = new Set<string>()
  for (const update of [...updates].sort((a, b) => a.order_id.localeCompare(b.order_id))) {
    const submittedTarget = await client.query(
      `SELECT 1
       FROM cleaning_tasks
       WHERE id::text = ANY($1::text[])
         AND order_id::text=$2::text
         AND ${activeCleaningTaskWhereSql('')}
         AND lower(COALESCE(status, '')) NOT IN ('ready','completed','done')
       LIMIT 1`,
      [submittedTaskIds, update.order_id],
    )
    if (!(submittedTarget?.rows || []).length) {
      const error: any = new Error('order_key_target_not_in_items')
      error.status = 400
      throw error
    }
    const orderResult = await client.query('SELECT id::text AS id, COALESCE(keys_required, 1) AS keys_required FROM orders WHERE id::text=$1::text FOR UPDATE', [update.order_id])
    const order = orderResult?.rows?.[0] || null
    if (!order) {
      const error: any = new Error('order not found')
      error.status = 404
      throw error
    }
    const nextKeys = Number(update.keys_required)
    if (Number(order.keys_required || 1) === nextKeys) continue
    const tasksResult = await client.query(
      `SELECT * FROM cleaning_tasks
       WHERE order_id::text=$1::text
         AND lower(COALESCE(task_type,'')) IN ('checkin_clean','checkout_clean')
         AND ${activeCleaningTaskWhereSql('')}
         AND lower(COALESCE(status, '')) NOT IN ('ready','completed','done')
       ORDER BY id
       FOR UPDATE`,
      [update.order_id],
    )
    await client.query('UPDATE orders SET keys_required=$1 WHERE id::text=$2::text', [nextKeys, update.order_id])
    await client.query(
      `UPDATE cleaning_tasks SET keys_required=$1, updated_at=now()
       WHERE order_id::text=$2::text
         AND lower(COALESCE(task_type,'')) IN ('checkin_clean','checkout_clean')
         AND ${activeCleaningTaskWhereSql('')}
         AND lower(COALESCE(status, '')) NOT IN ('ready','completed','done')`,
      [nextKeys, update.order_id],
    )
    for (const before of tasksResult?.rows || []) {
      const id = String(before?.id || '').trim()
      if (!id) continue
      affectedTaskIds.add(id)
      const taskType = String(before?.task_type || '').trim().toLowerCase()
      await emitWorkTaskEvent({
        taskId: `cleaning_task:${id}`,
        sourceType: 'cleaning_tasks',
        sourceRefIds: [id],
        eventType: 'TASK_UPDATED',
        changeScope: 'list',
        changedFields: [
          'keys_required',
          ...(taskType === 'checkout_clean' ? ['keys_required_checkout'] : []),
          ...(taskType === 'checkin_clean' ? ['keys_required_checkin'] : []),
          'key_tags',
        ],
        patch: {
          keys_required: nextKeys,
          ...(taskType === 'checkout_clean' ? { keys_required_checkout: nextKeys } : {}),
          ...(taskType === 'checkin_clean' ? { keys_required_checkin: nextKeys } : {}),
          key_tags: {
            checkout_sets: taskType === 'checkout_clean' ? nextKeys : 0,
            checkin_sets: taskType === 'checkin_clean' ? nextKeys : 0,
            show_checkout: taskType === 'checkout_clean' && nextKeys >= 2,
            show_checkin: taskType === 'checkin_clean' && nextKeys >= 2,
          },
        },
        causedByUserId: String(req?.user?.sub || '').trim() || null,
        visibilityHints: buildCleaningTaskVisibilityHints({ ...before, keys_required: nextKeys }),
      }, client)
    }
  }
  return Array.from(affectedTaskIds)
}

router.post('/tasks/atomic-patch', requirePerm('cleaning.task.assign'), requireR5TaskRuntimeSchema, async (req, res) => {
  if (!isPasswordAuthoritySchemaReady()) return res.status(503).json({ code: 'password_authority_schema_not_ready' })
  const parsed = atomicPatchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(503).json({ message: 'atomic_patch_requires_pg' })

  const itemIds = parsed.data.items.map((item) => item.id)
  if (new Set(itemIds).size !== itemIds.length) return res.status(400).json({ message: 'duplicate_task_id' })
  const orderIds = parsed.data.order_key_updates.map((item) => item.order_id)
  if (new Set(orderIds).size !== orderIds.length) return res.status(400).json({ message: 'duplicate_order_id' })
  const operationId = parsed.data.operation_id
  const actorUserId = String((req as any)?.user?.sub || '').trim()
  const normalizedItems = [...parsed.data.items].sort((a, b) => a.id.localeCompare(b.id))
  const normalizedOrderKeyUpdates = [...parsed.data.order_key_updates].sort((a, b) => a.order_id.localeCompare(b.order_id))
  const payloadHash = buildCanonicalIdempotencyPayloadHmac({ items: normalizedItems, order_key_updates: normalizedOrderKeyUpdates })
  const receiptScope = {
    scopeType: 'cleaning_tasks_atomic_patch',
    scopeId: actorUserId || 'unknown-actor',
    submitId: operationId,
    stepKey: 'save',
  }
  try {
    await ensureCleaningSchemaV2()
    const transactionResult = await pgRunInTransaction(async (client) => {
      await assertIdempotentStepReceiptsReady(client)
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        ['cleaning-tasks-atomic-patch', `${receiptScope.scopeId}:${operationId}`],
      )
      const existing = await loadIdempotentStepReceipt(client, receiptScope)
      if (existing) {
        if (String(existing.payload_hash || '') !== payloadHash) return { kind: 'conflict' as const }
        return { kind: 'replay' as const, responseBody: existing.response_json }
      }

      const taskResults: AtomicTaskPatchResult[] = []
      for (const item of normalizedItems) {
        taskResults.push(await applyAtomicTaskPatchPg({
          client,
          id: item.id,
          inputPatch: item.patch,
          operationId,
          req,
        }))
      }
      const orderKeyTaskIds = await applyAtomicOrderKeysPg(client, normalizedOrderKeyUpdates, itemIds, req)
      const deferredIds = taskResults
        .filter((result) => result.actualChangedFields.length > 0
          && isDeferredInspectionCheckinConflictRelevantChange(result.actualChangedFields))
        .map((result) => result.id)
      if (deferredIds.length) {
        await reconcileDeferredInspectionCheckinReplacement({
          taskIds: deferredIds,
          actorUserId: actorUserId || null,
          pgClient: client,
        })
      }
      const responseBody = {
        ok: true,
        operation_id: operationId,
        updated_task_ids: Array.from(new Set([
          ...taskResults.filter((result) => result.actualChangedFields.length > 0).map((result) => result.id),
          ...orderKeyTaskIds,
        ])).sort(),
        replayed: false,
      }
      await saveIdempotentStepReceipt(client, receiptScope, payloadHash, responseBody)
      return { kind: 'committed' as const, responseBody, taskResults, deferredIds }
    })
    if (!transactionResult) throw new Error('pg not available')
    if (transactionResult.kind === 'conflict') return res.status(409).json({ message: 'idempotency_conflict', operation_id: operationId })
    if (transactionResult.kind === 'replay') {
      return res.json({ ...(transactionResult.responseBody || { ok: true, operation_id: operationId }), replayed: true })
    }

    const changedResults = transactionResult.taskResults.filter((result) => result.actualChangedFields.length > 0)
    const deferredIds = transactionResult.deferredIds
    if (deferredIds.length) {
      enqueueNotification(() => emitDeferredInspectionCheckinConflictAlerts({ taskIds: deferredIds, actorUserId: actorUserId || null }))
    }
    for (const result of changedResults) {
      try {
        const notice = buildCleaningTaskUpdateNoticeDetails(result.before, result.after)
        const propertyId = String(result.after?.property_id || '').trim()
        if (!notice.changes.length || !propertyId) continue
        enqueueNotification(() => emitNotificationEvent({
          type: 'CLEANING_TASK_UPDATED',
          policyKey: 'task_requirements_changed',
          entity: 'cleaning_task',
          entityId: result.id,
          propertyId,
          updatedAt: new Date().toISOString(),
          changes: notice.changes,
          title: notice.lines.length ? '任务信息更新' : null,
          body: notice.lines.length ? notice.lines.join('\n') : null,
          inboxBody: notice.inboxLines.length ? notice.inboxLines.join('\n') : null,
          data: notice.lines.length
            ? { entity: 'cleaning_task', entityId: result.id, action: 'open_task', kind: 'cleaning_task_manager_fields_updated' }
            : { entity: 'cleaning_task', entityId: result.id, action: 'open_task' },
          actorUserId,
        }, { operationId: `${operationId}:${result.id}` }))
      } catch {}
    }
    return res.json(transactionResult.responseBody)
  } catch (error: any) {
    if (error instanceof IdempotentStepReceiptsNotReady) return res.status(503).json({ code: 'idempotent_step_receipts_not_ready' })
    if (error instanceof TurnoverLinkTopologyConflict) return res.status(error.status).json({ code: error.code, message: error.message })
    if (sendTurnoverInspectionScopeConflict(res, error)) return
    const conflict = inspectionAssignmentConflictPayload(error)
    if (conflict) return res.status(409).json(conflict)
    return res.status(Number(error?.status || 500)).json({ message: error?.message || 'atomic_patch_failed' })
  }
})

const bulkPatchSchema = z.object({ ids: z.array(z.string().min(1)).min(1), patch: patchTaskSchema }).strict()
router.post('/tasks/bulk-patch', requirePerm('cleaning.task.assign'), requireR5TaskRuntimeSchema, async (req, res) => {
  if (!isPasswordAuthoritySchemaReady()) return res.status(503).json({ code: 'password_authority_schema_not_ready' })
  const parsed = bulkPatchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!(await isValidStaffId((parsed.data.patch as any).cleaner_id ?? null, 'cleaner'))) return res.status(400).json({ message: '无效的清洁人员' })
  if (!(await isValidStaffId((parsed.data.patch as any).inspector_id ?? null, 'inspector'))) return res.status(400).json({ message: '无效的检查人员' })
  if (!(await isValidAnyStaffId((parsed.data.patch as any).assignee_id ?? null))) return res.status(400).json({ message: '无效的执行人' })
  const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)))
  const basePatch: any = { ...parsed.data.patch }
  const bulkPasswordVerification = basePatch.password_verification
  delete basePatch.password_verification
  if (basePatch.guest_special_request === undefined && basePatch.note !== undefined) basePatch.guest_special_request = basePatch.note
  delete basePatch.note
  if (basePatch.keys_required === null) basePatch.keys_required = 1
  if (basePatch.cleaner_id !== undefined && basePatch.assignee_id === undefined) basePatch.assignee_id = basePatch.cleaner_id
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
          return pgRunInTransaction(async (client) => {
          const snapshotResult = await client.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
          const snapshot = snapshotResult?.rows?.[0] || null
          if (!snapshot) return null
          const hasPasswordWrite = basePatch.old_code !== undefined || basePatch.new_code !== undefined || !!bulkPasswordVerification?.fields?.length
          const topologyTouched = basePatch.property_id !== undefined || basePatch.task_date !== undefined || basePatch.status !== undefined
          let lockedPasswordProperties: string[] = []
          if (hasPasswordWrite || topologyTouched) {
            lockedPasswordProperties = await normalizeCleaningPasswordChainKeys(client, [
              String(snapshot.property_id || '').trim(),
              String(basePatch.property_id || '').trim(),
            ])
            for (const propertyId of lockedPasswordProperties) await lockCleaningPasswordChainKey(client, propertyId)
          }
          const lockedTurnoverTopologyKeys = await lockCleaningTurnoverTopologyTargets(client, snapshot, basePatch)
          const r0 = await client.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1 FOR UPDATE', [id])
          const before = r0?.rows?.[0] || snapshot
          if (!before) return null
          if (hasPasswordWrite || topologyTouched) {
            const verifiedProperties = await normalizeCleaningPasswordChainKeys(client, [before.property_id, basePatch.property_id])
            if (verifiedProperties.some((propertyId) => !lockedPasswordProperties.includes(propertyId))) {
              const error: any = new Error('password_chain_topology_changed_retry')
              error.status = 409
              throw error
            }
            if (basePatch.property_id !== undefined && String(before.order_id || '').trim()) {
              const currentProperty = String(before.property_id || '').trim()
              const requestedProperty = String(basePatch.property_id || '').trim()
              const propertyIdentityChanged = !currentProperty || !requestedProperty
                ? currentProperty !== requestedProperty
                : verifiedProperties.length !== 1
              if (propertyIdentityChanged) {
                const error: any = new Error('order_linked_task_property_managed_by_order')
                error.status = 400
                throw error
              }
            }
          }
          const patch: any = { ...basePatch }
          const isCheckinSiteExecution = isCheckinSiteExecutionTask({
            task_type: patch.task_type ?? before.task_type,
            inspection_scope: patch.inspection_scope ?? before.inspection_scope,
          })
          if (patch.assignee_id !== undefined && patch.cleaner_id === undefined) {
            patch.cleaner_id = isCheckinSiteExecution ? null : patch.assignee_id
          }
          if (patch.task_date != null) patch.date = patch.task_date
          if (patch.inspection_mode !== undefined || patch.inspection_due_date !== undefined) {
            patch.inspection_replaced_by_checkin_task_id = null
            patch.inspection_replaced_original_due_date = null
          }
          validateAndApplyInspectionPatch({ patch, current: before })
          const lockedTurnoverTarget = turnoverInspectionScopeTarget(before, patch)
          if (lockedTurnoverTarget) {
            const verifiedTurnoverKeys = await normalizeCleaningTurnoverTargetKeys(client, [lockedTurnoverTarget])
            if (verifiedTurnoverKeys.some((key) => !lockedTurnoverTopologyKeys.has(key))) {
              const error: any = new Error('turnover_link_topology_changed_retry')
              error.status = 409
              throw error
            }
          }
          await assertPgExplicitTurnoverLinkTopology(client, String(id), before, patch)
          await assertPgTurnoverInspectionScope(client, String(id), before, patch)
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
              const nextCleanerId = isCheckinSiteExecution
                ? (patch.assignee_id !== undefined ? (patch.assignee_id ?? null) : (before.assignee_id ?? before.inspector_id ?? null))
                : (patch.cleaner_id !== undefined ? (patch.cleaner_id ?? null) : (before.cleaner_id ?? before.assignee_id ?? null))
              const nextInspectorId = patch.inspector_id !== undefined ? (patch.inspector_id ?? null) : (before.inspector_id ?? null)
              patch.status = assignedStatusFromAssignees(nextCleanerId, nextInspectorId)
            }
          }
          const requestedPasswordFields = Array.from(new Set([
            ...(basePatch.old_code !== undefined ? ['old_code' as const] : []),
            ...(basePatch.new_code !== undefined ? ['new_code' as const] : []),
            ...((bulkPasswordVerification?.fields || []) as Array<'old_code' | 'new_code'>),
          ]))
          const nextTaskType = String(patch.task_type || patch.type || before?.task_type || before?.type || '').trim().toLowerCase()
          const passwordFields = assertCleaningPasswordFieldsApplicable(nextTaskType, requestedPasswordFields)
          if (passwordFields.length) assertPasswordAuthorityTaskMutable({ ...before, ...patch })
          const passwordAudit: PasswordAuthorityAuditContext = {
            requestId: bulkPasswordVerification?.request_id || uuid(),
            actorUserId: String((req as any)?.user?.sub || '').trim() || null,
            actorRole: roleNamesOfRequest(req).join(',') || null,
            client: bulkPasswordVerification?.client || 'web',
          }
          const claimedPasswordFields = passwordFields.length
            ? await claimTaskPasswordAuthorityFields({ taskId: String(id), fields: passwordFields, client, audit: passwordAudit })
            : []
          for (const field of requestedPasswordFields) {
            if (!claimedPasswordFields.includes(field)) delete patch[field]
          }
          const substantiveKeys = Object.keys(patch).filter((key) => key !== 'updated_at' && patch[key] !== undefined)
          if (substantiveKeys.length) patch.updated_at = new Date().toISOString()
          else delete patch.updated_at
          const keys = Object.keys(patch).filter((k) => patch[k] !== undefined)
          let after = before
          if (keys.length) {
            const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(', ')
            const values = keys.map((k) => (patch[k] === undefined ? null : patch[k]))
            const sql = `UPDATE cleaning_tasks SET ${set} WHERE id=$${keys.length + 1} RETURNING *`
            const r1 = await client.query(sql, [...values, id])
            after = r1?.rows?.[0] || before
          }
          let confirmedPasswordFields: Array<'old_code' | 'new_code'> = []
          if (claimedPasswordFields.length) {
            const confirmed = await confirmTaskPasswordAuthority({
              taskId: String(id),
              fields: claimedPasswordFields,
              claimedFields: claimedPasswordFields,
              client,
              audit: passwordAudit,
            })
            confirmedPasswordFields = confirmed.updatedFields
            after = confirmed.task || after
          }
          if (
            confirmedPasswordFields.includes('new_code') &&
            String(after?.order_id || '').trim() &&
            String(after?.task_type || after?.type || '').trim().toLowerCase() === 'checkin_clean'
          ) {
            await syncCheckoutOldCodeFromCheckinNewCode({ orderId: String(after.order_id), client, audit: passwordAudit })
            await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: String(after.order_id), client, audit: passwordAudit })
          }
          if (topologyTouched) {
            await reconcilePasswordAuthorityAfterTaskTopologyChange({ before, after, client, audit: passwordAudit })
            const refreshed = await client.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
            after = refreshed?.rows?.[0] || after
          }
          const changedFields = Object.keys(patch || {}).filter((key) => patch[key] !== undefined)
          if (changedFields.length) {
            const assignmentChanged = ['assignee_id', 'cleaner_id', 'inspector_id'].some((key) => changedFields.includes(key))
            const arrangementRevision = buildMz031CleaningArrangementRevision(
              before,
              after,
              mz031ManagementStatusArrangementReasons(before, after, basePatch.status !== undefined),
            )
            await emitWorkTaskEvent({
              taskId: `cleaning_task:${String(id)}`,
              sourceType: 'cleaning_tasks',
              sourceRefIds: [String(id)],
              eventType: assignmentChanged ? 'TASK_ASSIGNMENT_CHANGED' : (String(after?.status || '').trim().toLowerCase() === 'cancelled' ? 'TASK_REMOVED' : 'TASK_UPDATED'),
              changeScope: assignmentChanged ? 'membership' : (String(after?.status || '').trim().toLowerCase() === 'cancelled' ? 'membership' : 'list'),
              changedFields,
              patch: Object.fromEntries(changedFields.map((field) => [field, (after as any)?.[field]])),
              payload: arrangementRevision ? { arrangement_revision: arrangementRevision } : undefined,
              causedByUserId: String((req as any)?.user?.sub || '').trim() || null,
              visibilityHints: buildCleaningTaskVisibilityHints(after || before),
            }, client)
          }
          return after
          })
        }
        const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
        if (!task) return null
        const memoryBefore = { ...task }
        const patch: any = { ...basePatch }
        if (patch.property_id !== undefined
          && String((task as any).order_id || '').trim()
          && memoryCanonicalCleaningPropertyId(patch.property_id) !== memoryCanonicalCleaningPropertyId((task as any).property_id)) {
          const error: any = new Error('order_linked_task_property_managed_by_order')
          error.status = 400
          throw error
        }
        const isCheckinSiteExecution = isCheckinSiteExecutionTask({
          task_type: patch.task_type ?? task.task_type,
          inspection_scope: patch.inspection_scope ?? task.inspection_scope,
        })
        if (patch.assignee_id !== undefined && patch.cleaner_id === undefined) {
          patch.cleaner_id = isCheckinSiteExecution ? null : patch.assignee_id
        }
        validateAndApplyInspectionPatch({ patch, current: task })
        assertExplicitTurnoverLinkTopology(task, patch, db.cleaningTasks as any[])
        assertMemoryTurnoverInspectionScope(String(id), task, patch)
        const requestedPasswordFields = Array.from(new Set([
          ...(basePatch.old_code !== undefined ? ['old_code' as const] : []),
          ...(basePatch.new_code !== undefined ? ['new_code' as const] : []),
          ...((bulkPasswordVerification?.fields || []) as Array<'old_code' | 'new_code'>),
        ]))
        const memoryTaskType = String(patch.task_type || patch.type || task.task_type || task.type || '').trim().toLowerCase()
        const passwordFields = assertCleaningPasswordFieldsApplicable(memoryTaskType, requestedPasswordFields)
        if (passwordFields.length) assertPasswordAuthorityTaskMutable({ ...task, ...patch })
        const passwordAudit: PasswordAuthorityAuditContext = {
          requestId: bulkPasswordVerification?.request_id || uuid(),
          actorUserId: String((req as any)?.user?.sub || '').trim() || null,
          actorRole: roleNamesOfRequest(req).join(',') || null,
          client: bulkPasswordVerification?.client || 'web',
        }
        const claimedPasswordFields = passwordFields.length
          ? await claimTaskPasswordAuthorityFields({ taskId: String(id), fields: passwordFields, audit: passwordAudit })
          : []
        for (const field of requestedPasswordFields) {
          if (!claimedPasswordFields.includes(field)) delete patch[field]
        }
        if (patch.property_id !== undefined) task.property_id = patch.property_id
        if (patch.task_date !== undefined) { task.task_date = patch.task_date; task.date = patch.task_date }
        if (patch.status !== undefined) task.status = patch.status
        if (patch.cleaner_id !== undefined) task.cleaner_id = patch.cleaner_id
        if (patch.inspector_id !== undefined) task.inspector_id = patch.inspector_id
        if (patch.assignee_id !== undefined) task.assignee_id = patch.assignee_id
        if (patch.inspection_scope !== undefined) task.inspection_scope = normalizeInspectionScope(patch.inspection_scope)
        if (patch.inspection_mode !== undefined) task.inspection_mode = patch.inspection_mode
        if (patch.inspection_due_date !== undefined) task.inspection_due_date = patch.inspection_due_date
        if (patch.keys_required !== undefined) task.keys_required = patch.keys_required
        if (patch.old_code !== undefined) task.old_code = patch.old_code
        if (patch.new_code !== undefined) task.new_code = patch.new_code
        if (patch.scheduled_at !== undefined) task.scheduled_at = patch.scheduled_at
        if (patch.guest_special_request !== undefined) task.guest_special_request = patch.guest_special_request
        let confirmedPasswordFields: Array<'old_code' | 'new_code'> = []
        if (claimedPasswordFields.length) {
          const confirmed = await confirmTaskPasswordAuthority({
            taskId: String(id),
            fields: claimedPasswordFields,
            claimedFields: claimedPasswordFields,
            audit: passwordAudit,
          })
          confirmedPasswordFields = confirmed.updatedFields
        }
        if (confirmedPasswordFields.includes('new_code')
          && String((task as any).order_id || '').trim()
          && String((task as any).task_type || (task as any).type || '').trim().toLowerCase() === 'checkin_clean') {
          await syncCheckoutOldCodeFromCheckinNewCode({ orderId: String((task as any).order_id), audit: passwordAudit })
          await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: String((task as any).order_id), audit: passwordAudit })
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
            const cleaner = String(isCheckinSiteExecution ? (task.assignee_id || task.inspector_id || '') : (task.cleaner_id || task.assignee_id || '')).trim()
            const inspector = String(task.inspector_id || '').trim()
            ;(task as any).status = assignedStatusFromAssignees(cleaner, inspector)
          }
        }
        if (patch.property_id !== undefined || patch.task_date !== undefined || patch.status !== undefined) {
          await reconcilePasswordAuthorityAfterTaskTopologyChange({ before: memoryBefore, after: task, audit: passwordAudit })
        }
        return task
      })()
      if (r) updated.push(r)
    }
    if (hasPg && pgPool && updated.length && isDeferredInspectionCheckinConflictRelevantChange(Object.keys(basePatch))) {
      const updatedIds = updated.map((task) => String(task?.id || '').trim()).filter(Boolean)
      await reconcileDeferredInspectionCheckinReplacement({
        taskIds: updatedIds,
        actorUserId: String((req as any)?.user?.sub || '').trim() || null,
      })
      enqueueNotification(() => emitDeferredInspectionCheckinConflictAlerts({
        taskIds: updatedIds,
        actorUserId: String((req as any)?.user?.sub || '').trim() || null,
      }))
    }
    return res.json({ ok: true, updated: updated.length })
  } catch (e: any) {
    if (e instanceof TurnoverLinkTopologyConflict) return res.status(e.status).json({ code: e.code, message: e.message })
    if (sendTurnoverInspectionScopeConflict(res, e)) return
    const conflict = inspectionAssignmentConflictPayload(e)
    if (conflict) return res.status(409).json(conflict)
    return res.status(Number(e?.status || 500)).json({ message: e?.message || 'bulk_patch_failed' })
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
    const canManageSchedule = await userHasAnyPerm((req as any).user || {}, ['cleaning.task.assign', 'cleaning.schedule.manage'])
    const withWebCapabilities = (item: any) => ({
      ...item,
      ...buildWebTaskCapabilityPayload(item, { canManageSchedule }),
    })
    if (hasPg && pgPool) {
      await ensureCleaningSchemaV2()
      const r = await pgPool.query(
        `SELECT
           t.id,
           t.order_id,
           COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
           COALESCE(p_id.code::text, p_code.code::text) AS property_code,
           COALESCE(p_id.region::text, p_code.region::text) AS property_region,
           COALESCE(NULLIF(t.task_type, ''), NULLIF(t.type, '')) AS task_type,
           t.linked_checkout_task_id,
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
	           t.old_code_authority_status,
	           t.new_code_authority_status,
	           t.old_code_source_task_id,
	           t.old_code_source_order_id,
	           t.old_code_source_field,
	           t.guest_special_request,
	         t.note,
	         (o.confirmation_code::text) AS order_code,
	         o.checkin::text AS order_checkin,
	         o.checkout::text AS order_checkout,
	         o.note::text AS order_note,
	         o.keys_required AS order_keys_required,
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
           AND ${validCleaningTaskOrderWhereSql('t', 'o')}
         ORDER BY COALESCE(task_date, date) ASC, COALESCE(p_id.code, p_code.code) NULLS LAST, t.id`,
        [from, to, includeDeferredInspection]
      )
      const rawRows = r?.rows || []
      const activeTaskIds = Array.from(new Set(rawRows.map((row: any) => String(row?.id || '').trim()).filter(Boolean)))
      if (activeTaskIds.length) {
        try {
          const completionAreasByTaskId = new Map<string, Set<string>>()
          const mediaResult = await pgPool.query(
            `SELECT task_id::text AS task_id, type
             FROM cleaning_task_media
             WHERE task_id::text = ANY($1::text[])
               AND type LIKE 'completion_%'`,
            [activeTaskIds],
          )
          for (const media of mediaResult?.rows || []) {
            const taskId = String(media.task_id || '').trim()
            const rawArea = String(media.type || '').replace(/^completion_/, '').trim()
            const area = rawArea === 'remote_controls' || rawArea === 'remote_ac' ? 'remote_tv' : rawArea
            if (!taskId || !area) continue
            const areas = completionAreasByTaskId.get(taskId) || new Set<string>()
            areas.add(area)
            completionAreasByTaskId.set(taskId, areas)
          }
          const exceptionResult = await pgPool.query(
            `SELECT DISTINCT ON (source_id::text) source_id::text AS task_id, metadata
             FROM work_task_action_audits
             WHERE source_type='cleaning_tasks'
               AND source_id::text = ANY($1::text[])
               AND performed_as_action='complete_cleaning'
               AND metadata ? 'completion_photo_exception'
             ORDER BY source_id::text, performed_at DESC, created_at DESC`,
            [activeTaskIds],
          )
          const exceptionCountByTaskId = new Map<string, number>()
          for (const audit of exceptionResult?.rows || []) {
            const taskId = String(audit.task_id || '').trim()
            const savedAreas = completionAreasByTaskId.get(taskId) || new Set<string>()
            const exceptionAreas = new Set<string>()
            for (const item of Array.isArray(audit.metadata?.completion_photo_exception?.items) ? audit.metadata.completion_photo_exception.items : []) {
              const rawArea = String(item?.area || '').trim()
              const area = rawArea === 'remote_controls' || rawArea === 'remote_ac' ? 'remote_tv' : rawArea
              if (area && !savedAreas.has(area)) exceptionAreas.add(area)
            }
            if (taskId && exceptionAreas.size) exceptionCountByTaskId.set(taskId, exceptionAreas.size)
          }
          for (const row of rawRows) {
            row.completion_photo_exception_count = exceptionCountByTaskId.get(String(row?.id || '').trim()) || 0
          }
        } catch (error: any) {
          if (String(error?.code || '') !== '42P01') throw error
        }
      }
      const supersededByReplacementId = new Map<string, any[]>()
      if (activeTaskIds.length) {
        const sr = await pgPool.query(
          `SELECT
             id::text AS id,
             superseded_by::text AS superseded_by,
             property_id::text AS property_id,
             COALESCE(NULLIF(task_type, ''), NULLIF(type, '')) AS task_type,
             COALESCE(task_date, date)::text AS task_date,
             checkout_time,
             checkin_time,
             keys_required,
             nights_override,
             guest_special_request,
             old_code,
             new_code
           FROM cleaning_tasks
           WHERE execution_state = 'superseded'
             AND superseded_by::text = ANY($1::text[])
           ORDER BY superseded_at DESC NULLS LAST, updated_at DESC NULLS LAST, id`,
          [activeTaskIds],
        )
        for (const row of sr?.rows || []) {
          const replacementId = String(row?.superseded_by || '').trim()
          if (!replacementId) continue
          const list = supersededByReplacementId.get(replacementId) || []
          list.push(row)
          supersededByReplacementId.set(replacementId, list)
        }
      }
      for (const row of rawRows) {
        const d = String(row.task_date || '').slice(0, 10)
        const rawType = row.task_type ? String(row.task_type) : 'cleaning_task'
        const sourceId = String(row.id)
        const supersededSources = supersededByReplacementId.get(sourceId) || []
        const inspectionMode = effectiveInspectionMode(row)
        const inspectionDueDate = dayOnly(row.inspection_due_date)
        const label =
          rawType === 'checkout_clean' ? '退房' :
          rawType === 'checkin_clean' ? '入住' :
          rawType === 'stayover_clean' ? '入住中清洁' :
          rawType
        const turnoverDisplay = buildCleaningTurnoverDisplay({
          propertyId: row.property_id,
          taskDate: d,
          checkoutTask: rawType === 'checkout_clean' ? {
            ...row,
            taskId: sourceId,
            taskType: rawType,
            orderId: row.order_id,
            orderNote: row.order_note,
            orderKeysRequired: row.order_keys_required,
            orderCheckin: row.order_checkin,
            orderCheckout: row.order_checkout,
          } : null,
          checkinTask: rawType === 'checkin_clean' ? {
            ...row,
            taskId: sourceId,
            taskType: rawType,
            orderId: row.order_id,
            orderNote: row.order_note,
            orderKeysRequired: row.order_keys_required,
            orderCheckin: row.order_checkin,
            orderCheckout: row.order_checkout,
          } : null,
          activeRows: [{
            ...row,
            taskId: sourceId,
            taskType: rawType,
            orderId: row.order_id,
            orderNote: row.order_note,
            orderKeysRequired: row.order_keys_required,
            orderCheckin: row.order_checkin,
            orderCheckout: row.order_checkout,
          }],
          supersededRows: supersededSources,
        })
        const baseItem = {
          source: 'cleaning_tasks' as const,
          order_id: row.order_id ? String(row.order_id) : null,
          order_code: row.order_code ? String(row.order_code) : null,
          order_checkin: row.order_checkin ? String(row.order_checkin).slice(0, 10) : null,
          order_checkout: row.order_checkout ? String(row.order_checkout).slice(0, 10) : null,
          linked_checkout_task_id: row.linked_checkout_task_id ? String(row.linked_checkout_task_id) : null,
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
          old_code: turnoverDisplay.old_code,
          new_code: cleaningTaskNewCodeForDisplay(row),
          password_authority: {
            old_code_status: rawType === 'checkout_clean' ? (turnoverDisplay.old_code_authority_status || 'needs_review') : 'not_applicable',
            new_code_status: rawType === 'checkin_clean' ? (row.new_code_authority_status || 'needs_review') : 'not_applicable',
            old_code_source_task_id: turnoverDisplay.old_code_source_task_id || null,
            old_code_source_order_id: turnoverDisplay.old_code_source_order_id || null,
            old_code_source_field: turnoverDisplay.old_code_source_field || null,
          },
          guest_special_request: row.guest_special_request != null ? String(row.guest_special_request || '') : null,
          note: row.note != null ? String(row.note || '') : null,
          nights: row.nights != null ? Number(row.nights) : null,
          summary_checkout_time: String(row.checkout_time || '').trim() || DEFAULT_SUMMARY_CHECKOUT_TIME,
          summary_checkin_time: String(row.checkin_time || '').trim() || DEFAULT_SUMMARY_CHECKIN_TIME,
          display_conflicts: turnoverDisplay.conflicts,
          turnover_display: turnoverDisplay,
          inspection_mode: inspectionMode,
          inspection_scope: normalizeInspectionScope(row.inspection_scope),
          inspection_due_date: inspectionDueDate,
          completion_photo_exception_count: Number(row.completion_photo_exception_count || 0),
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
          photo_urls: normalizePhotoUrls(row.photo_urls),
          old_code: null,
          new_code: null,
          nights: null,
          summary_checkout_time: null,
          summary_checkin_time: null,
        })
      }
      return res.json(items.map(withWebCapabilities))
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
        old_code: cleaningTaskOldCodeForDisplay(t),
        new_code: cleaningTaskNewCodeForDisplay(t),
        password_authority: {
          old_code_status: rawType === 'checkout_clean' ? (t.old_code_authority_status || 'needs_review') : 'not_applicable',
          new_code_status: rawType === 'checkin_clean' ? (t.new_code_authority_status || 'needs_review') : 'not_applicable',
          old_code_source_task_id: t.old_code_source_task_id || null,
          old_code_source_order_id: t.old_code_source_order_id || null,
          old_code_source_field: t.old_code_source_field || null,
        },
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
        photo_urls: normalizePhotoUrls(t.photo_urls),
        old_code: null,
        new_code: null,
        nights: null,
        summary_checkout_time: null,
        summary_checkin_time: null,
      })
    }
    items.sort((a, b) => String(a.task_date).localeCompare(String(b.task_date)) || String(a.property_id || '').localeCompare(String(b.property_id || '')))
    return res.json(items.map(withWebCapabilities))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'calendar_failed' })
  }
})

router.post('/backfill', requirePerm('cleaning.schedule.manage'), requireR5TaskRuntimeSchema, async (req, res) => {
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
