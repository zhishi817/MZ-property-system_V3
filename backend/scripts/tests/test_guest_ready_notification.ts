import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  GUEST_READY_NOTIFICATION_PERMISSION,
  GuestReadyNotificationConflict,
  buildPriorTaskGuestReadyNotification,
  buildGuestReadyNotificationProjection,
  buildGuestReadyOutsideKeyProjection,
  buildTaskGuestReadyNotificationProjection,
  guestReadyCheckinTaskId,
  guestReadyNotificationRequirementReasons,
  guestReadyNotificationAction,
  guestReadyNotificationWorkRecordActions,
  guestReadyOutsideKeyAction,
  hasCurrentGuestReadyReadinessEvidence,
  isGuestReadyNotificationCustomerServiceRole,
  isCurrentGuestReadyNotificationBusinessDate,
  isCurrentUnlinkedGuestReadyTaskProjection,
  isGuestReadyNotificationRequirementBindingCurrent,
  isGuestReadyTaskNotificationRequirementBindingCurrent,
  isGuestReadyNotificationRequired,
  planGuestReadyNotificationMutation,
  planTaskGuestReadyNotificationMutation,
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
  const melbourneNow = new Date('2026-11-01T00:00:00.000Z')
  assert.equal(isCurrentGuestReadyNotificationBusinessDate('2026-11-01', melbourneNow), true)
  assert.equal(isCurrentGuestReadyNotificationBusinessDate('2026-10-31', melbourneNow), false, 'historical manual check-ins must be read-only')
  assert.equal(isCurrentGuestReadyNotificationBusinessDate('2026-11-02', melbourneNow), false, 'future manual check-ins must be read-only')
  assert.equal(isCurrentUnlinkedGuestReadyTaskProjection({ taskId: 'manual-checkin-1', taskDate: '2026-11-01', now: melbourneNow }), true, 'a merged turnover card remains actionable through its exact embedded check-in task id')
  assert.equal(isCurrentUnlinkedGuestReadyTaskProjection({ orderId: 'order-1', taskId: 'manual-checkin-1', taskDate: '2026-11-01', now: melbourneNow }), false, 'a later order link switches authority to the order chain')
  assert.equal(isCurrentUnlinkedGuestReadyTaskProjection({ taskId: 'manual-checkin-1', taskDate: '2026-10-31', now: melbourneNow }), false, 'a historical merged card remains read-only')
  assert.equal(isGuestReadyTaskNotificationRequirementBindingCurrent({ notifiedRequirementVersion: 2, currentRequirementVersion: 2 }), true)
  assert.equal(isGuestReadyTaskNotificationRequirementBindingCurrent({ notifiedRequirementVersion: 2, currentRequirementVersion: 3 }), false, 'link/unlink, reopen, reschedule, and property changes must invalidate a task marker')
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
  assert.equal(isGuestReadyNotificationRequirementBindingCurrent({ notifiedCheckinTaskId: 'checkin-1', notifiedRequirementVersion: 0, currentCheckinTaskId: 'checkin-1', currentRequirementVersion: 0, notifiedAt: '2026-11-01T01:00:00Z', latestLegacyAssignmentChangedAt: '2026-11-01T02:00:00Z' }), false, 'a pre-migration order marker cannot survive a later audited assignment change')
  assert.equal(isGuestReadyNotificationRequirementBindingCurrent({ notifiedCheckinTaskId: 'checkin-1', notifiedRequirementVersion: 0, currentCheckinTaskId: 'checkin-1', currentRequirementVersion: 0, notifiedAt: '2026-11-01T02:00:00Z', latestLegacyAssignmentChangedAt: '2026-11-01T02:00:00Z' }), false, 'equal timestamps fail closed because cross-table ordering is unknown')
  assert.equal(isGuestReadyNotificationRequirementBindingCurrent({ notifiedCheckinTaskId: 'checkin-1', notifiedRequirementVersion: 0, currentCheckinTaskId: 'checkin-1', currentRequirementVersion: 0, notifiedAt: '2026-11-01T03:00:00Z', latestLegacyAssignmentChangedAt: '2026-11-01T02:00:00Z' }), true, 'a fresh marker after the audited assignment change remains current')

  assert.equal(hasCurrentGuestReadyReadinessEvidence({ propertyReady: true, currentCheckinTaskKeyHandoverComplete: false }), true, 'ordinary/merged/deferred/password-only flows keep the existing ready authority')
  assert.equal(hasCurrentGuestReadyReadinessEvidence({ propertyReady: false, currentCheckinTaskKeyHandoverComplete: true }), true, 'an order-bound keys-hung check-in may use its exact current-generation handover evidence')
  assert.equal(hasCurrentGuestReadyReadinessEvidence({ propertyReady: false, currentCheckinTaskKeyHandoverComplete: false }), false, 'missing, old-generation, wrong-performer, or reopened handover evidence cannot replace ready')
  const keysHungOrderPlan = planGuestReadyNotificationMutation({
    action: 'mark',
    expectedVersion: 0,
    currentVersion: 0,
    propertyReady: hasCurrentGuestReadyReadinessEvidence({ propertyReady: false, currentCheckinTaskKeyHandoverComplete: true }),
    currentCheckin: true,
    automaticEarlyArrival: false,
    outsideKeyRequired: false,
  })
  assert.equal(keysHungOrderPlan.notificationChanged, true, 'order-bound key-only/check-in execution remains markable after exact handover even without a paired ready row')
  assert.equal(conflictCode(() => planGuestReadyNotificationMutation({
    action: 'mark',
    expectedVersion: 0,
    currentVersion: 0,
    propertyReady: hasCurrentGuestReadyReadinessEvidence({ propertyReady: false, currentCheckinTaskKeyHandoverComplete: false }),
    currentCheckin: true,
    automaticEarlyArrival: false,
    outsideKeyRequired: false,
  })), 'GUEST_READY_PROPERTY_NOT_READY', 'reopened or stale handover evidence remains rejected for an order-bound task')

  const normalCheckin = buildGuestReadyNotificationProjection({ orderId: 'order-normal', propertyReady: true, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: false, includeAllOrderBoundCheckins: true })
  assert.deepEqual(normalCheckin?.requirement_reasons, [], 'every current order-bound check-in has the manual notification marker, while special reasons remain explicit metadata')
  assert.equal(guestReadyNotificationAction(normalCheckin, true)?.id, 'record_guest_ready_notified')
  assert.equal(buildGuestReadyNotificationProjection({ orderId: 'order-normal', propertyReady: true, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: false, includeAllOrderBoundCheckins: false }), null, 'non-customer-service read-only projections keep the prior special-reason-only boundary')
  const revertedToStandard = buildGuestReadyNotificationProjection({ orderId: 'order-reverted', notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: true, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: false, notificationBindingCurrent: true, includeAllOrderBoundCheckins: true })
  assert.equal(revertedToStandard?.status, 'notified', 'a current generation marker remains visible when no special requirement reason applies')
  assert.equal(buildGuestReadyNotificationProjection({ propertyReady: true, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: false, includeAllOrderBoundCheckins: true }), null, 'manual check-ins without an order cannot use the order-bound audit marker')
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
  const manualBeforeHandover = buildTaskGuestReadyNotificationProjection({
    taskId: 'manual-checkin-1', keyHandoverComplete: false, currentUnlinkedCheckin: true,
  })
  assert.equal(manualBeforeHandover?.disabled_reason, 'key_handover_incomplete')
  assert.deepEqual(guestReadyNotificationAction(manualBeforeHandover, true), {
    id: 'record_guest_ready_notified',
    label: '已通知客人',
    placement: 'primary',
    enabled: false,
    disabled_reason: 'key_handover_incomplete',
    target: 'TaskDetail',
    intent: 'manager',
    source_type: 'cleaning_tasks',
    source_id: 'manual-checkin-1',
  })
  const manualAfterHandover = buildTaskGuestReadyNotificationProjection({
    taskId: 'manual-checkin-1', keyHandoverComplete: true, currentUnlinkedCheckin: true,
  })
  assert.equal(guestReadyNotificationAction(manualAfterHandover, true)?.enabled, true)
  assert.equal(guestReadyNotificationAction(manualAfterHandover, true)?.source_type, 'cleaning_tasks')
  const priorManualRecord = buildPriorTaskGuestReadyNotification({
    taskId: 'manual-checkin-1',
    notifiedAt: '2026-11-01T01:00:00.000Z',
    notifiedByUserId: 'cs-1',
    notifiedByName: 'Support',
    version: 1,
    lastAction: 'mark',
    lastActionAt: '2026-11-01T01:00:00.000Z',
    lastActorUserId: 'cs-1',
    lastActorName: 'Support',
  })
  const laterLinkedOrder = buildGuestReadyNotificationProjection({
    orderId: 'order-later', propertyReady: true, currentCheckin: true, automaticEarlyArrival: false,
    outsideKeyRequired: false, includeAllOrderBoundCheckins: true, priorTaskNotification: priorManualRecord,
  })
  assert.equal(laterLinkedOrder?.status, 'not_notified', 'a later order association never imports the task marker')
  assert.equal(laterLinkedOrder?.prior_task_notification?.status, 'notified', 'the pre-link task record remains explicit read-only history')
  assert.equal(guestReadyCheckinTaskId({
    source_id: 'checkout-1',
    active_source_ids: ['checkout-1', 'manual-checkin-1'],
    phase_history: [
      { source_id: 'checkout-1', task_type: 'checkout_clean' },
      { source_id: 'manual-checkin-1', task_type: 'checkin_clean' },
    ],
  }), 'manual-checkin-1')
  assert.deepEqual(guestReadyNotificationWorkRecordActions([
    guestReadyNotificationAction(normalCheckin, true),
    { id: 'register_guest_ready_outside_key', source_type: 'orders', source_id: 'order-normal' },
    { id: 'record_guest_ready_notified', source_type: 'orders', source_id: 'other-order' },
    { id: 'report_issue', source_type: 'cleaning_tasks', source_id: 'cleaning-1' },
  ], { orderId: 'order-normal', canManage: true, canViewGuestContext: true, workRecordDate: '2026-11-01', workRecordState: 'completed', now: new Date('2026-11-01T00:00:00.000Z') }).map((action) => action.id), ['record_guest_ready_notified'], 'current-day completed work records keep only the exact order-bound notification status action')
  assert.deepEqual(guestReadyNotificationWorkRecordActions([
    guestReadyNotificationAction(normalCheckin, true),
  ], { orderId: 'order-normal', canManage: true, canViewGuestContext: false, workRecordDate: '2026-11-01', workRecordState: 'completed', now: new Date('2026-11-01T00:00:00.000Z') }), [], 'read-only guest-context authorization remains mandatory')
  assert.deepEqual(guestReadyNotificationWorkRecordActions([
    guestReadyNotificationAction(normalCheckin, true),
  ], { orderId: 'order-normal', canManage: true, canViewGuestContext: true, workRecordDate: '2026-10-31', workRecordState: 'completed', now: new Date('2026-11-01T00:00:00.000Z') }), [], 'historical work records keep their prior read-only rule')
  assert.deepEqual(guestReadyNotificationWorkRecordActions([
    guestReadyNotificationAction(normalCheckin, true),
  ], { orderId: 'order-normal', canManage: true, canViewGuestContext: true, workRecordDate: '2026-11-01', workRecordState: 'pending_review', now: new Date('2026-11-01T00:00:00.000Z') }).map((action) => action.id), ['record_guest_ready_notified'], 'same-day key-handover evidence remains actionable while its honest state is pending review')
  assert.deepEqual(guestReadyNotificationWorkRecordActions([
    guestReadyNotificationAction(manualAfterHandover, true),
    { id: 'record_guest_ready_notified', source_type: 'cleaning_tasks', source_id: 'other-task' },
  ], { sourceType: 'cleaning_tasks', sourceId: 'manual-checkin-1', canManage: true, canViewGuestContext: true, workRecordDate: '2026-11-01', workRecordState: 'pending_review', now: new Date('2026-11-01T00:00:00.000Z') }).map((action) => action.source_id), ['manual-checkin-1'], 'manual check-in records retain only their exact task-bound action')
  assert.deepEqual(guestReadyNotificationWorkRecordActions([
    guestReadyNotificationAction(normalCheckin, true),
  ], { orderId: 'order-normal', canManage: true, canViewGuestContext: true, workRecordDate: '2026-11-01', workRecordState: 'reassigned', now: new Date('2026-11-01T00:00:00.000Z') }), [], 'reassigned actor history must not duplicate the notification action')
  for (const role of ['admin', 'offline_manager']) {
    assert.deepEqual(guestReadyNotificationWorkRecordActions([
      guestReadyNotificationAction(normalCheckin, true),
    ], { orderId: 'order-normal', canManage: isGuestReadyNotificationCustomerServiceRole(role), canViewGuestContext: true, workRecordDate: '2026-11-01', workRecordState: 'completed', now: new Date('2026-11-01T00:00:00.000Z') }), [], `${role} must not receive the customer-service-only completed-record action`)
  }
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
  assert.deepEqual(planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 0, propertyReady: true, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: false }), {
    changed: true,
    nextVersion: 1,
    wantsNotified: true,
    nextOutsideKeyRequired: false,
    notificationRequired: false,
    notificationChanged: true,
  }, 'standard order-bound check-ins can record the same manual notification audit marker')
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
  const cancelOutsideOnly = planGuestReadyNotificationMutation({ action: 'cancel_outside_key', expectedVersion: 2, currentVersion: 2, notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: true, currentCheckin: true, automaticEarlyArrival: false, outsideKeyRequired: true, notificationBindingCurrent: true })
  assert.deepEqual(cancelOutsideOnly, { changed: true, nextVersion: 3, wantsNotified: true, nextOutsideKeyRequired: false, notificationRequired: false, notificationChanged: false }, 'cancelling the last special reason preserves the universal current-order notification marker')
  const cancelOutsideButKeepEarly = planGuestReadyNotificationMutation({ action: 'cancel_outside_key', expectedVersion: 4, currentVersion: 4, notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: true, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: true, notificationBindingCurrent: true })
  assert.deepEqual(cancelOutsideButKeepEarly, { changed: true, nextVersion: 5, wantsNotified: true, nextOutsideKeyRequired: false, notificationRequired: true, notificationChanged: false }, 'cancelling outside-key must preserve the notification marker while automatic early-arrival remains')
  assert.equal(conflictCode(() => planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 1, propertyReady: true, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: false })), 'GUEST_READY_NOTIFICATION_CHANGED')
  assert.equal(conflictCode(() => planGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 0, propertyReady: false, currentCheckin: true, automaticEarlyArrival: true, outsideKeyRequired: false })), 'GUEST_READY_PROPERTY_NOT_READY')
  assert.equal(conflictCode(() => planGuestReadyNotificationMutation({ action: 'revoke', expectedVersion: 1, currentVersion: 1, notifiedAt: 'now', notifiedByUserId: 'cs-1', propertyReady: true, currentCheckin: false, automaticEarlyArrival: true, outsideKeyRequired: false })), 'GUEST_READY_CHECKIN_ORDER_CHANGED')
  assert.deepEqual(planTaskGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 0, keyHandoverComplete: true, currentUnlinkedCheckin: true }), {
    changed: true, wantsNotified: true, nextVersion: 1,
  })
  assert.deepEqual(planTaskGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 1, currentVersion: 1, notifiedAt: 'now', notifiedByUserId: 'cs-1', notificationBindingCurrent: true, keyHandoverComplete: true, currentUnlinkedCheckin: true }), {
    changed: false, wantsNotified: true, nextVersion: 1,
  }, 'a new mark against an already-notified task is an audited no-op')
  assert.deepEqual(planTaskGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 1, currentVersion: 1, notifiedAt: 'old', notifiedByUserId: 'cs-old', notificationBindingCurrent: false, keyHandoverComplete: true, currentUnlinkedCheckin: true }), {
    changed: true, wantsNotified: true, nextVersion: 2,
  }, 'a new generation requires a fresh task marker instead of resurrecting old state')
  assert.deepEqual(planTaskGuestReadyNotificationMutation({ action: 'revoke', expectedVersion: 1, currentVersion: 1, notifiedAt: 'now', notifiedByUserId: 'cs-1', notificationBindingCurrent: true, keyHandoverComplete: false, currentUnlinkedCheckin: true }), {
    changed: true, wantsNotified: false, nextVersion: 2,
  }, 'revoke does not depend on retaining key-handover media')
  assert.equal(conflictCode(() => planTaskGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 0, keyHandoverComplete: false, currentUnlinkedCheckin: true })), 'GUEST_READY_KEY_HANDOVER_INCOMPLETE')
  assert.equal(conflictCode(() => planTaskGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 0, keyHandoverComplete: true, currentUnlinkedCheckin: false })), 'GUEST_READY_TASK_LINKED_TO_ORDER')
  assert.equal(conflictCode(() => planTaskGuestReadyNotificationMutation({ action: 'mark', expectedVersion: 0, currentVersion: 1, keyHandoverComplete: true, currentUnlinkedCheckin: true })), 'GUEST_READY_NOTIFICATION_CHANGED')

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
  const taskNotificationMigration = fs.readFileSync(path.resolve(__dirname, '../migrations/20261101_manual_task_guest_ready_notification.sql'), 'utf8')
  assert(taskNotificationMigration.includes('cleaning_task_guest_ready_notifications'))
  assert(taskNotificationMigration.includes('cleaning_task_guest_ready_notification_events'))
  assert(taskNotificationMigration.includes('notified_requirement_version bigint'), 'task markers must bind to the current check-in requirement generation')
  assert(taskNotificationMigration.includes('OLD.assignee_id IS DISTINCT FROM NEW.assignee_id') && taskNotificationMigration.includes('OLD.cleaner_id IS DISTINCT FROM NEW.cleaner_id') && taskNotificationMigration.includes('OLD.inspector_id IS DISTINCT FROM NEW.inspector_id'), 'assignment changes must advance the monotonic task qualification generation')
  assert(taskNotificationMigration.includes('BEFORE UPDATE OF checkin_time, order_id, task_type, type, status, execution_state, task_date, date, property_id, assignee_id, cleaner_id, inspector_id'), 'the trigger must actually fire for all assignment authorities')
  assert(!taskNotificationMigration.includes('UPDATE cleaning_tasks'), 'migration must not invalidate fresh post-assignment evidence through a historical bulk generation bump')
  assert(taskNotificationMigration.includes('previous_notified_requirement_version') && taskNotificationMigration.includes('resulting_notified_requirement_version'), 'task audit events must retain both generation bindings')
  assert(taskNotificationMigration.includes('UNIQUE INDEX IF NOT EXISTS uniq_cleaning_task_guest_ready_notification_operation'))
  assert(taskNotificationMigration.includes('order_id_at_action text'), 'task audit must preserve whether an order was linked at action time')
  assert(!taskNotificationMigration.includes('UPDATE orders'), 'manual task state must never be copied into the order chain by migration')
  const sqlIntegrationHarness = fs.readFileSync(path.resolve(__dirname, './test_guest_ready_notification_sql_integration.ts'), 'utf8')
  const httpIntegrationHarness = fs.readFileSync(path.resolve(__dirname, './test_guest_ready_notification_http_integration.ts'), 'utf8')
  for (const [name, harness] of [['SQL', sqlIntegrationHarness], ['HTTP', httpIntegrationHarness]] as const) {
    assert(harness.includes("key.toLowerCase() !== 'sslmode'"), `${name} integration must reject every connection query parameter except the explicit SSL mode`)
    assert(harness.includes("['host', 'hostaddr', 'service', 'port', 'user', 'password', 'options', 'database', 'dbname']"), `${name} integration must exercise redirect and target-override guard negatives`)
    assert(harness.includes('sslModes.length > 1') && harness.includes("sslModes[0].toLowerCase() !== 'disable'"), `${name} integration must reject duplicate or non-disable SSL modes`)
  }

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
  assert((route.match(/FOR UPDATE OF t/g) || []).length >= 2, 'fresh mutations and idempotent replays must both serialize on the selected check-in generation')
  assert((route.match(/FOR SHARE OF ready_task/g) || []).length >= 2, 'fresh mutations and idempotent replays must hold the selected ready row stable until commit')
  assert(route.includes('guest_ready_notified_requirement_version'), 'a notification marker must be stored with its check-in requirement generation')
  assert(route.includes('notification_binding_current_before'), 'audit metadata must retain the prior binding decision')
  assert(route.includes('WHEN $6::boolean THEN clock_timestamp()'), 'a mark waiting on a legacy assignment transaction must timestamp after the task lock is acquired')
  assert((route.match(/other\.order_id::text <> \$3::text/g) || []).length >= 2, 'both a fresh mutation and an idempotent replay must reject a competing current check-in')
  assert(route.includes('INSERT INTO order_guest_ready_notification_events'), 'every accepted operation must append an audit event')
  assert(route.includes('no_message_sent: true'), 'audit metadata must preserve the no-message side-effect contract')
  assert((route.match(/WHERE order_id_snapshot = \$1::text/g) || []).length >= 2, 'same-operation concurrency must re-check the audit receipt after acquiring the order lock')
  assert(!route.includes('emitNotificationEvent'), 'recording the marker must never send an app/SMS/email/platform notification')
  assert(route.includes('patch: {}'), 'shared refresh events must not contain the customer-service-only projection')
  const taskRouteStart = mzapp.indexOf("router.post('/guest-ready-task-notifications'")
  assert(taskRouteStart >= 0, 'manual check-in task notification route must exist')
  const taskRoute = mzapp.slice(taskRouteStart, mzapp.indexOf("router.get('/daily-necessities-options'", taskRouteStart))
  const guestReadyTaskLibrary = fs.readFileSync(path.resolve(__dirname, '../../src/lib/guestReadyNotification.ts'), 'utf8')
  assert(taskRoute.includes('requirePerm(GUEST_READY_NOTIFICATION_PERMISSION)'), 'task route must keep the same independent permission')
  assert(taskRoute.includes('isGuestReadyNotificationCustomerServiceRole(user?.role)'), 'task route must require the active customer-service role')
  assert(taskRoute.includes('lockGuestReadyTaskNotificationContext(client, parsed.data.task_id)'), 'task mutation must acquire the task lock before reading a fresh evidence snapshot')
  assert(taskRoute.includes("taskType !== 'checkin_clean'"), 'non-check-in tasks must fail closed')
  assert(taskRoute.includes("if (orderId) throw new GuestReadyNotificationConflict('GUEST_READY_TASK_LINKED_TO_ORDER')"), 'linking an order must switch authority without copying task state')
  assert(guestReadyTaskLibrary.includes('has_current_lockbox_video') && guestReadyTaskLibrary.includes('has_current_manual_key_handover'), 'the shared locked context requires exact key-handover evidence')
  assert(guestReadyTaskLibrary.includes("?| ARRAY['keys_hung_confirmed', 'keys_hung_reopened']"), 'manual key handover must use the latest confirm/reopen generation instead of any historical confirmation')
  assert(guestReadyTaskLibrary.includes("? 'keys_hung_reopened' THEN false"), 'a later reopened generation must invalidate manual key-handover evidence')
  assert(guestReadyTaskLibrary.includes("'{arrangement_revision,after,assignee_id}'") && guestReadyTaskLibrary.includes("= COALESCE(t.assignee_id::text, '')"), 'manual handover evidence must remain bound to the current assignment generation')
  assert(guestReadyTaskLibrary.includes('lockbox_handover_actor_user_id') && guestReadyTaskLibrary.includes('manual_handover_actor_user_id'), 'media performer evidence and manager confirmation authors must remain distinct')
  assert(guestReadyTaskLibrary.includes('currentPerformerIds.includes(lockboxHandoverActorUserId)'), 'the shared locked context must reject a stale lockbox upload from a replaced performer')
  assert(guestReadyTaskLibrary.includes('!!lockboxHandoverActorUserId'), 'the shared locked context must reject unattributed legacy lockbox media')
  assert(guestReadyTaskLibrary.includes('= ANY(ARRAY[') && (guestReadyTaskLibrary.match(/ORDER BY audit\.performed_at DESC, audit\.created_at DESC/g) || []).length >= 2, 'list and mutation projections must both use the latest qualifying lockbox audit actor')
  assert(taskRoute.includes('task.key_handover_complete === true'), 'task and order mutations must consume the same computed locked-context evidence field')
  assert(guestReadyTaskLibrary.includes("audit.metadata->>'guest_ready_requirement_version'"), 'lockbox evidence must bind to the current task generation')
  assert(guestReadyTaskLibrary.includes("'{arrangement_revision,guest_ready_requirement_version}'"), 'manual key-handover evidence must bind to the current task generation')
  assert(guestReadyTaskLibrary.includes('COALESCE(t.guest_ready_checkin_requirement_version, 0) = 0'), 'only unchanged generation zero may use exact legacy handover evidence')
  assert(guestReadyTaskLibrary.includes("audit.metadata#>>'{task_snapshot,scheduled_service_date}'") && guestReadyTaskLibrary.includes("audit.metadata#>>'{property_snapshot,property_id}'"), 'legacy generation-zero media must match the current task date and property snapshots')
  assert(guestReadyTaskLibrary.includes("~ '^[0-9]{1,18}$'") && guestReadyTaskLibrary.includes('ELSE NULL'), 'malformed or oversized generation metadata must never reach an unsafe bigint cast')
  assert(guestReadyTaskLibrary.includes("NOT (audit.metadata ? 'guest_ready_requirement_version')"), 'only an actually absent legacy generation key may use the generation-zero fallback')
  assert((guestReadyTaskLibrary.match(/\? 'assignment_changed'/g) || []).length >= 6, 'list and locked mutation evidence must be newer than the latest assignment-change audit')
  assert((guestReadyTaskLibrary.match(/'-infinity'::timestamptz/g) || []).length >= 3, 'tasks without assignment-change audit must retain exact current-generation cross-table evidence')
  assert((guestReadyTaskLibrary.match(/assignment_event\.occurred_at, assignment_event\.sequence_no/g) || []).length >= 3, 'manual handover events must compare their stable event tuple to the latest assignment event')
  assert((guestReadyTaskLibrary.match(/> \(event\.occurred_at, event\.sequence_no\)/g) || []).length >= 3, 'a combined assignment and keys-hung event is valid while earlier same-time confirmations fail closed')
  assert(guestReadyTaskLibrary.includes('latest_legacy_assignment_changed_at') && guestReadyTaskLibrary.includes('notifiedAtMs > latestAssignmentChangedAtMs'), 'legacy order markers must be strictly newer than the latest unstamped assignment change')
  assert((guestReadyTaskLibrary.match(/assignment_event\.payload#>>'\{arrangement_revision,guest_ready_requirement_version\}'/g) || []).length >= 8, 'stamped future assignment events must rely on monotonic generation instead of transaction timestamps')
  assert((mzapp.match(/latestLegacyAssignmentChangedAt:/g) || []).length >= 4, 'Mobile list, fresh mutation, projection and idempotent replay must all apply the legacy order-marker assignment boundary')
  assert(taskRoute.includes('notified_requirement_version'), 'task marker persistence must store and compare its requirement generation')
  assert(guestReadyTaskLibrary.includes('FOR UPDATE OF t') && guestReadyTaskLibrary.includes('fresh snapshot'), 'task mutation must serialize on the task row before the evidence statement obtains a fresh snapshot')
  assert(taskRoute.includes('INSERT INTO cleaning_task_guest_ready_notification_events'), 'every accepted task operation must append an audit event')
  assert(taskRoute.includes("association_state: 'manual_unlinked'"))
  assert(taskRoute.includes('no_message_sent: true'))
  assert(!taskRoute.includes('UPDATE orders'), 'task mutation must not dual-write the order marker')
  assert(!taskRoute.includes('emitNotificationEvent'), 'task marker must not send a real notification')
  assert(mzapp.includes('const guestReadyStatesByTask = canViewGuestReadyNotification'), 'task-level notification history must be loaded only for the active customer-service role')
  assert(mzapp.includes('const priorTaskNotification = canViewGuestReadyNotification && orderIdCheckin && guestReadyTaskState'), 'linked-before task history must never enter legacy non-customer-service special projections')
  assert(mzapp.includes('currentCheckinTaskKeyHandoverComplete: guestReadyTaskState?.key_handover_complete === true'), 'Mobile order projections must accept only the exact current task generation handover as readiness evidence')
  assert((mzapp.match(/currentCheckinTaskState = await lockGuestReadyTaskNotificationContext\(client, checkinTask\.task_id\)/g) || []).length >= 2, 'order mutation and idempotent replay must both lock and re-read current task handover evidence')
  const orderRouteStart = mzapp.indexOf("router.post('/guest-ready-notifications'")
  const orderRoute = mzapp.slice(orderRouteStart, taskRouteStart)
  const receiptStart = orderRoute.indexOf('const receiptFromEvent')
  const receiptEnd = orderRoute.indexOf("try {", receiptStart)
  const receiptSource = orderRoute.slice(receiptStart, receiptEnd)
  assert(receiptSource.includes('FOR UPDATE OF t'), 'concurrent existing-operation replays must serialize on the current check-in without SHARE-to-UPDATE lock upgrades')
  assert(!receiptSource.includes('FOR SHARE OF t'), 'the replay path must not retain a compatible task lock before requesting the exclusive evidence lock')

  const guestReadyLibrary = fs.readFileSync(path.resolve(__dirname, '../../src/lib/guestReadyNotification.ts'), 'utf8')
  assert(guestReadyLibrary.includes('other.order_id::text <> o.id::text'), 'list/Web reads must fail closed on a same-property/date check-in from another order')
  assert(guestReadyLibrary.includes('COALESCE(competing_checkin.candidate_count, 0)'), 'the shared projection loader must count cross-order check-in competitors')
  assert(guestReadyLibrary.includes('has_current_lockbox_handover') && guestReadyLibrary.includes('has_current_manual_handover'), 'list projections must use the same generation-bound handover evidence')
  const cleaningSync = fs.readFileSync(path.resolve(__dirname, '../../src/services/cleaningSync.ts'), 'utf8')
  assert((cleaningSync.match(/emitGuestReadyCheckinAuthorityEvent\(/g) || []).length >= 4, 'check-in sync create/update/cancel paths must publish an authority invalidation event')
  assert(cleaningSync.includes("'order_id_checkin'"), 'sync invalidation must force a full current-check-in projection refresh')
  assert(cleaningSync.includes('patch: {}'), 'sync invalidation events must not leak role-scoped guest-ready state')
  assert(cleaningSync.includes('pgRunInTransaction((client) => syncOrderToCleaningTasks'), 'retry/backfill sync must commit the task change and authority event atomically')
  assert(cleaningSync.includes('Persist the failure') && cleaningSync.includes("action: 'failed'"), 'a rolled-back sync must persist failure audit on an independent connection')
  assert(cleaningSync.includes('if (guestReadyIdentityChangedFields.length) {'), 'manual-placeholder inheritance must not swallow a check-in qualification invalidation failure')

  const taskCenter = fs.readFileSync(path.resolve(__dirname, '../../src/modules/task_center.ts'), 'utf8')
  assert(taskCenter.includes('latestLegacyAssignmentChangedAt: state?.latest_legacy_assignment_changed_at'), 'Web projection must apply the same legacy order-marker assignment boundary')
  assert(taskCenter.includes('buildGuestReadyOutsideKeyProjection'), 'Web task center must expose the explicit outside-key state')
  assert(taskCenter.includes('guestReadyOutsideKeyAction'), 'Web task center must expose register/cancel actions')
  assert(taskCenter.includes('includeAllOrderBoundCheckins: true'), 'customer-service Web task center must expose ordinary order-bound check-ins without widening the shared read-only projection default')
  assert(taskCenter.includes('isCurrentUnlinkedGuestReadyTaskProjection'), 'historical/future and later-linked task-center rows must fail closed without excluding merged turnover cards')
  assert(taskCenter.includes('taskState?.key_handover_complete === true'), 'Web actions must use generation-bound handover evidence rather than terminal status alone')
  assert(taskCenter.includes('currentCheckinTaskKeyHandoverComplete: taskState?.key_handover_complete === true'), 'Web order projections must use the exact current check-in handover as equivalent readiness evidence')
  const webPage = fs.readFileSync(path.resolve(__dirname, '../../../frontend/src/app/task-center/page.tsx'), 'utf8')
  assert(webPage.includes("viewerRole !== 'customer_service'"), 'Web mutation handler must enforce the current active customer-service role')
  assert(webPage.includes("action.id === 'register_guest_ready_outside_key'"))
  assert(webPage.includes("action.id === 'cancel_guest_ready_outside_key'"))
}

main()
console.log('guest ready notification tests passed')
