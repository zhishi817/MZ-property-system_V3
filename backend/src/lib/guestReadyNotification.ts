import { activeCleaningTaskWhereSql, validCleaningTaskOrderWhereSql } from '../services/cleaningSync'

export const GUEST_READY_NOTIFICATION_PERMISSION = 'order.guest_ready_notification.manage'

export type GuestReadyNotificationDisabledReason =
  | 'property_not_ready'
  | 'no_checkin_order'
  | 'checkin_order_changed'
  | 'key_handover_incomplete'
  | 'task_linked_to_order'

export type GuestReadyPriorTaskNotificationProjection = {
  task_id: string
  status: 'not_notified' | 'notified'
  notified_at: string | null
  notified_by_user_id: string | null
  notified_by_name: string | null
  version: number
  last_action: 'mark' | 'revoke'
  last_action_at: string
  last_actor_user_id: string
  last_actor_name: string
  read_only_reason: 'linked_to_order'
}

export type GuestReadyNotificationProjection = {
  source_type: 'orders' | 'cleaning_tasks'
  source_id: string
  order_id: string | null
  task_id: string | null
  association_state: 'order_bound' | 'manual_unlinked'
  status: 'not_notified' | 'notified'
  notified_at: string | null
  notified_by_user_id: string | null
  notified_by_name: string | null
  version: number
  requirement_reasons: Array<'early_arrival' | 'outside_key'>
  automatic_early_arrival: boolean
  outside_key_required: boolean
  eligible: boolean
  disabled_reason: GuestReadyNotificationDisabledReason | null
  prior_task_notification: GuestReadyPriorTaskNotificationProjection | null
}

export type GuestReadyOutsideKeyProjection = {
  order_id: string
  required: boolean
  registered_at: string | null
  registered_by_user_id: string | null
  registered_by_name: string | null
  version: number
}

export type GuestReadyNotificationAction = {
  id: 'record_guest_ready_notified' | 'revoke_guest_ready_notified'
  label: string
  placement: 'primary'
  enabled: boolean
  disabled_reason?: GuestReadyNotificationDisabledReason
  target: 'TaskDetail'
  intent: 'manager'
  source_type: 'orders' | 'cleaning_tasks'
  source_id: string
}

export type GuestReadyOutsideKeyAction = {
  id: 'register_guest_ready_outside_key' | 'cancel_guest_ready_outside_key'
  label: string
  placement: 'more'
  enabled: boolean
  target: 'TaskDetail'
  intent: 'manager'
  source_type: 'orders'
  source_id: string
}

export class GuestReadyNotificationConflict extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

function text(value: unknown) {
  return String(value ?? '').trim()
}

function version(value: unknown) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : 0
}

export function isGuestReadyNotificationCustomerServiceRole(role: unknown) {
  return text(role).toLowerCase() === 'customer_service'
}

export function guestReadyNotificationRequirementReasons(input: { earlyArrival?: unknown; outsideKey?: unknown }) {
  const reasons: Array<'early_arrival' | 'outside_key'> = []
  if (input.earlyArrival === true) reasons.push('early_arrival')
  if (input.outsideKey === true) reasons.push('outside_key')
  return reasons
}

export function isGuestReadyNotificationRequired(input: { earlyArrival?: unknown; outsideKey?: unknown }) {
  return guestReadyNotificationRequirementReasons(input).length > 0
}

export function isGuestReadyNotificationRequirementBindingCurrent(input: {
  notifiedCheckinTaskId?: unknown
  notifiedRequirementVersion?: unknown
  currentCheckinTaskId?: unknown
  currentRequirementVersion?: unknown
  notifiedAt?: unknown
  latestLegacyAssignmentChangedAt?: unknown
}) {
  const notifiedCheckinTaskId = text(input.notifiedCheckinTaskId)
  const currentCheckinTaskId = text(input.currentCheckinTaskId)
  if (!notifiedCheckinTaskId || !currentCheckinTaskId || notifiedCheckinTaskId !== currentCheckinTaskId) return false
  const notifiedRequirementVersion = Number(input.notifiedRequirementVersion)
  const currentRequirementVersion = Number(input.currentRequirementVersion)
  const generationMatches = Number.isInteger(notifiedRequirementVersion)
    && notifiedRequirementVersion >= 0
    && notifiedRequirementVersion === currentRequirementVersion
  if (!generationMatches) return false
  const latestAssignmentChangedAt = text(input.latestLegacyAssignmentChangedAt)
  if (!latestAssignmentChangedAt) return true
  const notifiedAtMs = Date.parse(text(input.notifiedAt))
  const latestAssignmentChangedAtMs = Date.parse(latestAssignmentChangedAt)
  return Number.isFinite(notifiedAtMs)
    && Number.isFinite(latestAssignmentChangedAtMs)
    && notifiedAtMs > latestAssignmentChangedAtMs
}

export function isGuestReadyTaskNotificationRequirementBindingCurrent(input: {
  notifiedRequirementVersion?: unknown
  currentRequirementVersion?: unknown
}) {
  const notifiedRequirementVersion = Number(input.notifiedRequirementVersion)
  const currentRequirementVersion = Number(input.currentRequirementVersion)
  return Number.isInteger(notifiedRequirementVersion)
    && notifiedRequirementVersion >= 0
    && notifiedRequirementVersion === currentRequirementVersion
}

export function hasCurrentGuestReadyReadinessEvidence(input: {
  propertyReady?: unknown
  currentCheckinTaskKeyHandoverComplete?: unknown
}) {
  return input.propertyReady === true || input.currentCheckinTaskKeyHandoverComplete === true
}

export function buildGuestReadyNotificationProjection(input: {
  orderId?: unknown
  notifiedAt?: unknown
  notifiedByUserId?: unknown
  notifiedByName?: unknown
  version?: unknown
  propertyReady: boolean
  currentCheckin: boolean
  automaticEarlyArrival: boolean
  outsideKeyRequired: boolean
  notificationBindingCurrent?: boolean
  includeAllOrderBoundCheckins?: boolean
  priorTaskNotification?: GuestReadyPriorTaskNotificationProjection | null
}): GuestReadyNotificationProjection | null {
  const orderId = text(input.orderId)
  const requirementReasons = guestReadyNotificationRequirementReasons({
    earlyArrival: input.automaticEarlyArrival,
    outsideKey: input.outsideKeyRequired,
  })
  if (!orderId || (!requirementReasons.length && input.includeAllOrderBoundCheckins !== true)) return null
  const notifiedAt = text(input.notifiedAt) || null
  const notifiedByUserId = text(input.notifiedByUserId) || null
  const notified = !!notifiedAt && !!notifiedByUserId && input.notificationBindingCurrent
  const disabledReason: GuestReadyNotificationDisabledReason | null = !input.currentCheckin
    ? 'checkin_order_changed'
    : !input.propertyReady
      ? 'property_not_ready'
      : null
  return {
    source_type: 'orders',
    source_id: orderId,
    order_id: orderId,
    task_id: null,
    association_state: 'order_bound',
    status: notified ? 'notified' : 'not_notified',
    notified_at: notified ? notifiedAt : null,
    notified_by_user_id: notified ? notifiedByUserId : null,
    notified_by_name: notified ? (text(input.notifiedByName) || notifiedByUserId) : null,
    version: version(input.version),
    requirement_reasons: requirementReasons,
    automatic_early_arrival: input.automaticEarlyArrival,
    outside_key_required: input.outsideKeyRequired,
    // Revoke remains allowed when readiness later changes, so an erroneous
    // marker can always be removed from the current check-in order.
    eligible: input.currentCheckin && (notified || input.propertyReady),
    disabled_reason: input.currentCheckin && notified ? null : disabledReason,
    prior_task_notification: input.priorTaskNotification || null,
  }
}

export function buildTaskGuestReadyNotificationProjection(input: {
  taskId?: unknown
  notifiedAt?: unknown
  notifiedByUserId?: unknown
  notifiedByName?: unknown
  version?: unknown
  lastAction?: unknown
  lastActionAt?: unknown
  lastActorUserId?: unknown
  lastActorName?: unknown
  keyHandoverComplete: boolean
  currentUnlinkedCheckin: boolean
  notificationBindingCurrent?: boolean
  unavailableReason?: Extract<GuestReadyNotificationDisabledReason, 'task_linked_to_order' | 'checkin_order_changed'>
}): GuestReadyNotificationProjection | null {
  const taskId = text(input.taskId)
  if (!taskId) return null
  const notifiedAt = text(input.notifiedAt) || null
  const notifiedByUserId = text(input.notifiedByUserId) || null
  const notified = !!notifiedAt && !!notifiedByUserId && input.notificationBindingCurrent === true
  const disabledReason: GuestReadyNotificationDisabledReason | null = !input.currentUnlinkedCheckin
    ? (input.unavailableReason || 'checkin_order_changed')
    : !input.keyHandoverComplete
      ? 'key_handover_incomplete'
      : null
  return {
    source_type: 'cleaning_tasks',
    source_id: taskId,
    order_id: null,
    task_id: taskId,
    association_state: 'manual_unlinked',
    status: notified ? 'notified' : 'not_notified',
    notified_at: notified ? notifiedAt : null,
    notified_by_user_id: notified ? notifiedByUserId : null,
    notified_by_name: notified ? (text(input.notifiedByName) || notifiedByUserId) : null,
    version: version(input.version),
    requirement_reasons: [],
    automatic_early_arrival: false,
    outside_key_required: false,
    eligible: input.currentUnlinkedCheckin && (notified || input.keyHandoverComplete),
    disabled_reason: notified && input.currentUnlinkedCheckin ? null : disabledReason,
    prior_task_notification: null,
  }
}

export function buildPriorTaskGuestReadyNotification(input: {
  taskId?: unknown
  notifiedAt?: unknown
  notifiedByUserId?: unknown
  notifiedByName?: unknown
  version?: unknown
  lastAction?: unknown
  lastActionAt?: unknown
  lastActorUserId?: unknown
  lastActorName?: unknown
}): GuestReadyPriorTaskNotificationProjection | null {
  const taskId = text(input.taskId)
  const lastAction = text(input.lastAction).toLowerCase()
  const lastActionAt = text(input.lastActionAt)
  const lastActorUserId = text(input.lastActorUserId)
  if (!taskId || !['mark', 'revoke'].includes(lastAction) || !lastActionAt || !lastActorUserId) return null
  const notifiedAt = text(input.notifiedAt) || null
  const notifiedByUserId = text(input.notifiedByUserId) || null
  const notified = !!notifiedAt && !!notifiedByUserId
  return {
    task_id: taskId,
    status: notified ? 'notified' : 'not_notified',
    notified_at: notified ? notifiedAt : null,
    notified_by_user_id: notified ? notifiedByUserId : null,
    notified_by_name: notified ? (text(input.notifiedByName) || notifiedByUserId) : null,
    version: version(input.version),
    last_action: lastAction as 'mark' | 'revoke',
    last_action_at: lastActionAt,
    last_actor_user_id: lastActorUserId,
    last_actor_name: text(input.lastActorName) || lastActorUserId,
    read_only_reason: 'linked_to_order',
  }
}

export function buildGuestReadyOutsideKeyProjection(input: {
  orderId?: unknown
  required?: unknown
  registeredAt?: unknown
  registeredByUserId?: unknown
  registeredByName?: unknown
  version?: unknown
  currentCheckin: boolean
}): GuestReadyOutsideKeyProjection | null {
  const orderId = text(input.orderId)
  if (!orderId || !input.currentCheckin) return null
  const required = input.required === true
  const registeredAt = required ? (text(input.registeredAt) || null) : null
  const registeredByUserId = required ? (text(input.registeredByUserId) || null) : null
  return {
    order_id: orderId,
    required,
    registered_at: registeredAt,
    registered_by_user_id: registeredByUserId,
    registered_by_name: required ? (text(input.registeredByName) || registeredByUserId) : null,
    version: version(input.version),
  }
}

export function guestReadyOutsideKeyAction(
  projection: GuestReadyOutsideKeyProjection | null,
  canManage: boolean,
): GuestReadyOutsideKeyAction | null {
  if (!projection || !canManage) return null
  return {
    id: projection.required ? 'cancel_guest_ready_outside_key' : 'register_guest_ready_outside_key',
    label: projection.required ? '取消钥匙外挂' : '登记钥匙外挂',
    placement: 'more',
    enabled: true,
    target: 'TaskDetail',
    intent: 'manager',
    source_type: 'orders',
    source_id: projection.order_id,
  }
}

export function guestReadyNotificationAction(
  projection: GuestReadyNotificationProjection | null,
  canManage: boolean,
): GuestReadyNotificationAction | null {
  if (!projection || !canManage) return null
  const revoke = projection.status === 'notified'
  return {
    id: revoke ? 'revoke_guest_ready_notified' : 'record_guest_ready_notified',
    label: revoke ? '撤销已通知客人' : '已通知客人',
    placement: 'primary',
    enabled: projection.eligible,
    ...(!projection.eligible && projection.disabled_reason ? { disabled_reason: projection.disabled_reason } : {}),
    target: 'TaskDetail',
    intent: 'manager',
    source_type: projection.source_type,
    source_id: projection.source_id,
  }
}

export function guestReadyNotificationWorkRecordActions(
  actions: unknown,
  input: { sourceType?: unknown; sourceId?: unknown; orderId?: unknown; canManage: boolean; canViewGuestContext: boolean; workRecordDate?: unknown; workRecordState?: unknown; now?: Date },
): GuestReadyNotificationAction[] {
  const sourceType = text(input.sourceType) || 'orders'
  const sourceId = text(input.sourceId) || text(input.orderId)
  const workRecordDate = text(input.workRecordDate).slice(0, 10)
  const workRecordState = text(input.workRecordState).toLowerCase()
  const todayParts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(input.now || new Date())
  const todayByType = new Map(todayParts.map((part) => [part.type, part.value]))
  const today = `${todayByType.get('year') || ''}-${todayByType.get('month') || ''}-${todayByType.get('day') || ''}`
  if (!input.canManage
    || !input.canViewGuestContext
    || !['completed', 'pending_review'].includes(workRecordState)
    || !['orders', 'cleaning_tasks'].includes(sourceType)
    || !sourceId
    || workRecordDate !== today
    || !Array.isArray(actions)) return []
  return actions.filter((action): action is GuestReadyNotificationAction => (
    action != null
    && typeof action === 'object'
    && ['record_guest_ready_notified', 'revoke_guest_ready_notified'].includes(text((action as any).id))
    && text((action as any).source_type) === sourceType
    && text((action as any).source_id) === sourceId
  ))
}

export function isCurrentGuestReadyNotificationBusinessDate(value: unknown, now = new Date()): boolean {
  const taskDate = text(value).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(taskDate)) return false
  const todayParts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const todayByType = new Map(todayParts.map((part) => [part.type, part.value]))
  const today = `${todayByType.get('year') || ''}-${todayByType.get('month') || ''}-${todayByType.get('day') || ''}`
  return taskDate === today
}

export function isCurrentUnlinkedGuestReadyTaskProjection(input: {
  orderId?: unknown
  taskId?: unknown
  taskDate?: unknown
  now?: Date
}): boolean {
  return !text(input.orderId)
    && !!text(input.taskId)
    && isCurrentGuestReadyNotificationBusinessDate(input.taskDate, input.now)
}

export function guestReadyCheckinTaskId(task: any) {
  const activeSourceIds = new Set([
    ...(Array.isArray(task?.active_source_ids) ? task.active_source_ids : []),
    ...(Array.isArray(task?.source_ids) ? task.source_ids : []),
    task?.source_id,
  ].map(text).filter(Boolean))
  const candidates = new Set<string>()
  for (const phase of Array.isArray(task?.phase_history) ? task.phase_history : []) {
    const sourceId = text(phase?.source_id)
    if (text(phase?.task_type).toLowerCase() === 'checkin_clean'
      && sourceId
      && (!activeSourceIds.size || activeSourceIds.has(sourceId))) candidates.add(sourceId)
  }
  if (text(task?.task_type).toLowerCase() === 'checkin_clean') {
    const direct = text(task?.source_id)
    if (direct && (!activeSourceIds.size || activeSourceIds.has(direct))) candidates.add(direct)
  }
  return candidates.size === 1 ? Array.from(candidates)[0] : ''
}

export function planTaskGuestReadyNotificationMutation(input: {
  action: 'mark' | 'revoke'
  expectedVersion: number
  currentVersion: number
  notifiedAt?: unknown
  notifiedByUserId?: unknown
  notificationBindingCurrent?: boolean
  keyHandoverComplete: boolean
  currentUnlinkedCheckin: boolean
}) {
  if (!input.currentUnlinkedCheckin) throw new GuestReadyNotificationConflict('GUEST_READY_TASK_LINKED_TO_ORDER')
  if (input.expectedVersion !== input.currentVersion) throw new GuestReadyNotificationConflict('GUEST_READY_NOTIFICATION_CHANGED')
  const hasStoredNotification = !!text(input.notifiedAt) && !!text(input.notifiedByUserId)
  const isNotified = hasStoredNotification && input.notificationBindingCurrent === true
  if (input.action === 'mark' && !input.keyHandoverComplete) {
    throw new GuestReadyNotificationConflict('GUEST_READY_KEY_HANDOVER_INCOMPLETE')
  }
  const wantsNotified = input.action === 'mark'
  const changed = hasStoredNotification !== wantsNotified
    || (wantsNotified && !input.notificationBindingCurrent)
  return {
    changed,
    wantsNotified,
    nextVersion: changed ? input.currentVersion + 1 : input.currentVersion,
  }
}

export function planGuestReadyNotificationMutation(input: {
  action: 'mark' | 'revoke' | 'register_outside_key' | 'cancel_outside_key'
  expectedVersion: number
  currentVersion: number
  notifiedAt?: unknown
  notifiedByUserId?: unknown
  propertyReady: boolean
  currentCheckin: boolean
  automaticEarlyArrival: boolean
  outsideKeyRequired: boolean
  notificationBindingCurrent?: boolean
}) {
  if (!input.currentCheckin) throw new GuestReadyNotificationConflict('GUEST_READY_CHECKIN_ORDER_CHANGED')
  if (input.expectedVersion !== input.currentVersion) throw new GuestReadyNotificationConflict('GUEST_READY_NOTIFICATION_CHANGED')
  const hasStoredNotification = !!text(input.notifiedAt) && !!text(input.notifiedByUserId)
  const isNotified = hasStoredNotification && input.notificationBindingCurrent === true
  const nextOutsideKeyRequired = input.action === 'register_outside_key'
    ? true
    : input.action === 'cancel_outside_key'
      ? false
      : input.outsideKeyRequired
  const notificationRequired = isGuestReadyNotificationRequired({
    earlyArrival: input.automaticEarlyArrival,
    outsideKey: nextOutsideKeyRequired,
  })
  if (input.action === 'mark' && !input.propertyReady) throw new GuestReadyNotificationConflict('GUEST_READY_PROPERTY_NOT_READY')
  const wantsNotified = input.action === 'mark'
    ? true
    : input.action === 'revoke'
      ? false
      : isNotified
  const outsideKeyChanged = nextOutsideKeyRequired !== input.outsideKeyRequired
  const notificationChanged = hasStoredNotification !== wantsNotified
    || (wantsNotified && !input.notificationBindingCurrent)
  return {
    changed: outsideKeyChanged || notificationChanged,
    nextVersion: outsideKeyChanged || notificationChanged ? input.currentVersion + 1 : input.currentVersion,
    wantsNotified,
    nextOutsideKeyRequired,
    notificationRequired,
    notificationChanged,
  }
}

export type GuestReadyNotificationOrderState = {
  order_id: string
  notified_at: string | null
  notified_by_user_id: string | null
  notified_by_name: string | null
  outside_key_required: boolean
  outside_key_registered_at: string | null
  outside_key_registered_by_user_id: string | null
  outside_key_registered_by_name: string | null
  notified_checkin_task_id: string | null
  notified_requirement_version: number | null
  current_checkin_task_id: string | null
  current_requirement_version: number | null
  latest_legacy_assignment_changed_at: string | null
  current_checkin_count: number
  version: number
}

export async function loadGuestReadyNotificationOrderStates(executor: any, orderIds0: unknown[]) {
  const orderIds = Array.from(new Set(orderIds0.map(text).filter(Boolean)))
  const out = new Map<string, GuestReadyNotificationOrderState>()
  if (!executor || !orderIds.length) return out
  const result = await executor.query(
    `SELECT o.id::text AS order_id,
            o.guest_ready_notified_at,
            o.guest_ready_notified_by::text AS guest_ready_notified_by,
            o.guest_ready_notified_checkin_task_id::text AS guest_ready_notified_checkin_task_id,
            o.guest_ready_notified_requirement_version,
            COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), ''), NULLIF(TRIM(u.email), ''), o.guest_ready_notified_by::text) AS notified_by_name,
            COALESCE(o.guest_ready_outside_key_required, false) AS guest_ready_outside_key_required,
            o.guest_ready_outside_key_registered_at,
            o.guest_ready_outside_key_registered_by::text AS guest_ready_outside_key_registered_by,
            COALESCE(NULLIF(TRIM(outside_user.display_name), ''), NULLIF(TRIM(outside_user.username), ''), NULLIF(TRIM(outside_user.email), ''), o.guest_ready_outside_key_registered_by::text) AS outside_key_registered_by_name,
            COALESCE(o.guest_ready_notification_version, 0) AS guest_ready_notification_version,
            current_checkin.task_id AS current_checkin_task_id,
            current_checkin.requirement_version AS current_requirement_version,
            current_checkin.latest_legacy_assignment_changed_at,
            COALESCE(current_checkin.candidate_count, 0)
              + COALESCE(competing_checkin.candidate_count, 0) AS current_checkin_count
       FROM orders o
       LEFT JOIN users u ON u.id::text = o.guest_ready_notified_by::text
       LEFT JOIN users outside_user ON outside_user.id::text = o.guest_ready_outside_key_registered_by::text
       LEFT JOIN LATERAL (
         SELECT t.id::text AS task_id,
                COALESCE(t.guest_ready_checkin_requirement_version, 0) AS requirement_version,
                (SELECT max(assignment_event.occurred_at)
                   FROM work_task_events assignment_event
                  WHERE assignment_event.task_id = ('cleaning_task:' || t.id::text)
                    AND COALESCE(assignment_event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb)
                      ? 'assignment_changed'
                    AND NOT (
                      COALESCE(assignment_event.payload#>>'{arrangement_revision,guest_ready_requirement_version}', '')
                        ~ '^[0-9]{1,18}$'
                    )) AS latest_legacy_assignment_changed_at,
                COALESCE(t.task_date, t.date)::date AS task_date,
                COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
                COUNT(*) OVER ()::integer AS candidate_count
           FROM cleaning_tasks t
           JOIN orders checkin_order ON checkin_order.id::text = t.order_id::text
           LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
          WHERE t.order_id::text = o.id::text
            AND lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
            AND ${activeCleaningTaskWhereSql('t')}
            AND ${validCleaningTaskOrderWhereSql('t', 'checkin_order')}
          ORDER BY t.updated_at DESC NULLS LAST, t.id
          LIMIT 1
       ) current_checkin ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::integer AS candidate_count
           FROM cleaning_tasks other
           JOIN orders other_order ON other_order.id::text = other.order_id::text
           LEFT JOIN properties other_p_id ON other_p_id.id::text = other.property_id::text
           LEFT JOIN properties other_p_code ON upper(other_p_code.code) = upper(other.property_id::text)
          WHERE current_checkin.task_id IS NOT NULL
            AND lower(COALESCE(other.task_type, other.type, '')) = 'checkin_clean'
            AND COALESCE(other.task_date, other.date)::date = current_checkin.task_date
            AND COALESCE(other_p_id.id::text, other_p_code.id::text, other.property_id::text) = current_checkin.property_id
            AND other.order_id::text <> o.id::text
            AND ${activeCleaningTaskWhereSql('other')}
            AND ${validCleaningTaskOrderWhereSql('other', 'other_order')}
       ) competing_checkin ON true
      WHERE o.id::text = ANY($1::text[])`,
    [orderIds],
  )
  for (const row of result?.rows || []) {
    const orderId = text(row.order_id)
    if (!orderId) continue
    out.set(orderId, {
      order_id: orderId,
      notified_at: text(row.guest_ready_notified_at) || null,
      notified_by_user_id: text(row.guest_ready_notified_by) || null,
      notified_by_name: text(row.notified_by_name) || null,
      outside_key_required: row.guest_ready_outside_key_required === true,
      outside_key_registered_at: text(row.guest_ready_outside_key_registered_at) || null,
      outside_key_registered_by_user_id: text(row.guest_ready_outside_key_registered_by) || null,
      outside_key_registered_by_name: text(row.outside_key_registered_by_name) || null,
      notified_checkin_task_id: text(row.guest_ready_notified_checkin_task_id) || null,
      notified_requirement_version: row.guest_ready_notified_requirement_version == null
        ? null
        : version(row.guest_ready_notified_requirement_version),
      current_checkin_task_id: text(row.current_checkin_task_id) || null,
      current_requirement_version: row.current_requirement_version == null
        ? null
        : version(row.current_requirement_version),
      latest_legacy_assignment_changed_at: text(row.latest_legacy_assignment_changed_at) || null,
      current_checkin_count: version(row.current_checkin_count),
      version: version(row.guest_ready_notification_version),
    })
  }
  return out
}

export type GuestReadyNotificationTaskState = {
  task_id: string
  notified_at: string | null
  notified_by_user_id: string | null
  notified_by_name: string | null
  notified_requirement_version: number | null
  current_requirement_version: number
  notification_binding_current: boolean
  key_handover_complete: boolean
  version: number
  last_action: 'mark' | 'revoke' | null
  last_action_at: string | null
  last_actor_user_id: string | null
  last_actor_name: string | null
}

export async function lockGuestReadyTaskNotificationContext(executor: any, taskId0: unknown) {
  const taskId = text(taskId0)
  if (!executor || !taskId) return null
  const taskResult = await executor.query(
    `SELECT t.id::text AS task_id,
            t.order_id::text AS order_id,
            COALESCE(t.task_type, t.type, '') AS task_type,
            COALESCE(t.task_date, t.date)::text AS task_date,
            COALESCE(t.status, '') AS status,
            COALESCE(t.execution_state, CASE WHEN lower(COALESCE(t.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled' ELSE 'active' END) AS execution_state,
            t.property_id::text AS property_id,
            t.assignee_id::text AS assignee_id,
            t.cleaner_id::text AS cleaner_id,
            t.inspector_id::text AS inspector_id,
            COALESCE(t.guest_ready_checkin_requirement_version, 0) AS guest_ready_checkin_requirement_version
       FROM cleaning_tasks t
      WHERE t.id::text = $1::text
      FOR UPDATE OF t`,
    [taskId],
  )
  const lockedTask = taskResult?.rows?.[0] || null
  if (!lockedTask) return null

  // This must be a second statement after the row lock is acquired. At READ
  // COMMITTED it receives a fresh snapshot, so a concurrent keys_hung_reopened
  // event committed while this request waited cannot be hidden by the waiting
  // SELECT's earlier statement snapshot.
  const evidenceResult = await executor.query(
    `SELECT (SELECT max(assignment_event.occurred_at)
               FROM work_task_events assignment_event
              WHERE assignment_event.task_id = ('cleaning_task:' || t.id::text)
                AND COALESCE(assignment_event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb)
                  ? 'assignment_changed'
                AND NOT (
                  COALESCE(assignment_event.payload#>>'{arrangement_revision,guest_ready_requirement_version}', '')
                    ~ '^[0-9]{1,18}$'
                )) AS latest_legacy_assignment_changed_at,
            EXISTS (
              SELECT 1 FROM cleaning_task_media media
               WHERE media.task_id::text = t.id::text
                 AND media.type = 'lockbox_video'
                 AND COALESCE(TRIM(media.url), '') <> ''
                 AND EXISTS (
                   SELECT 1
                     FROM work_task_action_audits audit
                    WHERE audit.source_type = 'cleaning_tasks'
                      AND audit.source_id::text = t.id::text
                      AND audit.performed_as_action = 'upload_access_video'
                      AND audit.performed_at > COALESCE((
                        SELECT max(assignment_event.occurred_at)
                          FROM work_task_events assignment_event
                         WHERE assignment_event.task_id = ('cleaning_task:' || t.id::text)
                           AND COALESCE(assignment_event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb)
                             ? 'assignment_changed'
                           AND NOT (
                             COALESCE(assignment_event.payload#>>'{arrangement_revision,guest_ready_requirement_version}', '')
                               ~ '^[0-9]{1,18}$'
                           )
                      ), '-infinity'::timestamptz)
                      AND (
                        (
                          CASE
                            WHEN COALESCE(audit.metadata->>'guest_ready_requirement_version', '') ~ '^[0-9]{1,18}$'
                              THEN (audit.metadata->>'guest_ready_requirement_version')::bigint
                            ELSE NULL
                          END = COALESCE(t.guest_ready_checkin_requirement_version, 0)
                        )
                        OR (
                          COALESCE(t.guest_ready_checkin_requirement_version, 0) = 0
                          AND NOT (audit.metadata ? 'guest_ready_requirement_version')
                          AND (audit.performed_at AT TIME ZONE 'Australia/Melbourne')::date
                            = COALESCE(t.task_date, t.date)::date
                          AND COALESCE(audit.metadata#>>'{task_snapshot,scheduled_service_date}', '')
                            = COALESCE(t.task_date, t.date)::text
                          AND COALESCE(audit.metadata#>>'{property_snapshot,property_id}', '')
                            = COALESCE(t.property_id::text, '')
                        )
                      )
                 )
            ) AS has_current_lockbox_video,
            COALESCE((
              SELECT CASE
                WHEN COALESCE(event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb) ? 'keys_hung_reopened' THEN false
                WHEN COALESCE(event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb) ? 'keys_hung_confirmed' THEN
                  (
                    (
                      CASE
                        WHEN COALESCE(event.payload#>>'{arrangement_revision,guest_ready_requirement_version}', '') ~ '^[0-9]{1,18}$'
                          THEN (event.payload#>>'{arrangement_revision,guest_ready_requirement_version}')::bigint
                        ELSE NULL
                      END = COALESCE(t.guest_ready_checkin_requirement_version, 0)
                    )
                    OR (
                      COALESCE(t.guest_ready_checkin_requirement_version, 0) = 0
                      AND NOT (
                        COALESCE(event.payload#>'{arrangement_revision}', '{}'::jsonb)
                          ? 'guest_ready_requirement_version'
                      )
                    )
                  )
                  AND COALESCE(NULLIF(TRIM(event.payload#>>'{arrangement_revision,after,scheduled_service_date}'), ''), '')
                    = COALESCE(t.task_date, t.date)::text
                  AND COALESCE(NULLIF(TRIM(event.payload#>>'{arrangement_revision,after,property_id}'), ''), '')
                    = COALESCE(t.property_id::text, '')
                  AND COALESCE(NULLIF(TRIM(event.payload#>>'{arrangement_revision,after,cleaner_id}'), ''), '')
                    = COALESCE(t.cleaner_id::text, '')
                  AND COALESCE(NULLIF(TRIM(event.payload#>>'{arrangement_revision,after,assignee_id}'), ''), '')
                    = COALESCE(t.assignee_id::text, '')
                  AND COALESCE(NULLIF(TRIM(event.payload#>>'{arrangement_revision,after,inspector_id}'), ''), '')
                    = COALESCE(t.inspector_id::text, '')
                ELSE false
              END
                FROM work_task_events event
               WHERE event.task_id = ('cleaning_task:' || t.id::text)
                 AND COALESCE(event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb)
                   ?| ARRAY['keys_hung_confirmed', 'keys_hung_reopened']
                 AND NOT EXISTS (
                   SELECT 1
                     FROM work_task_events assignment_event
                    WHERE assignment_event.task_id = ('cleaning_task:' || t.id::text)
                      AND COALESCE(assignment_event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb)
                        ? 'assignment_changed'
                      AND NOT (
                        COALESCE(assignment_event.payload#>>'{arrangement_revision,guest_ready_requirement_version}', '')
                          ~ '^[0-9]{1,18}$'
                      )
                      AND (assignment_event.occurred_at, assignment_event.sequence_no)
                        > (event.occurred_at, event.sequence_no)
                 )
               ORDER BY event.occurred_at DESC, event.sequence_no DESC
               LIMIT 1
            ), false) AS has_current_manual_key_handover,
            (SELECT COALESCE(audit.performed_by_user_id, audit.actor_user_id)::text
               FROM work_task_action_audits audit
              WHERE audit.source_type = 'cleaning_tasks'
                AND audit.source_id::text = t.id::text
                AND audit.performed_as_action = 'upload_access_video'
                AND audit.performed_at > COALESCE((
                  SELECT max(assignment_event.occurred_at)
                    FROM work_task_events assignment_event
                   WHERE assignment_event.task_id = ('cleaning_task:' || t.id::text)
                     AND COALESCE(assignment_event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb)
                       ? 'assignment_changed'
                     AND NOT (
                       COALESCE(assignment_event.payload#>>'{arrangement_revision,guest_ready_requirement_version}', '')
                         ~ '^[0-9]{1,18}$'
                     )
                ), '-infinity'::timestamptz)
                AND (
                  (
                    CASE
                      WHEN COALESCE(audit.metadata->>'guest_ready_requirement_version', '') ~ '^[0-9]{1,18}$'
                        THEN (audit.metadata->>'guest_ready_requirement_version')::bigint
                      ELSE NULL
                    END = COALESCE(t.guest_ready_checkin_requirement_version, 0)
                  )
                  OR (
                    COALESCE(t.guest_ready_checkin_requirement_version, 0) = 0
                    AND NOT (audit.metadata ? 'guest_ready_requirement_version')
                    AND (audit.performed_at AT TIME ZONE 'Australia/Melbourne')::date
                      = COALESCE(t.task_date, t.date)::date
                    AND COALESCE(audit.metadata#>>'{task_snapshot,scheduled_service_date}', '')
                      = COALESCE(t.task_date, t.date)::text
                    AND COALESCE(audit.metadata#>>'{property_snapshot,property_id}', '')
                      = COALESCE(t.property_id::text, '')
                  )
                )
              ORDER BY audit.performed_at DESC, audit.created_at DESC
              LIMIT 1)
              AS lockbox_handover_actor_user_id,
            (SELECT event.caused_by_user_id::text
               FROM work_task_events event
              WHERE event.task_id = ('cleaning_task:' || t.id::text)
                AND COALESCE(event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb)
                  ?| ARRAY['keys_hung_confirmed', 'keys_hung_reopened']
                AND NOT EXISTS (
                  SELECT 1
                    FROM work_task_events assignment_event
                   WHERE assignment_event.task_id = ('cleaning_task:' || t.id::text)
                     AND COALESCE(assignment_event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb)
                       ? 'assignment_changed'
                     AND NOT (
                       COALESCE(assignment_event.payload#>>'{arrangement_revision,guest_ready_requirement_version}', '')
                         ~ '^[0-9]{1,18}$'
                     )
                     AND (assignment_event.occurred_at, assignment_event.sequence_no)
                       > (event.occurred_at, event.sequence_no)
                )
                AND (
                  (
                    CASE
                      WHEN COALESCE(event.payload#>>'{arrangement_revision,guest_ready_requirement_version}', '') ~ '^[0-9]{1,18}$'
                        THEN (event.payload#>>'{arrangement_revision,guest_ready_requirement_version}')::bigint
                      ELSE NULL
                    END = COALESCE(t.guest_ready_checkin_requirement_version, 0)
                  )
                  OR (
                    COALESCE(t.guest_ready_checkin_requirement_version, 0) = 0
                    AND NOT (
                      COALESCE(event.payload#>'{arrangement_revision}', '{}'::jsonb)
                        ? 'guest_ready_requirement_version'
                    )
                  )
                )
              ORDER BY event.occurred_at DESC, event.sequence_no DESC
              LIMIT 1)
              AS manual_handover_actor_user_id
       FROM cleaning_tasks t
      WHERE t.id::text = $1::text`,
    [taskId],
  )
  const evidence = evidenceResult?.rows?.[0] || {}
  const currentPerformerIds = Array.from(new Set([
    lockedTask.assignee_id,
    lockedTask.cleaner_id,
    lockedTask.inspector_id,
  ].map(text).filter(Boolean)))
  const lockboxHandoverActorUserId = text(evidence.lockbox_handover_actor_user_id)
  const currentLockboxEvidence = evidence.has_current_lockbox_video === true
    && !!lockboxHandoverActorUserId
    && currentPerformerIds.includes(lockboxHandoverActorUserId)
  return {
    ...lockedTask,
    ...evidence,
    key_handover_complete: currentLockboxEvidence || evidence.has_current_manual_key_handover === true,
  }
}

export async function loadGuestReadyNotificationTaskStates(executor: any, taskIds0: unknown[]) {
  const taskIds = Array.from(new Set(taskIds0.map(text).filter(Boolean)))
  const out = new Map<string, GuestReadyNotificationTaskState>()
  if (!executor || !taskIds.length) return out
  const result = await executor.query(
    `SELECT task.id::text AS task_id,
            state.notified_at,
            state.notified_by_user_id::text AS notified_by_user_id,
            state.notified_requirement_version,
            COALESCE(task.guest_ready_checkin_requirement_version, 0) AS current_requirement_version,
            COALESCE(NULLIF(TRIM(notified_user.display_name), ''), NULLIF(TRIM(notified_user.username), ''), NULLIF(TRIM(notified_user.email), ''), state.notified_by_user_id::text) AS notified_by_name,
            COALESCE(state.version, 0) AS version,
            state.last_action,
            state.last_action_at,
            state.last_actor_user_id::text AS last_actor_user_id,
            COALESCE(NULLIF(TRIM(last_actor.display_name), ''), NULLIF(TRIM(last_actor.username), ''), NULLIF(TRIM(last_actor.email), ''), state.last_actor_user_id::text) AS last_actor_name,
            (
              EXISTS (
                SELECT 1
                  FROM cleaning_task_media media
                 WHERE media.task_id::text = task.id::text
                   AND media.type = 'lockbox_video'
                   AND COALESCE(TRIM(media.url), '') <> ''
              )
              AND COALESCE((
                SELECT NULLIF(COALESCE(audit.performed_by_user_id, audit.actor_user_id), '')::text
                  FROM work_task_action_audits audit
                 WHERE audit.source_type = 'cleaning_tasks'
                   AND audit.source_id::text = task.id::text
                   AND audit.performed_as_action = 'upload_access_video'
                   AND audit.performed_at > COALESCE((
                     SELECT max(assignment_event.occurred_at)
                       FROM work_task_events assignment_event
                      WHERE assignment_event.task_id = ('cleaning_task:' || task.id::text)
                        AND COALESCE(assignment_event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb)
                          ? 'assignment_changed'
                        AND NOT (
                          COALESCE(assignment_event.payload#>>'{arrangement_revision,guest_ready_requirement_version}', '')
                            ~ '^[0-9]{1,18}$'
                        )
                   ), '-infinity'::timestamptz)
                   AND (
                     (
                       CASE
                         WHEN COALESCE(audit.metadata->>'guest_ready_requirement_version', '') ~ '^[0-9]{1,18}$'
                           THEN (audit.metadata->>'guest_ready_requirement_version')::bigint
                         ELSE NULL
                       END = COALESCE(task.guest_ready_checkin_requirement_version, 0)
                     )
                     OR (
                       COALESCE(task.guest_ready_checkin_requirement_version, 0) = 0
                       AND NOT (audit.metadata ? 'guest_ready_requirement_version')
                       AND (audit.performed_at AT TIME ZONE 'Australia/Melbourne')::date
                         = COALESCE(task.task_date, task.date)::date
                       AND COALESCE(audit.metadata#>>'{task_snapshot,scheduled_service_date}', '')
                         = COALESCE(task.task_date, task.date)::text
                       AND COALESCE(audit.metadata#>>'{property_snapshot,property_id}', '')
                         = COALESCE(task.property_id::text, '')
                     )
                   )
                 ORDER BY audit.performed_at DESC, audit.created_at DESC
                 LIMIT 1
              ) = ANY(ARRAY[
                NULLIF(task.assignee_id::text, ''),
                NULLIF(task.cleaner_id::text, ''),
                NULLIF(task.inspector_id::text, '')
              ]), false)
            ) AS has_current_lockbox_handover,
            COALESCE((
              SELECT CASE
                WHEN COALESCE(event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb) ? 'keys_hung_reopened' THEN false
                WHEN COALESCE(event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb) ? 'keys_hung_confirmed' THEN
                  (
                    (
                      CASE
                        WHEN COALESCE(event.payload#>>'{arrangement_revision,guest_ready_requirement_version}', '') ~ '^[0-9]{1,18}$'
                          THEN (event.payload#>>'{arrangement_revision,guest_ready_requirement_version}')::bigint
                        ELSE NULL
                      END = COALESCE(task.guest_ready_checkin_requirement_version, 0)
                    )
                    OR (
                      COALESCE(task.guest_ready_checkin_requirement_version, 0) = 0
                      AND NOT (
                        COALESCE(event.payload#>'{arrangement_revision}', '{}'::jsonb)
                          ? 'guest_ready_requirement_version'
                      )
                    )
                  )
                  AND COALESCE(NULLIF(TRIM(event.payload#>>'{arrangement_revision,after,scheduled_service_date}'), ''), '')
                    = COALESCE(task.task_date, task.date)::text
                  AND COALESCE(NULLIF(TRIM(event.payload#>>'{arrangement_revision,after,property_id}'), ''), '')
                    = COALESCE(task.property_id::text, '')
                  AND COALESCE(NULLIF(TRIM(event.payload#>>'{arrangement_revision,after,cleaner_id}'), ''), '')
                    = COALESCE(task.cleaner_id::text, '')
                  AND COALESCE(NULLIF(TRIM(event.payload#>>'{arrangement_revision,after,assignee_id}'), ''), '')
                    = COALESCE(task.assignee_id::text, '')
                  AND COALESCE(NULLIF(TRIM(event.payload#>>'{arrangement_revision,after,inspector_id}'), ''), '')
                    = COALESCE(task.inspector_id::text, '')
                ELSE false
              END
                FROM work_task_events event
               WHERE event.task_id = ('cleaning_task:' || task.id::text)
                 AND COALESCE(event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb)
                   ?| ARRAY['keys_hung_confirmed', 'keys_hung_reopened']
                 AND NOT EXISTS (
                   SELECT 1
                     FROM work_task_events assignment_event
                    WHERE assignment_event.task_id = ('cleaning_task:' || task.id::text)
                      AND COALESCE(assignment_event.payload#>'{arrangement_revision,reasons}', '[]'::jsonb)
                        ? 'assignment_changed'
                      AND NOT (
                        COALESCE(assignment_event.payload#>>'{arrangement_revision,guest_ready_requirement_version}', '')
                          ~ '^[0-9]{1,18}$'
                      )
                      AND (assignment_event.occurred_at, assignment_event.sequence_no)
                        > (event.occurred_at, event.sequence_no)
                 )
               ORDER BY event.occurred_at DESC, event.sequence_no DESC
               LIMIT 1
            ), false) AS has_current_manual_handover
       FROM cleaning_tasks task
       LEFT JOIN cleaning_task_guest_ready_notifications state ON state.task_id::text = task.id::text
       LEFT JOIN users notified_user ON notified_user.id::text = state.notified_by_user_id::text
       LEFT JOIN users last_actor ON last_actor.id::text = state.last_actor_user_id::text
      WHERE task.id::text = ANY($1::text[])`,
    [taskIds],
  )
  for (const row of result?.rows || []) {
    const taskId = text(row.task_id)
    const lastActionText = text(row.last_action).toLowerCase()
    const lastAction = ['mark', 'revoke'].includes(lastActionText)
      ? lastActionText as 'mark' | 'revoke'
      : null
    if (!taskId) continue
    const notifiedRequirementVersion = row.notified_requirement_version == null
      ? null
      : version(row.notified_requirement_version)
    const currentRequirementVersion = version(row.current_requirement_version)
    out.set(taskId, {
      task_id: taskId,
      notified_at: text(row.notified_at) || null,
      notified_by_user_id: text(row.notified_by_user_id) || null,
      notified_by_name: text(row.notified_by_name) || null,
      notified_requirement_version: notifiedRequirementVersion,
      current_requirement_version: currentRequirementVersion,
      notification_binding_current: isGuestReadyTaskNotificationRequirementBindingCurrent({
        notifiedRequirementVersion,
        currentRequirementVersion,
      }),
      key_handover_complete: row.has_current_lockbox_handover === true || row.has_current_manual_handover === true,
      version: version(row.version),
      last_action: lastAction,
      last_action_at: text(row.last_action_at) || null,
      last_actor_user_id: text(row.last_actor_user_id) || null,
      last_actor_name: text(row.last_actor_name) || text(row.last_actor_user_id) || null,
    })
  }
  return out
}
