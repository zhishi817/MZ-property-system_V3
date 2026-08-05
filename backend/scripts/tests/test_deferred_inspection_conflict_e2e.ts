import assert from 'assert'
import express from 'express'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), override: true })

const TEST_PREFIX = `deferred-inspection-replacement-e2e-${Date.now()}`
const TEST_USER = {
  sub: `${TEST_PREFIX}-admin`,
  username: `${TEST_PREFIX}-admin`,
  role: 'admin',
  roles: ['admin'],
}

const DATES = {
  orderCheckin: '2031-01-11',
  orderDeferredTask: '2031-01-10',
  orderDeferredDue: '2031-01-12',
  createCheckin: '2031-02-11',
  createDeferredTask: '2031-02-10',
  createDeferredDue: '2031-02-12',
  editCheckin: '2031-03-11',
  editDeferredTask: '2031-03-10',
  editDeferredDue: '2031-03-12',
  boardCheckin: '2031-04-11',
  boardDeferredTask: '2031-04-10',
  boardDeferredDue: '2031-04-12',
}

const PROPERTY_IDS = {
  order: `${TEST_PREFIX}-property-order`,
  create: `${TEST_PREFIX}-property-create`,
  edit: `${TEST_PREFIX}-property-edit`,
  board: `${TEST_PREFIX}-property-board`,
}

const TASK_IDS = {
  orderDeferred: `${TEST_PREFIX}-task-order-deferred`,
  createDeferred: `${TEST_PREFIX}-task-create-deferred`,
  editDeferred: `${TEST_PREFIX}-task-edit-deferred`,
  editCheckin: `${TEST_PREFIX}-task-edit-checkin`,
  boardDeferred: `${TEST_PREFIX}-task-board-deferred`,
  boardCheckin: `${TEST_PREFIX}-task-board-checkin`,
}

const ORDER_ID = `${TEST_PREFIX}-order`
const BOARD_ROW_KEY = `${TEST_PREFIX}-row`

type ReplacementSnapshot = {
  inspectionMode: string | null
  inspectionDueDate: string | null
  replacementCheckinTaskId: string | null
  originalDueDate: string | null
}

function assertNonProductionWriteGate() {
  assert.equal(
    String(process.env.DEFERRED_INSPECTION_E2E_ALLOW_DB_WRITES || '').trim(),
    '1',
    'set DEFERRED_INSPECTION_E2E_ALLOW_DB_WRITES=1 only for a confirmed non-production database',
  )
  const label = String(process.env.DEFERRED_INSPECTION_E2E_DATABASE_LABEL || '').trim()
  assert(label && !/prod|production/i.test(label), 'DEFERRED_INSPECTION_E2E_DATABASE_LABEL must identify a non-production database')
  assert(!/^(prod|production)$/i.test(String(process.env.NODE_ENV || '').trim()), 'test refuses NODE_ENV=production')
  assert(!/^(prod|production)$/i.test(String(process.env.APP_ENV || '').trim()), 'test refuses APP_ENV=production')
}

async function maybeDelete(pgPool: any, table: string, sql: string, params: any[]) {
  const exists = await pgPool.query(`SELECT to_regclass($1) AS name`, [`public.${table}`])
  if (!exists?.rows?.[0]?.name) return
  await pgPool.query(sql, params)
}

async function cleanup(pgPool: any, allTaskIds: string[]) {
  await maybeDelete(pgPool, 'work_task_events', `DELETE FROM work_task_events WHERE source_type='cleaning_tasks' AND source_ref_ids && $1::text[]`, [allTaskIds])
  await maybeDelete(pgPool, 'work_task_event_versions', `DELETE FROM work_task_event_versions WHERE task_id = ANY($1::text[])`, [allTaskIds.map((id) => `cleaning_task:${id}`)])
  await maybeDelete(pgPool, 'task_center_board_items', `DELETE FROM task_center_board_items WHERE task_id = ANY($1::text[])`, [allTaskIds])
  await maybeDelete(pgPool, 'task_center_task_flags', `DELETE FROM task_center_task_flags WHERE task_id = ANY($1::text[])`, [allTaskIds])
  await maybeDelete(pgPool, 'task_center_board_rows', `DELETE FROM task_center_board_rows WHERE row_key=$1`, [BOARD_ROW_KEY])
  await maybeDelete(pgPool, 'cleaning_sync_logs', `DELETE FROM cleaning_sync_logs WHERE order_id=$1`, [ORDER_ID])
  await pgPool.query(`DELETE FROM cleaning_tasks WHERE id = ANY($1::text[])`, [allTaskIds])
  await pgPool.query(`DELETE FROM orders WHERE id=$1`, [ORDER_ID])
  await pgPool.query(`DELETE FROM properties WHERE id = ANY($1::text[])`, [Object.values(PROPERTY_IDS)])
}

async function seed(pgPool: any) {
  await pgPool.query(
    `INSERT INTO properties(id, code, address, region)
     VALUES ($1,$5,$9,'e2e'),($2,$6,$10,'e2e'),($3,$7,$11,'e2e'),($4,$8,$12,'e2e')`,
    [
      PROPERTY_IDS.order,
      PROPERTY_IDS.create,
      PROPERTY_IDS.edit,
      PROPERTY_IDS.board,
      `${TEST_PREFIX}-ORDER`,
      `${TEST_PREFIX}-CREATE`,
      `${TEST_PREFIX}-EDIT`,
      `${TEST_PREFIX}-BOARD`,
      'deferred inspection replacement order property',
      'deferred inspection replacement create property',
      'deferred inspection replacement edit property',
      'deferred inspection replacement board property',
    ],
  )
  await pgPool.query(
    `INSERT INTO orders(id, source, external_id, property_id, guest_name, checkin, checkout, price, currency, status, idempotency_key)
     VALUES ($1,'e2e',$2,$3,'e2e fixture',$4::date,'2031-01-14'::date,1,'AUD','confirmed',$5)`,
    [ORDER_ID, `${TEST_PREFIX}-external`, PROPERTY_IDS.order, DATES.orderCheckin, `${TEST_PREFIX}-order-key`],
  )
  await pgPool.query(
    `INSERT INTO cleaning_tasks(
       id, property_id, task_type, type, task_date, date, status, execution_state,
       inspection_mode, inspection_scope, inspection_due_date, source, auto_sync_enabled, manual_task_purpose, checkin_time
     ) VALUES
       ($1,$7,'checkout_clean','checkout_clean',$11::date,$11::date,'pending','active','deferred','inspect_and_hang',$12::date,'manual',false,'e2e_fixture',NULL),
       ($2,$8,'checkout_clean','checkout_clean',$13::date,$13::date,'pending','active','deferred','inspect_and_hang',$14::date,'manual',false,'e2e_fixture',NULL),
       ($3,$9,'checkout_clean','checkout_clean',$15::date,$15::date,'pending','active','deferred','inspect_and_hang',$16::date,'manual',false,'e2e_fixture',NULL),
       ($4,$9,'checkin_clean','checkin_clean','2031-03-14'::date,'2031-03-14'::date,'pending','active','same_day','inspect_and_hang',NULL,'manual',false,'e2e_fixture','10:00'),
       ($5,$10,'checkout_clean','checkout_clean',$17::date,$17::date,'pending','active','same_day','inspect_and_hang',NULL,'manual',false,'e2e_fixture',NULL),
       ($6,$10,'checkin_clean','checkin_clean',$18::date,$18::date,'pending','active','same_day','inspect_and_hang',NULL,'manual',false,'e2e_fixture','10:00')`,
    [
      TASK_IDS.orderDeferred,
      TASK_IDS.createDeferred,
      TASK_IDS.editDeferred,
      TASK_IDS.editCheckin,
      TASK_IDS.boardDeferred,
      TASK_IDS.boardCheckin,
      PROPERTY_IDS.order,
      PROPERTY_IDS.create,
      PROPERTY_IDS.edit,
      PROPERTY_IDS.board,
      DATES.orderDeferredTask,
      DATES.orderDeferredDue,
      DATES.createDeferredTask,
      DATES.createDeferredDue,
      DATES.editDeferredTask,
      DATES.editDeferredDue,
      DATES.boardDeferredTask,
      DATES.boardCheckin,
    ],
  )
}

async function withServer<T>(run: (baseUrl: string) => Promise<T>) {
  const worker = require('../../src/services/notificationQueueWorker')
  worker.scheduleNotificationQueueKick = () => {}
  const workTaskEvents = require('../../src/services/workTaskEvents')
  workTaskEvents.emitWorkTaskEvent = async () => ({ intercepted: true })
  const { router: cleaningRouter } = await import('../../src/modules/cleaning')
  const { router: taskCenterRouter } = await import('../../src/modules/task_center')
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use((req: any, _res, next) => {
    req.user = TEST_USER
    next()
  })
  app.use('/cleaning', cleaningRouter)
  app.use('/task-center', taskCenterRouter)
  const server = await new Promise<any>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function requestJson(baseUrl: string, method: string, requestPath: string, body?: any, expected = 200) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await response.text()
    const data = raw ? JSON.parse(raw) : null
    assert.equal(response.status, expected, `${method} ${requestPath} expected ${expected}, got ${response.status}`)
    return data
  } finally {
    clearTimeout(timeout)
  }
}

async function snapshotReplacement(pgPool: any, deferredTaskId: string): Promise<ReplacementSnapshot> {
  const r = await pgPool.query(
    `SELECT
       inspection_mode,
       inspection_due_date::text AS inspection_due_date,
       inspection_replaced_by_checkin_task_id::text AS inspection_replaced_by_checkin_task_id,
       inspection_replaced_original_due_date::text AS inspection_replaced_original_due_date
     FROM cleaning_tasks
     WHERE id::text=$1::text`,
    [deferredTaskId],
  )
  const row = r.rows[0] || {}
  return {
    inspectionMode: row.inspection_mode ? String(row.inspection_mode) : null,
    inspectionDueDate: row.inspection_due_date ? String(row.inspection_due_date).slice(0, 10) : null,
    replacementCheckinTaskId: row.inspection_replaced_by_checkin_task_id ? String(row.inspection_replaced_by_checkin_task_id) : null,
    originalDueDate: row.inspection_replaced_original_due_date ? String(row.inspection_replaced_original_due_date).slice(0, 10) : null,
  }
}

function assertReplaced(snapshot: ReplacementSnapshot, checkinTaskId: string, dueDate: string, label: string) {
  assert.deepStrictEqual(snapshot, {
    inspectionMode: 'checked_done',
    inspectionDueDate: null,
    replacementCheckinTaskId: checkinTaskId,
    originalDueDate: dueDate,
  }, `${label}: deferred inspection must be replaced by the qualifying check-in`)
}

function assertRestored(snapshot: ReplacementSnapshot, dueDate: string, label: string) {
  assert.deepStrictEqual(snapshot, {
    inspectionMode: 'deferred',
    inspectionDueDate: dueDate,
    replacementCheckinTaskId: null,
    originalDueDate: null,
  }, `${label}: cancelling the replacing check-in must restore the original deferred inspection`)
}

async function assertNoDeferredProjection(baseUrl: string, deferredTaskId: string, date: string, label: string) {
  const items = await requestJson(baseUrl, 'GET', `/cleaning/calendar-range?from=${date}&to=${date}&include_deferred_inspection=1`)
  const hasProjection = (Array.isArray(items) ? items : []).some((item: any) =>
    item?.deferred_inspection_view === true && Array.isArray(item?.entity_ids) && item.entity_ids.map(String).includes(deferredTaskId),
  )
  assert.equal(hasProjection, false, `${label}: replacement must remove the deferred card on its original due day`)
}

async function main() {
  assertNonProductionWriteGate()
  const { pgPool } = await import('../../src/dbAdapter')
  if (!pgPool) throw new Error('database_not_configured')
  const { bootstrapCleaningSyncSchemaV2, syncOrderToCleaningTasks } = await import('../../src/services/cleaningSync')
  await bootstrapCleaningSyncSchemaV2()
  const allTaskIds = Object.values(TASK_IDS)
  let manualCreateTaskId = ''

  try {
    await cleanup(pgPool, allTaskIds)
    await seed(pgPool)

    const orderFirst = await syncOrderToCleaningTasks(ORDER_ID, { jobId: `${TEST_PREFIX}-sync` })
    assert.equal(orderFirst.action, 'created', 'order sync fixture should create cleaning tasks')
    const orderCheckinResult = await pgPool.query(
      `SELECT id::text AS id FROM cleaning_tasks WHERE order_id=$1 AND task_type='checkin_clean' LIMIT 1`,
      [ORDER_ID],
    )
    const orderCheckinId = String(orderCheckinResult.rows[0]?.id || '')
    assert(orderCheckinId, 'order sync must create a check-in task')
    allTaskIds.push(orderCheckinId)
    const orderCheckoutResult = await pgPool.query(
      `SELECT id::text AS id FROM cleaning_tasks WHERE order_id=$1 AND task_type='checkout_clean' LIMIT 1`,
      [ORDER_ID],
    )
    const orderCheckoutId = String(orderCheckoutResult.rows[0]?.id || '')
    if (orderCheckoutId) allTaskIds.push(orderCheckoutId)
    assertReplaced(await snapshotReplacement(pgPool, TASK_IDS.orderDeferred), orderCheckinId, DATES.orderDeferredDue, 'order sync')
    const orderRepeat = await syncOrderToCleaningTasks(ORDER_ID, { jobId: `${TEST_PREFIX}-sync-repeat` })
    assert.equal(orderRepeat.action, 'no_change', 'unchanged order sync should remain idempotent')
    assertReplaced(await snapshotReplacement(pgPool, TASK_IDS.orderDeferred), orderCheckinId, DATES.orderDeferredDue, 'order sync repeat')

    await withServer(async (baseUrl) => {
      const created = await requestJson(baseUrl, 'POST', '/cleaning/tasks', {
        task_type: 'checkin_clean',
        task_date: DATES.createCheckin,
        property_id: PROPERTY_IDS.create,
        status: 'pending',
        inspection_scope: 'inspect_and_hang',
        checkin_time: '10:00',
      })
      manualCreateTaskId = String(created?.id || '')
      assert(manualCreateTaskId, 'manual create should return the created check-in task id')
      allTaskIds.push(manualCreateTaskId)
      assertReplaced(await snapshotReplacement(pgPool, TASK_IDS.createDeferred), manualCreateTaskId, DATES.createDeferredDue, 'manual create')
      await assertNoDeferredProjection(baseUrl, TASK_IDS.createDeferred, DATES.createDeferredDue, 'manual create')

      await requestJson(baseUrl, 'DELETE', `/cleaning/tasks/${manualCreateTaskId}`)
      assertRestored(await snapshotReplacement(pgPool, TASK_IDS.createDeferred), DATES.createDeferredDue, 'manual check-in cancellation')

      await requestJson(baseUrl, 'PATCH', `/cleaning/tasks/${TASK_IDS.editCheckin}`, { task_date: DATES.editCheckin })
      assertReplaced(await snapshotReplacement(pgPool, TASK_IDS.editDeferred), TASK_IDS.editCheckin, DATES.editDeferredDue, 'manual edit')
      await assertNoDeferredProjection(baseUrl, TASK_IDS.editDeferred, DATES.editDeferredDue, 'manual edit')

      const boardPayload = {
        date: DATES.boardDeferredDue,
        mode: 'board',
        rows: [{ row_key: BOARD_ROW_KEY, row_type: 'deferred', row_title: 'E2E deferred', row_order: 0 }],
        subrows: [],
        items: [],
        row_assignments: [],
        cleaning_assignments: [{
          task_id: TASK_IDS.boardDeferred,
          inspection_mode: 'deferred',
          inspection_scope: 'inspect_and_hang',
          inspection_due_date: DATES.boardDeferredDue,
        }],
        work_assignments: [],
        task_flags: [],
      }
      const boardResult = await requestJson(baseUrl, 'POST', '/task-center/save-board', boardPayload)
      assert.equal(Number(boardResult?.changed_tasks?.cleaning || 0), 1, 'task-center save should configure the deferred task')
      assertReplaced(await snapshotReplacement(pgPool, TASK_IDS.boardDeferred), TASK_IDS.boardCheckin, DATES.boardDeferredDue, 'task-center save')
      await assertNoDeferredProjection(baseUrl, TASK_IDS.boardDeferred, DATES.boardDeferredDue, 'task-center save')
    })

    await cleanup(pgPool, allTaskIds)
    console.log(JSON.stringify({ ok: true, flows: ['order_sync', 'manual_create_and_cancel', 'manual_edit', 'task_center_save'], externalPushes: 0, residualAfterCleanup: 0 }, null, 2))
  } finally {
    try {
      if (manualCreateTaskId && !allTaskIds.includes(manualCreateTaskId)) allTaskIds.push(manualCreateTaskId)
      await cleanup(pgPool, allTaskIds)
    } finally {
      await pgPool.end().catch(() => {})
    }
  }
}

main().catch((error) => {
  console.error(String(error?.message || 'deferred_inspection_replacement_e2e_failed'))
  process.exit(1)
})
