import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  authorizeDeferredInspectionCheckinSubmission,
  buildDeferredInspectionCheckinArrangements,
  deferredInspectionConflictSourceIds,
  deferredInspectionCheckinSubmissionGuard,
  deferredInspectionEvidenceAccessContext,
  deferredInspectionReorderAccessContext,
  deferredInspectionCheckinConflictEventId,
  findStoredDeferredInspectionCheckinReplacement,
  findDeferredInspectionCheckinReplacements,
  findDeferredInspectionCheckinConflicts,
  indexDeferredInspectionCheckinArrangements,
  isDeferredInspectionCheckinConflictRelevantChange,
  loadDeferredInspectionCheckinSubmissionGuard,
  loadDeferredInspectionEvidenceAccessContext,
  loadDeferredInspectionReorderAccessContext,
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
  assert.match(mzapp, /const mergedActionChildren = \[linkedInspectionActionChild\]\.filter\(Boolean\)/)
  assert.doesNotMatch(mzapp, /pendingHandoverActionChild/)
  assert.match(mzapp, /__merged_children: mergedActionChildren/)
  assert.match(mzapp, /withInspectionMergeIsolation\([\s\S]*managerMergeIsolationKey/)
  assert.match(mzapp, /withInspectionMergeIsolation\([\s\S]*?`\$\{inspectorDisplayDate\}\|\$\{rowBusinessIdentity\}[\s\S]*?managerMergeIsolationKey/)
  assert.match(mzapp, /nextCheckinsForCheckout = p\.kind === 'checkout' && !managerMergeIsolationKey/)
  assert.match(mzapp, /projectCleaningKeyHandover\([\s\S]*?lockboxVideoUrl: row\.has_current_lockbox_video/)
  assert.match(mzapp, /__lockbox_video_confirms_current_state/)
  assert.match(mzapp, /__manager_merge_isolation_key,[\s\S]*__lockbox_video_confirms_current_state,[\s\S]*property_ready_for_guest_notification/)
  assert.strictEqual((mzapp.match(/loadDeferredInspectionCheckinSubmissionGuard\(\{ taskId:/g) || []).length, 1)
  assert.strictEqual((cleaningApp.match(/loadDeferredInspectionCheckinSubmissionGuard\(\{ taskId:/g) || []).length, 0)
  assert.strictEqual((mzapp.match(/authorizeDeferredInspectionCheckinSubmission\(\{/g) || []).length, 2)
  assert.strictEqual((cleaningApp.match(/authorizeDeferredInspectionCheckinSubmission\(\{/g) || []).length, 3)
  assert.strictEqual((mzapp.match(/message: transactionResult\.guard\.reason/g) || []).length, 3)
  assert.strictEqual((cleaningApp.match(/message: transactionResult\.guard\.reason/g) || []).length, 3)
  const guardedWriteRoutes = [
    cleaningApp.slice(cleaningApp.indexOf("router.post('/tasks/:id/inspection-complete'"), cleaningApp.indexOf('function canViewDayEndForAllUsers')),
    cleaningApp.slice(cleaningApp.indexOf("router.post('/tasks/:id/inspection-photos'"), cleaningApp.indexOf("router.post('/tasks/:id/inspection-issue-photos'")),
    cleaningApp.slice(cleaningApp.indexOf("router.post('/tasks/:id/lockbox-video'"), cleaningApp.indexOf('async function handleDeleteLockboxVideo')),
    mzapp.slice(mzapp.indexOf("router.post('/cleaning-tasks/:id/inspection-photos'"), mzapp.indexOf("router.get('/cleaning-tasks/:id/completion-photos'")),
    mzapp.slice(mzapp.indexOf("router.post('/cleaning-tasks/:id/restock-proof'"), mzapp.indexOf('async function expandGuestCheckoutTaskIds')),
  ]
  for (const route of guardedWriteRoutes) {
    assert.match(route, /authorizeDeferredInspectionCheckinSubmission\(\{/, 'write route must authorize the target before exposing conflict metadata')
    assert.doesNotMatch(route, /loadDeferredInspectionCheckinSubmissionGuard\(\{/, 'write route must not call the metadata-bearing guard before task authorization')
    assert.ok(route.indexOf("kind === 'forbidden'") < route.indexOf("kind === 'inspection_arrangement_conflict'"), '403 must be selected before the 409 conflict response')
  }
  const consumablesReadRoute = mzapp.slice(
    mzapp.indexOf("router.get('/cleaning-tasks/:id/consumables'"),
    mzapp.indexOf("router.post('/cleaning-tasks/:id/inspection-photos'"),
  )
  assert.match(consumablesReadRoute, /loadDeferredInspectionEvidenceAccessContext\(\{/)
  assert.match(consumablesReadRoute, /canSubmitMzappInspection\(user, deferredContext\.actionTask, userId, pgPool\)/)
  const mixedReorderRoute = mzapp.slice(
    mzapp.indexOf("router.post('/work-tasks/mixed-reorder'"),
    mzapp.indexOf('const workTaskPhotosSchema'),
  )
  assert.strictEqual((mixedReorderRoute.match(/loadDeferredInspectionReorderAccessContext\(\{/g) || []).length, 1)
  assert.match(mixedReorderRoute, /const takeoverCandidateIds = inspectorEntries[\s\S]*?\.sort\(\(left, right\) => left\.localeCompare\(right\)\)/)
  assert.match(mixedReorderRoute, /OR t\.id::text = ANY\(\$4::text\[\]\)/)
  assert.match(mixedReorderRoute, /SET sort_index_inspector = v\.sort_index, updated_at = now\(\)/, 'the repair must remain an ordering-only write')
  assert.match(mixedReorderRoute, /client\.query\('BEGIN'\)[\s\S]*?loadDeferredInspectionReorderAccessContext[\s\S]*?UPDATE cleaning_tasks AS t[\s\S]*?rowCount[\s\S]*?client\.query\('ROLLBACK'\)/, 'takeover checks and every mixed reorder write must remain in one rollback-capable transaction')
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
      inspection_scope: 'inspect_and_hang', linked_checkout_task_id: 'deferred-linked', assignee_id: 'oscar', status: 'assigned',
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
    display_merge_eligible: true,
    display_merge_reasons: [],
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
        inspection_scope: 'inspect_and_hang', linked_checkout_task_id: 'deferred-linked', assignee_id: 'oscar', status: 'assigned',
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
      inspection_scope: 'inspect_and_hang', linked_checkout_task_id: 'deferred-linked', assignee_id: 'oscar', status: 'assigned',
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
      inspection_scope: 'inspect_and_hang', linked_checkout_task_id: 'deferred-mismatch', assignee_id: 'barbara', status: 'assigned',
    },
  ])[0]
  assert.deepStrictEqual(mismatchedArrangement.conflict_reasons, [], 'one reliable linked execution-day task records a reassignment instead of inventing a second inspector')
  assert.strictEqual(mismatchedArrangement.display_merge_eligible, true, 'display uses the linked check-in arrangement even when its executor differs from the deferred plan')
  assert.deepStrictEqual(
    deferredInspectionCheckinSubmissionGuard([
      {
        id: 'deferred-mismatch', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
        inspection_mode: 'deferred', inspection_due_date: '2026-08-02', inspector_id: 'oscar', status: 'assigned',
      },
      {
        id: 'checkin-mismatch', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-02',
        inspection_scope: 'inspect_and_hang', linked_checkout_task_id: 'deferred-mismatch', assignee_id: 'barbara', status: 'assigned',
      },
    ], 'checkin-mismatch'),
    { blocked: false, reason: null, canonical_action_task_id: null, conflicts: [] },
    'the current check-in executor may submit the reassigned inspection',
  )

  const unassignedLinkedArrangement = buildDeferredInspectionCheckinArrangements([
    {
      id: 'deferred-unassigned', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
      inspection_mode: 'deferred', inspection_due_date: '2026-08-02', inspector_id: 'oscar', status: 'assigned',
    },
    {
      id: 'checkin-unassigned', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-02',
      inspection_scope: 'inspect_and_hang', linked_checkout_task_id: 'deferred-unassigned', status: 'pending',
    },
  ])[0]
  assert.strictEqual(unassignedLinkedArrangement.display_merge_eligible, true)
  assert.strictEqual(unassignedLinkedArrangement.checkin_assignee_id, null)
  assert.ok(unassignedLinkedArrangement.conflict_reasons.includes('checkin_executor_missing'), 'submission guard remains fail-closed while display remains merged and unassigned')

  const uniquelyLinkedSameDayArrangement = buildDeferredInspectionCheckinArrangements([
    {
      id: 'deferred-unique-link', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
      inspection_mode: 'deferred', inspection_due_date: '2026-08-03', inspector_id: 'oscar', status: 'assigned',
    },
    {
      id: 'unrelated-earlier-checkin', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-02',
      inspection_scope: 'inspect_and_hang', assignee_id: 'barbara', status: 'assigned',
    },
    {
      id: 'reliably-linked-checkin', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-03',
      inspection_scope: 'inspect_and_hang', linked_checkout_task_id: 'deferred-unique-link', assignee_id: 'mia', status: 'assigned',
    },
  ])[0]
  assert.strictEqual(uniquelyLinkedSameDayArrangement.checkin_task_id, 'reliably-linked-checkin')
  assert.strictEqual(uniquelyLinkedSameDayArrangement.display_merge_eligible, true, 'one reliable same-turnover relation wins over an unrelated same-property task in the wider deferred window')

  const ambiguousReliableArrangement = buildDeferredInspectionCheckinArrangements([
    {
      id: 'deferred-ambiguous-link', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
      inspection_mode: 'deferred', inspection_due_date: '2026-08-03', inspector_id: 'oscar', status: 'assigned',
    },
    ...['a', 'b'].map((suffix) => ({
      id: `reliably-linked-${suffix}`, property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-03',
      inspection_scope: 'inspect_and_hang', linked_checkout_task_id: 'deferred-ambiguous-link', assignee_id: 'mia', status: 'assigned',
    })),
  ])[0]
  assert.strictEqual(ambiguousReliableArrangement.display_merge_eligible, false)
  assert.ok(ambiguousReliableArrangement.display_merge_reasons.includes('multiple_reliable_checkin_inspection_tasks'))

  const msq4206Rows = [
    {
      id: 'msq4206-checkout', property_id: 'msq4206', task_type: 'checkout_clean', task_date: '2026-10-26',
      inspection_mode: 'deferred', inspection_due_date: '2026-10-27', inspector_id: 'oscar', cleaner_id: 'carrie',
      order_id: 'checkout-order', order_status: 'confirmed', order_checkout: '2026-10-26', status: 'cleaned', execution_state: 'active',
    },
    {
      id: 'msq4206-checkin', property_id: 'msq4206', task_type: 'checkin_clean', task_date: '2026-10-27',
      inspection_scope: 'inspect_and_hang', assignee_id: 'angela', order_id: 'checkin-order', order_status: 'confirmed',
      order_checkin: '2026-10-27', status: 'assigned', execution_state: 'active',
    },
  ]
  const msq4206Arrangement = buildDeferredInspectionCheckinArrangements(msq4206Rows)[0]
  assert.ok(msq4206Arrangement.display_merge_eligible, 'exact adjacent order boundaries may express the reliable turnover without a stored manual link')
  assert.deepStrictEqual(msq4206Arrangement.conflict_reasons, [], 'the old deferred plan is historical after the unique current task is assigned')
  assert.strictEqual(
    deferredInspectionEvidenceAccessContext(msq4206Rows, 'msq4206-checkout', 'angela')?.actionTask?.id,
    'msq4206-checkin',
    'the current executor may read exact prior cleaning consumables through the reliable turnover',
  )
  assert.strictEqual(
    deferredInspectionEvidenceAccessContext(msq4206Rows, 'msq4206-checkout', 'oscar'),
    null,
    'the superseded planned inspector is not the current read-through executor',
  )
  assert.deepStrictEqual(
    deferredInspectionCheckinSubmissionGuard(msq4206Rows, 'msq4206-checkout'),
    {
      blocked: true,
      reason: 'inspection_action_moved_to_checkin_task',
      canonical_action_task_id: 'msq4206-checkin',
      conflicts: [],
    },
    'the former planned inspector cannot keep writing through the old checkout source',
  )
  const msq3401Rows = [
    {
      ...msq4206Rows[0],
      id: 'msq3401-deferred',
      property_id: 'msq3401',
      order_id: 'msq3401-checkout-order',
      order_checkout: '2026-10-29',
      task_date: '2026-10-29',
      inspection_due_date: '2026-10-30',
    },
    {
      ...msq4206Rows[1],
      id: 'msq3401-checkin',
      property_id: 'msq3401',
      order_id: 'msq3401-checkin-order',
      order_checkin: '2026-10-30',
      task_date: '2026-10-30',
    },
    {
      id: 'msq3401-unrelated-checkin',
      property_id: 'msq3401',
      task_type: 'checkin_clean',
      task_date: '2026-10-30',
      inspection_scope: 'inspect_and_hang',
      status: 'pending',
      execution_state: 'active',
    },
  ]
  const msq3401Entries = [
    { id: 'msq3401-deferred', sort_index: 4 },
    { id: 'msq3401-checkin', sort_index: 4 },
  ]
  const msq3401ReorderContext = deferredInspectionReorderAccessContext({
    rows: msq3401Rows,
    deferredTaskId: 'msq3401-deferred',
    userId: 'angela',
    date: '2026-10-30',
    entries: msq3401Entries,
  })
  assert.strictEqual(msq3401ReorderContext?.actionTask?.id, 'msq3401-checkin', 'the current reliable check-in executor may reorder the exact merged deferred source')
  assert.strictEqual(
    buildDeferredInspectionCheckinArrangements(msq3401Rows)[0].display_merge_eligible,
    true,
    'reorder authorization must consume the same unique reliable display relation as the work-task projection',
  )
  const msq3401ProductionShapeRows = [
    { ...msq3401Rows[0], inspector_id: null },
    msq3401Rows[1],
    { ...msq3401Rows[2], execution_state: 'superseded' },
  ]
  const msq3401ProductionShapeArrangement = buildDeferredInspectionCheckinArrangements(msq3401ProductionShapeRows)[0]
  assert.deepStrictEqual(
    msq3401ProductionShapeArrangement.conflict_reasons,
    ['deferred_inspector_missing'],
    'the production-shaped deferred source records the missing historical inspector without losing its reliable display relation',
  )
  assert.strictEqual(msq3401ProductionShapeArrangement.display_merge_eligible, true)
  assert.strictEqual(deferredInspectionReorderAccessContext({
    rows: msq3401ProductionShapeRows,
    deferredTaskId: 'msq3401-deferred',
    userId: 'angela',
    date: '2026-10-30',
    entries: msq3401Entries,
  })?.actionTask?.id, 'msq3401-checkin', 'a missing historical inspector and a superseded same-property candidate do not block the unique current executor from reordering')
  assert.strictEqual(
    deferredInspectionEvidenceAccessContext(msq3401ProductionShapeRows, 'msq3401-deferred', 'angela')?.actionTask?.id,
    'msq3401-checkin',
    'the unique current executor may read exact deferred consumables when the only conflict is the missing historical inspector',
  )
  assert.strictEqual(
    deferredInspectionEvidenceAccessContext(msq3401ProductionShapeRows, 'msq3401-deferred', 'mia'),
    null,
    'missing historical inspector evidence access remains bound to the unique current executor',
  )
  const productionShapeWriteGuard = deferredInspectionCheckinSubmissionGuard(msq3401ProductionShapeRows, 'msq3401-deferred')
  assert.strictEqual(productionShapeWriteGuard.blocked, true)
  assert.strictEqual(productionShapeWriteGuard.reason, 'inspection_arrangement_conflict')
  assert.strictEqual(productionShapeWriteGuard.canonical_action_task_id, null, 'the read-only exception must not authorize stale-source writes')
  assert.strictEqual(deferredInspectionEvidenceAccessContext([
    msq3401ProductionShapeRows[0],
    msq3401Rows[2],
  ], 'msq3401-deferred', 'angela'), null, 'a same-property check-in without a reliable turnover boundary cannot grant missing-inspector evidence access')
  assert.strictEqual(deferredInspectionEvidenceAccessContext([
    ...msq3401ProductionShapeRows,
    { ...msq3401Rows[1], id: 'msq3401-second-reliable-checkin', order_id: 'second-checkin-order' },
  ], 'msq3401-deferred', 'angela'), null, 'multiple reliable current check-ins remain denied for missing-inspector evidence access')
  assert.strictEqual(deferredInspectionEvidenceAccessContext([
    msq3401ProductionShapeRows[0],
    { ...msq3401Rows[1], task_date: '2026-10-31', order_checkin: '2026-10-31' },
  ], 'msq3401-deferred', 'angela'), null, 'a check-in outside the exact deferred inspection date cannot grant missing-inspector evidence access')
  assert.strictEqual(deferredInspectionReorderAccessContext({
    rows: msq3401Rows,
    deferredTaskId: 'msq3401-deferred',
    userId: 'oscar',
    date: '2026-10-30',
    entries: msq3401Entries,
  }), null, 'the superseded planned inspector cannot use the current executor takeover')
  assert.strictEqual(deferredInspectionReorderAccessContext({
    rows: msq3401Rows,
    deferredTaskId: 'msq3401-deferred',
    userId: 'angela',
    date: '2026-10-30',
    entries: [{ id: 'msq3401-deferred', sort_index: 4 }],
  }), null, 'the old deferred source cannot be reordered without its exact current check-in source')
  assert.strictEqual(deferredInspectionReorderAccessContext({
    rows: msq3401Rows,
    deferredTaskId: 'msq3401-deferred',
    userId: 'angela',
    date: '2026-10-30',
    entries: [msq3401Entries[0], { ...msq3401Entries[1], sort_index: 5 }],
  }), null, 'the two merged source ids must carry the same global order mark')
  assert.strictEqual(deferredInspectionReorderAccessContext({
    rows: msq3401Rows,
    deferredTaskId: 'msq3401-deferred',
    userId: 'angela',
    date: '2026-10-31',
    entries: msq3401Entries,
  }), null, 'a reliable arrangement cannot be reused on a different business date')
  assert.strictEqual(deferredInspectionReorderAccessContext({
    rows: [{ ...msq3401Rows[0], status: 'inspected' }, msq3401Rows[1]],
    deferredTaskId: 'msq3401-deferred',
    userId: 'angela',
    date: '2026-10-30',
    entries: msq3401Entries,
  }), null, 'a terminal deferred inspection cannot be reordered through takeover')
  assert.strictEqual(deferredInspectionReorderAccessContext({
    rows: [msq3401Rows[0], { ...msq3401Rows[1], inspection_scope: 'password_only' }],
    deferredTaskId: 'msq3401-deferred',
    userId: 'angela',
    date: '2026-10-30',
    entries: msq3401Entries,
  }), null, 'password-only work remains outside this inspection reorder repair')
  assert.strictEqual(deferredInspectionReorderAccessContext({
    rows: [msq3401ProductionShapeRows[0], msq3401Rows[2]],
    deferredTaskId: 'msq3401-deferred',
    userId: 'angela',
    date: '2026-10-30',
    entries: [
      msq3401Entries[0],
      { id: 'msq3401-unrelated-checkin', sort_index: 4 },
    ],
  }), null, 'same-property work without a reliable turnover relation remains unauthorized')
  assert.strictEqual(deferredInspectionReorderAccessContext({
    rows: [
      msq3401Rows[0],
      msq3401Rows[1],
      { ...msq3401Rows[1], id: 'msq3401-second-reliable-checkin', order_id: 'second-checkin-order' },
    ],
    deferredTaskId: 'msq3401-deferred',
    userId: 'angela',
    date: '2026-10-30',
    entries: [
      ...msq3401Entries,
      { id: 'msq3401-second-reliable-checkin', sort_index: 4 },
    ],
  }), null, 'multiple reliable check-in candidates remain fail-closed')
  assert.strictEqual(deferredInspectionReorderAccessContext({
    rows: [
      ...msq3401Rows,
      {
        ...msq3401Rows[0],
        id: 'msq3401-second-deferred',
        order_id: 'msq3401-second-checkout-order',
      },
    ],
    deferredTaskId: 'msq3401-deferred',
    userId: 'angela',
    date: '2026-10-30',
    entries: msq3401Entries,
  }), null, 'two deferred inspections competing for one check-in remain fail-closed')
  const reassignedAgainRows = [msq4206Rows[0], { ...msq4206Rows[1], assignee_id: 'mia' }]
  assert.strictEqual(deferredInspectionEvidenceAccessContext(reassignedAgainRows, 'msq4206-checkout', 'angela'), null)
  assert.strictEqual(
    deferredInspectionEvidenceAccessContext(reassignedAgainRows, 'msq4206-checkout', 'mia')?.actionTask?.id,
    'msq4206-checkin',
    'a repeated reassignment transfers only the current read-through contract',
  )
  const cancelledReassignmentRows = [msq4206Rows[0], {
    ...msq4206Rows[1],
    status: 'cancelled',
    execution_state: 'cancelled',
  }]
  assert.strictEqual(
    deferredInspectionEvidenceAccessContext(cancelledReassignmentRows, 'msq4206-checkout', 'angela'),
    null,
    'a cancelled check-in cannot authorize related evidence',
  )
  const ambiguousReassignmentRows = [msq4206Rows[0], msq4206Rows[1], {
    ...msq4206Rows[1],
    id: 'msq4206-checkin-second',
    order_id: 'second-checkin-order',
  }]
  assert.strictEqual(
    deferredInspectionEvidenceAccessContext(ambiguousReassignmentRows, 'msq4206-checkout', 'angela'),
    null,
    'multiple inspection-bearing check-ins remain fail-closed',
  )
  assert.strictEqual(
    deferredInspectionEvidenceAccessContext([
      msq4206Rows[0],
      { ...msq4206Rows[1], order_checkin: '2026-10-28' },
    ], 'msq4206-checkout', 'angela'),
    null,
    'same property and date without a reliable order boundary never grants read-through access',
  )

  const earlierCheckinArrangement = buildDeferredInspectionCheckinArrangements([
    {
      id: 'deferred-later-due', property_id: 'property-a', task_type: 'checkout_clean', task_date: '2026-08-01',
      inspection_mode: 'deferred', inspection_due_date: '2026-08-05', inspector_id: 'oscar', status: 'assigned',
    },
    {
      id: 'checkin-before-due', property_id: 'property-a', task_type: 'checkin_clean', task_date: '2026-08-03',
      inspection_scope: 'inspect_and_hang', linked_checkout_task_id: 'deferred-later-due', assignee_id: 'oscar', status: 'assigned',
    },
  ])[0]
  assert.strictEqual(earlierCheckinArrangement.effective_inspection_date, '2026-08-03')
  assert.strictEqual(earlierCheckinArrangement.checkin_task_id, 'checkin-before-due')
  assert.strictEqual(earlierCheckinArrangement.display_merge_eligible, false)
  assert.ok(earlierCheckinArrangement.display_merge_reasons.includes('checkin_not_on_deferred_inspection_date'))

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
  assert.match(guardQueries[2].sql, /linked_checkout_task_id/)
  assert.match(guardQueries[2].sql, /o\.checkin::text AS order_checkin/)

  const evidenceQueries: Array<{ sql: string; params: any[] }> = []
  const evidenceContext = await loadDeferredInspectionEvidenceAccessContext({
    taskId: 'msq4206-checkout',
    userId: 'angela',
    client: {
      async query(sql: string, params: any[]) {
        evidenceQueries.push({ sql, params })
        assert.doesNotMatch(sql, /FOR UPDATE|\b(?:INSERT|UPDATE|DELETE)\b/i, 'read-through authorization must remain read-only')
        if (evidenceQueries.length === 1) return { rows: [msq4206Rows[0]] }
        return { rows: msq4206Rows }
      },
    },
  })
  assert.strictEqual(evidenceContext?.actionTask?.id, 'msq4206-checkin')
  assert.deepStrictEqual(evidenceQueries[1].params, ['msq4206', '2026-10-26', '2026-10-27'])

  const productionEvidenceQueries: Array<{ sql: string; params: any[] }> = []
  const productionEvidenceContext = await loadDeferredInspectionEvidenceAccessContext({
    taskId: 'msq3401-deferred',
    userId: 'angela',
    client: {
      async query(sql: string, params: any[]) {
        productionEvidenceQueries.push({ sql, params })
        assert.doesNotMatch(sql, /FOR UPDATE|\b(?:INSERT|UPDATE|DELETE)\b/i, 'missing-inspector evidence authorization must remain read-only')
        if (productionEvidenceQueries.length === 1) return { rows: [msq3401ProductionShapeRows[0]] }
        return { rows: msq3401ProductionShapeRows }
      },
    },
  })
  assert.strictEqual(productionEvidenceContext?.actionTask?.id, 'msq3401-checkin')
  assert.deepStrictEqual(productionEvidenceQueries[1].params, ['msq3401', '2026-10-29', '2026-10-30'])

  const reorderQueries: Array<{ sql: string; params: any[] }> = []
  const reorderContext = await loadDeferredInspectionReorderAccessContext({
    taskId: 'msq3401-deferred',
    userId: 'angela',
    date: '2026-10-30',
    entries: msq3401Entries,
    client: {
      async query(sql: string, params: any[]) {
        reorderQueries.push({ sql, params })
        assert.match(sql, /^\s*SELECT\b/i, 'reorder takeover lookup must only select before the route update')
        if (reorderQueries.length === 1) return { rows: [msq3401Rows[0]] }
        return { rows: msq3401Rows }
      },
    },
  })
  assert.strictEqual(reorderContext?.actionTask?.id, 'msq3401-checkin')
  assert.deepStrictEqual(reorderQueries[1].params, ['msq3401', '2026-10-29', '2026-10-30'])
  assert.match(reorderQueries[1].sql, /ORDER BY t\.id::text\s+FOR UPDATE OF t/, 'the complete arrangement window must be locked in stable source-id order before sorting')

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
