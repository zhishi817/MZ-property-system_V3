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
  eligible: boolean
  disabled_reason: GuestReadyNotificationDisabledReason | null
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

export function buildGuestReadyNotificationProjection(input: {
  orderId?: unknown
  notifiedAt?: unknown
  notifiedByUserId?: unknown
  notifiedByName?: unknown
  version?: unknown
  propertyReady: boolean
  currentCheckin: boolean
}): GuestReadyNotificationProjection | null {
  const orderId = text(input.orderId)
  if (!orderId) return null
  const notifiedAt = text(input.notifiedAt) || null
  const notifiedByUserId = text(input.notifiedByUserId) || null
  const notified = !!notifiedAt && !!notifiedByUserId
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
    // Revoke remains allowed when readiness later changes, so an erroneous
    // marker can always be removed from the current check-in order.
    eligible: input.currentCheckin && (notified || input.propertyReady),
    disabled_reason: input.currentCheckin && notified ? null : disabledReason,
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
  action: 'mark' | 'revoke'
  expectedVersion: number
  currentVersion: number
  notifiedAt?: unknown
  notifiedByUserId?: unknown
  propertyReady: boolean
  currentCheckin: boolean
}) {
  if (!input.currentCheckin) throw new GuestReadyNotificationConflict('GUEST_READY_CHECKIN_ORDER_CHANGED')
  if (input.expectedVersion !== input.currentVersion) throw new GuestReadyNotificationConflict('GUEST_READY_NOTIFICATION_CHANGED')
  const isNotified = !!text(input.notifiedAt) && !!text(input.notifiedByUserId)
  if (input.action === 'mark' && !input.propertyReady) throw new GuestReadyNotificationConflict('GUEST_READY_PROPERTY_NOT_READY')
  const wantsNotified = input.action === 'mark'
  return {
    changed: isNotified !== wantsNotified,
    nextVersion: isNotified === wantsNotified ? input.currentVersion : input.currentVersion + 1,
    wantsNotified,
  }
}

export type GuestReadyNotificationOrderState = {
  order_id: string
  notified_at: string | null
  notified_by_user_id: string | null
  notified_by_name: string | null
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
            COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), ''), NULLIF(TRIM(u.email), ''), o.guest_ready_notified_by::text) AS notified_by_name,
            COALESCE(o.guest_ready_notification_version, 0) AS guest_ready_notification_version
       FROM orders o
       LEFT JOIN users u ON u.id::text = o.guest_ready_notified_by::text
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
      version: version(row.guest_ready_notification_version),
    })
  }
  return out
}
