import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  authorizeDeferredInspectionCheckinSubmission,
  buildDeferredInspectionCheckinArrangements,
  deferredInspectionConflictSourceIds,
  deferredInspectionCheckinSubmissionGuard,
  deferredInspectionCheckinConflictEventId,
  findStoredDeferredInspectionCheckinReplacement,
  findDeferredInspectionCheckinReplacements,
  findDeferredInspectionCheckinConflicts,
  indexDeferredInspectionCheckinArrangements,
  isDeferredInspectionCheckinConflictRelevantChange,
  loadDeferredInspectionCheckinSubmissionGuard,
  mergeDeferredInspectionAwareActions,
} from '../../src/services/deferredInspectionCheckinConflict'
import { getAppNotificationPolicyCatalogMeta } from '../../src/services/appNotificationPolicies'
import { buildMz031CleaningArrangementRevision } from '../../src/services/workTaskEvents'

async function run() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/services/deferredInspectionCheckinConflict.ts'), 'utf8')
  const taskCenter = fs.readFileSync(path.resolve(__dirname, '../../src/modules/task_center.ts'), 'utf8')
  const mzapp = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
  const cleaningApp = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
  const inspectionAuditQuery = source.slice(source.indexOf('SELECT MIN(a.performed_at)'), source.indexOf('AS inspection_completed_at'))
  assert.doesNotMatch(inspectionAuditQuery, /item_count/)
  assert.match(inspectionAuditQuery, /<> 'mzapp\.cleaning_tasks\.restock_proof'/)
  assert.match(inspectionAuditQuery, /cleaning_app\.tasks\.inspection_photos/)
  assert.match(inspectionAuditQuery, /mzapp\.cleaning_tasks\.inspection_photos/)
  assert.strictEqual(buildMz031CleaningArrangementRevision(
    { task_date: '2026-08-01', cleaner_id: 'cleaner-1', status: 'assigned' },
    { task_date: '2026-08-01', cleaner_id: 'cleaner-1', status: 'completed' },
  ), null, 'management close is not an arrangement revision')
  assert.deepStrictEqual(buildMz031CleaningArrangementRevision(
    { task_date: '2026-08-01', cleaner_id: 'cleaner-1', status: 'assigned' },
    { task_date: '2026-08-03', cleaner_id: 'cleaner-2', status: 'assigned' },
  )?.reasons, ['scheduled_service_date_changed', 'assignment_changed'])
  assert.deepStrictEqual(buildMz031CleaningArrangementRevision(
    { task_date: '2026-08-01', cleaner_id: 'cleaner-1', inspection_mode: 'deferred', inspection_due_date: '2026-08-02' },
    { task_date: '2026-08-01', cleaner_id: 'cleaner-1', inspection_mode: 'deferred', inspection_due_date: '2026-08-04' },
  )?.reasons, ['inspection_plan_changed'])
  assert.deepStrictEqual(buildMz031CleaningArrangementRevision(
    { task_date: '2026-08-01', inspector_id: 'inspector-1', inspection_mode: 'deferred', inspection_due_date: '2026-08-02' },
    { task_date: '2026-08-01', inspector_id: 'inspector-1', inspection_mode: 'checked_done', inspection_due_date: null },
    ['deferred_replaced_by_completed_checkin'],
  )?.reasons, ['inspection_plan_changed', 'deferred_replaced_by_completed_checkin'])
  assert.match(source, /buildMz031CleaningArrangementRevision\(params\.before, params\.after, \[explicitReason\]\)/)
  assert.match(source, /payload: arrangementRevision \? \{ arrangement_revision: arrangementRevision \} : undefined/)
  assert.match(source, /changeScope: 'membership'/)
  assert.match(taskCenter, /'inspection_mode',[\s\S]*'inspection_scope',[\s\S]*'inspection_due_date'/)
  assert.match(mzapp, /inspection_action_task_id:[\s\S]*checkin_task_id/)
  assert.match(mzapp, /mergeDeferredInspectionAwareActions\(actionGroups, blockedInspectionSourceIds\)/)
  assert.match(mzapp, /inspectionAssignmentConflicts = arr[\s\S]*deferredInspectionConflictSourceIds\(inspectionAssignmentConflicts\)/)
  assert.match(mzapp, /__inspection_conflict_source_ids/)
  assert.match(source, /disabled_reason: 'inspection_arrangement_conflict'/)
  assert.match(mzapp, /__merged_children: \[linkedInspectionActionChild\]/)
  assert.match(mzapp, /withInspectionMergeIsolation\([\s\S]*managerMergeIsolationKey/)
  assert.match(mzapp, /withInspectionMergeIsolation\([\s\S]*?`\$\{inspectorDisplayDate\}\|\$\{rowBusinessIdentity\}[\s\S]*?managerMergeIsolationKey/)
  assert.match(mzapp, /nextCheckinsForCheckout = p\.kind === 'checkout' && !managerMergeIsolationKey/)
  assert.match(mzapp, /projectCleaningKeyHandover\([\s\S]*?lockboxVideoUrl: row\.has_current_lockbox_video/)
  assert.match(mzapp, /__lockbox_video_confirms_current_state/)
  assert.match(mzapp, /__manager_merge_isolation_key,[\s\S]*__lockbox_video_confirms_current_state,[\s\S]*property_ready_for_guest_notification/)
  assert.strictEqual((mzapp.match(/loadDeferredInspectionCheckinSubmissionGuard\(\{ taskId:/g) || []).length, 1)
  assert.strictEqual((cleaningApp.match(/loadDeferredInspectionCheckinSubmissionGuard\(\{ taskId:/g) || []).length, 0)
  assert.strictEqual((mzapp.match(/authorizeDeferredInspectionCheckinSubmission\(\{/g) || []).length, 1)
  assert.strictEqual((cleaningApp.match(/authorizeDeferredInspectionCheckinSubmission\(\{/g) || []).length, 3)
  assert.strictEqual((mzapp.match(/message: transactionResult\.guard\.reason/g) || []).length, 2)
  assert.strictEqual((cleaningApp.match(/message: transactionResult\.guard\.reason/g) || []).length, 3)
  const guardedWriteRoutes = [
    cleaningApp.slice(cleaningApp.indexOf("router.post('/tasks/:id/inspection-complete'"), cleaningApp.indexOf('function canViewDayEndForAllUsers')),
    cleaningApp.slice(cleaningApp.indexOf("router.post('/tasks/:id/inspection-photos'"), cleaningApp.indexOf("router.post('/tasks/:id/inspection-issue-photos'")),
    cleaningApp.slice(cleaningApp.indexOf("router.post('/tasks/:id/lockbox-video'"), cleaningApp.indexOf('async function handleDeleteLockboxVideo')),
    mzapp.slice(mzapp.indexOf("router.post('/cleaning-tasks/:id/inspection-photos'"), mzapp.indexOf("router.get('/cleaning-tasks/:id/completion-photos'")),
  ]
  for (const route of guardedWriteRoutes) {
    assert.match(route, /authorizeDeferredInspectionCheckinSubmission\(\{/, 'write route must authorize the target before exposing conflict metadata')
    assert.doesNotMatch(route, /loadDeferredInspectionCheckinSubmissionGuard\(\{/, 'write route must not call the metadata-bearing guard before task authorization')
    assert.ok(route.indexOf("kind === 'forbidden'") < route.indexOf("kind === 'inspection_arrangement_conflict'"), '403 must be selected before the 409 conflict response')
  }
  const conflicts = findDeferredInspectionCheckinConflicts([
    {
      id: 'deferred-a',
      property_id: 'property-a',
      task_type: 'checkout_clean',
      task_date: '2026-08-03',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-08-05',
      status: 'assigned',
      execution_state: 'active',
    },
    {
      id: 'checkin-a',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-04',
      inspection_scope: 'inspect_and_hang',
      checkin_time: '15:00',
      status: 'assigned',
      execution_state: 'active',
    },
    {
      id: 'checkin-same-day',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-05',
      inspection_scope: 'inspect_and_hang',
      inspection_completed_at: '2026-08-01T05:00:00.000Z',
      status: 'pending',
      execution_state: 'active',
    },
    {
      id: 'checkin-later',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-06',
      inspection_scope: 'inspect_and_hang',
      status: 'pending',
      execution_state: 'active',
    },
    {
      id: 'checkin-other-property',
      property_id: 'property-b',
      task_type: 'checkin_clean',
      task_date: '2026-08-04',
      inspection_scope: 'inspect_and_hang',
      status: 'pending',
      execution_state: 'active',
    },
  ])

  assert.deepStrictEqual(conflicts.map((conflict) => conflict.checkin_task_id), ['checkin-a', 'checkin-same-day'])
  assert.strictEqual(conflicts[0].checkin_time, '15:00')
  assert.ok(deferredInspectionCheckinConflictEventId(conflicts[0]).includes('deferred-a:checkin-a:2026-08-05:2026-08-04:15:00'))

  const replacements = findDeferredInspectionCheckinReplacements([
    {
      id: 'deferred-replace',
      property_id: 'property-a',
      task_type: 'checkout_clean',
      task_date: '2026-08-01',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-08-02',
      inspector_id: 'oscar',
      status: 'pending',
      execution_state: 'active',
    },
    {
      id: 'checkin-same-day-replace',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-01',
      inspection_scope: 'inspect_and_hang',
      assignee_id: 'oscar',
      inspection_completed_at: '2026-08-01T05:00:00.000Z',
      status: 'pending',
      execution_state: 'active',
    },
    {
      id: 'checkin-before-checkout',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-07-31',
      inspection_scope: 'inspect_and_hang',
      status: 'pending',
      execution_state: 'active',
    },
  ])
  assert.deepStrictEqual(replacements.map((replacement) => ({
    deferred: replacement.deferred_task_id,
    checkin: replacement.checkin_task_id,
    deferredDate: replacement.deferred_task_date,
    dueDate: replacement.inspection_due_date,
  })), [{
    deferred: 'deferred-replace',
    checkin: 'checkin-same-day-replace',
    deferredDate: '2026-08-01',
    dueDate: '2026-08-02',
  }])

  const notYetInspected = findDeferredInspectionCheckinReplacements([
    {
      id: 'deferred-awaiting-checkin-inspection',
      property_id: 'property-a',
      task_type: 'checkout_clean',
      task_date: '2026-08-01',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-08-02',
      inspector_id: 'oscar',
      status: 'pending',
    },
    {
      id: 'checkin-created-only',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-02',
      inspection_scope: 'inspect_and_hang',
      assignee_id: 'oscar',
      status: 'assigned',
    },
  ])
  assert.deepStrictEqual(notYetInspected, [], 'a check-in assignment is not proof that inspection work finished')

  const unsafeReplacementBase = [
    {
      id: 'deferred-unsafe', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
      inspection_mode: 'deferred', inspection_due_date: '2026-08-05', inspector_id: 'oscar', status: 'assigned',
    },
    {
      id: 'checkin-unsafe', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-03',
      inspection_scope: 'inspect_and_hang', assignee_id: 'barbara', status: 'inspected',
      inspection_completed_at: '2026-08-03T05:00:00.000Z',
    },
  ]
  assert.deepStrictEqual(
    findDeferredInspectionCheckinReplacements(unsafeReplacementBase),
    [],
    'a completed check-in with the wrong executor must not auto-complete the deferred inspection',
  )
  assert.deepStrictEqual(findDeferredInspectionCheckinReplacements([
    { ...unsafeReplacementBase[0] },
    { ...unsafeReplacementBase[1], id: 'checkin-safe-a', assignee_id: 'oscar' },
    { ...unsafeReplacementBase[1], id: 'checkin-safe-b', assignee_id: 'oscar', task_date: '2026-08-04' },
  ]), [], 'multiple completed check-ins must not pick a deterministic replacement')
  assert.deepStrictEqual(findDeferredInspectionCheckinReplacements([
    { ...unsafeReplacementBase[0], id: 'deferred-safe-a' },
    { ...unsafeReplacementBase[0], id: 'deferred-safe-b', task_date: '2026-08-02' },
    { ...unsafeReplacementBase[1], id: 'shared-checkin', assignee_id: 'oscar' },
  ]), [], 'multiple deferred inspections must not claim the same completed check-in')

  const storedDeferred = {
    id: 'stored-deferred', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
    inspection_mode: 'checked_done', inspection_due_date: null, inspector_id: 'oscar', status: 'assigned',
    inspection_replaced_by_checkin_task_id: 'old-checkin', inspection_replaced_original_due_date: '2026-08-05',
  }
  const safeRelinkCheckin = {
    id: 'safe-relink', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-03',
    inspection_scope: 'inspect_and_hang', assignee_id: 'oscar', status: 'inspected',
    inspection_completed_at: '2026-08-03T05:00:00.000Z',
  }
  assert.strictEqual(
    findStoredDeferredInspectionCheckinReplacement([storedDeferred, safeRelinkCheckin], 'stored-deferred')?.checkin_task_id,
    'safe-relink',
  )
  assert.strictEqual(findStoredDeferredInspectionCheckinReplacement([
    storedDeferred,
    safeRelinkCheckin,
    { ...safeRelinkCheckin, id: 'second-relink', task_date: '2026-08-04' },
  ], 'stored-deferred'), null, 'stored replacement relinking must also fail closed on multiple candidates')

  const passwordOnlyReplacements = findDeferredInspectionCheckinReplacements([
    {
      id: 'deferred-password-only',
      property_id: 'property-a',
      task_type: 'checkout_clean',
      task_date: '2026-08-01',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-08-02',
      status: 'pending',
    },
    {
      id: 'password-only-checkin',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-02',
      inspection_scope: 'password_only',
      status: 'pending',
    },
  ])
  assert.deepStrictEqual(passwordOnlyReplacements, [])

  const passwordActionBeforeConflictingChild = mergeDeferredInspectionAwareActions([
    [{ id: 'upload_access_video', source_id: 'password-independent', enabled: true }],
    [{ id: 'upload_access_video', source_id: 'deferred-conflict', enabled: true }],
    [{ id: 'upload_access_video', source_id: 'checkin-conflict', enabled: true }],
  ], new Set(['deferred-conflict', 'checkin-conflict']))
  assert.deepStrictEqual(passwordActionBeforeConflictingChild, [
    { id: 'upload_access_video', source_id: 'password-independent', enabled: true },
  ], 'a later conflict child must not overwrite an independent password-only action')

  const conflictingParentBeforePasswordChild = mergeDeferredInspectionAwareActions([
    [{ id: 'upload_access_video', source_id: 'deferred-conflict', enabled: true }],
    [{ id: 'upload_access_video', source_id: 'password-independent', enabled: false, disabled_reason: 'task_completed' }],
  ], new Set(['deferred-conflict']))
  assert.deepStrictEqual(conflictingParentBeforePasswordChild, [
    { id: 'upload_access_video', source_id: 'password-independent', enabled: false, disabled_reason: 'task_completed' },
  ], 'an independent password-only action wins even when it is disabled for its own lifecycle reason')

  const onlyConflictingActions = mergeDeferredInspectionAwareActions([
    [{ id: 'submit_inspection', source_id: 'deferred-conflict', enabled: true }],
  ], new Set(['deferred-conflict']))
  assert.deepStrictEqual(onlyConflictingActions, [{
    id: 'submit_inspection',
    source_id: 'deferred-conflict',
    enabled: false,
    disabled_reason: 'inspection_arrangement_conflict',
  }])

  const twoConflictGroupSources = deferredInspectionConflictSourceIds([
    {
      deferred_task_id: 'deferred-conflict-a',
      checkin_task_id: 'checkin-conflict-a',
      checkin_task_ids: ['checkin-conflict-a', 'checkin-conflict-a-duplicate'],
    },
    {
      deferred_task_id: 'deferred-conflict-b',
      checkin_task_id: 'checkin-conflict-b',
      checkin_task_ids: ['checkin-conflict-b'],
    },
  ])
  assert.deepStrictEqual(twoConflictGroupSources, [
    'deferred-conflict-a',
    'checkin-conflict-a',
    'checkin-conflict-a-duplicate',
    'deferred-conflict-b',
    'checkin-conflict-b',
  ])
  assert.deepStrictEqual(mergeDeferredInspectionAwareActions([
    [{ id: 'upload_access_video', source_id: 'password-independent', enabled: true }],
    [{ id: 'upload_access_video', source_id: 'deferred-conflict-a', enabled: true }],
    [{ id: 'upload_access_video', source_id: 'deferred-conflict-b', enabled: true }],
  ], twoConflictGroupSources), [
    { id: 'upload_access_video', source_id: 'password-independent', enabled: true },
  ], 'manager merges must block every conflict group while retaining independent password-only work')

  const arrangements = buildDeferredInspectionCheckinArrangements([
    {
      id: 'deferred-linked', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
      inspection_mode: 'deferred', inspection_due_date: '2026-08-02', inspector_id: 'oscar', status: 'assigned',
    },
    {
      id: 'checkin-linked', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-02',
      inspection_scope: 'inspect_and_hang', assignee_id: 'oscar', status: 'assigned',
    },
    {
      id: 'password-independent', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-02',
      inspection_scope: 'password_only', assignee_id: 'oscar', status: 'assigned',
    },
  ])
  assert.deepStrictEqual(arrangements, [{
    deferred_task_id: 'deferred-linked',
    checkin_task_id: 'checkin-linked',
    checkin_task_ids: ['checkin-linked'],
    property_id: 'property-a',
    original_checkout_date: '2026-08-01',
    effective_inspection_date: '2026-08-02',
    planned_inspector_id: 'oscar',
    checkin_inspector_id: null,
    checkin_assignee_id: 'oscar',
    conflict_reasons: [],
  }])
  const arrangementIndex = indexDeferredInspectionCheckinArrangements(arrangements)
  assert.strictEqual(arrangementIndex.get('deferred-linked')?.[0], arrangements[0])
  assert.strictEqual(arrangementIndex.get('checkin-linked')?.[0], arrangements[0])
  assert.strictEqual(arrangementIndex.has('password-independent'), false)
  assert.deepStrictEqual(
    deferredInspectionCheckinSubmissionGuard([
      {
        id: 'deferred-linked', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
        inspection_mode: 'deferred', inspection_due_date: '2026-08-02', inspector_id: 'oscar', status: 'assigned',
      },
      {
        id: 'checkin-linked', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-02',
        inspection_scope: 'inspect_and_hang', assignee_id: 'oscar', status: 'assigned',
      },
    ], 'checkin-linked'),
    { blocked: false, reason: null, canonical_action_task_id: null, conflicts: [] },
  )
  const redirectedDeferredGuard = deferredInspectionCheckinSubmissionGuard([
    {
      id: 'deferred-linked', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
      inspection_mode: 'deferred', inspection_due_date: '2026-08-02', inspector_id: 'oscar', status: 'assigned',
    },
    {
      id: 'checkin-linked', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-02',
      inspection_scope: 'inspect_and_hang', assignee_id: 'oscar', status: 'assigned',
    },
  ], 'deferred-linked')
  assert.strictEqual(redirectedDeferredGuard.blocked, true)
  assert.strictEqual(redirectedDeferredGuard.reason, 'inspection_action_moved_to_checkin_task')
  assert.strictEqual(redirectedDeferredGuard.canonical_action_task_id, 'checkin-linked')

  const mismatchedArrangement = buildDeferredInspectionCheckinArrangements([
    {
      id: 'deferred-mismatch', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
      inspection_mode: 'deferred', inspection_due_date: '2026-08-02', inspector_id: 'oscar', status: 'assigned',
    },
    {
      id: 'checkin-mismatch', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-02',
      inspection_scope: 'inspect_and_hang', assignee_id: 'barbara', status: 'assigned',
    },
  ])[0]
  assert.ok(mismatchedArrangement.conflict_reasons.includes('checkin_executor_mismatch'))
  assert.ok(mismatchedArrangement.conflict_reasons.includes('planned_inspector_not_checkin_participant'))

  const earlierCheckinArrangement = buildDeferredInspectionCheckinArrangements([
    {
      id: 'deferred-later-due', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
      inspection_mode: 'deferred', inspection_due_date: '2026-08-05', inspector_id: 'oscar', status: 'assigned',
    },
    {
      id: 'checkin-before-due', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-03',
      inspection_scope: 'inspect_and_hang', assignee_id: 'oscar', status: 'assigned',
    },
  ])[0]
  assert.strictEqual(earlierCheckinArrangement.effective_inspection_date, '2026-08-03')
  assert.strictEqual(earlierCheckinArrangement.checkin_task_id, 'checkin-before-due')

  const duplicateExecutionRows = [
    {
      id: 'deferred-duplicate', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
      inspection_mode: 'deferred', inspection_due_date: '2026-08-05', inspector_id: 'oscar', status: 'assigned',
    },
    {
      id: 'checkin-duplicate-a', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-02',
      inspection_scope: 'inspect_and_hang', assignee_id: 'oscar', status: 'assigned',
    },
    {
      id: 'checkin-duplicate-b', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-03',
      inspection_scope: 'inspect_and_hang', assignee_id: 'oscar', status: 'assigned',
    },
    {
      id: 'password-stays-independent', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-02',
      inspection_scope: 'password_only', assignee_id: 'barbara', status: 'assigned',
    },
  ]
  for (const taskId of ['deferred-duplicate', 'checkin-duplicate-a', 'checkin-duplicate-b']) {
    const guard = deferredInspectionCheckinSubmissionGuard(duplicateExecutionRows, taskId)
    assert.strictEqual(guard.blocked, true, `${taskId} must fail closed`)
    assert.ok(guard.conflicts[0].conflict_reasons.includes('multiple_checkin_inspection_tasks'))
  }
  assert.deepStrictEqual(
    deferredInspectionCheckinSubmissionGuard(duplicateExecutionRows, 'password-stays-independent'),
    { blocked: false, reason: null, canonical_action_task_id: null, conflicts: [] },
  )
  const guardQueries: Array<{ sql: string; params: any[] }> = []
  const transactionalGuard = await loadDeferredInspectionCheckinSubmissionGuard({
    taskId: 'checkin-duplicate-a',
    client: {
      async query(sql: string, params: any[]) {
        guardQueries.push({ sql, params })
        if (guardQueries.length === 1) {
          return { rows: [{
            id: 'checkin-duplicate-a', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-02',
            inspection_scope: 'inspect_and_hang', status: 'assigned', execution_state: 'active',
          }] }
        }
        if (guardQueries.length === 2) return { rows: [{ window_start: '2026-08-01', window_end: '2026-08-05' }] }
        return { rows: duplicateExecutionRows }
      },
    },
  })
  assert.strictEqual(transactionalGuard.blocked, true)
  assert.ok(transactionalGuard.conflicts[0].conflict_reasons.includes('multiple_checkin_inspection_tasks'))
  assert.deepStrictEqual(guardQueries[2].params, ['property-a', '2026-08-01', '2026-08-05'])
  assert.match(guardQueries[2].sql, /ORDER BY t\.id::text\s+FOR UPDATE OF t/)

  const authorizationTarget = {
    id: 'checkin-duplicate-a', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-02',
    inspection_scope: 'inspect_and_hang', status: 'assigned', execution_state: 'active',
  }
  const authorizationClient = () => {
    const queries: string[] = []
    return {
      queries,
      async query(sql: string) {
        queries.push(sql)
        assert.match(sql, /^\s*SELECT\b/i, 'authorization/conflict checks must not write')
        if (/ORDER BY t\.id::text\s+FOR UPDATE OF t/.test(sql)) return { rows: duplicateExecutionRows }
        if (/MIN\(COALESCE\(deferred\.task_date/.test(sql)) return { rows: [{ window_start: '2026-08-01', window_end: '2026-08-05' }] }
        return { rows: [authorizationTarget] }
      },
    }
  }
  for (const role of ['customer_service', 'admin', 'offline_manager']) {
    const client = authorizationClient()
    const user = { role, taskAccess: true }
    let authorizationChecks = 0
    const result = await authorizeDeferredInspectionCheckinSubmission({
      taskId: authorizationTarget.id,
      client,
      canSubmit: async () => {
        authorizationChecks += 1
        return user.taskAccess
      },
    })
    assert.strictEqual(result.kind, 'inspection_arrangement_conflict', `${role} with task access must retain the 409 conflict path`)
    assert.strictEqual(authorizationChecks, 2, `${role} task access must be checked before and after the conflict lookup`)
    assert.ok(result.kind === 'inspection_arrangement_conflict' && result.guard.conflicts.length > 0)
  }
  const forbiddenClient = authorizationClient()
  const roleOnlyUser = { role: 'admin', taskAccess: false }
  const forbiddenResult = await authorizeDeferredInspectionCheckinSubmission({
    taskId: authorizationTarget.id,
    client: forbiddenClient,
    canSubmit: async () => roleOnlyUser.taskAccess,
  })
  assert.deepStrictEqual(forbiddenResult, { kind: 'forbidden' }, 'role without task access must get metadata-free 403 semantics')
  assert.strictEqual(forbiddenClient.queries.length, 1, 'forbidden callers must not run the conflict lookup or any write')

  const resolvedConflict = findDeferredInspectionCheckinConflicts([
    {
      id: 'deferred-done',
      property_id: 'property-a',
      task_date: '2026-08-03',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-08-05',
      status: 'completed',
    },
    {
      id: 'checkin-active',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-04',
      status: 'pending',
    },
  ])
  assert.deepStrictEqual(resolvedConflict, [])

  assert.strictEqual(isDeferredInspectionCheckinConflictRelevantChange(['inspector_id']), true)
  assert.strictEqual(isDeferredInspectionCheckinConflictRelevantChange(['assignee_id']), true)
  assert.strictEqual(isDeferredInspectionCheckinConflictRelevantChange(['inspection_due_date']), true)
  assert.strictEqual(isDeferredInspectionCheckinConflictRelevantChange(['inspection_scope']), true)
  assert.strictEqual(isDeferredInspectionCheckinConflictRelevantChange(['task_date']), true)

  const policy = getAppNotificationPolicyCatalogMeta('deferred_inspection_checkin_conflict')
  assert.strictEqual(policy.default_template_key, 'ops_manager_only')
  assert.deepStrictEqual(policy.source_event_types, ['CLEANING_TASK_UPDATED'])

  console.log('ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
