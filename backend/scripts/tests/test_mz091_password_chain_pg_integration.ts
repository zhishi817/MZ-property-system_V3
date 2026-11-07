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
  editing: `${prefix}_property_editing`,
  deferred: `${prefix}_property_deferred`,
  checkoutKeys: `${prefix}_property_checkout_keys`,
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
  pureCheckin: `${prefix}_order_pure_checkin`,
  pureCheckout: `${prefix}_order_pure_checkout`,
  checkoutKeys: `${prefix}_order_checkout_keys`,
  turnoverOutgoing: `${prefix}_order_turnover_outgoing`,
  turnoverIncoming: `${prefix}_order_turnover_incoming`,
  stayover: `${prefix}_order_stayover`,
  deferredOutgoing: `${prefix}_order_deferred_outgoing`,
  deferredIncoming: `${prefix}_order_deferred_incoming`,
  terminal: `${prefix}_order_terminal`,
  autoSyncDisabled: `${prefix}_order_auto_sync_disabled`,
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
  taskType: 'checkin_clean' | 'checkout_clean' | 'stayover_clean'
  taskDate: string
  oldCode?: string | null
  newCode?: string | null
  oldAuthority?: string | null
  newAuthority?: string | null
  oldSourceTaskId?: string | null
  oldSourceOrderId?: string | null
  oldSourceField?: string | null
  autoSyncEnabled?: boolean
  status?: string
  executionState?: string
  inspectionMode?: string | null
  inspectionScope?: string | null
  inspectionDueDate?: string | null
  inspectorId?: string | null
  assigneeId?: string | null
  cleanerId?: string | null
  linkedCheckoutTaskId?: string | null
  inspectionReplacedByCheckinTaskId?: string | null
  checkoutTime?: string | null
  checkinTime?: string | null
  guestSpecialRequest?: string | null
  keysRequired?: number | null
}) {
  await pgPool!.query(
    `INSERT INTO cleaning_tasks(
       id, order_id, property_id, task_type, type, task_date, date,
       status, source, execution_state, auto_sync_enabled,
       old_code, new_code, old_code_authority_status, new_code_authority_status,
       old_code_source_task_id, old_code_source_order_id, old_code_source_field,
       inspection_mode, inspection_scope, inspection_due_date,
       inspector_id, assignee_id, cleaner_id, linked_checkout_task_id,
       inspection_replaced_by_checkin_task_id, checkout_time, checkin_time,
       guest_special_request, keys_required
     ) VALUES(
       $1,$2,$3,$4,$4,$5::date,$5::date,$6,'auto',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::date,
       $19,$20,$21,$22,$23,$24,$25,$26,$27
     )`,
    [
      params.id,
      params.orderId,
      params.propertyId,
      params.taskType,
      params.taskDate,
      params.status || 'pending',
      params.executionState || 'active',
      params.autoSyncEnabled !== false,
      params.oldCode ?? null,
      params.newCode ?? null,
      params.oldAuthority ?? null,
      params.newAuthority ?? null,
      params.oldSourceTaskId ?? null,
      params.oldSourceOrderId ?? null,
      params.oldSourceField ?? null,
      params.inspectionMode ?? null,
      params.inspectionScope ?? null,
      params.inspectionDueDate ?? null,
      params.inspectorId ?? null,
      params.assigneeId ?? null,
      params.cleanerId ?? null,
      params.linkedCheckoutTaskId ?? null,
      params.inspectionReplacedByCheckinTaskId ?? null,
      params.checkoutTime ?? null,
      params.checkinTime ?? null,
      params.guestSpecialRequest ?? null,
      params.keysRequired ?? 1,
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
  await insertOrder(orders.pureCheckout, properties.editing, '2026-12-07', '2026-12-09')
  await insertOrder(orders.checkoutKeys, properties.checkoutKeys, '2026-12-28', '2026-12-30')
  await insertOrder(orders.pureCheckin, properties.editing, '2026-12-10', '2026-12-11')
  await insertOrder(orders.turnoverOutgoing, properties.editing, '2026-12-08', '2026-12-12')
  await insertOrder(orders.turnoverIncoming, properties.editing, '2026-12-12', '2026-12-15')
  await insertOrder(orders.stayover, properties.editing, '2026-12-13', '2026-12-16')
  await insertOrder(orders.deferredOutgoing, properties.deferred, '2026-12-14', '2026-12-16')
  await insertOrder(orders.deferredIncoming, properties.deferred, '2026-12-17', '2026-12-20')
  await insertOrder(orders.terminal, properties.editing, '2026-12-18', '2026-12-19')
  await insertOrder(orders.autoSyncDisabled, properties.generation, '2026-12-20', '2026-12-22')

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
  })
  const linked = await syncCheckout(orders.linked)
  assert.equal(linked.reason, 'source_linked')
  let linkedOut = await readTask(orders.linked, 'checkout_clean')
  assert.equal(linkedOut.old_code, 'SYNTH_LINKED')
  assert.equal(linkedOut.old_code_authority_status, 'source_linked')
  assert.equal(linkedOut.old_code_source_task_id, linkedCheckin)
  assert.equal(linkedOut.old_code_source_order_id, orders.linked)
  assert.equal(linkedOut.old_code_source_field, 'new_code')

  await insertTask({
    id: taskId('auto_sync_disabled_checkin'),
    orderId: orders.autoSyncDisabled,
    propertyId: properties.generation,
    taskType: 'checkin_clean',
    taskDate: '2026-12-20',
    newCode: 'SYNTH_DISABLED_SOURCE',
    newAuthority: 'manual_confirmed',
  })
  await insertTask({
    id: taskId('auto_sync_disabled_checkout'),
    orderId: orders.autoSyncDisabled,
    propertyId: properties.generation,
    taskType: 'checkout_clean',
    taskDate: '2026-12-22',
    oldCode: 'SYNTH_DISABLED_TARGET',
    autoSyncEnabled: false,
  })
  const autoSyncDisabled = await syncCheckout(orders.autoSyncDisabled)
  assert.equal(autoSyncDisabled.reason, 'auto_sync_disabled', 'a disabled task must stay protected from automatic password propagation')
  assert.equal((await readTask(orders.autoSyncDisabled, 'checkout_clean')).old_code, 'SYNTH_DISABLED_TARGET')

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

  const pureCheckoutTask = taskId('pure_checkout_edit')
  const checkoutKeysTask = taskId('checkout_keys_edit')
  const pureCheckinTask = taskId('pure_checkin_edit')
  const turnoverCheckoutTask = taskId('turnover_checkout_edit')
  const turnoverCheckinTask = taskId('turnover_checkin_edit')
  const stayoverTask = taskId('stayover_edit')
  const deferredCheckoutTask = taskId('deferred_checkout_edit')
  const deferredCheckinTask = taskId('deferred_checkin_edit')
  const terminalCheckinTask = taskId('terminal_checkin_edit')
  await insertTask({
    id: pureCheckoutTask,
    orderId: orders.pureCheckout,
    propertyId: properties.editing,
    taskType: 'checkout_clean',
    taskDate: '2026-12-09',
    oldCode: 'SYNTH_EXISTING_OLD',
    oldAuthority: 'manual_confirmed',
    oldSourceField: 'manual',
    inspectionMode: 'pending_decision',
    checkoutTime: '10am',
  })
  await insertTask({
    id: checkoutKeysTask,
    orderId: orders.checkoutKeys,
    propertyId: properties.checkoutKeys,
    taskType: 'checkout_clean',
    taskDate: '2026-12-30',
    oldCode: 'SYNTH_CHECKOUT_KEYS_OLD',
    oldAuthority: 'manual_confirmed',
    oldSourceField: 'manual',
    inspectionMode: 'pending_decision',
    checkoutTime: '10am',
    keysRequired: 1,
  })
  await insertTask({
    id: pureCheckinTask,
    orderId: orders.pureCheckin,
    propertyId: properties.editing,
    taskType: 'checkin_clean',
    taskDate: '2026-12-10',
    newCode: null,
    newAuthority: 'needs_review',
    inspectionMode: 'pending_decision',
    inspectionScope: 'password_only',
    assigneeId: `${prefix}_admin`,
    checkinTime: '3pm',
  })
  await insertTask({
    id: turnoverCheckoutTask,
    orderId: orders.turnoverOutgoing,
    propertyId: properties.editing,
    taskType: 'checkout_clean',
    taskDate: '2026-12-12',
    oldCode: 'SYNTH_TURNOVER_OLD',
    oldAuthority: 'manual_confirmed',
    oldSourceField: 'manual',
    checkoutTime: '10am',
  })
  await insertTask({
    id: turnoverCheckinTask,
    orderId: orders.turnoverIncoming,
    propertyId: properties.editing,
    taskType: 'checkin_clean',
    taskDate: '2026-12-12',
    newCode: 'SYNTH_TURNOVER_NEW',
    newAuthority: 'manual_confirmed',
    linkedCheckoutTaskId: turnoverCheckoutTask,
    checkinTime: '3pm',
  })
  await insertTask({
    id: stayoverTask,
    orderId: orders.stayover,
    propertyId: properties.editing,
    taskType: 'stayover_clean',
    taskDate: '2026-12-14',
    guestSpecialRequest: 'SYNTH_STAYOVER_BEFORE',
    cleanerId: `${prefix}_cleaner`,
  })
  await insertTask({
    id: deferredCheckoutTask,
    orderId: orders.deferredOutgoing,
    propertyId: properties.deferred,
    taskType: 'checkout_clean',
    taskDate: '2026-12-16',
    oldCode: null,
    oldAuthority: 'needs_review',
    inspectionMode: 'deferred',
    inspectionScope: 'inspect_and_hang',
    inspectionDueDate: '2026-12-17',
    inspectorId: `${prefix}_inspector`,
    inspectionReplacedByCheckinTaskId: deferredCheckinTask,
  })
  await insertTask({
    id: deferredCheckinTask,
    orderId: orders.deferredIncoming,
    propertyId: properties.deferred,
    taskType: 'checkin_clean',
    taskDate: '2026-12-17',
    newCode: null,
    newAuthority: 'needs_review',
    inspectionMode: 'same_day',
    inspectionScope: 'inspect_and_hang',
    inspectorId: `${prefix}_inspector`,
    linkedCheckoutTaskId: deferredCheckoutTask,
  })
  await insertTask({
    id: terminalCheckinTask,
    orderId: orders.terminal,
    propertyId: properties.editing,
    taskType: 'checkin_clean',
    taskDate: '2026-12-18',
    status: 'cancelled',
    executionState: 'cancelled',
  })

  const express = require('express') as typeof import('express')
  const { router: cleaningRouter } = require('../../src/modules/cleaning') as typeof import('../../src/modules/cleaning')
  const { router: mzappRouter } = require('../../src/modules/mzapp') as typeof import('../../src/modules/mzapp')
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => {
    const role = String(req.headers['x-test-role'] || 'admin')
    req.user = { sub: `${prefix}_${role}`, role, roles: [role] }
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

    const getWorkTasks = async (dateFrom: string, dateTo: string, role = 'admin') => {
      const result = await fetch(`http://127.0.0.1:${address.port}/mzapp/work-tasks?date_from=${dateFrom}&date_to=${dateTo}&view=all`, {
        headers: { 'x-test-role': role },
      })
      const body = await result.text()
      assert.equal(result.status, 200, `real MZapp work-tasks GET failed: ${body}`)
      return JSON.parse(body) as any[]
    }
    const managerFields = async (payload: any, role = 'admin') => {
      const result = await fetch(`http://127.0.0.1:${address.port}/mzapp/cleaning-tasks/manager-fields`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-test-role': role },
        body: JSON.stringify(payload),
      })
      const bodyText = await result.text()
      let body: any = null
      try { body = bodyText ? JSON.parse(bodyText) : null } catch { body = bodyText }
      return { status: result.status, body, bodyText }
    }
    const exactPasswordTargets = (card: any, fields: Array<'old_code' | 'new_code'>) => {
      const targets = fields.map((field) => String(
        field === 'old_code'
          ? card?.turnover_display?.old_code_task_id
          : card?.turnover_display?.new_code_task_id,
      ).trim())
      assert.ok(targets.every(Boolean), `every requested password field must have an exact target: ${fields.join(',')}`)
      assert.equal(new Set(targets).size, fields.length, 'different password fields must not collapse to the same target')
      return targets
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
    assert.equal(linkedCard.turnover_display?.old_code_task_id, linkedCheckout, 'the real GET route must retain the checkout password target')

    const manualCards = await getWorkTasks('2026-11-04', '2026-11-06')
    const manualMatches = manualCards.filter((item: any) => (item.active_source_ids || item.source_ids || []).includes(manualCheckout))
    assert.equal(manualMatches.length, 1, 'the real MZapp GET route must return exactly one manual-confirmed checkout card')
    const manualCard = manualMatches[0]
    assert.equal(manualCard.old_code, 'SYNTH_LOCAL_FIX')
    assert.equal(manualCard.password_authority?.old_code_status, 'manual_confirmed')
    assert.equal(manualCard.password_authority?.old_code_source_field, 'manual')
    assert.equal(manualCard.turnover_display?.old_code_authority_status, 'manual_confirmed')
    assert.equal(manualCard.turnover_display?.old_code_task_id, manualCheckout, 'an existing old code must still target the exact checkout task')

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
    assert.equal(missingCard.turnover_display?.old_code_task_id, mergedMissingCheckout, 'an empty/hidden old value must keep its checkout write target')
    assert.equal(missingCard.turnover_display?.new_code_task_id, mergedMissingCheckin, 'an empty new value must keep its check-in write target')

    const pureCheckoutCards = await getWorkTasks('2026-12-09', '2026-12-09')
    const pureCheckoutCard = pureCheckoutCards.find((item: any) => (item.active_source_ids || []).includes(pureCheckoutTask))
    assert.ok(pureCheckoutCard, 'the real GET route must return the checkout-only editing card')
    assert.equal(pureCheckoutCard.task_type, 'checkout_clean')
    assert.equal(pureCheckoutCard.turnover_display?.old_code_task_id, pureCheckoutTask)
    assert.equal(pureCheckoutCard.turnover_display?.new_code_task_id, null)

    const pureCheckinCards = await getWorkTasks('2026-12-10', '2026-12-10')
    const pureCheckinCard = pureCheckinCards.find((item: any) => (item.active_source_ids || []).includes(pureCheckinTask))
    assert.ok(pureCheckinCard, 'the real GET route must return the check-in-only pending-decision card without an inspector')
    assert.equal(pureCheckinCard.task_type, 'checkin_clean')
    assert.equal(pureCheckinCard.turnover_display?.old_code_task_id, null)
    assert.equal(pureCheckinCard.turnover_display?.new_code_task_id, pureCheckinTask)
    assert.equal(pureCheckinCard.turnover_display?.new_code, null)

    for (const role of ['admin', 'customer_service', 'offline_manager']) {
      const roleCards = await getWorkTasks('2026-12-10', '2026-12-10', role)
      const roleCard = roleCards.find((item: any) => (item.active_source_ids || []).includes(pureCheckinTask))
      assert.equal(roleCard?.turnover_display?.new_code_task_id, pureCheckinTask, `${role} must receive the same exact password target`)
      const allowed = await managerFields({ task_ids: [pureCheckinTask] }, role)
      assert.equal(allowed.status, 200, `${role} must retain manager-fields access: ${allowed.bodyText}`)
      assert.equal(allowed.body?.skipped, 'no_change')
    }
    const denied = await managerFields({ task_ids: [pureCheckinTask] }, 'cleaner')
    assert.equal(denied.status, 403, 'a cleaner must not gain manager-fields access')

    const wrongTargetBefore = await readTask(orders.pureCheckout, 'checkout_clean')
    const wrongTarget = await managerFields({
      task_ids: [pureCheckoutTask],
      password_task_ids: [pureCheckoutTask],
      new_code: 'SYNTH_MUST_NOT_WRITE',
      password_verification: {
        fields: ['new_code'],
        request_id: `${prefix}_wrong_target`,
        client: 'mobile',
      },
    })
    assert.equal(wrongTarget.status, 400, `wrong password target type must fail closed: ${wrongTarget.bodyText}`)
    assert.equal(wrongTarget.body?.message, 'password_field_not_applicable')
    const wrongTargetAfter = await readTask(orders.pureCheckout, 'checkout_clean')
    assert.equal(wrongTargetAfter.new_code, wrongTargetBefore.new_code, 'a rejected target must not write new_code')
    assert.equal(wrongTargetAfter.old_code, wrongTargetBefore.old_code, 'a rejected target must not alter the valid old_code')

    const checkoutSave = await managerFields({
      task_ids: [pureCheckoutTask],
      password_task_ids: exactPasswordTargets(pureCheckoutCard, ['old_code']),
      checkout_time: '11am',
      old_code: 'SYNTH_UPDATED_OLD',
      guest_special_request: 'SYNTH_CHECKOUT_REQUEST',
      password_verification: {
        fields: ['old_code'],
        request_id: `${prefix}_pure_checkout_save`,
        client: 'mobile',
      },
    })
    assert.equal(checkoutSave.status, 201, `checkout-only multi-field save failed: ${checkoutSave.bodyText}`)
    const pureCheckoutSaved = await readTask(orders.pureCheckout, 'checkout_clean')
    assert.equal(pureCheckoutSaved.checkout_time, '11am')
    assert.equal(pureCheckoutSaved.old_code, 'SYNTH_UPDATED_OLD')
    assert.equal(pureCheckoutSaved.old_code_authority_status, 'manual_confirmed')
    assert.equal(pureCheckoutSaved.guest_special_request, 'SYNTH_CHECKOUT_REQUEST')

    const checkoutKeysCards = await getWorkTasks('2026-12-30', '2026-12-30')
    const checkoutKeysCard = checkoutKeysCards.find((item: any) => (item.active_source_ids || []).includes(checkoutKeysTask))
    assert.ok(checkoutKeysCard, 'the real GET route must return the checkout-only key-editing card without a future check-in')
    assert.equal(checkoutKeysCard.task_type, 'checkout_clean')
    assert.equal(Number(checkoutKeysCard.keys_required_checkout), 1)
    const checkoutKeysPayload = {
      operation_id: `${prefix}_checkout_keys_save`,
      task_ids: [checkoutKeysTask],
      items: [{ id: checkoutKeysTask, checkout_time: '12:10pm' }],
      keys_required: 2,
    }
    const checkoutKeysEventsBefore = Number((await pgPool!.query(
      'SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && $1::text[]',
      [[checkoutKeysTask]],
    )).rows[0].count)
    const checkoutKeysSave = await managerFields(checkoutKeysPayload)
    assert.equal(checkoutKeysSave.status, 201, `checkout-only keys save failed: ${checkoutKeysSave.bodyText}`)
    const checkoutKeysSaved = await readTask(orders.checkoutKeys, 'checkout_clean')
    assert.equal(checkoutKeysSaved.checkout_time, '12:10pm')
    assert.equal(Number(checkoutKeysSaved.keys_required), 2, 'checkout-only keys must persist to the selected checkout task')
    assert.equal(
      Number((await pgPool!.query('SELECT keys_required FROM orders WHERE id=$1', [orders.checkoutKeys])).rows[0]?.keys_required),
      2,
      'checkout-only keys must persist to the selected checkout order',
    )
    const checkoutKeysRefreshed = (await getWorkTasks('2026-12-30', '2026-12-30'))
      .find((item: any) => (item.active_source_ids || []).includes(checkoutKeysTask))
    assert.equal(Number(checkoutKeysRefreshed?.keys_required_checkout), 2, 'authoritative GET must read back the checkout-side key count')
    const checkoutKeysEventsAfter = Number((await pgPool!.query(
      'SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && $1::text[]',
      [[checkoutKeysTask]],
    )).rows[0].count)
    assert.ok(checkoutKeysEventsAfter > checkoutKeysEventsBefore, 'checkout-only keys must emit durable task event evidence')
    const checkoutKeysReplay = await managerFields(checkoutKeysPayload)
    assert.equal(checkoutKeysReplay.status, 201, `checkout-only keys replay failed: ${checkoutKeysReplay.bodyText}`)
    assert.equal(checkoutKeysReplay.body?.replayed, true)
    assert.equal(Number((await pgPool!.query(
      'SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && $1::text[]',
      [[checkoutKeysTask]],
    )).rows[0].count), checkoutKeysEventsAfter, 'lost-response replay must not duplicate checkout-only key events')

    const checkinSave = await managerFields({
      task_ids: [pureCheckinTask],
      password_task_ids: exactPasswordTargets(pureCheckinCard, ['new_code']),
      checkin_time: '2:30pm',
      new_code: 'SYNTH_FIRST_NEW',
      guest_special_request: 'SYNTH_CHECKIN_REQUEST',
      password_verification: {
        fields: ['new_code'],
        request_id: `${prefix}_pure_checkin_save`,
        client: 'mobile',
      },
    })
    assert.equal(checkinSave.status, 201, `check-in-only first-password save failed: ${checkinSave.bodyText}`)
    const pureCheckinSaved = await readTask(orders.pureCheckin, 'checkin_clean')
    assert.equal(pureCheckinSaved.checkin_time, '2:30pm')
    assert.equal(pureCheckinSaved.new_code, 'SYNTH_FIRST_NEW')
    assert.equal(pureCheckinSaved.new_code_authority_status, 'manual_confirmed')
    assert.equal(pureCheckinSaved.guest_special_request, 'SYNTH_CHECKIN_REQUEST')

    const turnoverCards = await getWorkTasks('2026-12-12', '2026-12-12')
    const turnoverMatches = turnoverCards.filter((item: any) => (
      (item.active_source_ids || []).includes(turnoverCheckoutTask)
      && (item.active_source_ids || []).includes(turnoverCheckinTask)
    ))
    assert.equal(turnoverMatches.length, 1, 'same-day checkout/check-in must be one canonical turnover card')
    const turnoverCard = turnoverMatches[0]
    assert.equal(turnoverCard.turnover_display?.old_code_task_id, turnoverCheckoutTask)
    assert.equal(turnoverCard.turnover_display?.new_code_task_id, turnoverCheckinTask)
    const turnoverTargets = exactPasswordTargets(turnoverCard, ['old_code', 'new_code'])
    assert.deepEqual([...turnoverTargets].sort(), [turnoverCheckoutTask, turnoverCheckinTask].sort())
    const turnoverSave = await managerFields({
      task_ids: [...(turnoverCard.active_source_ids || [])],
      password_task_ids: turnoverTargets,
      checkout_time: '11:15am',
      checkin_time: '2:15pm',
      old_code: 'SYNTH_MULTI_OLD',
      new_code: 'SYNTH_MULTI_NEW',
      guest_special_request: 'SYNTH_MULTI_FIELD_REQUEST',
      keys_required: 2,
      password_verification: {
        fields: ['old_code', 'new_code'],
        request_id: `${prefix}_turnover_multi_save`,
        client: 'mobile',
      },
    })
    assert.equal(turnoverSave.status, 201, `same-request turnover multi-field save failed: ${turnoverSave.bodyText}`)
    const turnoverCheckoutSaved = await readTask(orders.turnoverOutgoing, 'checkout_clean')
    const turnoverCheckinSaved = await readTask(orders.turnoverIncoming, 'checkin_clean')
    assert.equal(turnoverCheckoutSaved.checkout_time, '11:15am')
    assert.equal(turnoverCheckinSaved.checkin_time, '2:15pm')
    assert.equal(turnoverCheckoutSaved.old_code, 'SYNTH_MULTI_OLD')
    assert.equal(turnoverCheckinSaved.new_code, 'SYNTH_MULTI_NEW')
    assert.equal(turnoverCheckoutSaved.guest_special_request, 'SYNTH_MULTI_FIELD_REQUEST')
    assert.equal(turnoverCheckinSaved.guest_special_request, 'SYNTH_MULTI_FIELD_REQUEST')
    assert.equal(Number(turnoverCheckinSaved.keys_required), 2)
    const turnoverIncomingOrder = await pgPool!.query('SELECT keys_required FROM orders WHERE id=$1', [orders.turnoverIncoming])
    assert.equal(Number(turnoverIncomingOrder.rows[0]?.keys_required), 2)

    const stayoverCards = await getWorkTasks('2026-12-14', '2026-12-14')
    const stayoverCard = stayoverCards.find((item: any) => (item.active_source_ids || []).includes(stayoverTask))
    assert.ok(stayoverCard, 'stayover task must remain independently editable')
    assert.equal(stayoverCard.turnover_display?.old_code_task_id, null)
    assert.equal(stayoverCard.turnover_display?.new_code_task_id, null)
    const stayoverSave = await managerFields({
      task_ids: [stayoverTask],
      guest_special_request: 'SYNTH_STAYOVER_AFTER',
    })
    assert.equal(stayoverSave.status, 201, `stayover non-password save failed: ${stayoverSave.bodyText}`)
    assert.equal((await readTask(orders.stayover, 'stayover_clean')).guest_special_request, 'SYNTH_STAYOVER_AFTER')

    const deferredCards = await getWorkTasks('2026-12-16', '2026-12-17')
    const deferredCard = deferredCards.find((item: any) => (
      String(item.property_id || '') === properties.deferred
      && item.turnover_display?.new_code_task_id === deferredCheckinTask
    ))
    assert.ok(deferredCard, 'deferred inspection projection must retain the linked check-in target')
    assert.equal(deferredCard.turnover_display?.new_code_task_id, deferredCheckinTask)
    const deferredSave = await managerFields({
      task_ids: [...(deferredCard.active_source_ids || [])],
      password_task_ids: exactPasswordTargets(deferredCard, ['new_code']),
      new_code: 'SYNTH_DEFERRED_NEW',
      guest_special_request: 'SYNTH_DEFERRED_REQUEST',
      password_verification: {
        fields: ['new_code'],
        request_id: `${prefix}_deferred_save`,
        client: 'mobile',
      },
    })
    assert.equal(deferredSave.status, 201, `deferred inspection save failed: ${deferredSave.bodyText}`)
    const deferredCheckinSaved = await readTask(orders.deferredIncoming, 'checkin_clean')
    assert.equal(deferredCheckinSaved.new_code, 'SYNTH_DEFERRED_NEW')

    const terminalSave = await managerFields({
      task_ids: [terminalCheckinTask],
      password_task_ids: [terminalCheckinTask],
      new_code: 'SYNTH_TERMINAL_MUST_NOT_WRITE',
      password_verification: {
        fields: ['new_code'],
        request_id: `${prefix}_terminal_save`,
        client: 'mobile',
      },
    })
    assert.equal(terminalSave.status, 409, `terminal task must reject edits: ${terminalSave.bodyText}`)
    assert.equal(terminalSave.body?.message, 'manager_fields_task_inactive')
    assert.equal((await readTask(orders.terminal, 'checkin_clean')).new_code, null)

    const refreshedTurnoverCards = await getWorkTasks('2026-12-12', '2026-12-12')
    const refreshedTurnover = refreshedTurnoverCards.find((item: any) => (
      (item.active_source_ids || []).includes(turnoverCheckoutTask)
      && (item.active_source_ids || []).includes(turnoverCheckinTask)
    ))
    assert.equal(refreshedTurnover?.turnover_display?.old_code, 'SYNTH_MULTI_OLD')
    assert.equal(refreshedTurnover?.turnover_display?.new_code, 'SYNTH_MULTI_NEW')
    assert.equal(refreshedTurnover?.turnover_display?.old_code_task_id, turnoverCheckoutTask)
    assert.equal(refreshedTurnover?.turnover_display?.new_code_task_id, turnoverCheckinTask)
    assert.equal(refreshedTurnover?.guest_special_request, 'SYNTH_MULTI_FIELD_REQUEST')
    assert.equal(refreshedTurnover?.start_time, '11:15am')
    assert.equal(refreshedTurnover?.end_time, '2:15pm')
    assert.equal(Number(refreshedTurnover?.keys_required_checkin), 2)
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
