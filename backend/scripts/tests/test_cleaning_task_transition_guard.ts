import assert from 'assert'

type FakeTask = {
  status: string
  inspection_scope: string
}

function makeExecutor(task: FakeTask, mediaRows: any[], guestArrivalSkipAudit = false, cleaningReady = true) {
  const queries: string[] = []
  return {
    queries,
    query: async (sql: string, params: any[] = []) => {
      queries.push(sql)
      if (sql.includes('FROM cleaning_tasks t')) {
        return { rows: params[2] === true || guestArrivalSkipAudit || mediaRows.length ? [{ ok: 1 }] : [] }
      }
      if (sql.includes('FROM cleaning_consumable_usages')) {
        return {
          rows: [{ consumables_submitted: cleaningReady, property_photo_submitted: cleaningReady }],
        }
      }
      if (sql.includes('FROM cleaning_tasks')) {
        return { rows: [{ id: 'task-guard', status: task.status, task_type: 'checkin_clean', inspection_scope: task.inspection_scope, finished_at: null }] }
      }
      if (sql.includes('FROM users')) return { rows: [] }
      return { rows: [], rowCount: 1 }
    },
  }
}

async function main() {
  process.env.DATABASE_URL = 'postgres://unit-test'
  const { applyCleaningTaskActionTransition } = require('../../src/lib/workTaskActionAudit') as typeof import('../../src/lib/workTaskActionAudit')
  const task: FakeTask = { status: 'to_inspect', inspection_scope: 'inspect_and_hang' }
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

  const videoOnly = makeExecutor(task, [])
  const videoSaved = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'upload_access_video',
    actorUserId: 'inspector-1',
  }, videoOnly as any)
  assert.equal(videoSaved.status_after, 'keys_hung')
  assert.equal(videoSaved.finalization_pending, true)

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

  task.inspection_scope = 'password_only'
  const passwordOnly = makeExecutor(task, [])
  const passwordCompleted = await applyCleaningTaskActionTransition({
    taskId: 'task-guard',
    actionId: 'upload_access_video',
    actorUserId: 'inspector-1',
  }, passwordOnly as any)
  assert.equal(passwordCompleted.status_after, 'inspected')
  assert.equal(passwordCompleted.finalization_pending, false)

  const cleaningNotSubmitted = makeExecutor({ status: 'inspected', inspection_scope: 'inspect_and_hang' }, [], false, false)
  await assert.rejects(
    () => import('../../src/lib/workTaskActionAudit').then(({ assertCleaningSubmissionReady }) => assertCleaningSubmissionReady('task-guard', cleaningNotSubmitted as any)),
    (error: any) => error?.code === 'CLEANING_SUBMISSION_REQUIRED' && error?.statusCode === 409,
  )

  process.stdout.write('test_cleaning_task_transition_guard: ok\n')
}

void main()
