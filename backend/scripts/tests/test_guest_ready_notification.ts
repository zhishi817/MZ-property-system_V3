import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  GUEST_READY_NOTIFICATION_PERMISSION,
  GuestReadyNotificationConflict,
  buildGuestReadyNotificationProjection,
  buildGuestReadyOutsideKeyProjection,
  guestReadyNotificationRequirementReasons,
  guestReadyNotificationAction,
  guestReadyOutsideKeyAction,
  isGuestReadyNotificationCustomerServiceRole,
  isGuestReadyNotificationRequirementBindingCurrent,
  isGuestReadyNotificationRequired,
  planGuestReadyNotificationMutation,
} from '../../src/lib/guestReadyNotification'
import { buildCleaningTurnoverDisplay } from '../../src/lib/cleaningTurnoverDisplay'

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
  assert.equal(isGuestReadyNotificationCustomerServiceRole('customer_service'), true)
  assert.equal(isGuestReadyNotificationCustomerServiceRole('admin'), false)
  const earlyDisplay = buildCleaningTurnoverDisplay({ checkinTask: { task_type: 'checkin_clean', checkin_time: '2:30pm' } })
  const standardDisplay = buildCleaningTurnoverDisplay({ checkinTask: { task_type: 'checkin_clean', checkin_time: '3pm' } })
  const lateDisplay = buildCleaningTurnoverDisplay({ checkinTask: { task_type: 'checkin_clean', checkin_time: '4pm' } })
  assert.equal(earlyDisplay.is_early_checkin, true, 'the canonical pre-15:00 rule qualifies automatically')
  assert.equal(standardDisplay.is_early_checkin, false)
  assert.equal(lateDisplay.is_early_checkin, false, 'a later time must never become an automatic special-notification case')
  assert.deepEqual(guestReadyNotificationRequirementReasons({ earlyArrival: true, outsideKey: false }), ['early_arrival'])
  assert.deepEqual(guestReadyNotificationRequirementReasons({ earlyArrival: false, outsideKey: true }), ['outside_key'])
  assert.deepEqual(guestReadyNotificationRequirementReasons({ earlyArrival: true, outsideKey: true }), ['early_arrival', 'outside_key'])
  assert.equal(isGuestReadyNotificationRequired({ earlyArrival: earlyDisplay.is_early_checkin, outsideKey: false }), true)
  assert.equal(isGuestReadyNotificationRequired({ earlyArrival: standardDisplay.is_early_checkin, outsideKey: false }), false)
  assert.equal(isGuestReadyNotificationRequired({ earlyArrival: standardDisplay.is_early_checkin, outsideKey: true }), true)
  assert.equal(isGuestReadyNotificationRequirementBindingCurrent({ notifiedCheckinTaskId: 'checkin-1', notifiedRequirementVersion: 2, currentCheckinTaskId: 'checkin-1', currentRequirementVersion: 2 }), true)
  assert.equal(isGuestReadyNotificationRequirementBindingCurrent({ notifiedCheckinTaskId: 'checkin-1', notifiedRequirementVersion: 2, currentCheckinTaskId: 'checkin-1', currentRequirementVersion: 4 }), false, 'a later check-in qualification generation invalidates the old marker')
  assert.equal(isGuestReadyNotificationRequirementBindingCurrent({ notifiedCheckinTaskId: 'checkin-old', notifiedRequirementVersion: 2, currentCheckinTaskId: 'checkin-new', currentRequirementVersion: 2 }), false, 'a replacement check-in task never inherits the old marker')

  const normalCheckin = buildGuestReadyNotificationProjection({ orderId: 'order-normal', propertyReady: true, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: false })
  assert.equal(normalCheckin, null, 'standard and late check-ins have no notification label or action')
  const revertedToStandard = buildGuestReadyNotificationProjection({ orderId: 'order-reverted', notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: true, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: false })
  assert.equal(revertedToStandard, null, 'changing an early check-in back to the standard time hides the projection even if an old marker exists')
  const outsideKeyAtStandardTime = buildGuestReadyNotificationProjection({ orderId: 'order-outside', propertyReady: true, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: true })
  assert.deepEqual(outsideKeyAtStandardTime?.requirement_reasons, ['outside_key'])
  const bothConditions = buildGuestReadyNotificationProjection({ orderId: 'order-both', propertyReady: true, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: true })
  assert.deepEqual(bothConditions?.requirement_reasons, ['early_arrival', 'outside_key'])

  const outsideKeyRegistration = buildGuestReadyOutsideKeyProjection({ orderId: 'order-1', required: false, version: 0, currentCheckin: true })
  assert.equal(guestReadyOutsideKeyAction(outsideKeyRegistration, true)?.id, 'register_guest_ready_outside_key')
  const registeredOutsideKey = buildGuestReadyOutsideKeyProjection({ orderId: 'order-1', required: true, registeredAt: 'now', registeredByUserId: 'cs-1', version: 1, currentCheckin: true })
  assert.equal(guestReadyOutsideKeyAction(registeredOutsideKey, true)?.id, 'cancel_guest_ready_outside_key')
  assert.equal(guestReadyOutsideKeyAction(registeredOutsideKey, false), null)

  const notReady = buildGuestReadyNotificationProjection({ orderId: 'order-1', propertyReady: false, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: false })
  assert.equal(notReady?.status, 'not_notified')
  assert.equal(notReady?.disabled_reason, 'property_not_ready')
  assert.equal(guestReadyNotificationAction(notReady, true)?.enabled, false)
  assert.equal(guestReadyNotificationAction(notReady, false), null, 'permission is independent and server authoritative')

  const ready = buildGuestReadyNotificationProjection({ orderId: 'order-1', propertyReady: true, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: false })
  assert.equal(guestReadyNotificationAction(ready, true)?.id, 'record_guest_ready_notified')
  const notified = buildGuestReadyNotificationProjection({
    orderId: 'order-1',
    notifiedAt: '2026-10-04T01:02:03.000Z',
    notifiedByUserId: 'cs-1',
    notifiedByName: '客服 A',
    version: 2,
    propertyReady: false,
    currentCheckin: true,
    automaticEarlyArrival: true,
    outsideKeyRequired: false,
    notificationBindingCurrent: true,
  })
  assert.equal(notified?.eligible, true, 'a mistaken marker can be revoked even after readiness changes')
  assert.equal(guestReadyNotificationAction(notified, true)?.id, 'revoke_guest_ready_notified')
  const reactivatedEarlyArrival = buildGuestReadyNotificationProjection({
    orderId: 'order-1',
    notifiedAt: '2026-10-04T01:02:03.000Z',
    notifiedByUserId: 'cs-1',
    propertyReady: true,
    currentCheckin: true,
    automaticEarlyArrival: true,
    outsideKeyRequired: false,
    notificationBindingCurrent: false,
  })
  assert.equal(reactivatedEarlyArrival?.status, 'not_notified', 'early → standard → early must require a new notification confirmation')
  assert.equal(guestReadyNotificationAction(reactivatedEarlyArrival, true)?.id, 'record_guest_ready_notified')
  const outsideKeySurvivesTimeGeneration = buildGuestReadyNotificationProjection({
    orderId: 'order-1',
    notifiedAt: '2026-10-04T01:02:03.000Z',
    notifiedByUserId: 'cs-1',
    propertyReady: true,
    currentCheckin: true,
    automaticEarlyArrival: false,
    outsideKeyRequired: true,
    notificationBindingCurrent: false,
  })
  assert.deepEqual(outsideKeySurvivesTimeGeneration?.requirement_reasons, ['outside_key'], 'the outside-key requirement remains active across a check-in time change')
  assert.equal(outsideKeySurvivesTimeGeneration?.status, 'not_notified', 'the surviving requirement still needs confirmation for the new check-in generation')
  const replacementOrder = buildGuestReadyNotificationProjection({ orderId: 'order-2', propertyReady: true, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: false })
  assert.equal(replacementOrder?.status, 'not_notified', 'a new check-in order never inherits the prior order marker')
  assert.equal(replacementOrder?.version, 0)

  assert.deepEqual(planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 0, propertyReady: true, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: false }), {
    changed: true,
    nextVersion: 1,
    wantsNotified: true,
    nextOutsideKeyRequired: false,
    notificationRequired: true,
    notificationChanged: true,
  })
  assert.deepEqual(planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 1, currentVersion: 1, notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: true, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: false, notificationBindingCurrent: true }), {
    changed: false,
    nextVersion: 1,
    wantsNotified: true,
    nextOutsideKeyRequired: false,
    notificationRequired: true,
    notificationChanged: false,
  }, 'a new idempotent operation against the same state is a no-op')
  assert.deepEqual(planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 1, currentVersion: 1, notifiedAt: 'old', notifiedByUserId: 'cs-old', propertyReady: true, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: false, notificationBindingCurrent: false }), {
    changed: true,
    nextVersion: 2,
    wantsNotified: true,
    nextOutsideKeyRequired: false,
    notificationRequired: true,
    notificationChanged: true,
  }, 'marking a reactivated early-arrival requirement overwrites the stale binding instead of reviving it')
  assert.deepEqual(planGuestReadyNotificationMutation({ action: 'revoke', expectedVersion: 2, currentVersion: 2, notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: false, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: false }), {
    changed: true,
    nextVersion: 3,
    wantsNotified: false,
    nextOutsideKeyRequired: false,
    notificationRequired: false,
    notificationChanged: true,
  }, 'revoke remains auditable even if the property later stops being ready')
  const registerOutside = planGuestReadyNotificationMutation({ action: 'register_outside_key', expectedVersion: 0, currentVersion: 0, propertyReady: false, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: false })
  assert.deepEqual(registerOutside, { changed: true, nextVersion: 1, wantsNotified: false, nextOutsideKeyRequired: true, notificationRequired: true, notificationChanged: false })
  const registerOutsideAfterHiddenEarlyMarker = planGuestReadyNotificationMutation({ action: 'register_outside_key', expectedVersion: 3, currentVersion: 3, notifiedAt: 'old', notifiedByUserId: 'cs-old', propertyReady: true, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: false })
  assert.deepEqual(registerOutsideAfterHiddenEarlyMarker, { changed: true, nextVersion: 4, wantsNotified: false, nextOutsideKeyRequired: true, notificationRequired: true, notificationChanged: true }, 'a newly registered condition must not resurrect a marker from an earlier inactive condition')
  const cancelOutsideOnly = planGuestReadyNotificationMutation({ action: 'cancel_outside_key', expectedVersion: 2, currentVersion: 2, notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: true, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: true })
  assert.deepEqual(cancelOutsideOnly, { changed: true, nextVersion: 3, wantsNotified: false, nextOutsideKeyRequired: false, notificationRequired: false, notificationChanged: true }, 'cancelling the last condition clears the current marker without deleting its audit event')
  const cancelOutsideButKeepEarly = planGuestReadyNotificationMutation({ action: 'cancel_outside_key', expectedVersion: 4, currentVersion: 4, notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: true, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: true, notificationBindingCurrent: true })
  assert.deepEqual(cancelOutsideButKeepEarly, { changed: true, nextVersion: 5, wantsNotified: true, nextOutsideKeyRequired: false, notificationRequired: true, notificationChanged: false }, 'cancelling outside-key must preserve the notification marker while automatic early-arrival remains')
  assert.equal(conflictCode(() => planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 1, propertyReady: true, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: false })), 'GUEST_READY_NOTIFICATION_CHANGED')
  assert.equal(conflictCode(() => planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 0, propertyReady: true, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: false })), 'GUEST_READY_NOTIFICATION_NOT_REQUIRED')
  assert.equal(conflictCode(() => planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 0, propertyReady: false, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: false })), 'GUEST_READY_PROPERTY_NOT_READY')
  assert.equal(conflictCode(() => planGuestReadyNotificationMutation({ action: 'revoke', expectedVersion: 1, currentVersion: 1, notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: true, currentCheckin: false, automaticEarlyArrival: true, outsideKeyRequired: false })), 'GUEST_READY_CHECKIN_ORDER_CHANGED')

  const migration = fs.readFileSync(path.resolve(__dirname, '../migrations/20261004_order_guest_ready_notification.sql'), 'utf8')
  assert(migration.includes('guest_ready_notified_at timestamptz'))
  assert(migration.includes('guest_ready_notification_version integer NOT NULL DEFAULT 0'))
  assert(migration.includes('order_guest_ready_notification_events'))
  assert(migration.includes(GUEST_READY_NOTIFICATION_PERMISSION))
  const outsideKeyMigration = fs.readFileSync(path.resolve(__dirname, '../migrations/20261011_order_guest_ready_outside_key.sql'), 'utf8')
  assert(outsideKeyMigration.includes('guest_ready_outside_key_required boolean NOT NULL DEFAULT false'))
  assert(outsideKeyMigration.includes('guest_ready_checkin_requirement_version bigint NOT NULL DEFAULT 0'))
  assert(outsideKeyMigration.includes('guest_ready_notified_checkin_task_id text'))
  assert(outsideKeyMigration.includes('guest_ready_notified_requirement_version bigint'))
  assert(outsideKeyMigration.includes('guest_ready_notified_checkin_task_id IS NULL\n          OR guest_ready_notified_at IS NOT NULL'), 'a notification binding may exist only with a physical notification marker')
  assert(outsideKeyMigration.includes('trg_guest_ready_checkin_requirement_version'))
  assert(outsideKeyMigration.includes('BEFORE UPDATE OF checkin_time, order_id, task_type, type, status, execution_state, task_date, date, property_id'), 'one database trigger must cover every application write path that can change the current check-in requirement identity')
  assert(outsideKeyMigration.includes("'register_outside_key', 'cancel_outside_key'"))
  assert(!outsideKeyMigration.includes('UPDATE orders'), 'the migration must not infer or backfill historical free text')

  const mzapp = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
  const routeStart = mzapp.indexOf("router.post('/guest-ready-notifications'")
  assert(routeStart >= 0, 'guest ready notification mutation route must exist')
  const route = mzapp.slice(routeStart, mzapp.indexOf("router.get('/daily-necessities-options'", routeStart))
  assert(route.includes(`requirePerm(GUEST_READY_NOTIFICATION_PERMISSION)`), 'route must enforce the independent permission')
  assert(route.includes('isGuestReadyNotificationCustomerServiceRole(user?.role)'), 'route must require the current customer-service role')
  assert(route.includes('GUEST_READY_NO_CHECKIN_ORDER'), 'route must report a missing current check-in order explicitly')
  assert(route.includes('t.checkin_time'), 'route must use the canonical check-in time for the early-arrival rule')
  assert(route.includes('buildCleaningTurnoverDisplay'), 'route must reuse the canonical pre-15:00 calculation')
  assert(!route.includes('guest_special_request'), 'free text must not become an implicit eligibility parser')
  assert(mzapp.includes("z.enum(['mark', 'revoke', 'register_outside_key', 'cancel_outside_key'])"), 'the route schema must expose only the approved explicit outside-key registration actions')
  assert(route.includes('guest_ready_outside_key_required'), 'outside-key state must be stored as an explicit order fact')
  assert(route.includes('currentOrderResult'), 'idempotent replay must rebuild the current projection instead of replaying stale eligibility metadata')
  assert(route.includes('FOR UPDATE OF t'), 'a mutation must lock the selected check-in generation before binding the marker')
  assert(route.includes('FOR SHARE OF t'), 'an idempotent replay must not mix a receipt with a concurrently changed check-in generation')
  assert(route.includes('guest_ready_notified_requirement_version'), 'a notification marker must be stored with its check-in requirement generation')
  assert(route.includes('notification_binding_current_before'), 'audit metadata must retain the prior binding decision')
  assert((route.match(/other\.order_id::text <> \$3::text/g) || []).length >= 2, 'both a fresh mutation and an idempotent replay must reject a competing current check-in')
  assert(route.includes('INSERT INTO order_guest_ready_notification_events'), 'every accepted operation must append an audit event')
  assert(route.includes('no_message_sent: true'), 'audit metadata must preserve the no-message side-effect contract')
  assert((route.match(/WHERE order_id_snapshot = \$1::text/g) || []).length >= 2, 'same-operation concurrency must re-check the audit receipt after acquiring the order lock')
  assert(!route.includes('emitNotificationEvent'), 'recording the marker must never send an app/SMS/email/platform notification')
  assert(route.includes('patch: {}'), 'shared refresh events must not contain the customer-service-only projection')

  const guestReadyLibrary = fs.readFileSync(path.resolve(__dirname, '../../src/lib/guestReadyNotification.ts'), 'utf8')
  assert(guestReadyLibrary.includes('other.order_id::text <> o.id::text'), 'list/Web reads must fail closed on a same-property/date check-in from another order')
  assert(guestReadyLibrary.includes('COALESCE(competing_checkin.candidate_count, 0)'), 'the shared projection loader must count cross-order check-in competitors')
  const cleaningSync = fs.readFileSync(path.resolve(__dirname, '../../src/services/cleaningSync.ts'), 'utf8')
  assert((cleaningSync.match(/emitGuestReadyCheckinAuthorityEvent\(/g) || []).length >= 4, 'check-in sync create/update/cancel paths must publish an authority invalidation event')
  assert(cleaningSync.includes("'order_id_checkin'"), 'sync invalidation must force a full current-check-in projection refresh')
  assert(cleaningSync.includes('patch: {}'), 'sync invalidation events must not leak role-scoped guest-ready state')
  assert(cleaningSync.includes('pgRunInTransaction((client) => syncOrderToCleaningTasks'), 'retry/backfill sync must commit the task change and authority event atomically')
  assert(cleaningSync.includes('Persist the failure') && cleaningSync.includes("action: 'failed'"), 'a rolled-back sync must persist failure audit on an independent connection')
  assert(cleaningSync.includes('if (guestReadyIdentityChangedFields.length) {'), 'manual-placeholder inheritance must not swallow a check-in qualification invalidation failure')

  const taskCenter = fs.readFileSync(path.resolve(__dirname, '../../src/modules/task_center.ts'), 'utf8')
  assert(taskCenter.includes('buildGuestReadyOutsideKeyProjection'), 'Web task center must expose the explicit outside-key state')
  assert(taskCenter.includes('guestReadyOutsideKeyAction'), 'Web task center must expose register/cancel actions')
  const webPage = fs.readFileSync(path.resolve(__dirname, '../../../frontend/src/app/task-center/page.tsx'), 'utf8')
  assert(webPage.includes("viewerRole !== 'customer_service'"), 'Web mutation handler must enforce the current active customer-service role')
  assert(webPage.includes("action.id === 'register_guest_ready_outside_key'"))
  assert(webPage.includes("action.id === 'cancel_guest_ready_outside_key'"))
}

main()
console.log('guest ready notification tests passed')
