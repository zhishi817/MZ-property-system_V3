import assert from 'assert'
import { randomBytes } from 'crypto'

const connectionString = String(process.env.MZ091_TEST_DATABASE_URL || '').trim()
const expectedDataDirectory = String(process.env.MZ091_TEST_DATA_DIR || '').trim()
const writeEnabled = String(process.env.MZ091_TEST_DATABASE_WRITE || '').trim().toLowerCase() === 'yes'
const ephemeralConfirmed = String(process.env.MZ091_TEST_CONFIRM_EPHEMERAL || '').trim().toLowerCase() === 'yes'

function requireSafeTarget() {
  if (!connectionString) throw new Error('MZ091_TEST_DATABASE_URL_required')
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol.toLowerCase())) throw new Error('MZ091_TEST_DATABASE_URL_invalid')
  if (url.search) throw new Error('MZ091_TEST_DATABASE_URL_must_not_include_query_parameters')
  if (url.hostname !== '127.0.0.1') throw new Error('MZ091_TEST_DATABASE_URL_must_use_numeric_loopback')
  const port = Number(url.port || 5432)
  if (!Number.isInteger(port) || port <= 0 || port === 5432) throw new Error('MZ091_TEST_DATABASE_URL_must_use_random_nondefault_port')
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!/^mz091_test_[a-z0-9_]+$/i.test(database)) throw new Error('MZ091_TEST_DATABASE_URL_must_name_mz091_test_database')
  if (!/^\/tmp\/mz091-v2-pg\.[A-Za-z0-9_-]+\/data$/.test(expectedDataDirectory)) throw new Error('MZ091_TEST_DATA_DIR_invalid')
  if (!writeEnabled || !ephemeralConfirmed) throw new Error('MZ091_TEST_write_confirmation_required')
}

requireSafeTarget()
process.env.DATABASE_URL = connectionString
process.env.DATABASE_DIRECT_URL = connectionString
process.env.NODE_ENV = 'test'
process.env.PG_POOL_MAX = '8'

const { pgPool, pgRunInTransaction } = require('../../src/dbAdapter') as typeof import('../../src/dbAdapter')
const { warmupPasswordAuthoritySchema } = require('../../src/lib/passwordAuthoritySchema') as typeof import('../../src/lib/passwordAuthoritySchema')
const { warmupR5TaskRuntimeSchema } = require('../../src/lib/r5RequestSchema') as typeof import('../../src/lib/r5RequestSchema')
const { warmupMaintenanceRuntimeSchema } = require('../../src/lib/maintenanceRuntimeSchema') as typeof import('../../src/lib/maintenanceRuntimeSchema')
const {
  syncCheckoutOldCodeFromCheckinNewCode,
  syncNextCheckinOldCodeFromSourceOrder,
  syncOrderToCleaningTasks,
} = require('../../src/services/cleaningSync') as typeof import('../../src/services/cleaningSync')

if (!pgPool) throw new Error('MZ091_TEST_pg_pool_missing')

const runId = randomBytes(6).toString('hex')
const prefix = `mz091v2_${runId}`
const properties = {
  primary: `${prefix}_property_primary`,
  generation: `${prefix}_property_generation`,
  crossOrder: `${prefix}_property_cross_order`,
  mergedMissing: `${prefix}_property_merged_missing`,
}
const orders = {
  linked: `${prefix}_order_linked`,
  manual: `${prefix}_order_manual`,
  checkinFirst: `${prefix}_order_checkin_first`,
  checkoutFirst: `${prefix}_order_checkout_first`,
  concurrent: `${prefix}_order_concurrent`,
  freshSync: `${prefix}_order_fresh_sync`,
  freshMissing: `${prefix}_order_fresh_missing`,
  legacyFilled: `${prefix}_order_legacy_filled`,
  apiRoute: `${prefix}_order_api_route`,
  mergedMissingOutgoing: `${prefix}_order_merged_missing_outgoing`,
  mergedMissingIncoming: `${prefix}_order_merged_missing_incoming`,
  crossSource: `${prefix}_order_cross_source`,
  crossTarget: `${prefix}_order_cross_target`,
}
const taskIds: string[] = []
const orderIds = Object.values(orders)
const propertyIds = Object.values(properties)

function taskId(suffix: string) {
  const id = `${prefix}_task_${suffix}`
  taskIds.push(id)
  return id
}

async function insertOrder(id: string, propertyId: string, checkin: string, checkout: string, guestPhone?: string | null) {
  await pgPool!.query(
    `INSERT INTO orders(id, property_id, checkin, checkout, nights, status, confirmation_code, guest_phone)
     VALUES($1,$2,$3::date,$4::date,($4::date-$3::date),'confirmed',$5,$6)`,
    [id, propertyId, checkin, checkout, `${prefix}_${id.slice(-12)}`, guestPhone ?? null],
  )
}

async function insertTask(params: {
  id: string
  orderId: string
  propertyId: string
  taskType: 'checkin_clean' | 'checkout_clean'
  taskDate: string
  oldCode?: string | null
  newCode?: string | null
  oldAuthority?: string | null
  newAuthority?: string | null
  oldSourceTaskId?: string | null
  oldSourceOrderId?: string | null
  oldSourceField?: string | null
  autoSyncEnabled?: boolean
}) {
  await pgPool!.query(
    `INSERT INTO cleaning_tasks(
       id, order_id, property_id, task_type, type, task_date, date,
       status, source, execution_state, auto_sync_enabled,
       old_code, new_code, old_code_authority_status, new_code_authority_status,
       old_code_source_task_id, old_code_source_order_id, old_code_source_field
     ) VALUES($1,$2,$3,$4,$4,$5::date,$5::date,'pending','auto','active',$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      params.id,
      params.orderId,
      params.propertyId,
      params.taskType,
      params.taskDate,
      params.autoSyncEnabled !== false,
      params.oldCode ?? null,
      params.newCode ?? null,
      params.oldAuthority ?? null,
      params.newAuthority ?? null,
      params.oldSourceTaskId ?? null,
      params.oldSourceOrderId ?? null,
      params.oldSourceField ?? null,
    ],
  )
}

async function readTask(orderId: string, taskType: string) {
  const result = await pgPool!.query(
    `SELECT * FROM cleaning_tasks
     WHERE order_id=$1 AND lower(COALESCE(task_type,type,''))=lower($2)
     LIMIT 1`,
    [orderId, taskType],
  )
  return result.rows[0] || null
}

async function syncCheckout(orderId: string) {
  return pgRunInTransaction((client) => syncCheckoutOldCodeFromCheckinNewCode({ orderId, client }))
}

async function main() {
  const identity = await pgPool!.query(
    `SELECT current_database() AS database,
            host(inet_server_addr()) AS address,
            inet_server_port() AS port,
            current_setting('data_directory') AS data_directory`,
  )
  const row = identity.rows[0]
  assert.match(String(row.database), /^mz091_test_[a-z0-9_]+$/i)
  assert.equal(String(row.address), '127.0.0.1')
  assert.notEqual(Number(row.port), 5432)
  assert.equal(String(row.data_directory), expectedDataDirectory)

  await warmupPasswordAuthoritySchema()
  await warmupR5TaskRuntimeSchema()
  await warmupMaintenanceRuntimeSchema()

  for (const propertyId of propertyIds) {
    await pgPool!.query('INSERT INTO properties(id,code) VALUES($1,$1) ON CONFLICT(id) DO NOTHING', [propertyId])
  }
  await insertOrder(orders.linked, properties.primary, '2026-11-01', '2026-11-03')
  await insertOrder(orders.manual, properties.primary, '2026-11-04', '2026-11-06')
  await insertOrder(orders.checkinFirst, properties.generation, '2026-11-07', '2026-11-09')
  await insertOrder(orders.checkoutFirst, properties.generation, '2026-11-10', '2026-11-12')
  await insertOrder(orders.concurrent, properties.generation, '2026-11-13', '2026-11-15')
  await insertOrder(orders.freshSync, properties.generation, '2026-11-22', '2026-11-24', '0400004826')
  await insertOrder(orders.freshMissing, properties.generation, '2026-11-25', '2026-11-27')
  await insertOrder(orders.legacyFilled, properties.generation, '2026-11-28', '2026-11-30')
  await insertOrder(orders.apiRoute, properties.generation, '2026-12-01', '2026-12-03')
  await insertOrder(orders.mergedMissingOutgoing, properties.mergedMissing, '2026-12-01', '2026-12-05')
  await insertOrder(orders.mergedMissingIncoming, properties.mergedMissing, '2026-12-05', '2026-12-08')
  await insertOrder(orders.crossSource, properties.crossOrder, '2026-11-16', '2026-11-18')
  await insertOrder(orders.crossTarget, properties.crossOrder, '2026-11-19', '2026-11-21')

  const linkedCheckin = taskId('linked_checkin')
  const linkedCheckout = taskId('linked_checkout')
  await insertTask({
    id: linkedCheckin,
    orderId: orders.linked,
    propertyId: properties.primary,
    taskType: 'checkin_clean',
    taskDate: '2026-11-01',
    newCode: 'SYNTH_LINKED',
    newAuthority: 'manual_confirmed',
  })
  await insertTask({
    id: linkedCheckout,
    orderId: orders.linked,
    propertyId: properties.primary,
    taskType: 'checkout_clean',
    taskDate: '2026-11-03',
    oldCode: 'SYNTH_STALE',
    oldAuthority: null,
    autoSyncEnabled: false,
  })
  const linked = await syncCheckout(orders.linked)
  assert.equal(linked.reason, 'source_linked')
  let linkedOut = await readTask(orders.linked, 'checkout_clean')
  assert.equal(linkedOut.old_code, 'SYNTH_LINKED')
  assert.equal(linkedOut.old_code_authority_status, 'source_linked')
  assert.equal(linkedOut.old_code_source_task_id, linkedCheckin)
  assert.equal(linkedOut.old_code_source_order_id, orders.linked)
  assert.equal(linkedOut.old_code_source_field, 'new_code')

  await syncOrderToCleaningTasks(orders.freshSync)
  const freshCheckin = await readTask(orders.freshSync, 'checkin_clean')
  const freshCheckout = await readTask(orders.freshSync, 'checkout_clean')
  assert.equal(freshCheckin.new_code, '4826', 'the first PostgreSQL insert must persist the derived check-in new_code')
  assert.equal(freshCheckout.old_code, freshCheckin.new_code, 'the first full sync must converge checkout old_code from the same-order check-in')
  assert.equal(freshCheckout.old_code_authority_status, 'source_linked')
  assert.equal(freshCheckout.old_code_source_order_id, orders.freshSync)

  await syncOrderToCleaningTasks(orders.freshMissing)
  const freshMissingCheckin = await readTask(orders.freshMissing, 'checkin_clean')
  const freshMissingCheckout = await readTask(orders.freshMissing, 'checkout_clean')
  assert.equal(freshMissingCheckin.new_code, null, 'a fresh order without a source value must keep check-in new_code empty')
  assert.equal(freshMissingCheckout.old_code, null, 'a fresh order without a source value must keep checkout old_code empty')

  const legacyFilledCheckin = taskId('legacy_filled_checkin')
  await insertTask({
    id: legacyFilledCheckin,
    orderId: orders.legacyFilled,
    propertyId: properties.generation,
    taskType: 'checkin_clean',
    taskDate: '2026-11-28',
    oldCode: 'SYNTH_UNRELATED_OLD',
    oldAuthority: 'needs_review',
    newCode: 'SYNTH_LEGACY_FILLED',
    newAuthority: 'needs_review',
  })
  await insertTask({
    id: taskId('legacy_filled_checkout'),
    orderId: orders.legacyFilled,
    propertyId: properties.generation,
    taskType: 'checkout_clean',
    taskDate: '2026-11-30',
    oldCode: 'SYNTH_STALE_LEGACY',
  })
  const legacyFilled = await syncCheckout(orders.legacyFilled)
  assert.equal(legacyFilled.reason, 'source_linked')
  const legacyFilledOut = await readTask(orders.legacyFilled, 'checkout_clean')
  assert.equal(legacyFilledOut.old_code, 'SYNTH_LEGACY_FILLED', 'PostgreSQL propagation must use a populated same-order new_code even when its legacy label is needs_review')
  assert.equal(legacyFilledOut.old_code_authority_status, 'source_linked')
  assert.equal(legacyFilledOut.old_code_source_task_id, legacyFilledCheckin)
  assert.equal(legacyFilledOut.old_code_source_order_id, orders.legacyFilled)

  const apiCheckin = taskId('api_route_checkin')
  const apiCheckout = taskId('api_route_checkout')
  await insertTask({
    id: apiCheckin,
    orderId: orders.apiRoute,
    propertyId: properties.generation,
    taskType: 'checkin_clean',
    taskDate: '2026-12-01',
  })
  await insertTask({
    id: apiCheckout,
    orderId: orders.apiRoute,
    propertyId: properties.generation,
    taskType: 'checkout_clean',
    taskDate: '2026-12-03',
  })
  const manualCheckin = taskId('manual_checkin')
  const manualCheckout = taskId('manual_checkout')
  await insertTask({
    id: manualCheckin,
    orderId: orders.manual,
    propertyId: properties.primary,
    taskType: 'checkin_clean',
    taskDate: '2026-11-04',
    newCode: 'SYNTH_SOURCE_NEW',
    newAuthority: 'manual_confirmed',
  })
  await insertTask({
    id: manualCheckout,
    orderId: orders.manual,
    propertyId: properties.primary,
    taskType: 'checkout_clean',
    taskDate: '2026-11-06',
    oldCode: 'SYNTH_LOCAL_FIX',
    oldAuthority: 'manual_confirmed',
    oldSourceField: 'manual',
  })
  const preserved = await syncCheckout(orders.manual)
  assert.equal(preserved.reason, 'manual_confirmation_preserved')
  assert.equal((await readTask(orders.manual, 'checkout_clean')).old_code, 'SYNTH_LOCAL_FIX')

  const mergedMissingCheckin = taskId('merged_missing_checkin')
  const mergedMissingCheckout = taskId('merged_missing_checkout')
  await insertTask({
    id: mergedMissingCheckin,
    orderId: orders.mergedMissingIncoming,
    propertyId: properties.mergedMissing,
    taskType: 'checkin_clean',
    taskDate: '2026-12-05',
    newCode: null,
    newAuthority: 'needs_review',
  })
  await insertTask({
    id: mergedMissingCheckout,
    orderId: orders.mergedMissingOutgoing,
    propertyId: properties.mergedMissing,
    taskType: 'checkout_clean',
    taskDate: '2026-12-05',
    oldCode: 'SYNTH_HIDDEN_STALE',
    oldAuthority: 'needs_review',
  })
  const express = require('express') as typeof import('express')
  const { router: cleaningRouter } = require('../../src/modules/cleaning') as typeof import('../../src/modules/cleaning')
  const { router: mzappRouter } = require('../../src/modules/mzapp') as typeof import('../../src/modules/mzapp')
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => {
    req.user = { sub: `${prefix}_admin`, role: 'admin', roles: ['admin'] }
    next()
  })
  app.use('/cleaning', cleaningRouter)
  app.use('/mzapp', mzappRouter)
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const response = await fetch(`http://127.0.0.1:${address.port}/cleaning/tasks/${apiCheckin}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        new_code: 'SYNTH_API_ROUTE',
        password_verification: {
          fields: ['new_code'],
          request_id: `${prefix}_api_route_request`,
          client: 'api',
        },
      }),
    })
    assert.equal(response.status, 200, `real Express/PG password PATCH failed: ${await response.text()}`)
    const apiSourceOut = await readTask(orders.apiRoute, 'checkin_clean')
    const apiTargetOut = await readTask(orders.apiRoute, 'checkout_clean')
    assert.equal(apiSourceOut.new_code, 'SYNTH_API_ROUTE')
    assert.equal(apiSourceOut.new_code_authority_status, 'manual_confirmed')
    assert.equal(apiTargetOut.old_code, 'SYNTH_API_ROUTE', 'the actual HTTP route must commit the same-order checkout SQL update')
    assert.equal(apiTargetOut.old_code_authority_status, 'source_linked')
    assert.equal(apiTargetOut.old_code_source_task_id, apiCheckin)
    assert.equal(apiTargetOut.old_code_source_order_id, orders.apiRoute)

    const getWorkTasks = async (dateFrom: string, dateTo: string) => {
      const result = await fetch(`http://127.0.0.1:${address.port}/mzapp/work-tasks?date_from=${dateFrom}&date_to=${dateTo}&view=all`)
      const body = await result.text()
      assert.equal(result.status, 200, `real MZapp work-tasks GET failed: ${body}`)
      return JSON.parse(body) as any[]
    }
    const linkedCards = await getWorkTasks('2026-11-01', '2026-11-03')
    const linkedMatches = linkedCards.filter((item: any) => (item.active_source_ids || item.source_ids || []).includes(linkedCheckout))
    assert.equal(linkedMatches.length, 1, 'the real MZapp GET route must return exactly one source-linked checkout card')
    const linkedCard = linkedMatches[0]
    assert.equal(linkedCard.old_code, 'SYNTH_LINKED')
    assert.equal(linkedCard.password_authority?.old_code_status, 'source_linked')
    assert.equal(linkedCard.password_authority?.old_code_source_task_id, linkedCheckin)
    assert.equal(linkedCard.password_authority?.old_code_source_order_id, orders.linked)
    assert.equal(linkedCard.password_authority?.old_code_source_field, 'new_code')
    assert.equal(linkedCard.turnover_display?.old_code_authority_status, 'source_linked')

    const manualCards = await getWorkTasks('2026-11-04', '2026-11-06')
    const manualMatches = manualCards.filter((item: any) => (item.active_source_ids || item.source_ids || []).includes(manualCheckout))
    assert.equal(manualMatches.length, 1, 'the real MZapp GET route must return exactly one manual-confirmed checkout card')
    const manualCard = manualMatches[0]
    assert.equal(manualCard.old_code, 'SYNTH_LOCAL_FIX')
    assert.equal(manualCard.password_authority?.old_code_status, 'manual_confirmed')
    assert.equal(manualCard.password_authority?.old_code_source_field, 'manual')
    assert.equal(manualCard.turnover_display?.old_code_authority_status, 'manual_confirmed')

    const missingCards = await getWorkTasks('2026-12-05', '2026-12-05')
    const missingMatches = missingCards.filter((item: any) => String(item.property_id || '') === properties.mergedMissing)
    assert.equal(missingMatches.length, 1, 'the real MZapp GET route must return exactly one same-day missing-source turnover card')
    const missingCard = missingMatches[0]
    assert.deepEqual(
      [...(missingCard.active_source_ids || missingCard.source_ids || [])].sort(),
      [mergedMissingCheckin, mergedMissingCheckout].sort(),
      'the null/fallback assertion must target the canonical outgoing-checkout plus incoming-checkin merged card',
    )
    assert.equal(missingCard.task_type, 'turnover')
    assert.equal(missingCard.old_code, null, 'merged GET output must not restore the stale stored needs_review old_code')
    assert.equal(missingCard.password_authority?.old_code_status, 'needs_review')
    assert.equal(missingCard.password_authority?.old_code_source_task_id, null)
    assert.equal(missingCard.password_authority?.old_code_source_order_id, null)
    assert.equal(missingCard.password_authority?.old_code_source_field, null)
    assert.equal(missingCard.turnover_display?.old_code, null)
    assert.equal(missingCard.turnover_display?.old_code_authority_status, null, 'a hidden stale value must not retain display authority metadata')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()))
  }

  await pgPool!.query(
    `UPDATE cleaning_tasks
     SET old_code_source_order_id=$2, old_code_source_field='old_code'
     WHERE id=$1`,
    [linkedCheckout, orders.crossSource],
  )
  const relinked = await syncCheckout(orders.linked)
  assert.equal(relinked.reason, 'source_linked')
  linkedOut = await readTask(orders.linked, 'checkout_clean')
  assert.equal(linkedOut.old_code_source_order_id, orders.linked)
  assert.equal(linkedOut.old_code_source_field, 'new_code')

  await pgPool!.query('UPDATE cleaning_tasks SET new_code=NULL WHERE id=$1', [linkedCheckin])
  const cleared = await syncCheckout(orders.linked)
  assert.equal(cleared.reason, 'source_missing')
  linkedOut = await readTask(orders.linked, 'checkout_clean')
  assert.equal(linkedOut.old_code, null)
  assert.equal(linkedOut.old_code_source_order_id, orders.linked)

  const checkinFirstId = taskId('checkin_first')
  await insertTask({
    id: checkinFirstId,
    orderId: orders.checkinFirst,
    propertyId: properties.generation,
    taskType: 'checkin_clean',
    taskDate: '2026-11-07',
    newCode: 'SYNTH_BEFORE_CREATE',
    newAuthority: 'manual_confirmed',
  })
  assert.equal((await syncCheckout(orders.checkinFirst)).reason, 'target_missing_or_terminal')
  await syncOrderToCleaningTasks(orders.checkinFirst)
  assert.equal((await readTask(orders.checkinFirst, 'checkout_clean')).old_code, 'SYNTH_BEFORE_CREATE')

  const checkoutFirstId = taskId('checkout_first')
  await insertTask({
    id: checkoutFirstId,
    orderId: orders.checkoutFirst,
    propertyId: properties.generation,
    taskType: 'checkout_clean',
    taskDate: '2026-11-12',
  })
  await syncOrderToCleaningTasks(orders.checkoutFirst, { scope: 'checkin_only' })
  const checkoutFirstCheckin = await readTask(orders.checkoutFirst, 'checkin_clean')
  taskIds.push(String(checkoutFirstCheckin.id))
  await pgPool!.query(
    `UPDATE cleaning_tasks
     SET new_code='SYNTH_AFTER_CREATE', new_code_authority_status='manual_confirmed'
     WHERE id=$1`,
    [checkoutFirstCheckin.id],
  )
  await syncCheckout(orders.checkoutFirst)
  assert.equal((await readTask(orders.checkoutFirst, 'checkout_clean')).old_code, 'SYNTH_AFTER_CREATE')

  const concurrentCheckinId = taskId('concurrent_checkin')
  await insertTask({
    id: concurrentCheckinId,
    orderId: orders.concurrent,
    propertyId: properties.generation,
    taskType: 'checkin_clean',
    taskDate: '2026-11-13',
    newCode: 'SYNTH_CONCURRENT',
    newAuthority: 'manual_confirmed',
  })
  const creatorClient = await pgPool!.connect()
  const observerClient = await pgPool!.connect()
  let creatorCommitted = false
  let observerCommitted = false
  try {
    await creatorClient.query('BEGIN')
    await observerClient.query('BEGIN')
    const creatorPid = Number((await creatorClient.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
    const observerPid = Number((await observerClient.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
    assert.notEqual(creatorPid, observerPid, 'the race regression must use two independent PostgreSQL sessions')

    await creatorClient.query('SELECT 1 FROM orders WHERE id=$1 FOR UPDATE', [orders.concurrent])
    const waitingSync = syncCheckoutOldCodeFromCheckinNewCode({ orderId: orders.concurrent, client: observerClient })
    let observerWaiting = false
    for (let attempt = 0; attempt < 100 && !observerWaiting; attempt += 1) {
      const waiting = await pgPool!.query(
        `SELECT EXISTS(
           SELECT 1 FROM pg_locks
           WHERE pid=$1 AND NOT granted
         ) AS waiting`,
        [observerPid],
      )
      observerWaiting = waiting.rows[0]?.waiting === true
      if (!observerWaiting) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(observerWaiting, true, 'the second session must block on the open source-order transaction before creation commits')

    await syncOrderToCleaningTasks(orders.concurrent, { client: creatorClient })
    await creatorClient.query('COMMIT')
    creatorCommitted = true
    await waitingSync
    await observerClient.query('COMMIT')
    observerCommitted = true
  } finally {
    if (!creatorCommitted) await creatorClient.query('ROLLBACK').catch(() => null)
    if (!observerCommitted) await observerClient.query('ROLLBACK').catch(() => null)
    creatorClient.release()
    observerClient.release()
  }
  const concurrentCheckout = await readTask(orders.concurrent, 'checkout_clean')
  taskIds.push(String(concurrentCheckout.id))
  assert.equal(concurrentCheckout.old_code, 'SYNTH_CONCURRENT')
  assert.equal(concurrentCheckout.old_code_source_order_id, orders.concurrent)

  const crossSourceCheckin = taskId('cross_source_checkin')
  const crossSourceCheckout = taskId('cross_source_checkout')
  const crossTargetCheckin = taskId('cross_target_checkin')
  await insertTask({
    id: crossSourceCheckin,
    orderId: orders.crossSource,
    propertyId: properties.crossOrder,
    taskType: 'checkin_clean',
    taskDate: '2026-11-16',
    newCode: 'SYNTH_CROSS_SOURCE',
    newAuthority: 'manual_confirmed',
  })
  await insertTask({
    id: crossSourceCheckout,
    orderId: orders.crossSource,
    propertyId: properties.crossOrder,
    taskType: 'checkout_clean',
    taskDate: '2026-11-18',
  })
  await insertTask({
    id: crossTargetCheckin,
    orderId: orders.crossTarget,
    propertyId: properties.crossOrder,
    taskType: 'checkin_clean',
    taskDate: '2026-11-19',
    oldCode: 'SYNTH_CROSS_SOURCE',
    oldAuthority: 'source_linked',
    oldSourceTaskId: crossSourceCheckout,
    oldSourceOrderId: orders.crossSource,
    oldSourceField: 'old_code',
  })
  const crossInvalidation = await pgRunInTransaction((client: any) => syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: orders.crossSource, client }))
  assert.equal(crossInvalidation.reason, 'cross_order_password_chain_removed')
  const crossTarget = await readTask(orders.crossTarget, 'checkin_clean')
  assert.equal(crossTarget.old_code, null)
  assert.equal(crossTarget.old_code_source_order_id, null)

  process.stdout.write('test_mz091_password_chain_pg_integration: ok\n')
}

let cleanupAttempted = false

async function cleanup() {
  if (cleanupAttempted) return
  cleanupAttempted = true
  const errors: unknown[] = []
  const run = async (sql: string, params: any[]) => {
    try { await pgPool!.query(sql, params) } catch (error) { errors.push(error) }
  }
  await run('DELETE FROM cleaning_password_authority_receipts WHERE task_id = ANY($1::text[])', [taskIds])
  await run('DELETE FROM cleaning_sync_logs WHERE order_id = ANY($1::text[]) OR task_id = ANY($2::text[])', [orderIds, taskIds])
  await run('DELETE FROM work_task_events WHERE task_id LIKE $1 OR source_ref_ids && $2::text[]', [`cleaning_task:${prefix}%`, taskIds])
  await run('DELETE FROM work_task_event_versions WHERE task_id LIKE $1', [`cleaning_task:${prefix}%`])
  await run('DELETE FROM cleaning_tasks WHERE order_id = ANY($1::text[]) OR id = ANY($2::text[])', [orderIds, taskIds])
  await run('DELETE FROM orders WHERE id = ANY($1::text[])', [orderIds])
  await run('DELETE FROM properties WHERE id = ANY($1::text[])', [propertyIds])
  await pgPool!.end().catch((error: unknown) => errors.push(error))
  if (errors.length) throw errors[0]
}

main()
  .then(cleanup)
  .catch(async (error) => {
    try { await cleanup() } catch (cleanupError) { console.error(cleanupError) }
    console.error(error)
    process.exit(1)
  })
