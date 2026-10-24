import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import {
  canonicalCleaningTurnoverPairs,
  canonicalKeyHandoverSourceIds,
  canonicalKeyHandoverSourceIdsForProjection,
  cleaningAuditBusinessDateSql,
  cleaningExecutionBusinessDate,
  cleaningTaskBusinessIdentity,
  deferredInspectionManagerTimingAuthority,
  deferredProjectionDate,
  isCheckinKeyHandoverTask,
  isDeferredInspectionExecutionDayProjection,
  isInspectionModeAllowedForTask,
  keyPhotoConfirmsCurrentTaskProgress,
  lockboxVideoConfirmsCurrentTaskState,
  mergeCleaningKeyHandoverProjections,
  mergeInspectionPlan,
  mergeTurnoverTaskPlan,
  mobileInspectionProjectionDate,
  normalizeTurnoverInspectionScope,
  projectCleaningKeyHandover,
  reconcilePendingHandoverInspectorGroups,
  resolveInspectionTaskAssignment,
  resolveBoardInspectionDueDate,
  sanitizeInspectionModeForTask,
  unlinkedDeferredInspectionMergeKey,
  withInspectionMergeIsolation,
} from '../../src/lib/cleaningInspection'

function testCheckinInspectionAssignmentUsesTheSavedExecutorWithoutMixingPeople() {
  assert.deepEqual(resolveInspectionTaskAssignment({
    task_type: 'checkin_clean',
    inspection_scope: 'inspect_and_hang',
    assignee_id: 'mia-id',
    assignee_name: 'Mia',
    inspector_id: null,
  }), {
    userId: 'mia-id',
    userName: 'Mia',
    source: 'assignee',
  }, 'a pure check-in inspection must project the executor saved by Task Center')

  assert.deepEqual(resolveInspectionTaskAssignment({
    task_type: 'checkin_clean',
    inspection_scope: 'inspect_and_hang',
    assignee_id: 'summer-id',
    assignee_name: 'Summer',
    inspector_id: 'mia-id',
    inspector_name: 'Mia',
  }), {
    userId: 'mia-id',
    userName: 'Mia',
    source: 'inspector',
  }, 'an explicit inspector wins without borrowing the generic assignee name')

  assert.deepEqual(resolveInspectionTaskAssignment({
    task_type: 'checkin_clean',
    inspection_scope: 'inspect_and_hang',
    assignee_id: 'summer-id',
    assignee_name: 'Summer',
    inspector_id: 'mia-id',
    inspector_name: '',
  }), {
    userId: 'mia-id',
    userName: null,
    source: 'inspector',
  }, 'a missing inspector name must not be paired with another person\'s assignee name')

  assert.deepEqual(resolveInspectionTaskAssignment({
    task_type: 'checkin_clean',
    inspection_scope: 'inspect_and_hang',
    assignee_id: 'mia-id',
    assignee_name: 'Mia',
    inspector_id: 'mia-id',
    inspector_name: '',
  }), {
    userId: 'mia-id',
    userName: 'Mia',
    source: 'inspector',
  }, 'the matching generic assignee name may fill a missing explicit inspector name')

  assert.deepEqual(resolveInspectionTaskAssignment({
    task_type: 'checkin_clean',
    inspection_scope: 'password_only',
    assignee_id: 'executor-id',
    assignee_name: 'Executor',
  }), {
    userId: null,
    userName: null,
    source: null,
  }, 'password-only execution must not become an inspection assignment')

  assert.deepEqual(resolveInspectionTaskAssignment({
    task_type: 'checkout_clean',
    inspection_scope: 'inspect_and_hang',
    assignee_id: 'cleaner-id',
    assignee_name: 'Cleaner',
  }), {
    userId: null,
    userName: null,
    source: null,
  }, 'ordinary checkout cleaning must not promote the cleaner to inspector')

  assert.deepEqual(resolveInspectionTaskAssignment({
    task_type: 'checkin_clean',
    inspection_scope: 'inspect_and_hang',
  }), {
    userId: null,
    userName: null,
    source: null,
  }, 'an actually unassigned check-in remains unassigned')

  const workTasksSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
  assert.match(workTasksSource, /const inspectionAssignment = resolveInspectionTaskAssignment\(\{/)
  assert.match(workTasksSource, /const effectiveInspectionAssigneeId = displayDeferredArrangement[\s\S]*?displayCheckinAssignment\?\.userId[\s\S]*?: \(inspectionAssignment\.userId/)
  assert.match(workTasksSource, /__assignee_inspector: displayDeferredArrangement[\s\S]*?displayCheckinAssignment\?\.userId[\s\S]*?: inspectionAssignment\.userId/)
  assert.match(workTasksSource, /inspector_name: displayDeferredArrangement[\s\S]*?displayCheckinAssignment\?\.userName[\s\S]*?: inspectionAssignment\.userName/)
  assert.doesNotMatch(
    workTasksSource,
    /firstNonEmpty\(displayMergeCheckinRow\.inspector_name, displayMergeCheckinRow\.assignee_name\)/,
    'a missing explicit inspector name must not fall back to a different generic assignee name',
  )
}

function testQueuedInspectionUsesCapturedBusinessDateOnlyWithExactEvidence() {
  assert.equal(cleaningExecutionBusinessDate({
    taskDate: '2026-10-12',
    performedAt: '2026-10-13T00:30:39+11:00',
    evidenceCapturedAt: [
      '2026-10-12T15:34:00+11:00',
      '2026-10-12T15:35:00+11:00',
    ],
  }), '2026-10-12')
  assert.equal(cleaningExecutionBusinessDate({
    taskDate: '2026-10-12',
    performedAt: '2026-10-13T10:00:00+11:00',
    evidenceCapturedAt: ['2026-10-13T09:45:00+11:00'],
  }), '2026-10-13', 'a genuine next-day execution must stay on its actual day')
  assert.equal(cleaningExecutionBusinessDate({
    taskDate: '2026-10-12',
    performedAt: '2026-10-13T10:00:00+11:00',
    evidenceCapturedAt: [],
  }), '2026-10-13', 'missing capture evidence must never manufacture an original-day record')
  const sql = cleaningAuditBusinessDateSql('audit')
  assert.match(sql, /evidence_snapshot/)
  assert.ok(sql.includes('[T ]'), 'persisted audit snapshots may serialize captured_at with either an ISO T or a PostgreSQL space separator')
  assert.match(sql, /scheduled_service_date/)
  assert.match(sql, /Australia\/Melbourne/)
  assert.throws(() => cleaningAuditBusinessDateSql('audit; DROP TABLE users'))
}

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

function testManualCheckinLinkMigrationIsGuardedAndTransactional() {
  const migration = fs.readFileSync(
    path.resolve(__dirname, '../migrations/20261021_mz065_manual_checkin_turnover_link.sql'),
    'utf8',
  )
  assert.match(migration, /^BEGIN;/)
  assert.match(migration, /schema_migrations_missing/)
  assert.match(migration, /cleaning_tasks_missing/)
  assert.match(migration, /orders_missing/)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS linked_checkout_task_id text/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION mz065_lock_order_turnover_boundaries\(\)/)
  assert.match(migration, /pg_advisory_xact_lock\(/)
  assert.match(migration, /hashtext\('cleaning-turnover:' \|\| boundary\.property_key\)/)
  assert.match(migration, /BEFORE INSERT ON orders/)
  assert.doesNotMatch(migration, /BEFORE INSERT OR UPDATE/)
  assert.match(migration, /ORDER BY key_parts\.property_key, key_parts\.boundary_day/)
  assert.match(migration, /VALUES \('20261021_mz065_manual_checkin_turnover_link'\)/)
  assert.match(migration, /COMMIT;\s*$/)

  const dbAdapterSource = fs.readFileSync(path.resolve(__dirname, '../../src/dbAdapter.ts'), 'utf8')
  assert.match(dbAdapterSource, /const ORDER_TURNOVER_IDENTITY_FIELDS = new Set\(\['property_id', 'checkin', 'checkout', 'status'\]\)/)
  assert.match(dbAdapterSource, /if \(updatesOrderTurnoverIdentity && !client\) \{[\s\S]*?pgRunInTransaction/)
  assert.match(dbAdapterSource, /lockOrderTurnoverIdentityWrite[\s\S]*?order-turnover-identity[\s\S]*?cleaning-turnover:/)

  const syncSource = fs.readFileSync(path.resolve(__dirname, '../../src/services/cleaningSync.ts'), 'utf8')
  assert.match(syncSource, /lockCleaningOrderIdentityKey\(client, id\)[\s\S]*?const order = await loadOrder\(id, client\)/)
  const boundaryLockBlock = syncSource.indexOf('const turnoverBoundaryDates = Array.from(new Set(')
  const firstTaskSync = syncSource.indexOf('const rCheckout = await syncOneTask', boundaryLockBlock)
  assert.ok(boundaryLockBlock >= 0 && firstTaskSync > boundaryLockBlock, 'sync must acquire every sorted order boundary advisory lock before task rows')
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

function testPendingHandoverRecordMergesOnlyIntoItsExactLiveTurnover() {
  const buildRows = (propertyCode: string) => {
    const businessIdentity = `turnover:${propertyCode}-out:${propertyCode}-in`
    const checkoutSource = {
      id: `${propertyCode}-checkout`,
      task_type: 'checkout_clean',
      property_id: `${propertyCode}-property`,
      task_date: '2026-10-24',
      order_id: `${propertyCode}-out`,
      order_checkout: '2026-10-24',
      status: 'inspected',
      execution_state: 'active',
      inspection_scope: 'inspect_and_hang',
    }
    const checkinSource = {
      id: `${propertyCode}-checkin`,
      task_type: 'checkin_clean',
      property_id: `${propertyCode}-property`,
      task_date: '2026-10-24',
      order_id: `${propertyCode}-in`,
      order_checkin: '2026-10-24',
      status: 'assigned',
      execution_state: 'active',
      inspection_scope: 'inspect_and_hang',
      inspector_id: 'inspector-1',
    }
    const pair = canonicalCleaningTurnoverPairs([checkoutSource, checkinSource])[0]
    assert.ok(pair, `${propertyCode} fixture must form one canonical turnover`)
    const checkoutRecord = {
      ...checkoutSource,
      __raw_id: checkoutSource.id,
      raw_status: checkoutSource.status,
      __date: '2026-10-24',
      __original_scheduled_date: '2026-10-24',
      __work_record_date: '2026-10-24',
      __work_record_state: 'completed',
      __work_record_actor_user_id: 'inspector-1',
      __assignee_inspector: 'inspector-1',
      __source_inspector_assignee_id: 'inspector-1',
      __inspection_mode: 'same_day',
      __inspection_scope: 'inspect_and_hang',
      __business_identity: businessIdentity,
    }
    const liveCheckin = {
      ...checkinSource,
      __raw_id: checkinSource.id,
      raw_status: checkinSource.status,
      __date: '2026-10-24',
      __assignee_inspector: 'inspector-1',
      __source_inspector_assignee_id: 'inspector-1',
      __inspection_mode: 'same_day',
      __inspection_scope: 'inspect_and_hang',
      __business_identity: businessIdentity,
    }
    return { pair, checkoutRecord, liveCheckin }
  }

  for (const propertyCode of ['sample-a', 'sample-b']) {
    const { pair, checkoutRecord, liveCheckin } = buildRows(propertyCode)
    const recordKey = `${propertyCode}-record`
    const liveKey = `${propertyCode}-live`
    const merged = reconcilePendingHandoverInspectorGroups(
      new Map([[recordKey, [checkoutRecord]], [liveKey, [liveCheckin]]]),
      [pair],
    )
    assert.equal(merged.size, 1, `${propertyCode} pending handover record must not create a second card`)
    assert.equal(merged.has(recordKey), false)
    assert.deepEqual(
      merged.get(liveKey)?.map((row) => row.__raw_id),
      [checkoutRecord.__raw_id, liveCheckin.__raw_id],
    )
    assert.equal(merged.get(liveKey)?.[0]?.__pending_handover_record_embedded, true)

    const assertFailsClosed = (recordPatch: any, livePatch: any, pairs = [pair]) => {
      const result = reconcilePendingHandoverInspectorGroups(
        new Map([[recordKey, [{ ...checkoutRecord, ...recordPatch }]], [liveKey, [{ ...liveCheckin, ...livePatch }]]]),
        pairs,
      )
      assert.equal(result.size, 2)
      assert.equal(result.has(recordKey), true)
    }
    assertFailsClosed({ __work_record_state: 'reassigned' }, {})
    assertFailsClosed({ __work_record_state: 'pending_review' }, {})
    assertFailsClosed({ raw_status: 'done', status: 'done' }, {})
    assertFailsClosed({ __inspection_mode: 'deferred' }, {})
    assertFailsClosed({ __inspection_scope: 'password_only', inspection_scope: 'password_only' }, {})
    assertFailsClosed({ __work_record_date: '2026-10-25' }, {})
    assertFailsClosed({ __business_identity: 'turnover:other:booking' }, {})
    assertFailsClosed({ __source_inspector_assignee_id: null }, {})
    assertFailsClosed({ __source_inspector_assignee_id: 'inspector-other' }, {})
    assertFailsClosed({ __manager_merge_isolation_key: 'deferred:checkout' }, {})
    assertFailsClosed({ __deferred_checkin_arrangement: { checkin_task_id: liveCheckin.__raw_id } }, {})
    assertFailsClosed({}, { __is_deferred_projection: true })
    assertFailsClosed({}, { __deferred_inspection_display_merge: { deferred_task_id: checkoutRecord.__raw_id } })
    assertFailsClosed({}, { __assignee_inspector: 'other-inspector' })
    assertFailsClosed({}, { __source_inspector_assignee_id: null })
    assertFailsClosed({}, { execution_state: 'cancelled', status: 'cancelled', raw_status: 'cancelled' })
    assertFailsClosed({}, {}, [])
    assertFailsClosed({}, {}, [pair, { ...pair }])

    const secondCheckinSource = {
      ...pair.checkin,
      id: `${propertyCode}-other-checkin`,
      order_id: `${propertyCode}-other-in`,
    }
    const ambiguousPairs = canonicalCleaningTurnoverPairs([
      pair.checkout,
      pair.checkin,
      secondCheckinSource,
    ])
    assert.deepEqual(ambiguousPairs, [], 'one checkout plus two valid incoming orders must remain fail-closed')
    const otherLiveKey = `${propertyCode}-other-live`
    const ambiguousGroups = reconcilePendingHandoverInspectorGroups(
      new Map([
        [recordKey, [checkoutRecord]],
        [liveKey, [liveCheckin]],
        [otherLiveKey, [{
          ...liveCheckin,
          ...secondCheckinSource,
          __raw_id: secondCheckinSource.id,
          __business_identity: `cleaning_task:${secondCheckinSource.id}`,
        }]],
      ]),
      ambiguousPairs,
    )
    assert.equal(ambiguousGroups.size, 3, 'distinct incoming orders remain visible for calendar correction')
    assert.equal(ambiguousGroups.has(recordKey), true)
    assert.equal(ambiguousGroups.has(liveKey), true)
    assert.equal(ambiguousGroups.has(otherLiveKey), true)

    const manuallyGrantedButUnassignedCheckin = { ...pair.checkin, inspector_id: null, assignee_id: null }
    const unassignedPair = { ...pair, checkin: manuallyGrantedButUnassignedCheckin }
    const manualGrantOnly = reconcilePendingHandoverInspectorGroups(
      new Map([
        [recordKey, [checkoutRecord]],
        [liveKey, [{
          ...liveCheckin,
          __assignee_inspector: 'inspector-1',
          __source_inspector_assignee_id: null,
        }]],
      ]),
      [unassignedPair],
    )
    assert.equal(manualGrantOnly.size, 2, 'a manual action grant must not replace the live check-in assignment')
    assert.equal(manualGrantOnly.has(recordKey), true)
  }
}

function testDeferredInspectionDisplayAuthoritySurvivesBothProjectionStages() {
  assert.equal(isDeferredInspectionExecutionDayProjection({
    displayMergeEligible: true,
    hasDisplayCheckinSource: false,
    groupDate: '2026-10-25',
    effectiveInspectionDate: '2026-10-26',
  }), false, 'the original checkout-day cleaner row is not the deferred execution-day merge')
  assert.equal(isDeferredInspectionExecutionDayProjection({
    displayMergeEligible: true,
    hasDisplayCheckinSource: true,
    groupDate: '2026-10-26',
    effectiveInspectionDate: '2026-10-26',
  }), true, 'the linked check-in source on the execution day is the deferred merge')
  assert.equal(isDeferredInspectionExecutionDayProjection({
    displayMergeEligible: true,
    hasDisplayCheckinSource: true,
    groupDate: '2026-10-25',
    effectiveInspectionDate: '2026-10-25',
  }), true, 'an actual same-day checkout remains a current-day turnover')
  assert.equal(isDeferredInspectionExecutionDayProjection({
    displayMergeEligible: true,
    hasDisplayCheckinSource: false,
    groupDate: '2026-10-26',
    effectiveInspectionDate: '2026-10-26',
  }), false, 'a deferred inspection without a linked check-in remains an independent deferred card')

  const d1Authority = deferredInspectionManagerTimingAuthority([
    {
      task_type: 'checkin_clean',
      deferred_inspection_merged: true,
      deferred_inspection_current_day_checkout: false,
      start_time: null,
      end_time: '3pm',
    },
    {
      task_type: 'checkout_clean',
      start_time: '10am',
      turnover_display: { checkout_time: '10am', is_late_checkout: true },
    },
  ], { checkout_time: '10am', checkin_time: '3pm', is_late_checkout: true })
  assert.equal(d1Authority.deferredInspectionMerged, true)
  assert.equal(d1Authority.currentDayCheckout, false)
  assert.equal(d1Authority.checkoutTimingAuthoritative, false)
  assert.equal(d1Authority.turnoverDisplay?.checkout_time, null, 'manager aggregation must not restore D0 checkout time')
  assert.equal(d1Authority.turnoverDisplay?.is_late_checkout, false, 'manager aggregation must not restore D0 late-checkout')

  const actualSameDayAuthority = deferredInspectionManagerTimingAuthority([
    { deferred_inspection_merged: true, deferred_inspection_current_day_checkout: true },
  ], { checkout_time: '10am', checkin_time: '3pm', is_late_checkout: true })
  assert.equal(actualSameDayAuthority.checkoutTimingAuthoritative, true)
  assert.equal(actualSameDayAuthority.turnoverDisplay?.checkout_time, '10am')

  const ordinaryCheckoutAuthority = deferredInspectionManagerTimingAuthority([
    { task_type: 'checkout_clean', start_time: '10am' },
  ], { checkout_time: '10am', is_late_checkout: true })
  assert.equal(ordinaryCheckoutAuthority.deferredInspectionMerged, false)
  assert.equal(ordinaryCheckoutAuthority.currentDayCheckout, null)
  assert.equal(ordinaryCheckoutAuthority.checkoutTimingAuthoritative, true)
}

function testExplicitManualCheckinLinkIsCanonicalButNeverPropertyDateInferred() {
  const checkout = {
    id: 'manual-checkout', task_type: 'checkout_clean', property_id: 'property-1', task_date: '2026-10-22',
    order_id: 'outgoing-order', order_checkout: '2026-10-22', status: 'assigned', execution_state: 'active',
  }
  const checkin = {
    id: 'manual-checkin', task_type: 'checkin_clean', property_id: 'property-1', task_date: '2026-10-22',
    order_id: null, linked_checkout_task_id: 'manual-checkout', status: 'pending', execution_state: 'active',
  }
  assert.deepEqual(canonicalCleaningTurnoverPairs([checkout, checkin]).map((pair) => ({
    source_ids: pair.source_ids,
    business_identity: pair.business_identity,
  })), [{
    source_ids: ['manual-checkout', 'manual-checkin'],
    business_identity: 'turnover_link:manual-checkout:manual-checkin',
  }])
  assert.deepEqual(canonicalKeyHandoverSourceIds([checkout, checkin]), ['manual-checkout', 'manual-checkin'])
  assert.deepEqual(canonicalCleaningTurnoverPairs([checkout, { ...checkin, linked_checkout_task_id: null }]), [], 'same room/date alone must not merge')
  assert.deepEqual(canonicalCleaningTurnoverPairs([checkout, { ...checkin, task_date: '2026-10-23' }]), [], 'explicit link cannot cross the business date')
  assert.deepEqual(canonicalCleaningTurnoverPairs([checkout, { ...checkin, status: 'cancelled', execution_state: 'cancelled' }]), [], 'cancelled linked check-in is excluded')
  assert.deepEqual(canonicalCleaningTurnoverPairs([checkout, checkin, { ...checkin, id: 'duplicate-checkin' }]), [], 'multiple linked check-ins fail closed')
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
  const cleaningPageSource = fs.readFileSync(path.resolve(__dirname, '../../../frontend/src/app/cleaning/page.tsx'), 'utf8')
  const cleaningDailyMergeSource = fs.readFileSync(path.resolve(__dirname, '../../../frontend/src/lib/cleaningDailyMerge.ts'), 'utf8')
  assert.match(source, /latest_lockbox_audit AS \([\s\S]*?audit\.source_id::text AS task_id[\s\S]*?performed_as_action = 'upload_access_video'/)
  assert.match(source, /current_media\.task_id::text = t\.id::text[\s\S]*?current_media\.type = 'lockbox_video'/)
  assert.match(source, /lockboxVideoUrl: row\.has_current_lockbox_video === true \? 'recorded' : ''/)
  assert.doesNotMatch(source, /invalidatedAfterUpload|invalidated_after_upload|lockbox_audit_invalidated/)
  assert.match(source, /key_handover: keyHandover/)
  assert.match(source, /canonicalCleaningTurnoverPairs\(cleaningRows\)/)
  assert.match(source, /reconcilePendingHandoverInspectorGroups\([\s\S]*?inspectorGroups,[\s\S]*?canonicalTurnoverPairs/)
  assert.match(source, /const isWorkRecordGroup = !!workRecordState && !embedsPendingHandoverRecord/)
  assert.match(source, /const pendingHandoverRecordRow = embedsPendingHandoverRecord/)
  assert.match(source, /pendingHandoverRecordRow\?\.__raw_id[\s\S]*?pendingHandoverRecordRow\?\.source_id/)
  assert.doesNotMatch(source, /pendingHandoverActionChild/)
  assert.match(source, /inspection_action_task_id: pendingHandoverActionSourceId/)
  assert.match(source, /canonicalKeyHandoverSourceIds\(keyHandoverRelationRows\)/)
  assert.match(source, /deferred_inspection_current_day_checkout: deferredInspectionExecutionDayProjection[\s\S]*?deferredInspectionHasCurrentDayCheckout/)
  assert.match(source, /deferredInspectionManagerTimingAuthority\(arr, mergedTurnoverDisplay\)/)
  assert.match(source, /summary: displayMergeCheckinRow && !deferredInspectionHasCurrentDayCheckout[\s\S]*?`\$\{checkinTime\}入住`/)
  assert.match(source, /start_time: displayMergeCheckinRow && !deferredInspectionHasCurrentDayCheckout[\s\S]*?\? null/)
  assert.match(source, /business_identity: businessIdentity/)
  assert.match(source, /phase_history: phaseHistory/)
  assert.match(source, /executor_id: roleKind === 'executor'/)
  assert.match(source, /const canonicalTurnover = sameDayTurnoverFor\(row\.id\)/)
  assert.match(source, /const rowBusinessIdentity = displayDeferredArrangement[\s\S]*?canonicalTurnover\?\.businessIdentity[\s\S]*?cleaningTaskBusinessIdentity\(\{ sourceId: row\.id \}\)/)
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
  const manualCreateRoute = cleaningSource.slice(
    cleaningSource.indexOf("router.post('/tasks'"),
    cleaningSource.indexOf("router.delete('/tasks/:id'"),
  )
  const transactionStart = manualCreateRoute.indexOf("client.query('BEGIN')")
  const advisoryLock = manualCreateRoute.indexOf('lockCleaningTurnoverKey(client, normalizedPropertyId, parsed.data.task_date)', transactionStart)
  const sameDayRowLock = manualCreateRoute.indexOf('FOR UPDATE OF t', transactionStart)
  assert.ok(transactionStart >= 0 && advisoryLock > transactionStart && sameDayRowLock > advisoryLock, 'manual check-in linking must acquire the turnover advisory lock before any task row lock')
  assert.match(cleaningAppSource, /changedFields: \['status', 'lockbox_video_uploaded_at', 'lockbox_video_url', 'key_handover'\]/)
  assert.match(cleaningAppSource, /lockbox_video_uploaded_at: null, lockbox_video_url: null, key_handover: null/)
  assert.doesNotMatch(source, /lockboxVideoConfirmsCurrentTaskState\([\s\S]{0,240}\) \|\| !!keyHandover/)
  assert.match(cleaningPageSource, /label="入住执行方式"[\s\S]*?value=\{editForm\.checkout_ids\.length > 0 \? 'inspect_and_hang' : editForm\.checkin_inspection_scope\}/, 'existing check-in edit must expose the supported execution mode')
  assert.match(cleaningPageSource, /manualCreateForm\.create_mode === 'checkin'[\s\S]*?入住执行方式[\s\S]*?manualCreateForm\.checkin_inspection_scope/, 'top-level manual check-in create must expose the execution mode')
  assert.match(cleaningPageSource, /manualCheckinCheckoutCandidates\(items, propertyId, selectedDateStr\)/, 'manual check-in relation choices must use the shared reliable-candidate helper')
  assert.match(cleaningDailyMergeSource, /if \(loadState !== 'ready'\) return current[\s\S]*?candidateIds\.length === 1[\s\S]*?linked_checkout_task_id: candidateIds\[0\][\s\S]*?checkin_link_decision: 'link'/, 'one reliable checkout candidate must be selected only after a successful candidate load')
  assert.match(cleaningDailyMergeSource, /current\.checkin_link_decision === 'independent' && current\.checkin_link_decision_user_selected/, 'an explicit independent choice must be distinguished from an automatic empty-list state')
  assert.match(cleaningDailyMergeSource, /candidateIds\.length === 0[\s\S]*?checkin_link_decision: 'independent'[\s\S]*?checkin_link_decision_user_selected: false/, 'a successfully loaded empty candidate set may create only an automatic independent default')
  assert.match(cleaningPageSource, /setCalendarRangeLoadState\('loading'\)[\s\S]*?setCalendarRangeLoadState\('ready'\)[\s\S]*?setCalendarRangeLoadState\('error'\)/, 'calendar candidate state must distinguish loading, successful hydration, and load failure')
  assert.match(cleaningPageSource, /manualCreateForm\.create_mode === 'checkin' && calendarRangeLoadState !== 'ready'/, 'manual check-in save must reject unknown or failed candidate state')
  assert.match(cleaningPageSource, /calendarRangeLoadState === 'error'[\s\S]*?任务关系加载失败，不能把未知候选当作独立任务。[\s\S]*?loadRangeItems\(\)/, 'failed candidate loads must offer a retry instead of silently creating an independent check-in')
  assert.match(cleaningPageSource, /任务关系仍在加载，请稍后再保存/, 'manual check-in save must fail closed while relation candidates are loading')
  assert.match(cleaningPageSource, /value: '__independent__', label: '明确创建独立入住任务'/, 'multiple checkout candidates must offer an explicit independent choice')
  assert.match(cleaningPageSource, /checkin_link_decision: manualCreateForm\.create_mode === 'checkin' \? manualCreateForm\.checkin_link_decision : null/, 'top-level create must send the explicit link decision')
  assert.match(cleaningPageSource, /linked_checkout_task_id: String\(editForm\.checkout_ids\[0\]\),[\s\S]*?checkin_link_decision: 'link'/, 'checkout-detail add-checkin must declare the exact linked decision')
  assert.match(cleaningPageSource, /inspection_scope: manualCreateForm\.create_mode === 'checkin'[\s\S]*?manualCreateForm\.linked_checkout_task_id \? 'inspect_and_hang' : manualCreateForm\.checkin_inspection_scope/, 'top-level linked check-in must submit the only valid same-day scope')
  assert.match(cleaningPageSource, /value=\{manualCreateForm\.linked_checkout_task_id \? 'inspect_and_hang' : manualCreateForm\.checkin_inspection_scope\}[\s\S]*?disabled=\{!!manualCreateForm\.linked_checkout_task_id\}/, 'top-level linked check-in must not offer the rejected password-only choice')
  assert.match(cleaningPageSource, /linked_checkout_task_id: v === '__independent__' \? null : String\(v \|\| ''\),[\s\S]*?checkin_link_decision: v === '__independent__' \? 'independent' : 'link',[\s\S]*?v !== '__independent__' \? \{ checkin_inspection_scope: 'inspect_and_hang' as const \} : \{\}/, 'choosing a checkout must immediately normalize the visible execution mode')
  assert.match(cleaningPageSource, /pending_add_checkin[\s\S]*?inspection_scope: editForm\.checkout_ids\.length > 0[\s\S]*?\? 'inspect_and_hang'[\s\S]*?: editForm\.checkin_inspection_scope/, 'checkout-side add-checkin entry must persist the supported mode')
  assert.match(cleaningPageSource, /value=\{editForm\.checkout_ids\.length > 0 \? 'inspect_and_hang' : editForm\.checkin_inspection_scope\}/, 'turnover editing must not offer a mode that the backend rejects')
  assert.match(cleaningPageSource, /disabled=\{!editDetailsGate\.enabled \|\| editForm\.checkout_ids\.length > 0\}/, 'turnover execution mode is read-only and explicit')
  assert.match(cleaningPageSource, /inspection_scope: editForm\.checkout_ids\.length > 0[\s\S]*?\? 'inspect_and_hang'[\s\S]*?: editForm\.checkin_inspection_scope/, 'checkout-side add-checkin must send the only valid turnover scope')
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
  const { buildTaskCenterDay, router } = await import('../../src/modules/task_center')
  const { router: cleaningRouter } = await import('../../src/modules/cleaning')
  const taskId = 'test-board-deferred-date-preservation'
  const turnoverCheckoutId = 'test-board-turnover-checkout'
  const turnoverCheckinId = 'test-board-turnover-checkin'
  const pureCheckinId = 'test-board-pure-checkin'
  const dateMoveCheckoutId = 'test-date-move-checkout'
  const linkedCheckoutId = 'test-manual-link-checkout'
  const decisionCheckoutUniqueId = 'test-manual-link-decision-unique'
  const decisionCheckoutIndependentId = 'test-manual-link-decision-independent'
  const decisionCheckoutAmbiguousAId = 'test-manual-link-decision-ambiguous-a'
  const decisionCheckoutAmbiguousBId = 'test-manual-link-decision-ambiguous-b'
  const deferredMergeCheckoutId = 'test-deferred-merge-checkout'
  const deferredMergeCheckinId = 'test-deferred-merge-checkin'
  const deferredMergeAssigneeId = 'test-deferred-merge-assignee'
  const deferredMergePropertyId = 'property-deferred-save-refresh'
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
    { id: turnoverCheckinId, property_id: 'property-turnover', task_date: '2026-09-16', date: '2026-09-16', task_type: 'checkin_clean', type: 'checkin_clean', status: 'assigned', execution_state: 'active', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang', linked_checkout_task_id: turnoverCheckoutId },
    { id: pureCheckinId, property_id: 'property-pure-checkin', task_date: '2026-09-16', date: '2026-09-16', task_type: 'checkin_clean', type: 'checkin_clean', status: 'assigned', execution_state: 'active', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang' },
    { id: dateMoveCheckoutId, property_id: 'property-pure-checkin', task_date: '2026-09-17', date: '2026-09-17', task_type: 'checkout_clean', type: 'checkout_clean', status: 'assigned', execution_state: 'active', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang' },
    { id: linkedCheckoutId, property_id: testPropertyId, task_date: '2026-09-19', date: '2026-09-19', task_type: 'checkout_clean', type: 'checkout_clean', status: 'assigned', execution_state: 'active', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang' },
    { id: decisionCheckoutUniqueId, property_id: testPropertyId, task_date: '2026-09-21', date: '2026-09-21', task_type: 'checkout_clean', type: 'checkout_clean', status: 'assigned', execution_state: 'active', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang' },
    { id: decisionCheckoutIndependentId, property_id: testPropertyId, task_date: '2026-09-22', date: '2026-09-22', task_type: 'checkout_clean', type: 'checkout_clean', status: 'assigned', execution_state: 'active', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang' },
    { id: decisionCheckoutAmbiguousAId, property_id: testPropertyId, task_date: '2026-09-23', date: '2026-09-23', task_type: 'checkout_clean', type: 'checkout_clean', status: 'assigned', execution_state: 'active', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang' },
    { id: decisionCheckoutAmbiguousBId, property_id: testPropertyId, task_date: '2026-09-23', date: '2026-09-23', task_type: 'checkout_clean', type: 'checkout_clean', status: 'assigned', execution_state: 'active', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang' },
    { id: deferredMergeCheckoutId, property_id: deferredMergePropertyId, task_date: '2026-09-18', date: '2026-09-18', task_type: 'checkout_clean', type: 'checkout_clean', status: 'assigned', execution_state: 'active', cleaner_id: 'test-original-cleaner', inspector_id: 'test-deferred-plan-inspector', inspection_mode: 'deferred', inspection_due_date: '2026-09-19', inspection_scope: 'inspect_and_hang', guest_special_request: '延期任务旧要求' },
    { id: deferredMergeCheckinId, property_id: deferredMergePropertyId, task_date: '2026-09-19', date: '2026-09-19', task_type: 'checkin_clean', type: 'checkin_clean', status: 'pending', execution_state: 'active', assignee_id: null, inspector_id: null, linked_checkout_task_id: deferredMergeCheckoutId, inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang', guest_special_request: '入住任务优先要求', checkin_time: '3pm' },
  )
  ;((db as any).properties ||= []).push(
    { id: testPropertyId, code: 'TEST-TURNOVER', region: 'Melbourne' },
    { id: deferredMergePropertyId, code: 'TEST-DEFERRED-SAVE', region: 'Melbourne' },
  )
  ;((db as any).users ||= []).push({
    id: deferredMergeAssigneeId,
    email: 'test-deferred-merge-assignee@example.invalid',
    username: 'Test Deferred Merge Assignee',
    role: 'cleaning_inspector',
  })
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
  const save = async (
    inspectionMode: string,
    inspectionDueDate: string | null,
    statusAction?: string,
    modeChangeAction?: 'set',
    targetTaskId = taskId,
    inspectionScope?: 'inspect_and_hang' | 'password_only',
    assigneeId?: string | null,
  ) => {
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
          ...(assigneeId !== undefined ? {
            assignee_id: assigneeId,
            assignee_assignment_action: assigneeId ? 'assign' : 'unassign',
          } : {}),
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
    const dateMoveIndependent = await postJson(`/cleaning/tasks/${pureCheckinId}`, { task_date: '2026-09-17' }, 'PATCH')
    assert.equal(dateMoveIndependent.status, 200, 'same room and date alone must not invent a turnover relation')
    assert.equal((db.cleaningTasks as any[]).find((item) => item.id === pureCheckinId)?.task_date, '2026-09-17')
    const manualTurnoverConflict = await postJson('/cleaning/tasks', {
      create_mode: 'turnover',
      task_date: '2026-09-18',
      property_id: testPropertyId,
      inspection_scope: 'password_only',
    })
    assert.equal(manualTurnoverConflict.status, 400)
    assert.equal(manualTurnoverConflict.body.code, 'turnover_requires_inspect_and_hang')
    const independentPasswordOnly = await postJson('/cleaning/tasks', {
      create_mode: 'checkin',
      task_date: '2026-09-20',
      property_id: testPropertyId,
      inspection_scope: 'password_only',
    })
    assert.equal(independentPasswordOnly.status, 200)
    assert.equal(independentPasswordOnly.body.inspection_scope, 'password_only')
    const unrelatedCheckout = await postJson('/cleaning/tasks', {
      create_mode: 'checkout',
      task_date: '2026-09-20',
      property_id: testPropertyId,
      inspection_scope: 'inspect_and_hang',
    })
    assert.equal(unrelatedCheckout.status, 200, 'an independent password-only check-in must not block an unrelated checkout on the same day')
    const unrelatedCheckoutPatch = await postJson(`/cleaning/tasks/${String(unrelatedCheckout.body.id)}`, {
      guest_special_request: 'updated without adopting the independent check-in',
    }, 'PATCH')
    assert.equal(unrelatedCheckoutPatch.status, 200, 'an independent password-only check-in must not poison later checkout edits')
    const uniqueDecisionRequired = await postJson('/cleaning/tasks', {
      create_mode: 'checkin',
      task_date: '2026-09-21',
      property_id: testPropertyId,
      inspection_scope: 'inspect_and_hang',
    })
    assert.equal(uniqueDecisionRequired.status, 409)
    assert.equal(uniqueDecisionRequired.body.code, 'manual_checkin_checkout_link_decision_required')
    assert.equal(uniqueDecisionRequired.body.candidate_count, 1)
    const uniqueLinked = await postJson('/cleaning/tasks', {
      create_mode: 'checkin',
      task_date: '2026-09-21',
      property_id: testPropertyId,
      linked_checkout_task_id: decisionCheckoutUniqueId,
      checkin_link_decision: 'link',
      inspection_scope: 'inspect_and_hang',
    })
    assert.equal(uniqueLinked.status, 200)
    assert.equal(uniqueLinked.body.linked_checkout_task_id, decisionCheckoutUniqueId)
    const contradictoryIndependent = await postJson('/cleaning/tasks', {
      create_mode: 'checkin',
      task_date: '2026-09-22',
      property_id: testPropertyId,
      linked_checkout_task_id: decisionCheckoutIndependentId,
      checkin_link_decision: 'independent',
    })
    assert.equal(contradictoryIndependent.status, 409)
    assert.equal(contradictoryIndependent.body.code, 'manual_checkin_checkout_link_conflict')
    const explicitIndependent = await postJson('/cleaning/tasks', {
      create_mode: 'checkin',
      task_date: '2026-09-22',
      property_id: testPropertyId,
      checkin_link_decision: 'independent',
      inspection_scope: 'password_only',
    })
    assert.equal(explicitIndependent.status, 200)
    assert.equal(explicitIndependent.body.linked_checkout_task_id, null)
    const unrelatedExistingCheckoutPatch = await postJson(`/cleaning/tasks/${decisionCheckoutIndependentId}`, {
      guest_special_request: 'independent check-in remains unrelated',
    }, 'PATCH')
    assert.equal(unrelatedExistingCheckoutPatch.status, 200, 'an explicit independent choice must not turn the same-day checkout into a turnover')
    const ambiguousDecisionRequired = await postJson('/cleaning/tasks', {
      create_mode: 'checkin',
      task_date: '2026-09-23',
      property_id: testPropertyId,
    })
    assert.equal(ambiguousDecisionRequired.status, 409)
    assert.equal(ambiguousDecisionRequired.body.code, 'manual_checkin_checkout_link_decision_required')
    assert.equal(ambiguousDecisionRequired.body.candidate_count, 2)
    const ambiguousSelected = await postJson('/cleaning/tasks', {
      create_mode: 'checkin',
      task_date: '2026-09-23',
      property_id: testPropertyId,
      linked_checkout_task_id: decisionCheckoutAmbiguousBId,
      checkin_link_decision: 'link',
    })
    assert.equal(ambiguousSelected.status, 200)
    assert.equal(ambiguousSelected.body.linked_checkout_task_id, decisionCheckoutAmbiguousBId)
    const noCandidateOldClient = await postJson('/cleaning/tasks', {
      create_mode: 'checkin',
      task_date: '2026-09-24',
      property_id: testPropertyId,
      inspection_scope: 'password_only',
    })
    assert.equal(noCandidateOldClient.status, 200, 'an old client remains compatible when no reliable checkout candidate exists')
    assert.equal(noCandidateOldClient.body.linked_checkout_task_id, null)
    const linkedCheckin = await postJson('/cleaning/tasks', {
      create_mode: 'checkin',
      task_date: '2026-09-19',
      property_id: testPropertyId,
      linked_checkout_task_id: linkedCheckoutId,
      inspection_mode: 'self_complete',
      inspection_scope: 'inspect_and_hang',
    })
    assert.equal(linkedCheckin.status, 200)
    assert.equal(linkedCheckin.body.linked_checkout_task_id, linkedCheckoutId)
    assert.equal(linkedCheckin.body.inspection_mode, 'self_complete', 'same-day scope enforcement must preserve the existing self-complete path')
    assert.equal(linkedCheckin.body.inspector_id, null, 'self-complete turnover must not create or infer a separate inspector')
    const duplicateLinkedCheckin = await postJson('/cleaning/tasks', {
      create_mode: 'checkin',
      task_date: '2026-09-19',
      property_id: testPropertyId,
      linked_checkout_task_id: linkedCheckoutId,
    })
    assert.equal(duplicateLinkedCheckin.status, 409)
    assert.equal(duplicateLinkedCheckin.body.code, 'manual_checkin_checkout_link_conflict')
    const crossDateLinkedCheckin = await postJson('/cleaning/tasks', {
      create_mode: 'checkin',
      task_date: '2026-09-20',
      property_id: testPropertyId,
      linked_checkout_task_id: linkedCheckoutId,
    })
    assert.equal(crossDateLinkedCheckin.status, 409)

    const beforeAssignment = await buildTaskCenterDay('2026-09-19', false, true, false, true)
    const beforeCards = beforeAssignment.rows.flatMap((row: any) => row.subrows.flatMap((subrow: any) => subrow.tasks))
      .filter((item: any) => item.property_id === deferredMergePropertyId && item.deferred_inspection_merged === true)
    assert.equal(beforeCards.length, 1, 'the linked deferred inspection and check-in render as one card before assignment')
    assert.equal(beforeCards[0]?.inspection_action_task_id, deferredMergeCheckinId)
    assert.equal(beforeCards[0]?.assignee_id, null, 'the deferred plan inspector must not fill an unassigned check-in')
    assert.equal(beforeCards[0]?.status, 'pending')

    const assignCheckin = await save(
      'same_day',
      null,
      undefined,
      undefined,
      deferredMergeCheckinId,
      'inspect_and_hang',
      deferredMergeAssigneeId,
    )
    assert.equal(assignCheckin.status, 200, JSON.stringify(assignCheckin.body))
    const assignedCheckinSource = (db.cleaningTasks as any[]).find((item) => item.id === deferredMergeCheckinId)
    const untouchedDeferredSource = (db.cleaningTasks as any[]).find((item) => item.id === deferredMergeCheckoutId)
    assert.equal(assignedCheckinSource?.assignee_id, deferredMergeAssigneeId, 'Task Center writes the selected executor to the check-in source')
    assert.equal(assignedCheckinSource?.status, 'assigned')
    assert.equal(untouchedDeferredSource?.inspector_id, 'test-deferred-plan-inspector', 'saving the check-in executor does not rewrite the deferred plan')

    const afterAssignment = await buildTaskCenterDay('2026-09-19', false, true, false, true)
    const afterCards = afterAssignment.rows.flatMap((row: any) => row.subrows.flatMap((subrow: any) => subrow.tasks))
      .filter((item: any) => item.property_id === deferredMergePropertyId && item.deferred_inspection_merged === true)
    assert.equal(afterCards.length, 1, 'refresh keeps one merged card after assignment')
    assert.equal(afterCards[0]?.inspection_action_task_id, deferredMergeCheckinId)
    assert.equal(afterCards[0]?.assignee_id, deferredMergeAssigneeId)
    assert.equal(afterCards[0]?.status, 'assigned')
    assert.equal(afterCards[0]?.cleaner_id, 'test-original-cleaner', 'the original cleaner remains attached after assigning the check-in')
    assert.equal(afterCards[0]?.guest_special_request, '入住任务优先要求')
    assert.equal(afterCards[0]?.turnover_display?.guest_request_summary, '入住任务优先要求')
    assert.equal(afterCards[0]?.deferred_inspection_original_checkout_date, '2026-09-18')
    assert.equal(afterCards[0]?.deferred_inspection_effective_date, '2026-09-19')
    assert.equal(afterCards[0]?.deferred_inspection_current_day_checkout, false)
    assert.equal(afterCards[0]?.task_kind, 'checkin_clean')
    assert.equal(afterCards[0]?.detail, '3pm入住')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const index = db.cleaningTasks.findIndex((item) => item.id === taskId)
    if (index >= 0) db.cleaningTasks.splice(index, 1)
    for (const id of [turnoverCheckoutId, turnoverCheckinId, pureCheckinId, dateMoveCheckoutId, linkedCheckoutId, decisionCheckoutUniqueId, decisionCheckoutIndependentId, decisionCheckoutAmbiguousAId, decisionCheckoutAmbiguousBId, deferredMergeCheckoutId, deferredMergeCheckinId]) {
      const fixtureIndex = db.cleaningTasks.findIndex((item) => item.id === id)
      if (fixtureIndex >= 0) db.cleaningTasks.splice(fixtureIndex, 1)
    }
    for (const propertyId of [testPropertyId, deferredMergePropertyId]) {
      const propertyIndex = ((db as any).properties || []).findIndex((item: any) => item.id === propertyId)
      if (propertyIndex >= 0) (db as any).properties.splice(propertyIndex, 1)
    }
    const userIndex = ((db as any).users || []).findIndex((item: any) => item.id === deferredMergeAssigneeId)
    if (userIndex >= 0) (db as any).users.splice(userIndex, 1)
  }
}

testTurnoverCheckoutAssignmentWinsOverPendingFallback()
testCheckinInspectionAssignmentUsesTheSavedExecutorWithoutMixingPeople()
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
testManualCheckinLinkMigrationIsGuardedAndTransactional()
testKeyHandoverSurvivesOrdinaryWorkflowChanges()
testManualKeysHungIsVisibleWithoutPretendingVideoEvidenceExists()
testKeyHandoverFactRequiresExactCurrentTaskMediaOrManualConfirmation()
testQueuedInspectionUsesCapturedBusinessDateOnlyWithExactEvidence()
testKeyHandoverMergeRequiresCanonicalSourceMembership()
testManagerProjectionKeepsCanonicalHandoverForVisiblePhaseSubset()
testCanonicalKeyHandoverTurnoverRequiresExactOrderBoundary()
testCanonicalTurnoverBusinessIdentityRejectsCancelledOrAmbiguousCandidates()
testPendingHandoverRecordMergesOnlyIntoItsExactLiveTurnover()
testDeferredInspectionDisplayAuthoritySurvivesBothProjectionStages()
testExplicitManualCheckinLinkIsCanonicalButNeverPropertyDateInferred()
testWorkTaskPayloadUsesExactAuditWithoutExposingMediaUrl()

testTaskCenterSaveBoardDoesNotEraseDeferredDate()
  .then(() => console.log('test_cleaning_inspection_merge: ok'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
