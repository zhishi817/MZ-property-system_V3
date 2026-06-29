import assert from 'assert'
import express from 'express'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), override: true })
process.env.PG_CONN_TIMEOUT_MS = process.env.PG_CONN_TIMEOUT_MS || '8000'
process.env.PG_QUERY_TIMEOUT_MS = process.env.PG_QUERY_TIMEOUT_MS || '15000'
process.env.PG_STATEMENT_TIMEOUT_MS = process.env.PG_STATEMENT_TIMEOUT_MS || '15000'

const TEST_DATE = '2026-06-29'

async function requestJson(app: express.Express, method: string, path: string, body?: any) {
  const server = await new Promise<any>((resolve) => {
    const listener = app.listen(0, () => resolve(listener))
  })
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60000)
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    assert.ok(response.ok, `${method} ${path} failed: ${response.status} ${text}`)
    return data
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function fetchWorkTask(pgPool: any, id: string) {
  const result = await pgPool.query(`SELECT * FROM work_tasks WHERE id=$1 LIMIT 1`, [id])
  return result?.rows?.[0] || null
}

async function main() {
  process.stdout.write('test_task_assignment_canonical: loading db\n')
  const { pgPool } = await import('../../src/dbAdapter')
  if (!pgPool) {
    process.stdout.write('test_task_assignment_canonical: skipped (pg not configured)\n')
    return
  }
  process.stdout.write('test_task_assignment_canonical: loading modules\n')
  const { ensureCleaningSchemaV2 } = await import('../../src/services/cleaningSync')
  const { upsertWorkTaskFromOfflineTask } = await import('../../src/modules/cleaning')
  const { router: taskCenterRouter } = await import('../../src/modules/task_center')
  const { router: mzappRouter } = await import('../../src/modules/mzapp')

  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    req.user = { sub: 'test-admin', username: 'test-admin', role: 'admin', roles: ['admin'] }
    next()
  })
  app.use('/task-center', taskCenterRouter)
  app.use('/mzapp', mzappRouter)

  const offlineNullId = 'test-assignment-offline-null'
  const offlineOldId = 'test-assignment-offline-old'
  const offlineDisplayId = 'test-assignment-offline-display'
  const workId = 'test-assignment-work'
  const cleaningId = 'test-assignment-cleaning'
  const propertyId = 'P_TEST_ASSIGN'

  process.stdout.write('test_task_assignment_canonical: preparing schema\n')
  await ensureCleaningSchemaV2()
  await pgPool.query(`CREATE TABLE IF NOT EXISTS cleaning_offline_tasks (
    id text PRIMARY KEY,
    date date NOT NULL,
    task_type text NOT NULL DEFAULT 'other',
    title text NOT NULL DEFAULT '',
    content text,
    kind text NOT NULL DEFAULT 'offline',
    status text NOT NULL DEFAULT 'todo',
    urgency text NOT NULL DEFAULT 'medium',
    property_id text,
    assignee_id text,
    photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`)
  await pgPool.query(`DELETE FROM work_tasks WHERE id = ANY($1::text[]) OR source_id = ANY($2::text[])`, [
    [`cleaning_offline_tasks:${offlineNullId}`, `cleaning_offline_tasks:${offlineOldId}`, `cleaning_offline_tasks:${offlineDisplayId}`, workId],
    [offlineNullId, offlineOldId, offlineDisplayId],
  ])
  await pgPool.query(`DELETE FROM cleaning_offline_tasks WHERE id = ANY($1::text[])`, [[offlineNullId, offlineOldId, offlineDisplayId]])
  await pgPool.query(`DELETE FROM cleaning_tasks WHERE id=$1`, [cleaningId])
  await pgPool.query(`INSERT INTO properties(id, address) VALUES($1, 'Test assignment property') ON CONFLICT (id) DO NOTHING`, [propertyId])

  try {
    process.stdout.write('test_task_assignment_canonical: testing offline upsert preserve null\n')
    await upsertWorkTaskFromOfflineTask({
      id: offlineNullId,
      date: TEST_DATE,
      property_id: propertyId,
      title: 'Offline null',
      content: 'before',
      assignee_id: 'legacy-create',
      status: 'todo',
      urgency: 'medium',
      photo_urls: [],
    }, 'todo')
    await pgPool.query(`UPDATE work_tasks SET assignee_id='canonical-user', status='assigned' WHERE source_type='cleaning_offline_tasks' AND source_id=$1`, [offlineNullId])
    process.stdout.write('test_task_assignment_canonical: testing offline upsert preserve old legacy\n')
    await upsertWorkTaskFromOfflineTask({
      id: offlineNullId,
      date: TEST_DATE,
      property_id: propertyId,
      title: 'Offline null changed',
      content: 'after',
      assignee_id: null,
      status: 'todo',
      urgency: 'high',
      photo_urls: [],
    })
    assert.equal((await fetchWorkTask(pgPool, `cleaning_offline_tasks:${offlineNullId}`)).assignee_id, 'canonical-user')

    await upsertWorkTaskFromOfflineTask({
      id: offlineOldId,
      date: TEST_DATE,
      property_id: propertyId,
      title: 'Offline old',
      content: 'before',
      assignee_id: 'legacy-old-create',
      status: 'todo',
      urgency: 'medium',
      photo_urls: [],
    }, 'todo')
    await pgPool.query(`UPDATE work_tasks SET assignee_id='canonical-new', status='assigned' WHERE source_type='cleaning_offline_tasks' AND source_id=$1`, [offlineOldId])
    await upsertWorkTaskFromOfflineTask({
      id: offlineOldId,
      date: TEST_DATE,
      property_id: propertyId,
      title: 'Offline old changed',
      content: 'after',
      assignee_id: 'legacy-old-value',
      status: 'todo',
      urgency: 'low',
      photo_urls: [],
    })
    assert.equal((await fetchWorkTask(pgPool, `cleaning_offline_tasks:${offlineOldId}`)).assignee_id, 'canonical-new')

    process.stdout.write('test_task_assignment_canonical: testing task-center assign/unassign\n')
    await pgPool.query(
      `INSERT INTO work_tasks(id, task_kind, source_type, source_id, property_id, title, summary, scheduled_date, assignee_id, status, urgency)
       VALUES($1, 'offline', 'test_assignment', $1, $3, 'Task center work', 'before', $2::date, 'initial-user', 'assigned', 'medium')
       ON CONFLICT (id) DO UPDATE SET assignee_id='initial-user', status='assigned', summary='before', updated_at=now()`,
      [workId, TEST_DATE, propertyId],
    )
    await requestJson(app, 'POST', '/task-center/save-board', {
      date: TEST_DATE,
      mode: 'board',
      rows: [{ row_key: 'region:test-assignment', row_type: 'region', row_title: 'Test', row_order: 1 }],
      items: [],
      row_assignments: [],
      cleaning_assignments: [],
      work_assignments: [{
        task_id: workId,
        assignee_id: 'assigned-user',
        assignee_assignment_action: 'assign',
        title: 'Task center work',
        summary: 'before',
        scheduled_date: TEST_DATE,
        status: 'assigned',
        urgency: 'medium',
      }],
      task_flags: [],
    })
    assert.equal((await fetchWorkTask(pgPool, workId)).assignee_id, 'assigned-user')

    await requestJson(app, 'POST', '/task-center/save-board', {
      date: TEST_DATE,
      mode: 'board',
      rows: [{ row_key: 'region:test-assignment', row_type: 'region', row_title: 'Test', row_order: 1 }],
      items: [],
      row_assignments: [],
      cleaning_assignments: [],
      work_assignments: [{
        task_id: workId,
        assignee_id: null,
        title: 'Task center work',
        summary: 'content changed only',
        scheduled_date: TEST_DATE,
        status: 'assigned',
        urgency: 'medium',
      }],
      task_flags: [],
    })
    assert.equal((await fetchWorkTask(pgPool, workId)).assignee_id, 'assigned-user', 'plain assignee_id null without intent must be ignored')

    await requestJson(app, 'POST', '/task-center/save-board', {
      date: TEST_DATE,
      mode: 'board',
      rows: [{ row_key: 'region:test-assignment', row_type: 'region', row_title: 'Test', row_order: 1 }],
      items: [],
      row_assignments: [],
      cleaning_assignments: [],
      work_assignments: [{
        task_id: workId,
        assignee_id: null,
        assignee_assignment_action: 'unassign',
        title: 'Task center work',
        summary: 'content changed only',
        scheduled_date: TEST_DATE,
        status: 'todo',
        urgency: 'medium',
      }],
      task_flags: [],
    })
    assert.equal((await fetchWorkTask(pgPool, workId)).assignee_id, null)

    process.stdout.write('test_task_assignment_canonical: testing manager fields preserve assignment\n')
    await pgPool.query(
      `INSERT INTO cleaning_tasks(
         id, property_id, task_type, type, task_date, date, status, assignee_id, cleaner_id, inspector_id, source, execution_state
       ) VALUES($1, $3, 'checkout_clean', 'checkout_clean', $2::date, $2::date, 'assigned', 'cleaner-a', 'cleaner-a', 'inspector-a', 'manual', 'active')`,
      [cleaningId, TEST_DATE, propertyId],
    )
    await requestJson(app, 'POST', '/mzapp/cleaning-tasks/manager-fields', {
      task_ids: [cleaningId],
      checkout_time: '12pm',
      checkin_time: '2pm',
      guest_special_request: 'keep assignment',
      old_code: '1111',
      new_code: '2222',
    })
    const cleaningTask = (await pgPool.query(`SELECT assignee_id, cleaner_id, inspector_id FROM cleaning_tasks WHERE id=$1`, [cleaningId])).rows[0]
    assert.equal(cleaningTask.assignee_id, 'cleaner-a')
    assert.equal(cleaningTask.cleaner_id, 'cleaner-a')
    assert.equal(cleaningTask.inspector_id, 'inspector-a')

    process.stdout.write('test_task_assignment_canonical: testing mzapp display canonical assignment\n')
    await pgPool.query(
      `INSERT INTO cleaning_offline_tasks(id, date, task_type, title, content, kind, status, urgency, property_id, assignee_id)
       VALUES($1, $2::date, 'property', 'Display offline', 'display', 'offline', 'todo', 'medium', $3, 'legacy-display')`,
      [offlineDisplayId, TEST_DATE, propertyId],
    )
    await upsertWorkTaskFromOfflineTask({
      id: offlineDisplayId,
      date: TEST_DATE,
      property_id: propertyId,
      title: 'Display offline',
      content: 'display',
      assignee_id: 'legacy-display',
      status: 'todo',
      urgency: 'medium',
      photo_urls: [],
    }, 'todo')
    await pgPool.query(`UPDATE work_tasks SET assignee_id='canonical-display', status='assigned' WHERE source_type='cleaning_offline_tasks' AND source_id=$1`, [offlineDisplayId])
    const visibleTasks = await requestJson(app, 'GET', `/mzapp/work-tasks?date_from=${TEST_DATE}&date_to=${TEST_DATE}&view=all`)
    const displayTask = (visibleTasks || []).find((item: any) => String(item.id) === `cleaning_offline_tasks:${offlineDisplayId}`)
    assert.ok(displayTask, 'offline work task should be visible in mzapp work-tasks')
    assert.equal(displayTask.assignee_id, 'canonical-display')
  } finally {
    await pgPool.query(`DELETE FROM work_tasks WHERE id = ANY($1::text[]) OR source_id = ANY($2::text[])`, [
      [`cleaning_offline_tasks:${offlineNullId}`, `cleaning_offline_tasks:${offlineOldId}`, `cleaning_offline_tasks:${offlineDisplayId}`, workId],
      [offlineNullId, offlineOldId, offlineDisplayId],
    ])
    await pgPool.query(`DELETE FROM cleaning_offline_tasks WHERE id = ANY($1::text[])`, [[offlineNullId, offlineOldId, offlineDisplayId]])
    await pgPool.query(`DELETE FROM cleaning_tasks WHERE id=$1`, [cleaningId])
    await pgPool.query(`DELETE FROM properties WHERE id=$1`, [propertyId])
  }

  process.stdout.write('test_task_assignment_canonical: ok\n')
  await pgPool.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
