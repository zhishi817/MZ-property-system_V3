import { activeCleaningTaskWhereSql, validCleaningTaskOrderWhereSql } from '../services/cleaningSync'

export const GUEST_READY_NOTIFICATION_PERMISSION = 'order.guest_ready_notification.manage'

export type GuestReadyNotificationDisabledReason =
  | 'property_not_ready'
  | 'no_checkin_order'
  | 'checkin_order_changed'

export type GuestReadyNotificationProjection = {
  order_id: string
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
  source_type: 'orders'
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
}) {
  const notifiedCheckinTaskId = text(input.notifiedCheckinTaskId)
  const currentCheckinTaskId = text(input.currentCheckinTaskId)
  if (!notifiedCheckinTaskId || !currentCheckinTaskId || notifiedCheckinTaskId !== currentCheckinTaskId) return false
  const notifiedRequirementVersion = Number(input.notifiedRequirementVersion)
  const currentRequirementVersion = Number(input.currentRequirementVersion)
  return Number.isInteger(notifiedRequirementVersion)
    && notifiedRequirementVersion >= 0
    && notifiedRequirementVersion === currentRequirementVersion
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
}): GuestReadyNotificationProjection | null {
  const orderId = text(input.orderId)
  const requirementReasons = guestReadyNotificationRequirementReasons({
    earlyArrival: input.automaticEarlyArrival,
    outsideKey: input.outsideKeyRequired,
  })
  if (!orderId || !requirementReasons.length) return null
  const notifiedAt = text(input.notifiedAt) || null
  const notifiedByUserId = text(input.notifiedByUserId) || null
  const notified = !!notifiedAt && !!notifiedByUserId && input.notificationBindingCurrent
  const disabledReason: GuestReadyNotificationDisabledReason | null = !input.currentCheckin
    ? 'checkin_order_changed'
    : !input.propertyReady
      ? 'property_not_ready'
      : null
  return {
    order_id: orderId,
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
    source_type: 'orders',
    source_id: projection.order_id,
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
  const isNotified = hasStoredNotification && input.notificationBindingCurrent
  const nextOutsideKeyRequired = input.action === 'register_outside_key'
    ? true
    : input.action === 'cancel_outside_key'
      ? false
      : input.outsideKeyRequired
  const notificationRequired = isGuestReadyNotificationRequired({
    earlyArrival: input.automaticEarlyArrival,
    outsideKey: nextOutsideKeyRequired,
  })
  const notificationWasRequired = isGuestReadyNotificationRequired({
    earlyArrival: input.automaticEarlyArrival,
    outsideKey: input.outsideKeyRequired,
  })
  if (input.action === 'mark' && !notificationRequired) throw new GuestReadyNotificationConflict('GUEST_READY_NOTIFICATION_NOT_REQUIRED')
  if (input.action === 'mark' && !input.propertyReady) throw new GuestReadyNotificationConflict('GUEST_READY_PROPERTY_NOT_READY')
  const wantsNotified = input.action === 'mark'
    ? true
    : input.action === 'revoke'
      ? false
      : notificationRequired && notificationWasRequired && isNotified
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
            COALESCE(current_checkin.candidate_count, 0)
              + COALESCE(competing_checkin.candidate_count, 0) AS current_checkin_count
       FROM orders o
       LEFT JOIN users u ON u.id::text = o.guest_ready_notified_by::text
       LEFT JOIN users outside_user ON outside_user.id::text = o.guest_ready_outside_key_registered_by::text
       LEFT JOIN LATERAL (
         SELECT t.id::text AS task_id,
                COALESCE(t.guest_ready_checkin_requirement_version, 0) AS requirement_version,
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
      current_checkin_count: version(row.current_checkin_count),
      version: version(row.guest_ready_notification_version),
    })
  }
  return out
}
