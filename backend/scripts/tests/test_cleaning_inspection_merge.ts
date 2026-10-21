import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import {
  canonicalCleaningTurnoverPairs,
  canonicalKeyHandoverSourceIds,
  canonicalKeyHandoverSourceIdsForProjection,
  cleaningTaskBusinessIdentity,
  deferredProjectionDate,
  isCheckinKeyHandoverTask,
  isInspectionModeAllowedForTask,
  keyPhotoConfirmsCurrentTaskProgress,
  lockboxVideoConfirmsCurrentTaskState,
  mergeCleaningKeyHandoverProjections,
  mergeInspectionPlan,
  mergeTurnoverTaskPlan,
  mobileInspectionProjectionDate,
  normalizeTurnoverInspectionScope,
  projectCleaningKeyHandover,
  resolveBoardInspectionDueDate,
  sanitizeInspectionModeForTask,
  unlinkedDeferredInspectionMergeKey,
  withInspectionMergeIsolation,
} from '../../src/lib/cleaningInspection'

function testKeyHandoverFactStaysSeparateFromWorkflowFinalization() {
  assert.deepEqual(projectCleaningKeyHandover({
    taskId: 'mq2212-checkout',
    status: 'in_progress',
    executionState: 'active',
    lockboxVideoUrl: 'https://example.invalid/mq2212-lockbox.mp4',
    latestUploadAudit: {
      performed_as_action: 'upload_access_video',
      performed_at: '2026-10-20T02:32:15.623Z',
      status_before: 'in_progress',
      status_after: 'in_progress',
      metadata: {
        finalization_pending: true,
        missing_requirements: ['cleaning_consumables', 'cleaning_property_photo'],
      },
    },
  }), {
    state: 'completed',
    source_task_id: 'mq2212-checkout',
    completed_at: '2026-10-20T02:32:15.623Z',
    confirmation_source: 'video',
    media_evidence_present: true,
    workflow_finalization_pending: true,
    missing_requirements: ['cleaning_consumables', 'cleaning_property_photo'],
  })
}

function testKeyHandoverSurvivesOrdinaryWorkflowChanges() {
  const latestUploadAudit = {
    performed_as_action: 'upload_access_video',
    performed_at: '2026-10-21T02:21:00.000Z',
    status_before: 'in_progress',
    status_after: 'in_progress',
    metadata: { finalization_pending: true, missing_requirements: ['inspection_photos'] },
  }
  for (const status of ['assigned', 'in_progress', 'to_inspect', 'cleaned', 'restock_pending', 'restocked']) {
    assert.deepEqual(projectCleaningKeyHandover({
      taskId: `task-${status}`,
      status,
      executionState: 'active',
      lockboxVideoUrl: 'recorded',
      latestUploadAudit,
    }), {
      state: 'completed',
      source_task_id: `task-${status}`,
      completed_at: '2026-10-21T02:21:00.000Z',
      confirmation_source: 'video',
      media_evidence_present: true,
      workflow_finalization_pending: true,
      missing_requirements: ['inspection_photos'],
    })
  }
  assert.equal(projectCleaningKeyHandover({
    taskId: 'cancelled-cleaned',
    status: 'cleaned',
    executionState: 'cancelled',
    lockboxVideoUrl: 'recorded',
    latestUploadAudit,
  }), null)
}

function testManualKeysHungIsVisibleWithoutPretendingVideoEvidenceExists() {
  assert.deepEqual(projectCleaningKeyHandover({
    taskId: 'mq2913-checkin',
    status: 'keys_hung',
    executionState: 'active',
    lockboxVideoUrl: '',
    manualConfirmedAt: '2026-10-21T01:29:00.000Z',
  }), {
    state: 'completed',
    source_task_id: 'mq2913-checkin',
    completed_at: '2026-10-21T01:29:00.000Z',
    confirmation_source: 'manual',
    media_evidence_present: false,
    workflow_finalization_pending: false,
    missing_requirements: [],
  })
  assert.equal(projectCleaningKeyHandover({
    taskId: 'reopened-mq2913',
    status: 'assigned',
    executionState: 'active',
    lockboxVideoUrl: '',
    manualConfirmedAt: '2026-10-21T01:29:00.000Z',
  }), null)
  assert.deepEqual(projectCleaningKeyHandover({
    taskId: 'mq2913-video-and-manual',
    status: 'keys_hung',
    executionState: 'active',
    lockboxVideoUrl: 'recorded',
    latestUploadAudit: {
      performed_as_action: 'upload_access_video',
      performed_at: '2026-10-20T01:00:00.000Z',
    },
    manualConfirmedAt: '2026-10-21T01:29:00.000Z',
  }), {
    state: 'completed',
    source_task_id: 'mq2913-video-and-manual',
    completed_at: '2026-10-20T01:00:00.000Z',
    confirmation_source: 'video',
    media_evidence_present: true,
    workflow_finalization_pending: false,
    missing_requirements: [],
  }, 'the exact task video remains the primary fact when a manual confirmation also exists')
}

function testKeyHandoverFactRequiresExactCurrentTaskMediaOrManualConfirmation() {
  const audit = {
    performed_as_action: 'upload_access_video',
    performed_at: '2026-10-20T02:32:15.623Z',
    status_before: 'in_progress',
    status_after: 'in_progress',
    metadata: { finalization_pending: true, missing_requirements: ['cleaning_consumables'] },
  }
  assert.deepEqual(projectCleaningKeyHandover({
    taskId: 'reopened-assigned',
    status: 'assigned',
    executionState: 'active',
    lockboxVideoUrl: 'recorded',
    latestUploadAudit: audit,
  }), {
    state: 'completed',
    source_task_id: 'reopened-assigned',
    completed_at: '2026-10-20T02:32:15.623Z',
    confirmation_source: 'video',
    media_evidence_present: true,
    workflow_finalization_pending: true,
    missing_requirements: ['cleaning_consumables'],
  })
  assert.equal(projectCleaningKeyHandover({
    taskId: 'cancelled-task',
    status: 'cancelled',
    executionState: 'cancelled',
    lockboxVideoUrl: 'https://example.invalid/cancelled.mp4',
    latestUploadAudit: audit,
  }), null)
  assert.equal(projectCleaningKeyHandover({
    taskId: 'deleted-video',
    status: 'in_progress',
    executionState: 'active',
    lockboxVideoUrl: '',
    latestUploadAudit: audit,
  }), null)
  assert.deepEqual(projectCleaningKeyHandover({
    taskId: 'url-only',
    status: 'in_progress',
    executionState: 'active',
    lockboxVideoUrl: 'recorded',
    latestUploadAudit: null,
  }), {
    state: 'completed',
    source_task_id: 'url-only',
    completed_at: null,
    confirmation_source: 'video',
    media_evidence_present: true,
    workflow_finalization_pending: false,
    missing_requirements: [],
  })
}

function testKeyHandoverMergeRequiresCanonicalSourceMembership() {
  const fact = {
    state: 'completed' as const,
    source_task_id: 'checkout-1',
    completed_at: '2026-10-20T02:32:15.623Z',
    confirmation_source: 'video' as const,
    media_evidence_present: true,
    workflow_finalization_pending: true,
    missing_requirements: ['cleaning_consumables'],
  }
  assert.equal(mergeCleaningKeyHandoverProjections([{ key_handover: fact }], []), null)
  assert.equal(mergeCleaningKeyHandoverProjections([{ key_handover: fact }], ['unrelated-task']), null)
  assert.deepEqual(mergeCleaningKeyHandoverProjections([{ key_handover: fact }], ['checkout-1']), fact)
  assert.deepEqual(
    mergeCleaningKeyHandoverProjections([{ key_handover: fact }, { key_handover: null }], ['checkout-1', 'checkin-1']),
    fact,
  )
  const laterManualFact = {
    state: 'completed' as const,
    source_task_id: 'checkin-1',
    completed_at: '2026-10-21T03:00:00.000Z',
    confirmation_source: 'manual' as const,
    media_evidence_present: false,
    workflow_finalization_pending: false,
    missing_requirements: [] as string[],
  }
  assert.deepEqual(
    mergeCleaningKeyHandoverProjections(
      [{ key_handover: fact }, { key_handover: laterManualFact }],
      ['checkout-1', 'checkin-1'],
    ),
    fact,
    'a canonical turnover keeps its exact video fact primary even when the paired source has a later manual confirmation',
  )
}

function testManagerProjectionKeepsCanonicalHandoverForVisiblePhaseSubset() {
  const relationRows = [
    {
      __raw_id: 'checkout-1', task_type: 'checkout_clean', property_id: 'property-1', task_date: '2026-10-21',
      order_id: 'outgoing-order', order_checkout: '2026-10-21', status: 'restock_pending', execution_state: 'active',
    },
    {
      __raw_id: 'checkin-1', task_type: 'checkin_clean', property_id: 'property-1', task_date: '2026-10-21',
      order_id: 'incoming-order', order_checkin: '2026-10-21', status: 'assigned', execution_state: 'active',
    },
  ]
  assert.deepEqual(
    canonicalKeyHandoverSourceIdsForProjection(relationRows, ['checkout-1']),
    ['checkout-1', 'checkin-1'],
    'a suppressed paired phase must not erase an exact-task video from the visible turnover projection',
  )
  assert.deepEqual(
    canonicalKeyHandoverSourceIdsForProjection(relationRows, ['checkout-1', 'checkin-1']),
    ['checkout-1', 'checkin-1'],
  )
  assert.deepEqual(
    canonicalKeyHandoverSourceIdsForProjection(relationRows, ['checkout-1', 'independent-task']),
    [],
    'an unrelated active source must fail closed instead of borrowing turnover evidence',
  )
  assert.deepEqual(
    canonicalKeyHandoverSourceIdsForProjection([relationRows[0]], ['checkout-1']),
    ['checkout-1'],
    'a standalone exact-source projection keeps only its own evidence boundary',
  )
}

function testCanonicalTurnoverBusinessIdentityRejectsCancelledOrAmbiguousCandidates() {
  const checkout = {
    id: 'checkout-1', task_type: 'checkout_clean', property_id: 'property-1', task_date: '2026-10-21',
    order_id: 'outgoing-order', order_checkout: '2026-10-21', status: 'cleaned', execution_state: 'active',
  }
  const checkin = {
    id: 'checkin-1', task_type: 'checkin_clean', property_id: 'property-1', task_date: '2026-10-21',
    order_id: 'incoming-order', order_checkin: '2026-10-21', status: 'assigned', execution_state: 'active',
  }
  const canonicalPairs = canonicalCleaningTurnoverPairs([checkout, checkin])
  assert.deepEqual(canonicalPairs.map((pair) => ({
    source_ids: pair.source_ids,
    business_identity: pair.business_identity,
  })), [{
    source_ids: ['checkout-1', 'checkin-1'],
    business_identity: 'turnover:outgoing-order:incoming-order',
  }])
  const identityBySource = new Map<string, string>()
  for (const pair of canonicalPairs) {
    for (const sourceId of pair.source_ids) identityBySource.set(sourceId, pair.business_identity)
  }
  assert.equal(identityBySource.get('checkout-1'), 'turnover:outgoing-order:incoming-order')
  assert.equal(identityBySource.get('checkin-1'), 'turnover:outgoing-order:incoming-order')
  assert.deepEqual(canonicalCleaningTurnoverPairs([
    { ...checkout, id: 'cancelled-checkout', status: 'cancelled', execution_state: 'cancelled' },
    checkin,
  ]), [])
  assert.deepEqual(canonicalCleaningTurnoverPairs([
    checkout,
    checkin,
    { ...checkin, id: 'another-checkin', order_id: 'another-order' },
  ]), [], 'an ambiguous source is never paired using property/date alone')
  assert.equal(cleaningTaskBusinessIdentity({
    checkoutOrderId: 'outgoing-order',
    checkinOrderId: 'incoming-order',
    sourceId: 'checkout-1',
  }), 'turnover:outgoing-order:incoming-order')
  assert.equal(cleaningTaskBusinessIdentity({ sourceId: 'standalone-task' }), 'cleaning_task:standalone-task')
}

function testCanonicalKeyHandoverTurnoverRequiresExactOrderBoundary() {
  const checkout = {
    __raw_id: 'checkout-1',
    task_type: 'checkout_clean',
    property_id: 'property-1',
    task_date: '2026-10-20',
    order_id: 'outgoing-order',
    order_checkout: '2026-10-20',
  }
  const checkin = {
    __raw_id: 'checkin-1',
    task_type: 'checkin_clean',
    property_id: 'property-1',
    task_date: '2026-10-20',
    order_id: 'incoming-order',
    order_checkin: '2026-10-20',
  }
  assert.deepEqual(canonicalKeyHandoverSourceIds([checkout]), ['checkout-1'])
  assert.deepEqual(canonicalKeyHandoverSourceIds([checkout, checkin]), ['checkout-1', 'checkin-1'])
  assert.deepEqual(canonicalKeyHandoverSourceIds([checkout, { ...checkin, order_checkin: '2026-10-21' }]), [])
  assert.deepEqual(canonicalKeyHandoverSourceIds([checkout, { ...checkin, order_id: 'outgoing-order' }]), [])
  assert.deepEqual(canonicalKeyHandoverSourceIds([checkout, { ...checkin, property_id: 'property-2' }]), [])
  assert.deepEqual(canonicalKeyHandoverSourceIds([checkout, { ...checkin, __work_record_state: 'completed' }]), [])
}

function testWorkTaskPayloadUsesExactAuditWithoutExposingMediaUrl() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
  const cleaningSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning.ts'), 'utf8')
  const cleaningAppSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
  assert.match(source, /latest_lockbox_audit AS \([\s\S]*?audit\.source_id::text AS task_id[\s\S]*?performed_as_action = 'upload_access_video'/)
  assert.match(source, /current_media\.task_id::text = t\.id::text[\s\S]*?current_media\.type = 'lockbox_video'/)
  assert.match(source, /lockboxVideoUrl: row\.has_current_lockbox_video === true \? 'recorded' : ''/)
  assert.doesNotMatch(source, /invalidatedAfterUpload|invalidated_after_upload|lockbox_audit_invalidated/)
  assert.match(source, /key_handover: keyHandover/)
  assert.match(source, /canonicalCleaningTurnoverPairs\(cleaningRows\)/)
  assert.match(source, /canonicalKeyHandoverSourceIds\(keyHandoverRelationRows\)/)
  assert.match(source, /business_identity: businessIdentity/)
  assert.match(source, /phase_history: phaseHistory/)
  assert.match(source, /executor_id: roleKind === 'executor'/)
  assert.match(source, /const canonicalTurnover = sameDayTurnoverFor\(row\.id\)/)
  assert.match(source, /const rowBusinessIdentity = canonicalTurnover\?\.businessIdentity[\s\S]*?cleaningTaskBusinessIdentity\(\{ sourceId: row\.id \}\)/)
  assert.match(source, /const k = `\$\{taskDate\}\|\$\{rowBusinessIdentity\}\|\$\{effectiveCleanerId/)
  assert.match(source, /const keyHandoverRelationRowsById = new Map<string, any>\(\)/)
  assert.doesNotMatch(source, /const k = `\$\{taskDate\}\|\$\{propId \|\| ''\}\|\$\{effectiveCleanerId/)
  assert.match(source, /LEFT JOIN users cu ON \(cu\.id::text\) = \(t\.cleaner_id::text\)/)
  assert.doesNotMatch(source, /LEFT JOIN users cu ON \(cu\.id::text\) = \(COALESCE\(t\.cleaner_id, t\.assignee_id\)::text\)/)
  assert.match(source, /__key_handover_source_ids/)
  assert.match(source, /latest_cancellation\.is_deleted = false/)
  assert.match(source, /candidate_cancellation\.id = candidate_id\.id[\s\S]*?COALESCE\(candidate_cancellation\.is_deleted, false\) = false/)
  assert.match(source, /latest_cancellation_ids AS MATERIALIZED \([\s\S]*?patch,status[\s\S]*?IN \('cancelled', 'canceled'\)/)
  assert.doesNotMatch(source, /latest_cancellation_ids AS MATERIALIZED \([\s\S]*?event\.event_type = 'TASK_REMOVED'[\s\S]*?ORDER BY event\.task_id/)
  assert.match(source, /changedFields: \['status', 'lockbox_video_uploaded_at', 'lockbox_video_url', 'key_handover'\][\s\S]*?key_handover: keyHandover/)
  assert.match(source, /lockbox_video_uploaded_at: null, lockbox_video_url: null, key_handover: null/)
  assert.match(cleaningSource, /changedFields: \['status', 'execution_state', 'lifecycle_state'\][\s\S]*?lifecycle_state: 'deleted'/)
  assert.match(cleaningSource, /pgRunInTransaction\(async \(client\)[\s\S]*?lifecycle_state: 'deleted'[\s\S]*?\}, client\)/)
  assert.match(cleaningAppSource, /changedFields: \['status', 'lockbox_video_uploaded_at', 'lockbox_video_url', 'key_handover'\]/)
  assert.match(cleaningAppSource, /lockbox_video_uploaded_at: null, lockbox_video_url: null, key_handover: null/)
  assert.doesNotMatch(source, /lockboxVideoConfirmsCurrentTaskState\([\s\S]{0,240}\) \|\| !!keyHandover/)
}

function testTurnoverCheckoutAssignmentWinsOverPendingFallback() {
  const out = mergeInspectionPlan([
    {
      task_type: 'checkout_clean',
      inspection_mode: 'same_day',
      inspector_id: 'justin',
      status: 'assigned',
    },
    {
      task_type: 'checkin_clean',
      inspection_mode: 'same_day',
      inspector_id: null,
      status: 'assigned',
    },
  ])
  assert.equal(out.inspectionMode, 'same_day')
  assert.equal(out.inspectionDueDate, null)
}

function testTurnoverPendingCheckoutDoesNotGetPromotedByCheckinDefault() {
  const out = mergeInspectionPlan([
    {
      task_type: 'checkout_clean',
      inspection_mode: 'pending_decision',
      inspector_id: null,
      status: 'assigned',
    },
    {
      task_type: 'checkin_clean',
      inspection_mode: 'same_day',
      inspector_id: null,
      status: 'assigned',
    },
  ])
  assert.equal(out.inspectionMode, 'pending_decision')
  assert.equal(out.inspectionDueDate, null)
}

function testDeferredCheckoutKeepsDeferredDate() {
  const out = mergeInspectionPlan([
    {
      task_type: 'checkout_clean',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-05-05',
      inspector_id: 'justin',
      status: 'assigned',
    },
    {
      task_type: 'checkin_clean',
      inspection_mode: 'same_day',
      inspector_id: null,
      status: 'assigned',
    },
  ])
  assert.equal(out.inspectionMode, 'deferred')
  assert.equal(out.inspectionDueDate, '2026-05-05')
}

function testStayoverRemainsSelfComplete() {
  const out = mergeInspectionPlan([
    {
      task_type: 'stayover_clean',
      inspection_mode: 'self_complete',
      inspector_id: null,
      status: 'assigned',
    },
  ])
  assert.equal(out.inspectionMode, 'self_complete')
  assert.equal(out.inspectionDueDate, null)
}

function testCheckedDoneBeatsSelfCompleteWhenMerged() {
  const out = mergeInspectionPlan([
    {
      task_type: 'checkout_clean',
      inspection_mode: 'self_complete',
      inspector_id: null,
      status: 'assigned',
    },
    {
      task_type: 'checkout_clean',
      inspection_mode: 'checked_done',
      inspector_id: null,
      status: 'assigned',
    },
  ])
  assert.equal(out.inspectionMode, 'checked_done')
  assert.equal(out.inspectionDueDate, null)
}

function testTemporaryCheckinDoesNotUnassignScheduledCheckout() {
  const out = mergeTurnoverTaskPlan([
    {
      task_type: 'checkout_clean',
      cleaner_id: 'cleaner-1',
      assignee_id: 'cleaner-1',
      inspector_id: null,
      inspection_mode: 'pending_decision',
      status: 'assigned',
    },
    {
      task_type: 'checkin_clean',
      cleaner_id: null,
      assignee_id: null,
      inspector_id: null,
      inspection_mode: 'same_day',
      inspection_scope: 'password_only',
      status: 'pending',
    },
  ])
  assert.equal(out.cleanerId, 'cleaner-1')
  assert.equal(out.assigneeId, 'cleaner-1')
  assert.equal(out.status, 'assigned')
  assert.equal(out.inspectionMode, 'pending_decision')
  assert.equal(out.inspectionScope, 'inspect_and_hang')
  assert.equal(out.inspectorId, null)
}

function testTemporaryCheckinDoesNotClearCheckoutInspector() {
  const out = mergeTurnoverTaskPlan([
    {
      task_type: 'checkout_clean',
      cleaner_id: 'cleaner-1',
      assignee_id: 'cleaner-1',
      inspector_id: 'inspector-1',
      inspection_mode: 'same_day',
      status: 'assigned',
    },
    {
      task_type: 'checkin_clean',
      cleaner_id: null,
      assignee_id: null,
      inspector_id: null,
      inspection_mode: 'same_day',
      status: 'pending',
    },
  ])
  assert.equal(out.inspectorId, 'inspector-1')
  assert.equal(out.inspectionMode, 'same_day')
}

function testTurnoverKeepsKeysHungFromAnyUnderlyingTask() {
  const out = mergeTurnoverTaskPlan([
    {
      task_type: 'checkout_clean',
      cleaner_id: 'cleaner-1',
      assignee_id: 'cleaner-1',
      inspector_id: 'inspector-1',
      inspection_mode: 'same_day',
      status: 'assigned',
    },
    {
      task_type: 'checkin_clean',
      cleaner_id: null,
      assignee_id: null,
      inspector_id: 'inspector-1',
      inspection_mode: 'same_day',
      status: 'keys_hung',
    },
  ])
  assert.equal(out.status, 'keys_hung')
  assert.equal(out.cleanerId, 'cleaner-1')
  assert.equal(out.inspectorId, 'inspector-1')
}

function testCompletedDeferredInspectionStillProjectsToDueDate() {
  const out = deferredProjectionDate({
    inspectionMode: 'deferred',
    inspectionDueDate: '2026-06-21',
    dateFrom: '2026-06-21',
    dateTo: '2026-06-21',
    status: 'completed',
  })
  assert.equal(out, '2026-06-21')
}

function testTerminalDeferredInspectionDoesNotClampIntoLaterRange() {
  assert.equal(deferredProjectionDate({
    inspectionMode: 'deferred',
    inspectionDueDate: '2026-06-21',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-28',
    status: 'completed',
  }), null)
  assert.equal(deferredProjectionDate({
    inspectionMode: 'deferred',
    inspectionDueDate: '2026-06-21',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-28',
    status: 'cancelled',
  }), null)
}

function testIncompleteDeferredInspectionStillClampsAsOverdue() {
  assert.equal(deferredProjectionDate({
    inspectionMode: 'deferred',
    inspectionDueDate: '2026-06-21',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-28',
    status: 'assigned',
  }), '2026-06-22')
}

function testMsq1905eReopenedDeferredEvidenceDoesNotContaminateNewTurnover() {
  const historicalSource = 'msq1905e-deferred-2026-10-11'
  const historicalIsolation = unlinkedDeferredInspectionMergeKey({
    sourceId: historicalSource,
    inspectionMode: 'deferred',
    hasExplicitInspectionRelation: false,
  })
  const currentIsolation = unlinkedDeferredInspectionMergeKey({
    sourceId: 'msq1905e-checkout-2026-10-19',
    inspectionMode: 'same_day',
    hasExplicitInspectionRelation: false,
  })
  assert.equal(historicalIsolation, `deferred:${historicalSource}`)
  assert.equal(currentIsolation, null)
  assert.equal(lockboxVideoConfirmsCurrentTaskState({
    status: 'assigned',
    lockboxVideoUrl: 'https://example.invalid/historical-lockbox.mp4',
  }), true, 'the exact task keeps its own video fact; merge isolation prevents it leaking to a different turnover')
  assert.equal(keyPhotoConfirmsCurrentTaskProgress({
    status: 'assigned',
    keyPhotoUrl: 'https://example.invalid/historical-key.jpg',
  }), false, 'retained key evidence on a reopened task must not override the assigned lifecycle state')
  assert.equal(keyPhotoConfirmsCurrentTaskProgress({
    status: 'in_progress',
    keyPhotoUrl: 'https://example.invalid/current-key.jpg',
  }), true)
  assert.equal(lockboxVideoConfirmsCurrentTaskState({
    status: 'keys_hung',
    lockboxVideoUrl: 'https://example.invalid/current-lockbox.mp4',
  }), true)

  const ranges = [
    { label: 'day', from: '2026-10-19', to: '2026-10-19' },
    { label: 'week', from: '2026-10-19', to: '2026-10-25' },
    { label: 'month', from: '2026-10-01', to: '2026-10-31' },
  ]
  for (const range of ranges) {
    const historicalDate = deferredProjectionDate({
      inspectionMode: 'deferred',
      inspectionDueDate: '2026-10-13',
      dateFrom: range.from,
      dateTo: range.to,
      status: 'assigned',
    })
    assert.ok(historicalDate, `${range.label} keeps the incomplete overdue inspection visible`)
    const historicalKey = withInspectionMergeIsolation(`${historicalDate}|MSQ1905E`, historicalIsolation)
    const currentKey = withInspectionMergeIsolation('2026-10-19|MSQ1905E', currentIsolation)
    assert.notEqual(historicalKey, currentKey, `${range.label} keeps the historical and current canonical sources separate`)
  }
}

function testFo1602HistoricalInspectionStaysSeparateFromLegitimateTurnoverMerge() {
  const historicalIsolation = unlinkedDeferredInspectionMergeKey({
    sourceId: 'fo1602-deferred-old',
    inspectionMode: 'deferred',
    hasExplicitInspectionRelation: false,
  })
  const checkoutIsolation = unlinkedDeferredInspectionMergeKey({
    sourceId: 'fo1602-current-checkout',
    inspectionMode: 'same_day',
    hasExplicitInspectionRelation: false,
  })
  const checkinIsolation = unlinkedDeferredInspectionMergeKey({
    sourceId: 'fo1602-current-checkin',
    inspectionMode: 'same_day',
    hasExplicitInspectionRelation: false,
  })
  assert.notEqual(
    withInspectionMergeIsolation('2026-10-19|FO1602', historicalIsolation),
    withInspectionMergeIsolation('2026-10-19|FO1602', checkoutIsolation),
  )
  assert.equal(
    withInspectionMergeIsolation('2026-10-19|FO1602', checkoutIsolation),
    withInspectionMergeIsolation('2026-10-19|FO1602', checkinIsolation),
    'ordinary same-day checkout and check-in still share the turnover merge bucket',
  )
  assert.equal(unlinkedDeferredInspectionMergeKey({
    sourceId: 'fo1602-explicitly-linked-deferred',
    inspectionMode: 'deferred',
    hasExplicitInspectionRelation: true,
  }), null, 'a stored canonical inspection relation remains eligible for the intended merge')
}

function testBoardSavePreservesDeferredDate() {
  const due = resolveBoardInspectionDueDate({
    inspectionMode: 'deferred',
    requestedDueDate: null,
    previousDueDate: '2026-09-07',
  })
  assert.equal(due, '2026-09-07')
  assert.equal(deferredProjectionDate({
    inspectionMode: 'deferred',
    inspectionDueDate: due,
    dateFrom: '2026-09-07',
    dateTo: '2026-09-07',
    status: 'completed',
  }), '2026-09-07')
  assert.equal(resolveBoardInspectionDueDate({
    inspectionMode: 'same_day',
    requestedDueDate: null,
    previousDueDate: '2026-09-07',
    previousInspectionMode: 'deferred',
    modeChangeAction: 'set',
  }), null)
  assert.throws(() => resolveBoardInspectionDueDate({
    inspectionMode: 'same_day',
    requestedDueDate: null,
    previousDueDate: '2026-09-07',
    previousInspectionMode: 'deferred',
  }), /inspection_mode_change_confirmation_required/)
  assert.throws(() => resolveBoardInspectionDueDate({
    inspectionMode: 'deferred',
    requestedDueDate: null,
    previousDueDate: null,
  }), /inspection_due_date_required/)
}

function testKeysHungSelfCompleteProjectsToOriginalTaskDate() {
  const out = mobileInspectionProjectionDate({
    inspectionMode: 'self_complete',
    taskDate: '2026-06-22',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-22',
    status: 'keys_hung',
  })
  assert.equal(out, '2026-06-22')
}

function testOrdinarySelfCompleteDoesNotCreateInspectorTask() {
  const out = mobileInspectionProjectionDate({
    inspectionMode: 'self_complete',
    taskDate: '2026-06-22',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-22',
    status: 'completed',
  })
  assert.equal(out, null)
}

function testPasswordOnlyCannotUseSelfCompleteOrCheckedDone() {
  const normalizedTurnoverScope = normalizeTurnoverInspectionScope({
    inspectionScope: 'password_only',
    hasCheckoutCheckinTurnover: true,
  })
  assert.equal(normalizedTurnoverScope, 'inspect_and_hang', 'App/Web projections must not classify a turnover check-in as password-only execution')
  assert.equal(isCheckinKeyHandoverTask({
    task_type: 'checkin_clean',
    inspection_scope: normalizedTurnoverScope,
  }), false, 'App inspector grouping must include the normalized turnover check-in side')
  assert.equal(normalizeTurnoverInspectionScope({
    inspectionScope: 'password_only',
    hasCheckoutCheckinTurnover: false,
  }), 'password_only', 'pure check-in password-only execution remains legal')
  assert.equal(isInspectionModeAllowedForTask({
    taskType: 'checkin_clean',
    inspectionScope: 'password_only',
    inspectionMode: 'self_complete',
  }), false)
  assert.equal(isInspectionModeAllowedForTask({
    taskType: 'checkin_clean',
    inspectionScope: 'password_only',
    inspectionMode: 'checked_done',
  }), false)
  assert.equal(sanitizeInspectionModeForTask({
    taskType: 'checkin_clean',
    inspectionScope: 'password_only',
    inspectionMode: 'checked_done',
  }), 'same_day')
}

async function testTaskCenterSaveBoardDoesNotEraseDeferredDate() {
  // Use only the in-memory store; no database URL is loaded by this regression.
  process.env.DATABASE_URL = ''
  const { hasPg } = await import('../../src/dbAdapter')
  assert.equal(hasPg, false)
  const { db } = await import('../../src/store')
  const { router } = await import('../../src/modules/task_center')
  const { router: cleaningRouter } = await import('../../src/modules/cleaning')
  const taskId = 'test-board-deferred-date-preservation'
  const turnoverCheckoutId = 'test-board-turnover-checkout'
  const turnoverCheckinId = 'test-board-turnover-checkin'
  const pureCheckinId = 'test-board-pure-checkin'
  const dateMoveCheckoutId = 'test-date-move-checkout'
  const testPropertyId = 'property-manual-turnover'
  const task: any = {
    id: taskId,
    date: '2026-09-16',
    task_date: '2026-09-16',
    task_type: 'checkout_clean',
    type: 'checkout_clean',
    status: 'assigned',
    inspection_mode: 'deferred',
    inspection_due_date: '2026-09-17',
    inspector_id: 'test-inspector',
  }
  ;(db.cleaningTasks as any[]).push(task)
  ;(db.cleaningTasks as any[]).push(
    { id: turnoverCheckoutId, property_id: 'property-turnover', task_date: '2026-09-16', date: '2026-09-16', task_type: 'checkout_clean', type: 'checkout_clean', status: 'assigned', execution_state: 'active', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang' },
    { id: turnoverCheckinId, property_id: 'property-turnover', task_date: '2026-09-16', date: '2026-09-16', task_type: 'checkin_clean', type: 'checkin_clean', status: 'assigned', execution_state: 'active', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang' },
    { id: pureCheckinId, property_id: 'property-pure-checkin', task_date: '2026-09-16', date: '2026-09-16', task_type: 'checkin_clean', type: 'checkin_clean', status: 'assigned', execution_state: 'active', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang' },
    { id: dateMoveCheckoutId, property_id: 'property-pure-checkin', task_date: '2026-09-17', date: '2026-09-17', task_type: 'checkout_clean', type: 'checkout_clean', status: 'assigned', execution_state: 'active', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang' },
  )
  ;((db as any).properties ||= []).push({ id: testPropertyId, code: 'TEST-TURNOVER', region: 'Melbourne' })
  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    req.user = { sub: 'local-test', role: 'admin', roles: ['admin'] }
    next()
  })
  app.use('/task-center', router)
  app.use('/cleaning', cleaningRouter)
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const save = async (inspectionMode: string, inspectionDueDate: string | null, statusAction?: string, modeChangeAction?: 'set', targetTaskId = taskId, inspectionScope?: 'inspect_and_hang' | 'password_only') => {
    const response = await fetch(`${base}/task-center/save-board`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        date: '2026-09-16',
        rows: [{ row_key: 'region:local-test', row_type: 'region' }],
        cleaning_assignments: [{
          task_id: targetTaskId,
          inspection_mode: inspectionMode,
          ...(inspectionScope ? { inspection_scope: inspectionScope } : {}),
          ...(modeChangeAction ? { inspection_mode_action: modeChangeAction } : {}),
          inspection_due_date: inspectionDueDate,
          ...(statusAction ? { status_action: statusAction, status: 'completed' } : {}),
        }],
      }),
    })
    return { status: response.status, body: await response.json() as any }
  }
  const postJson = async (path: string, body: any, method = 'POST') => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as any }
  }
  try {
    assert.equal((await save('deferred', null)).status, 200)
    assert.equal(task.inspection_due_date, '2026-09-17')
    assert.equal((await save('deferred', null, 'set_completed')).status, 200)
    assert.equal(task.status, 'completed')
    assert.equal(task.inspection_due_date, '2026-09-17')
    task.status = 'assigned'
    task.inspection_due_date = null
    const missingDate = await save('deferred', null, 'set_completed')
    assert.equal(missingDate.status, 400)
    assert.equal(missingDate.body.code, 'inspection_due_date_required')
    assert.equal(task.status, 'assigned')
    task.inspection_due_date = '2026-09-17'
    const implicitModeChange = await save('same_day', null)
    assert.equal(implicitModeChange.status, 400)
    assert.equal(implicitModeChange.body.code, 'inspection_mode_change_confirmation_required')
    assert.equal(task.inspection_due_date, '2026-09-17')
    assert.equal((await save('same_day', null, undefined, 'set')).status, 200)
    assert.equal(task.inspection_due_date, null)
    const invalidTurnoverScope = await save('same_day', null, undefined, undefined, turnoverCheckinId, 'password_only')
    assert.equal(invalidTurnoverScope.status, 400)
    assert.equal(invalidTurnoverScope.body.code, 'turnover_requires_inspect_and_hang')
    assert.equal((db.cleaningTasks as any[]).find((item) => item.id === turnoverCheckinId)?.inspection_scope, 'inspect_and_hang')
    assert.equal((await save('same_day', null, undefined, undefined, pureCheckinId, 'password_only')).status, 200)
    assert.equal((db.cleaningTasks as any[]).find((item) => item.id === pureCheckinId)?.inspection_scope, 'password_only')
    const singlePatchConflict = await postJson(`/cleaning/tasks/${turnoverCheckinId}`, { inspection_scope: 'password_only' }, 'PATCH')
    assert.equal(singlePatchConflict.status, 400)
    assert.equal(singlePatchConflict.body.code, 'turnover_requires_inspect_and_hang')
    const bulkPatchConflict = await postJson('/cleaning/tasks/bulk-patch', {
      ids: [turnoverCheckoutId],
      patch: { inspection_scope: 'password_only' },
    })
    assert.equal(bulkPatchConflict.status, 400)
    assert.equal(bulkPatchConflict.body.code, 'turnover_requires_inspect_and_hang')
    const dateMoveConflict = await postJson(`/cleaning/tasks/${pureCheckinId}`, { task_date: '2026-09-17' }, 'PATCH')
    assert.equal(dateMoveConflict.status, 400)
    assert.equal(dateMoveConflict.body.code, 'turnover_requires_inspect_and_hang')
    assert.equal((db.cleaningTasks as any[]).find((item) => item.id === pureCheckinId)?.task_date, '2026-09-16')
    const manualTurnoverConflict = await postJson('/cleaning/tasks', {
      create_mode: 'turnover',
      task_date: '2026-09-18',
      property_id: testPropertyId,
      inspection_scope: 'password_only',
    })
    assert.equal(manualTurnoverConflict.status, 400)
    assert.equal(manualTurnoverConflict.body.code, 'turnover_requires_inspect_and_hang')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const index = db.cleaningTasks.findIndex((item) => item.id === taskId)
    if (index >= 0) db.cleaningTasks.splice(index, 1)
    for (const id of [turnoverCheckoutId, turnoverCheckinId, pureCheckinId, dateMoveCheckoutId]) {
      const fixtureIndex = db.cleaningTasks.findIndex((item) => item.id === id)
      if (fixtureIndex >= 0) db.cleaningTasks.splice(fixtureIndex, 1)
    }
    const propertyIndex = ((db as any).properties || []).findIndex((item: any) => item.id === testPropertyId)
    if (propertyIndex >= 0) (db as any).properties.splice(propertyIndex, 1)
  }
}

testTurnoverCheckoutAssignmentWinsOverPendingFallback()
testTurnoverPendingCheckoutDoesNotGetPromotedByCheckinDefault()
testDeferredCheckoutKeepsDeferredDate()
testStayoverRemainsSelfComplete()
testCheckedDoneBeatsSelfCompleteWhenMerged()
testTemporaryCheckinDoesNotUnassignScheduledCheckout()
testTemporaryCheckinDoesNotClearCheckoutInspector()
testTurnoverKeepsKeysHungFromAnyUnderlyingTask()
testCompletedDeferredInspectionStillProjectsToDueDate()
testTerminalDeferredInspectionDoesNotClampIntoLaterRange()
testIncompleteDeferredInspectionStillClampsAsOverdue()
testMsq1905eReopenedDeferredEvidenceDoesNotContaminateNewTurnover()
testFo1602HistoricalInspectionStaysSeparateFromLegitimateTurnoverMerge()
testBoardSavePreservesDeferredDate()
testKeysHungSelfCompleteProjectsToOriginalTaskDate()
testOrdinarySelfCompleteDoesNotCreateInspectorTask()
testPasswordOnlyCannotUseSelfCompleteOrCheckedDone()
testKeyHandoverFactStaysSeparateFromWorkflowFinalization()
testKeyHandoverSurvivesOrdinaryWorkflowChanges()
testManualKeysHungIsVisibleWithoutPretendingVideoEvidenceExists()
testKeyHandoverFactRequiresExactCurrentTaskMediaOrManualConfirmation()
testKeyHandoverMergeRequiresCanonicalSourceMembership()
testManagerProjectionKeepsCanonicalHandoverForVisiblePhaseSubset()
testCanonicalKeyHandoverTurnoverRequiresExactOrderBoundary()
testCanonicalTurnoverBusinessIdentityRejectsCancelledOrAmbiguousCandidates()
testWorkTaskPayloadUsesExactAuditWithoutExposingMediaUrl()

testTaskCenterSaveBoardDoesNotEraseDeferredDate()
  .then(() => console.log('test_cleaning_inspection_merge: ok'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
