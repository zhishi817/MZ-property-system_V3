import assert from 'node:assert/strict'
import express from 'express'

process.env.DATABASE_URL = ''
process.env.MZ_DEV_PREVIEW_DISABLE_RUNTIME_DDL = '1'

type FixtureTask = {
  id: string
  status: string
  task_type: string
  task_date: string
  date: string
  inspection_mode: string
  inspection_scope: string
  inspection_due_date: string | null
  execution_state: string
  inspector_id: string
  cleaner_id: string | null
  assignee_id: string
  property_id: string
}

type FixtureState = {
  tasks: Record<string, FixtureTask>
  media: Array<Record<string, any>>
  audits: Array<Record<string, any>>
  receipts: Record<string, { payload_hash: string; response_json: any }>
}

type AdapterStats = {
  begins: number
  commits: number
  rollbacks: number
  releases: number
  writeStatements: number
  lockWaiters: number
}

function makeTask(id: string, status = 'to_inspect'): FixtureTask {
  return {
    id,
    status,
    task_type: 'checkout_clean',
    task_date: '2026-11-01',
    date: '2026-11-01',
    inspection_mode: 'normal',
    inspection_scope: 'inspect_and_hang',
    inspection_due_date: null,
    execution_state: 'active',
    inspector_id: 'inspector-1',
    cleaner_id: null,
    assignee_id: 'inspector-1',
    property_id: 'property-1',
  }
}

function cloneState(value: FixtureState): FixtureState {
  return JSON.parse(JSON.stringify(value))
}

function normalizeSql(sql: any) {
  return String(sql || '').replace(/\s+/g, ' ').trim()
}

function receiptKey(params: any[]) {
  return params.slice(0, 4).map((value) => String(value || '')).join('\u0000')
}

class AsyncTaskLock {
  private locked = false
  private waiters: Array<(release: () => void) => void> = []

  constructor(private readonly onWait: () => void) {}

  async acquire() {
    if (!this.locked) {
      this.locked = true
      return this.releaseFactory()
    }
    this.onWait()
    return new Promise<() => void>((resolve) => this.waiters.push(resolve))
  }

  private releaseFactory() {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next(this.releaseFactory())
      else this.locked = false
    }
  }
}

let state: FixtureState = { tasks: {}, media: [], audits: [], receipts: {} }
let stats: AdapterStats = { begins: 0, commits: 0, rollbacks: 0, releases: 0, writeStatements: 0, lockWaiters: 0 }
let failNextAuditInsert = false
let sideEffects = { broadcasts: 0, notifications: 0 }
let taskLocks = new Map<string, AsyncTaskLock>()
let concurrencyGate: { enabled: boolean; holderChosen: boolean; resolveContended: (() => void) | null; contended: Promise<void> } = {
  enabled: false,
  holderChosen: false,
  resolveContended: null,
  contended: Promise.resolve(),
}

function resetFixture(tasks: FixtureTask[]) {
  state = {
    tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
    media: [],
    audits: [],
    receipts: {},
  }
  stats = { begins: 0, commits: 0, rollbacks: 0, releases: 0, writeStatements: 0, lockWaiters: 0 }
  failNextAuditInsert = false
  sideEffects = { broadcasts: 0, notifications: 0 }
  taskLocks = new Map()
  concurrencyGate = { enabled: false, holderChosen: false, resolveContended: null, contended: Promise.resolve() }
}

function enableConcurrencyGate() {
  let resolveContended: (() => void) | null = null
  const contended = new Promise<void>((resolve) => { resolveContended = resolve })
  concurrencyGate = { enabled: true, holderChosen: false, resolveContended, contended }
}

async function waitForConcurrentLockAttempt() {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      concurrencyGate.contended,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('second request did not contend for the task row lock within 3000ms')),
          3000,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function lockFor(taskId: string) {
  let lock = taskLocks.get(taskId)
  if (!lock) {
    lock = new AsyncTaskLock(() => {
      stats.lockWaiters += 1
      concurrencyGate.resolveContended?.()
      concurrencyGate.resolveContended = null
    })
    taskLocks.set(taskId, lock)
  }
  return lock
}

class FakeTransactionClient {
  private inTransaction = false
  private snapshot: FixtureState | null = null
  private releases: Array<() => void> = []

  on() {}

  async query(sql0: any, params: any[] = []) {
    const sql = normalizeSql(sql0)
    if (sql === 'BEGIN') {
      assert.equal(this.inTransaction, false)
      this.inTransaction = true
      this.snapshot = cloneState(state)
      stats.begins += 1
      return { rows: [], rowCount: 0 }
    }
    if (sql === 'COMMIT') {
      assert.equal(this.inTransaction, true)
      this.inTransaction = false
      this.snapshot = null
      stats.commits += 1
      this.releaseLocks()
      return { rows: [], rowCount: 0 }
    }
    if (sql === 'ROLLBACK') {
      assert.equal(this.inTransaction, true)
      assert.ok(this.snapshot)
      state = cloneState(this.snapshot)
      this.inTransaction = false
      this.snapshot = null
      stats.rollbacks += 1
      this.releaseLocks()
      return { rows: [], rowCount: 0 }
    }
    return executeSql(sql, params, this)
  }

  async acquireTask(taskId: string) {
    const release = await lockFor(taskId).acquire()
    this.releases.push(release)
    if (concurrencyGate.enabled && !concurrencyGate.holderChosen) {
      concurrencyGate.holderChosen = true
      await waitForConcurrentLockAttempt()
    }
  }

  assertCanWrite() {
    assert.equal(this.inTransaction, true, 'fixture writes must remain inside pgRunInTransaction')
  }

  private releaseLocks() {
    for (const release of this.releases.splice(0)) release()
  }

  release() {
    assert.equal(this.inTransaction, false)
    assert.equal(this.releases.length, 0)
    stats.releases += 1
  }
}

async function executeSql(sql: string, params: any[], client: FakeTransactionClient | null) {
  if (/^SELECT 1 FROM schema_migrations WHERE version=\$1 LIMIT 1$/i.test(sql)) {
    return { rows: [{ '?column?': 1 }], rowCount: 1 }
  }
  if (/FROM app_submit_receipts LIMIT 0$/i.test(sql)) return { rows: [], rowCount: 0 }
  if (/^SELECT payload_hash, response_json FROM app_submit_receipts /i.test(sql)) {
    const receipt = state.receipts[receiptKey(params)]
    return { rows: receipt ? [receipt] : [], rowCount: receipt ? 1 : 0 }
  }
  if (/FROM cleaning_tasks/i.test(sql)) {
    const taskId = String(params[0] || '')
    if (/FOR UPDATE/i.test(sql)) {
      assert.ok(client, 'FOR UPDATE must use the transaction client')
      await client.acquireTask(taskId)
    }
    const task = state.tasks[taskId]
    return { rows: task ? [{ ...task }] : [], rowCount: task ? 1 : 0 }
  }
  if (/^SELECT COALESCE\(/i.test(sql) && / FROM users /i.test(sql)) {
    return { rows: [{ name: 'Inspector One' }], rowCount: 1 }
  }
  if (/^DELETE FROM cleaning_task_media /i.test(sql)) {
    assert.ok(client)
    client.assertCanWrite()
    assert.match(sql, /type LIKE 'restock_proof:%'/i, 'restock replacement must not broaden beyond restock proof media')
    assert.match(sql, /type='inspection_consumables_confirmed'/i, 'restock replacement must target the confirmation marker explicitly')
    stats.writeStatements += 1
    const taskId = String(params[0] || '')
    state.media = state.media.filter((item) => {
      if (item.task_id !== taskId) return true
      const type = String(item.type || '')
      return !type.startsWith('restock_proof:') && type !== 'inspection_consumables_confirmed'
    })
    return { rows: [], rowCount: 0 }
  }
  if (/^INSERT INTO cleaning_task_media /i.test(sql)) {
    assert.ok(client)
    client.assertCanWrite()
    stats.writeStatements += 1
    const isConfirmedSufficient = /'inspection_consumables_confirmed'/i.test(sql)
    state.media.push({
      id: params[0],
      task_id: String(params[1]),
      type: isConfirmedSufficient ? 'inspection_consumables_confirmed' : String(params[2]),
      url: isConfirmedSufficient ? String(params[2]) : String(params[3]),
      note: isConfirmedSufficient
        ? (params[3] == null ? null : String(params[3]))
        : (params[4] == null ? null : String(params[4])),
      uploader_id: String(isConfirmedSufficient ? params[4] : params[5]),
    })
    return { rows: [], rowCount: 1 }
  }
  if (/^INSERT INTO work_task_action_audits /i.test(sql)) {
    assert.ok(client)
    client.assertCanWrite()
    stats.writeStatements += 1
    if (failNextAuditInsert) {
      failNextAuditInsert = false
      throw new Error('synthetic_audit_insert_failure')
    }
    state.audits.push({
      id: params[0],
      source_type: params[1],
      source_id: params[2],
      performed_as_action: params[5],
      actor_user_id: params[7],
      status_before: params[8],
      status_after: params[9],
      metadata: JSON.parse(String(params[10] || '{}')),
    })
    return { rows: [], rowCount: 1 }
  }
  if (/^INSERT INTO app_submit_receipts /i.test(sql)) {
    assert.ok(client)
    client.assertCanWrite()
    stats.writeStatements += 1
    state.receipts[receiptKey(params.slice(1, 5))] = {
      payload_hash: String(params[5]),
      response_json: params[6] == null ? null : JSON.parse(String(params[6])),
    }
    return { rows: [], rowCount: 1 }
  }
  throw new Error(`unexpected fixture query: ${sql.slice(0, 240)}`)
}

const fakePool = {
  async query(sql: any, params: any[] = []) {
    const normalized = normalizeSql(sql)
    assert.doesNotMatch(normalized, /^(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i, 'pool-level preflight must remain read-only')
    return executeSql(normalized, params, null)
  },
  async connect() {
    return new FakeTransactionClient()
  },
}

const dbAdapter = require('../../src/dbAdapter')
dbAdapter.hasPg = true
dbAdapter.pgPool = fakePool

const r5 = require('../../src/lib/r5RequestSchema')

const notificationEvents = require('../../src/services/notificationEvents')
notificationEvents.emitNotificationEvent = async () => { sideEffects.notifications += 1 }
const cleaningEvents = require('../../src/modules/events')
cleaningEvents.broadcastCleaningEvent = () => { sideEffects.broadcasts += 1 }

type JsonResult = { status: number; body: any }

async function withRouteServer(run: (baseUrl: string) => Promise<void>) {
  await r5.warmupR5RequestSchema()
  await r5.warmupR5TaskRuntimeSchema()
  const { router } = require('../../src/modules/mzapp')
  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    req.user = { sub: 'inspector-1', role: 'cleaning_inspector', roles: ['cleaning_inspector'] }
    next()
  })
  app.use('/mzapp', router)
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function submitRestock(baseUrl: string, taskId: string, submitId: string, item = false): Promise<JsonResult> {
  const response = await fetch(`${baseUrl}/mzapp/cleaning-tasks/${taskId}/restock-proof`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: item
        ? [{ item_id: 'toilet_paper', status: 'restocked', qty: 1, proof_url: 'cleaning/test/restock.jpg' }]
        : [],
      confirmed_sufficient: !item,
      submit_id: submitId,
      step_key: 'inspection_restock_proof',
    }),
  })
  return { status: response.status, body: await response.json() }
}

async function run() {
  await withRouteServer(async (baseUrl) => {
    for (const terminalStatus of ['cancelled', 'ready', 'completed', 'done']) {
      const taskId = `terminal-${terminalStatus}`
      resetFixture([makeTask(taskId, terminalStatus)])
      state.media.push({ id: 'existing', task_id: taskId, type: 'restock_proof:soap', url: 'cleaning/test/existing.jpg' })
      const terminalBefore = cloneState(state)
      const terminal = await submitRestock(baseUrl, taskId, `terminal-submit-${terminalStatus}`, true)
      assert.equal(terminal.status, 409)
      assert.equal(terminal.body.message, 'work_record_read_only')
      assert.deepEqual(state, terminalBefore, `${terminalStatus} rejection must not change media, audits, task state, or receipts`)
      assert.equal(stats.writeStatements, 0, `${terminalStatus} rejection must execute zero mutation statements`)
      assert.deepEqual(sideEffects, { broadcasts: 0, notifications: 0 })
      assert.deepEqual(
        { begins: stats.begins, commits: stats.commits, rollbacks: stats.rollbacks, releases: stats.releases },
        { begins: 1, commits: 1, rollbacks: 0, releases: 1 },
      )
    }

    resetFixture([makeTask('rollback-task')])
    const rollbackBefore = cloneState(state)
    failNextAuditInsert = true
    const rollback = await submitRestock(baseUrl, 'rollback-task', 'rollback-submit', true)
    assert.equal(rollback.status, 500)
    assert.equal(rollback.body.message, 'synthetic_audit_insert_failure')
    assert.deepEqual(state, rollbackBefore, 'a mid-transaction failure must roll back earlier media mutations')
    assert.ok(stats.writeStatements >= 3, 'the failure must happen after actual transaction writes were attempted')
    assert.deepEqual(
      { begins: stats.begins, commits: stats.commits, rollbacks: stats.rollbacks, releases: stats.releases },
      { begins: 1, commits: 0, rollbacks: 1, releases: 1 },
    )
    assert.deepEqual(sideEffects, { broadcasts: 0, notifications: 0 })

    resetFixture([makeTask('replay-task')])
    state.media.push({ id: 'inspection-photo', task_id: 'replay-task', type: 'inspection_photo:toilet', url: 'cleaning/test/inspection.jpg' })
    const first = await submitRestock(baseUrl, 'replay-task', 'stable-replay-submit')
    assert.equal(first.status, 201)
    const committedState = cloneState(state)
    const writesAfterFirst = stats.writeStatements
    const effectsAfterFirst = { ...sideEffects }
    const replay = await submitRestock(baseUrl, 'replay-task', 'stable-replay-submit')
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.body, first.body)
    assert.deepEqual(state, committedState, 'receipt replay must not duplicate media, audit, or receipt rows')
    assert.equal(stats.writeStatements, writesAfterFirst)
    assert.deepEqual(sideEffects, effectsAfterFirst, 'receipt replay must not repeat broadcasts or notifications')
    assert.equal(state.media.filter((item) => item.type === 'inspection_consumables_confirmed').length, 1)
    assert.equal(state.media.filter((item) => item.type === 'inspection_photo:toilet').length, 1, 'restock replacement must retain unrelated inspection media')
    assert.equal(state.audits.length, 1)
    assert.equal(state.audits[0].performed_as_action, 'record_restock_proof')
    assert.equal(Object.keys(state.receipts).length, 1)

    resetFixture([makeTask('concurrent-task')])
    state.media.push({ id: 'lockbox-video', task_id: 'concurrent-task', type: 'lockbox_video', url: 'cleaning/test/lockbox.mp4' })
    enableConcurrencyGate()
    const concurrent = await Promise.all([
      submitRestock(baseUrl, 'concurrent-task', 'concurrent-submit'),
      submitRestock(baseUrl, 'concurrent-task', 'concurrent-submit'),
    ])
    assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 201])
    assert.deepEqual(concurrent[0].body, concurrent[1].body)
    assert.equal(stats.lockWaiters, 1, 'the adapter must serialize one concurrent retry on the task row lock')
    assert.equal(state.media.filter((item) => item.type === 'inspection_consumables_confirmed').length, 1)
    assert.equal(state.media.filter((item) => item.type === 'lockbox_video').length, 1, 'concurrent restock replacement must retain unrelated lockbox media')
    assert.equal(state.audits.length, 1)
    assert.equal(Object.keys(state.receipts).length, 1)
    assert.deepEqual(sideEffects, { broadcasts: 1, notifications: 1 })
    assert.deepEqual(
      { begins: stats.begins, commits: stats.commits, rollbacks: stats.rollbacks, releases: stats.releases },
      { begins: 2, commits: 2, rollbacks: 0, releases: 2 },
    )
  })
  console.log('MZapp restock-proof Express/transaction route tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
