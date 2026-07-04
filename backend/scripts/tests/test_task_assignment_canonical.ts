import assert from 'assert'
import express from 'express'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), override: true })
process.env.PG_CONN_TIMEOUT_MS = process.env.PG_CONN_TIMEOUT_MS || '8000'
process.env.PG_QUERY_TIMEOUT_MS = process.env.PG_QUERY_TIMEOUT_MS || '15000'
process.env.PG_STATEMENT_TIMEOUT_MS = process.env.PG_STATEMENT_TIMEOUT_MS || '15000'

function dbIdentity(value: any) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.username}@${url.hostname}:${url.port || '5432'}${url.pathname}`
  } catch {
    return raw
  }
}

const activeDbIdentity = dbIdentity(process.env.DATABASE_URL)
const prodDbIdentity = dbIdentity(process.env.NEON_DATABASE_URL_PROD || process.env.DATABASE_URL_PROD)
if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {
  throw new Error('Refusing to run write tests when NODE_ENV=production')
}
if (activeDbIdentity && prodDbIdentity && activeDbIdentity === prodDbIdentity) {
  throw new Error('Refusing to run write tests because DATABASE_URL matches production database URL')
}

const TEST_DATE = '2026-06-29'
const NEXT_DATE = '2026-06-30'

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
  const cleaningKeysHungId = 'test-assignment-keys-hung'
  const propertyId = 'P_TEST_ASSIGN'
  const crossDayPropertyId = 'P_TEST_ASSIGN_CROSS_DAY'
  const sameDayPropertyId = 'P_TEST_ASSIGN_SAME_DAY'
  const sameDayLatePropertyId = 'P_TEST_ASSIGN_SAME_DAY_LATE'
  const pureCheckinPropertyId = 'P_TEST_ASSIGN_PURE_CHECKIN'
  const keyHandoverPropertyId = 'P_TEST_ASSIGN_KEY_HANDOVER'
  const crossDayCheckoutId = 'test-assignment-cross-day-checkout'
  const crossDayCheckinId = 'test-assignment-cross-day-checkin'
  const sameDayCheckoutId = 'test-assignment-same-day-checkout'
  const sameDayCheckinId = 'test-assignment-same-day-checkin'
  const sameDayLockboxVideoId = 'test-assignment-same-day-lockbox-video'
  const sameDayLateCheckoutId = 'test-assignment-same-day-late-checkout'
  const sameDayLateCheckinId = 'test-assignment-same-day-late-checkin'
  const sameDayLateLockboxVideoId = 'test-assignment-same-day-late-lockbox-video'
  const pureCheckinId = 'test-assignment-pure-checkin'
  const keyHandoverId = 'test-assignment-key-handover'

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
  await pgPool.query(`DELETE FROM cleaning_tasks WHERE id = ANY($1::text[])`, [[cleaningId, cleaningKeysHungId, crossDayCheckoutId, crossDayCheckinId, sameDayCheckoutId, sameDayCheckinId, sameDayLateCheckoutId, sameDayLateCheckinId, pureCheckinId, keyHandoverId]])
  await pgPool.query(`INSERT INTO properties(id, address) VALUES($1, 'Test assignment property') ON CONFLICT (id) DO NOTHING`, [propertyId])
  await pgPool.query(
    `INSERT INTO properties(id, code, address)
     VALUES
       ($1, 'TEST-CROSS-DAY', 'Test cross day property'),
       ($2, 'TEST-SAME-DAY', 'Test same day property'),
       ($3, 'TEST-SAME-DAY-LATE', 'Test same day late property'),
       ($4, 'TEST-PURE-CHECKIN', 'Test pure checkin property'),
       ($5, 'TEST-KEY-HANDOVER', 'Test key handover property')
     ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, address = EXCLUDED.address`,
    [crossDayPropertyId, sameDayPropertyId, sameDayLatePropertyId, pureCheckinPropertyId, keyHandoverPropertyId],
  )

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

    process.stdout.write('test_task_assignment_canonical: testing save-board ignores derived cleaning status\n')
    await pgPool.query(
      `INSERT INTO cleaning_tasks(
         id, property_id, task_type, type, task_date, date, status, assignee_id, cleaner_id, inspector_id, inspection_mode, inspection_scope, source, execution_state, lockbox_video_uploaded_at
       ) VALUES($1, $3, 'checkin_clean', 'checkin_clean', $2::date, $2::date, 'keys_hung', 'inspector-a', NULL, 'inspector-a', 'same_day', 'inspect_and_hang', 'manual', 'active', now())`,
      [cleaningKeysHungId, TEST_DATE, propertyId],
    )
    await requestJson(app, 'POST', '/task-center/save-board', {
      date: TEST_DATE,
      mode: 'board',
      rows: [{ row_key: 'region:test-assignment', row_type: 'region', row_title: 'Test', row_order: 1 }],
      items: [],
      row_assignments: [],
      cleaning_assignments: [{
        task_id: cleaningKeysHungId,
        inspection_mode: 'same_day',
        inspection_scope: 'inspect_and_hang',
        inspection_due_date: null,
        status: 'assigned',
      }],
      work_assignments: [],
      task_flags: [],
    })
    const preservedKeysHung = (await pgPool.query(`SELECT status, inspector_id FROM cleaning_tasks WHERE id=$1`, [cleaningKeysHungId])).rows[0]
    assert.equal(preservedKeysHung.status, 'keys_hung')
    assert.equal(preservedKeysHung.inspector_id, 'inspector-a')

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

    process.stdout.write('test_task_assignment_canonical: testing mzapp same-day checkin merge boundary\n')
    await pgPool.query(
      `INSERT INTO cleaning_tasks(
         id, property_id, task_type, type, task_date, date, status, assignee_id, cleaner_id, source, execution_state, checkout_time, checkin_time, new_code, keys_required, nights_override
       ) VALUES
         ($1, $5, 'checkout_clean', 'checkout_clean', $3::date, $3::date, 'assigned', 'cleaner-boundary', 'cleaner-boundary', 'manual', 'active', '10am', NULL, NULL, 1, 4),
         ($2, $5, 'checkin_clean', 'checkin_clean', $4::date, $4::date, 'assigned', 'cleaner-boundary', 'cleaner-boundary', 'manual', 'active', NULL, '3pm', 'NEXTDAY', 2, 2)`,
      [crossDayCheckoutId, crossDayCheckinId, TEST_DATE, NEXT_DATE, crossDayPropertyId],
    )
    await pgPool.query(
      `INSERT INTO cleaning_tasks(
         id, property_id, task_type, type, task_date, date, status, assignee_id, cleaner_id, source, execution_state, checkout_time, checkin_time, new_code, keys_required, nights_override
       ) VALUES
         ($1, $4, 'checkout_clean', 'checkout_clean', $3::date, $3::date, 'assigned', 'cleaner-same-day', 'cleaner-same-day', 'manual', 'active', '11am', NULL, NULL, 1, 5),
         ($2, $4, 'checkin_clean', 'checkin_clean', $3::date, $3::date, 'assigned', 'cleaner-same-day', 'cleaner-same-day', 'manual', 'active', NULL, '2pm', 'SAMEDAY', 2, 3)`,
      [sameDayCheckoutId, sameDayCheckinId, TEST_DATE, sameDayPropertyId],
    )
    await pgPool.query(
      `INSERT INTO cleaning_task_media(id, task_id, type, url, captured_at, uploader_id)
       VALUES($1, $2, 'lockbox_video', 'https://example.test/same-day-lockbox.mp4', now(), 'cleaner-same-day')
       ON CONFLICT (id) DO UPDATE SET task_id=EXCLUDED.task_id, type=EXCLUDED.type, url=EXCLUDED.url, captured_at=EXCLUDED.captured_at, uploader_id=EXCLUDED.uploader_id`,
      [sameDayLockboxVideoId, sameDayCheckoutId],
    )
    await pgPool.query(
      `INSERT INTO cleaning_tasks(
         id, property_id, task_type, type, task_date, date, status, assignee_id, cleaner_id, source, execution_state, checkout_time, checkin_time, new_code, keys_required, nights_override
       ) VALUES
         ($1, $4, 'checkout_clean', 'checkout_clean', $3::date, $3::date, 'assigned', 'cleaner-same-day-late', 'cleaner-same-day-late', 'manual', 'active', '10am', NULL, NULL, 1, 2),
         ($2, $4, 'checkin_clean', 'checkin_clean', $3::date, $3::date, 'assigned', 'cleaner-same-day-late', 'cleaner-same-day-late', 'manual', 'active', NULL, '7pm', 'LATEIN', 1, 2)`,
      [sameDayLateCheckoutId, sameDayLateCheckinId, TEST_DATE, sameDayLatePropertyId],
    )
    await pgPool.query(
      `INSERT INTO cleaning_task_media(id, task_id, type, url, captured_at, uploader_id)
       VALUES($1, $2, 'lockbox_video', 'https://example.test/same-day-late-lockbox.mp4', now(), 'cleaner-same-day-late')
       ON CONFLICT (id) DO UPDATE SET task_id=EXCLUDED.task_id, type=EXCLUDED.type, url=EXCLUDED.url, captured_at=EXCLUDED.captured_at, uploader_id=EXCLUDED.uploader_id`,
      [sameDayLateLockboxVideoId, sameDayLateCheckoutId],
    )
    const boundaryTasks = await requestJson(app, 'GET', `/mzapp/work-tasks?date_from=${TEST_DATE}&date_to=${NEXT_DATE}&view=all`)
    const crossDayTask = (boundaryTasks || []).find((item: any) =>
      String(item.property_id) === crossDayPropertyId
      && String(item.scheduled_date || '').slice(0, 10) === TEST_DATE
    )
    assert.ok(crossDayTask, 'cross-day checkout task should be visible')
    assert.ok(!String(crossDayTask.summary || '').includes('入住'), 'next-day checkin must not be shown in checkout-day summary')
    assert.equal(crossDayTask.end_time, null)
    assert.equal(crossDayTask.new_code, null)
    assert.equal(crossDayTask.keys_required_checkin, null)
    assert.equal(crossDayTask.remaining_nights, 0)

    const sameDayTasks = (boundaryTasks || []).filter((item: any) =>
      String(item.property_id) === sameDayPropertyId
      && String(item.scheduled_date || '').slice(0, 10) === TEST_DATE
    )
    assert.equal(sameDayTasks.length, 1, 'same-day turnover with lockbox video should produce one completed card')
    const sameDayTask = sameDayTasks[0]
    assert.ok(sameDayTask, 'same-day turnover task should be visible')
    assert.equal(sameDayTask.status, 'keys_hung')
    assert.ok(String(sameDayTask.summary || '').includes('入住'), 'same-day checkin should still merge into summary')
    assert.equal(sameDayTask.end_time, '2pm')
    assert.equal(sameDayTask.is_late_checkout, true, 'same-day completed turnover must preserve late checkout tag')
    assert.equal(sameDayTask.is_early_checkin, true, 'same-day completed turnover must preserve early checkin tag')
    assert.equal(sameDayTask.new_code, 'SAMEDAY')
    assert.ok(sameDayTask.keys_required_checkin != null, 'same-day checkin key requirement should still be present')
    assert.equal(sameDayTask.remaining_nights, 3)
    const sameDayLateTasks = (boundaryTasks || []).filter((item: any) =>
      String(item.property_id) === sameDayLatePropertyId
      && String(item.scheduled_date || '').slice(0, 10) === TEST_DATE
    )
    assert.equal(sameDayLateTasks.length, 1, 'same-day late-checkin turnover with lockbox video should produce one completed card')
    const sameDayLateTask = sameDayLateTasks[0]
    assert.equal(sameDayLateTask.status, 'keys_hung')
    assert.equal(sameDayLateTask.end_time, '7pm')
    assert.equal(sameDayLateTask.is_late_checkin, true, 'same-day completed turnover must preserve late checkin tag')

    process.stdout.write('test_task_assignment_canonical: testing password-only checkin uses executor assignee\n')
    await pgPool.query(
      `INSERT INTO cleaning_tasks(
         id, property_id, task_type, type, task_date, date, status, assignee_id, cleaner_id, inspector_id, source, execution_state, checkout_time, checkin_time, new_code, keys_required, nights_override, inspection_mode, inspection_scope
       ) VALUES
         ($1, $3, 'checkin_clean', 'checkin_clean', $2::date, $2::date, 'assigned', 'legacy-cleaner', 'legacy-cleaner', 'checkin-inspector', 'manual', 'active', NULL, '3pm', 'PURE', 1, 4, 'same_day', 'password_only')`,
      [pureCheckinId, TEST_DATE, pureCheckinPropertyId],
    )
    const pureCheckinTasks = await requestJson(app, 'GET', `/mzapp/work-tasks?date_from=${TEST_DATE}&date_to=${TEST_DATE}&view=all`)
    const pureCheckinTask = (pureCheckinTasks || []).find((item: any) =>
      String(item.property_id) === pureCheckinPropertyId
      && String(item.scheduled_date || '').slice(0, 10) === TEST_DATE
    )
    assert.ok(pureCheckinTask, 'password-only checkin should stay visible to manager view')
    assert.equal(pureCheckinTask.task_kind, 'execution')
    assert.equal(pureCheckinTask.execution_role, 'execution')
    assert.equal(pureCheckinTask.execution_semantics, 'key_or_password_action')
    assert.equal(pureCheckinTask.assignee_id, 'legacy-cleaner')
    assert.equal(pureCheckinTask.cleaner_id, null)
    assert.equal(pureCheckinTask.inspector_id, null)
    assert.deepEqual(pureCheckinTask.cleaning_task_ids, [])
    assert.deepEqual(pureCheckinTask.execution_task_ids, [pureCheckinId])
    assert.ok(!(pureCheckinTasks || []).some((item: any) =>
      String(item.property_id) === pureCheckinPropertyId
      && String(item.task_kind || '') === 'cleaning'
    ), 'password-only checkin must not produce a cleaning row even when legacy cleaner_id exists')

    process.stdout.write('test_task_assignment_canonical: testing inspect-and-hang checkin stays inspector assignment\n')
    await pgPool.query(
      `INSERT INTO cleaning_tasks(
         id, property_id, task_type, type, task_date, date, status, assignee_id, cleaner_id, inspector_id, source, execution_state, checkout_time, checkin_time, new_code, keys_required, nights_override, inspection_mode, inspection_scope
       ) VALUES
         ($1, $3, 'checkin_clean', 'checkin_clean', $2::date, $2::date, 'assigned', 'handover-executor', NULL, 'legacy-inspector', 'manual', 'active', NULL, '3pm', 'HANDOVER', 1, 2, 'same_day', 'inspect_and_hang')`,
      [keyHandoverId, TEST_DATE, keyHandoverPropertyId],
    )
    const keyHandoverTasks = await requestJson(app, 'GET', `/mzapp/work-tasks?date_from=${TEST_DATE}&date_to=${TEST_DATE}&view=all`)
    const keyHandoverTask = (keyHandoverTasks || []).find((item: any) =>
      String(item.property_id) === keyHandoverPropertyId
      && String(item.scheduled_date || '').slice(0, 10) === TEST_DATE
    )
    assert.ok(keyHandoverTask, 'inspect-and-hang checkin should stay visible to manager view')
    assert.equal(keyHandoverTask.task_kind, 'inspection')
    assert.equal(keyHandoverTask.execution_role, 'inspection')
    assert.equal(keyHandoverTask.execution_semantics, 'checkin_inspection')
    assert.equal(keyHandoverTask.assignee_id, 'legacy-inspector')
    assert.equal(keyHandoverTask.cleaner_id, null)
    assert.equal(keyHandoverTask.inspector_id, 'legacy-inspector')
  } finally {
    await pgPool.query(`DELETE FROM cleaning_task_media WHERE id = ANY($1::text[]) OR task_id = ANY($2::text[])`, [
      [sameDayLockboxVideoId, sameDayLateLockboxVideoId],
      [cleaningId, cleaningKeysHungId, crossDayCheckoutId, crossDayCheckinId, sameDayCheckoutId, sameDayCheckinId, sameDayLateCheckoutId, sameDayLateCheckinId, pureCheckinId, keyHandoverId],
    ])
    await pgPool.query(`DELETE FROM work_tasks WHERE id = ANY($1::text[]) OR source_id = ANY($2::text[])`, [
      [`cleaning_offline_tasks:${offlineNullId}`, `cleaning_offline_tasks:${offlineOldId}`, `cleaning_offline_tasks:${offlineDisplayId}`, workId],
      [offlineNullId, offlineOldId, offlineDisplayId],
    ])
    await pgPool.query(`DELETE FROM cleaning_offline_tasks WHERE id = ANY($1::text[])`, [[offlineNullId, offlineOldId, offlineDisplayId]])
    await pgPool.query(`DELETE FROM cleaning_tasks WHERE id = ANY($1::text[])`, [[cleaningId, cleaningKeysHungId, crossDayCheckoutId, crossDayCheckinId, sameDayCheckoutId, sameDayCheckinId, sameDayLateCheckoutId, sameDayLateCheckinId, pureCheckinId, keyHandoverId]])
    await pgPool.query(`DELETE FROM properties WHERE id = ANY($1::text[])`, [[propertyId, crossDayPropertyId, sameDayPropertyId, sameDayLatePropertyId, pureCheckinPropertyId, keyHandoverPropertyId]])
  }

  process.stdout.write('test_task_assignment_canonical: ok\n')
  await pgPool.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
