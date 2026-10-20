import assert from 'assert'

type FakeTask = {
  status: string
  inspection_scope: string
  task_type?: string
  inspection_mode?: string
}

function makeExecutor(
  task: FakeTask,
  inspectionMediaRows: any[],
  guestArrivalSkipAudit = false,
  cleaningReady = true,
  lockboxVideoSaved = false,
  priorRoleAudits: Array<{ action: string; actor: string }> = [],
) {
  const queries: string[] = []
  const insertedAudits: any[] = []
  return {
    queries,
    insertedAudits,
    query: async (sql: string, params: any[] = []) => {
      queries.push(sql)
      if (sql.includes('SELECT t.id::text AS task_id')) {
        return { rows: [{
          task_id: 'task-guard',
          property_id: 'property-1',
          property_label: 'FG1003',
          property_type: '一房一卫',
          task_type: task.task_type || 'checkout_clean',
          scheduled_service_date: '2026-09-08',
          inspection_due_date: '2026-09-10',
          inspection_mode: task.inspection_mode || 'deferred',
          inspection_scope: task.inspection_scope,
          assignee_id: 'inspector-1',
          cleaner_id: 'cleaner-1',
          inspector_id: 'inspector-1',
        }] }
      }
      if (sql.includes('SELECT id::text AS media_id')) {
        return { rows: inspectionMediaRows.map((row, index) => row?.media_id ? row : {
          media_id: `inspection-photo-${index + 1}`,
          type: 'inspection_bedroom',
          url: `private-media-reference-${index + 1}`,
          note: null,
          captured_at: '2026-09-10T01:00:00.000Z',
          created_at: '2026-09-10T01:00:00.000Z',
        }) }
      }
      if (sql.includes('FROM cleaning_tasks t')) {
        return { rows: params[2] === true || guestArrivalSkipAudit || inspectionMediaRows.length ? [{ ok: 1 }] : [] }
      }
      if (sql.includes('FROM cleaning_consumable_usages')) {
        return {
          rows: [{ consumables_submitted: cleaningReady, property_photo_submitted: cleaningReady }],
        }
      }
      if (sql.includes("m.type = 'lockbox_video'")) {
        return { rows: lockboxVideoSaved ? [{ ok: 1 }] : [] }
      }
      if (sql.includes('FROM work_task_action_audits audit') && sql.includes('performed_as_action = ANY')) {
        const actions = Array.isArray(params[1]) ? params[1].map(String) : []
        const actor = String(params[2] || '')
        return {
          rows: priorRoleAudits.some((audit) => actions.includes(audit.action) && audit.actor === actor) ? [{ ok: 1 }] : [],
          rowCount: priorRoleAudits.some((audit) => actions.includes(audit.action) && audit.actor === actor) ? 1 : 0,
        }
      }
      if (sql.includes('FROM cleaning_tasks')) {
        return {
          rows: [{
            id: 'task-guard',
            status: task.status,
            task_type: task.task_type || 'checkout_clean',
            inspection_scope: task.inspection_scope,
            inspection_mode: task.inspection_mode || null,
            finished_at: null,
          }],
        }
      }
      if (sql.includes('FROM users')) return { rows: [] }
      if (sql.includes('INSERT INTO work_task_action_audits')) {
        insertedAudits.push(JSON.parse(String(params[10] || '{}')))
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    },
  }
}

async function main() {
  process.env.DATABASE_URL = 'postgres://unit-test'
  const { actorAndPerformerFromRequest, applyCleaningTaskActionTransition, assertCleaningTaskRoleRecordMutable } = require('../../src/lib/workTaskActionAudit') as typeof import('../../src/lib/workTaskActionAudit')
  assert.deepStrictEqual(
    actorAndPerformerFromRequest(
      { sub: 'actor-1' },
      { performed_by_user_id: 'forged-user', performed_by_name: 'Forged Name' },
    ),
    { actorUserId: 'actor-1', performedByUserId: 'actor-1', performedByName: null },
  )
  const task: FakeTask = { status: 'to_inspect', inspection_scope: 'inspect_and_hang', task_type: 'checkout_clean' }
  const cancelledTask = makeExecutor({ ...task, status: 'cancelled' }, [{ ok: 1 }])
  await assert.rejects(() => applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'submit_inspection',
    actorUserId: 'inspector-1',
  }, cancelledTask as any), /task_is_cancelled/)
  assert.equal(cancelledTask.insertedAudits.length, 0)
  assert.equal(cancelledTask.queries.some((sql) => sql.includes('UPDATE cleaning_tasks')), false)
  await assert.rejects(() => assertCleaningTaskRoleRecordMutable({
    taskId: 'task-guard',
    actionId: 'complete_cleaning',
    actorUserId: 'cleaner-1',
    statusBefore: 'cleaned',
  }, makeExecutor({ ...task, status: 'cleaned' }, []) as any), /work_record_read_only/)
  const noPhotos = makeExecutor(task, [])
  const blocked = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'submit_inspection',
    actorUserId: 'inspector-1',
  }, noPhotos as any)
  assert.equal(blocked.status_after, 'to_inspect')
  assert.equal(blocked.finalization_pending, true)
  assert.deepEqual(blocked.missing_requirements, ['inspection_photos'])
  assert.equal(noPhotos.queries.some((sql) => sql.includes('UPDATE cleaning_tasks')), false)

  const withPhotos = makeExecutor(task, [{ ok: 1 }])
  const inspected = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'submit_inspection',
    actorUserId: 'inspector-1',
  }, withPhotos as any)
  assert.equal(inspected.status_after, 'inspected')
  assert.equal(inspected.finalization_pending, false)

  const videoOnly = makeExecutor(task, [], false, true, true)
  const videoSaved = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'upload_access_video',
    actorUserId: 'inspector-1',
  }, videoOnly as any)
  assert.equal(videoSaved.status_after, 'to_inspect')
  assert.equal(videoSaved.finalization_pending, true)
  assert.deepEqual(videoSaved.missing_requirements, ['inspection_photos'])

  const inspectionBeforeCleaner = makeExecutor(task, [{ ok: 1 }], false, false)
  const inspectionSaved = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'submit_inspection',
    actorUserId: 'inspector-1',
  }, inspectionBeforeCleaner as any)
  assert.equal(inspectionSaved.status_after, 'to_inspect')
  assert.equal(inspectionSaved.finalization_pending, true)
  assert.deepEqual(inspectionSaved.missing_requirements, ['cleaning_consumables', 'cleaning_property_photo'])
  assert.equal(inspectionBeforeCleaner.insertedAudits.length, 1)
  assert.deepEqual(inspectionBeforeCleaner.insertedAudits[0].property_snapshot, {
    property_id: 'property-1', property_label: 'FG1003', property_type: '一房一卫',
  })
  assert.equal(inspectionBeforeCleaner.insertedAudits[0].execution_key, 'inspection:task-guard')
  assert.equal(inspectionBeforeCleaner.insertedAudits[0].inspection_submission_complete, true)
  assert.equal(inspectionBeforeCleaner.insertedAudits[0].task_snapshot.scheduled_service_date, '2026-09-08')
  assert.equal(inspectionBeforeCleaner.insertedAudits[0].evidence_count, 1)
  assert.match(inspectionBeforeCleaner.insertedAudits[0].evidence_snapshot[0].reference_hash, /^[a-f0-9]{64}$/)
  assert.equal('reference' in inspectionBeforeCleaner.insertedAudits[0].evidence_snapshot[0], false)

  const videoBeforeCleaner = makeExecutor(task, [{ ok: 1 }], false, false, true)
  const videoSavedBeforeCleaner = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'upload_access_video',
    actorUserId: 'inspector-1',
  }, videoBeforeCleaner as any)
  assert.equal(videoSavedBeforeCleaner.status_after, 'to_inspect')
  assert.equal(videoSavedBeforeCleaner.finalization_pending, true)
  assert.deepEqual(videoSavedBeforeCleaner.missing_requirements, ['cleaning_consumables', 'cleaning_property_photo'])

  const cleanerFinishesLast = makeExecutor(task, [{ ok: 1 }], false, true, true)
  const finalized = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'fill_supplies',
    actorUserId: 'cleaner-1',
  }, cleanerFinishesLast as any)
  assert.equal(finalized.status_after, 'keys_hung')
  assert.equal(finalized.finalization_pending, false)

  const cleaningEvidence = makeExecutor(task, [
    { media_id: 'completion-toilet', type: 'completion_toilet', url: 'private-completion-toilet', note: null, captured_at: null, created_at: '2026-09-10T02:00:00.000Z' },
    { media_id: 'completion-kitchen', type: 'completion_kitchen', url: 'private-completion-kitchen', note: null, captured_at: null, created_at: '2026-09-10T02:01:00.000Z' },
  ])
  await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'complete_cleaning',
    actorUserId: 'cleaner-1',
  }, cleaningEvidence as any)
  assert.equal(cleaningEvidence.insertedAudits[0].evidence_count, 2)
  assert.deepEqual(cleaningEvidence.insertedAudits[0].evidence_snapshot.map((item: any) => item.type), ['completion_toilet', 'completion_kitchen'])
  assert.ok(cleaningEvidence.insertedAudits[0].evidence_snapshot.every((item: any) => /^[a-f0-9]{64}$/.test(item.reference_hash)))
  assert.ok(cleaningEvidence.insertedAudits[0].evidence_snapshot.every((item: any) => !('url' in item)))
  assert.ok(cleaningEvidence.queries.some((sql) => sql.includes("type LIKE 'completion_%'")))

  const selfCompleteVideo = makeExecutor(task, [], false, false)
  const selfCompleteVideoSaved = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'upload_access_video',
    actorUserId: 'cleaner-1',
    metadata: { self_complete_lockbox: true },
  }, selfCompleteVideo as any)
  assert.equal(selfCompleteVideoSaved.status_after, 'keys_hung')
  assert.equal(selfCompleteVideoSaved.finalization_pending, false)
  assert.equal(selfCompleteVideo.queries.some((sql) => sql.includes('FROM cleaning_consumable_usages')), false)

  const guestArrivalSkip = makeExecutor(task, [])
  const skipped = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'submit_inspection',
    actorUserId: 'inspector-1',
    metadata: { guest_arrival_skip: true },
  }, guestArrivalSkip as any)
  assert.equal(skipped.status_after, 'inspected')
  assert.equal(skipped.finalization_pending, false)

  const skippedVideo = makeExecutor(task, [], true)
  const videoAfterSkip = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'upload_access_video',
    actorUserId: 'inspector-1',
  }, skippedVideo as any)
  assert.equal(videoAfterSkip.status_after, 'keys_hung')
  assert.equal(videoAfterSkip.finalization_pending, false)

  const checkinInspection = makeExecutor({ status: 'to_inspect', inspection_scope: 'inspect_and_hang', task_type: 'checkin_clean' }, [{ ok: 1 }], false, false)
  const checkinInspectionSaved = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'submit_inspection',
    actorUserId: 'inspector-1',
  }, checkinInspection as any)
  assert.equal(checkinInspectionSaved.status_after, 'to_hang_keys')
  assert.equal(checkinInspectionSaved.finalization_pending, false)

  task.inspection_scope = 'password_only'
  const passwordOnly = makeExecutor(task, [])
  const passwordCompleted = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'upload_access_video',
    actorUserId: 'inspector-1',
  }, passwordOnly as any)
  assert.equal(passwordCompleted.status_after, 'inspected')
  assert.equal(passwordCompleted.finalization_pending, false)

  const checkinNotSubmitted = makeExecutor({ status: 'to_inspect', inspection_scope: 'inspect_and_hang', task_type: 'checkin_clean' }, [], false, false, true)
  const checkinVideoSaved = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'upload_access_video',
    actorUserId: 'inspector-1',
  }, checkinNotSubmitted as any)
  assert.equal(checkinVideoSaved.status_after, 'keys_hung')
  assert.equal(checkinVideoSaved.finalization_pending, true)
  assert.deepEqual(checkinVideoSaved.missing_requirements, ['inspection_photos'])
  assert.equal(checkinNotSubmitted.queries.some((sql) => sql.includes('FROM cleaning_consumable_usages')), false)

  const duplicateActor = makeExecutor(
    { status: 'inspected', inspection_scope: 'inspect_and_hang', task_type: 'checkout_clean' },
    [{ ok: 1 }],
    false,
    true,
    true,
    [{ action: 'upload_access_video', actor: 'inspector-1' }],
  )
  await assert.rejects(() => applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'upload_access_video',
    actorUserId: 'inspector-1',
  }, duplicateActor as any), /work_record_read_only/)

  const reassignedActor = makeExecutor(
    { status: 'inspected', inspection_scope: 'inspect_and_hang', task_type: 'checkout_clean' },
    [{ ok: 1 }],
    false,
    true,
    true,
    [{ action: 'upload_access_video', actor: 'inspector-1' }],
  )
  const reassignedSaved = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'upload_access_video',
    actorUserId: 'inspector-2',
  }, reassignedActor as any)
  assert.equal(reassignedSaved.status_after, 'keys_hung', 'a newly assigned actor may create their own first record')

  process.stdout.write('test_cleaning_task_transition_guard: ok\n')
}

void main()
