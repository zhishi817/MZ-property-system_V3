import assert from 'node:assert/strict'
import express from 'express'
import {
  deferredProjectionDate,
  isCheckinKeyHandoverTask,
  isInspectionModeAllowedForTask,
  mergeInspectionPlan,
  mergeTurnoverTaskPlan,
  mobileInspectionProjectionDate,
  normalizeTurnoverInspectionScope,
  resolveBoardInspectionDueDate,
  sanitizeInspectionModeForTask,
} from '../../src/lib/cleaningInspection'

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
testBoardSavePreservesDeferredDate()
testKeysHungSelfCompleteProjectsToOriginalTaskDate()
testOrdinarySelfCompleteDoesNotCreateInspectorTask()
testPasswordOnlyCannotUseSelfCompleteOrCheckedDone()

testTaskCenterSaveBoardDoesNotEraseDeferredDate()
  .then(() => console.log('test_cleaning_inspection_merge: ok'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
