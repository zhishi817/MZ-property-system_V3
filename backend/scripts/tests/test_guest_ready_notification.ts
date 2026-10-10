import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  GUEST_READY_NOTIFICATION_PERMISSION,
  GuestReadyNotificationConflict,
  buildGuestReadyNotificationProjection,
  guestReadyNotificationAction,
  planGuestReadyNotificationMutation,
} from '../../src/lib/guestReadyNotification'

function conflictCode(fn: () => unknown) {
  try {
    fn()
    return null
  } catch (error) {
    assert(error instanceof GuestReadyNotificationConflict)
    return error.code
  }
}

function main() {
  const notReady = buildGuestReadyNotificationProjection({ orderId: 'order-1', propertyReady: false, currentCheckin: true })
  assert.equal(notReady?.status, 'not_notified')
  assert.equal(notReady?.disabled_reason, 'property_not_ready')
  assert.equal(guestReadyNotificationAction(notReady, true)?.enabled, false)
  assert.equal(guestReadyNotificationAction(notReady, false), null, 'permission is independent and server authoritative')

  const ready = buildGuestReadyNotificationProjection({ orderId: 'order-1', propertyReady: true, currentCheckin: true })
  assert.equal(guestReadyNotificationAction(ready, true)?.id, 'record_guest_ready_notified')
  const notified = buildGuestReadyNotificationProjection({
    orderId: 'order-1',
    notifiedAt: '2026-10-04T01:02:03.000Z',
    notifiedByUserId: 'cs-1',
    notifiedByName: '客服 A',
    version: 2,
    propertyReady: false,
    currentCheckin: true,
  })
  assert.equal(notified?.eligible, true, 'a mistaken marker can be revoked even after readiness changes')
  assert.equal(guestReadyNotificationAction(notified, true)?.id, 'revoke_guest_ready_notified')
  const replacementOrder = buildGuestReadyNotificationProjection({ orderId: 'order-2', propertyReady: true, currentCheckin: true })
  assert.equal(replacementOrder?.status, 'not_notified', 'a new check-in order never inherits the prior order marker')
  assert.equal(replacementOrder?.version, 0)

  assert.deepEqual(planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 0, propertyReady: true, currentCheckin: true }), {
    changed: true,
    nextVersion: 1,
    wantsNotified: true,
  })
  assert.deepEqual(planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 1, currentVersion: 1, notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: true, currentCheckin: true }), {
    changed: false,
    nextVersion: 1,
    wantsNotified: true,
  }, 'a new idempotent operation against the same state is a no-op')
  assert.deepEqual(planGuestReadyNotificationMutation({ action: 'revoke', expectedVersion: 2, currentVersion: 2, notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: false, currentCheckin: true }), {
    changed: true,
    nextVersion: 3,
    wantsNotified: false,
  }, 'revoke remains auditable even if the property later stops being ready')
  assert.equal(conflictCode(() => planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 1, propertyReady: true, currentCheckin: true })), 'GUEST_READY_NOTIFICATION_CHANGED')
  assert.equal(conflictCode(() => planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 0, propertyReady: false, currentCheckin: true })), 'GUEST_READY_PROPERTY_NOT_READY')
  assert.equal(conflictCode(() => planGuestReadyNotificationMutation({ action: 'revoke', expectedVersion: 1, currentVersion: 1, notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: true, currentCheckin: false })), 'GUEST_READY_CHECKIN_ORDER_CHANGED')

  const migration = fs.readFileSync(path.resolve(__dirname, '../migrations/20261004_order_guest_ready_notification.sql'), 'utf8')
  assert(migration.includes('guest_ready_notified_at timestamptz'))
  assert(migration.includes('guest_ready_notification_version integer NOT NULL DEFAULT 0'))
  assert(migration.includes('order_guest_ready_notification_events'))
  assert(migration.includes(GUEST_READY_NOTIFICATION_PERMISSION))

  const mzapp = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
  const routeStart = mzapp.indexOf("router.post('/guest-ready-notifications'")
  assert(routeStart >= 0, 'guest ready notification mutation route must exist')
  const route = mzapp.slice(routeStart, mzapp.indexOf("router.get('/daily-necessities-options'", routeStart))
  assert(route.includes(`requirePerm(GUEST_READY_NOTIFICATION_PERMISSION)`), 'route must enforce the independent permission')
  assert(route.includes('GUEST_READY_NO_CHECKIN_ORDER'), 'route must report a missing current check-in order explicitly')
  assert(route.includes('INSERT INTO order_guest_ready_notification_events'), 'every accepted operation must append an audit event')
  assert(route.includes('no_message_sent: true'), 'audit metadata must preserve the no-message side-effect contract')
  assert((route.match(/WHERE order_id_snapshot = \$1::text/g) || []).length >= 2, 'same-operation concurrency must re-check the audit receipt after acquiring the order lock')
  assert(!route.includes('emitNotificationEvent'), 'recording the marker must never send an app/SMS/email/platform notification')
}

main()
console.log('guest ready notification tests passed')
