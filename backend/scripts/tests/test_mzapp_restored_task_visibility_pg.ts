import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { Client } from 'pg'

// No application imports, dotenv, bootstrap, network host, or DATABASE_URL fallback.
// Run only against a disposable Unix-socket PostgreSQL cluster under /tmp.
const socket = process.env.MZ_RESTORE_TEST_SOCKET || ''
const dataDir = process.env.MZ_RESTORE_TEST_DATA_DIR || ''
assert.notEqual(process.env.NODE_ENV, 'production')
assert.equal(process.env.MZ_RESTORE_TEST_WRITE, 'ephemeral-only')
const tempRoot = fs.realpathSync('/tmp') + path.sep
for (const value of [socket, dataDir]) {
  assert.ok(value && path.isAbsolute(value), 'explicit socket/data directory required')
  assert.ok(fs.realpathSync(value).startsWith(tempRoot), 'test cluster must be under /tmp')
}
const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
const cancellation = source.match(/latest_cancellation_ids AS MATERIALIZED \(([\s\S]*?)\n          \),\n          lockbox_video_candidate_task_ids/)
const visibility = source.match(/WHERE \(\n                COALESCE\(candidate_cancellation.is_deleted[\s\S]*?\n              \)\n              AND \(/)
assert.ok(cancellation && visibility, 'extract production SQL rather than duplicate the rule')
const predicate = visibility[0].replace(/^WHERE /, '').replace(/\n              AND \($/, '')

// Exercise the unchanged production role-ownership predicates without loading the router.
function routeCondition(marker: string) {
  const start = source.indexOf(marker)
  assert.ok(start >= 0)
  const open = source.indexOf('(', start)
  let depth = 1
  for (let end = open + 1; end < source.length; end++) {
    if (source[end] === '(') depth++
    if (source[end] === ')' && --depth === 0) return source.slice(open + 1, end)
  }
  throw new Error('unterminated route condition')
}
const cleanerCondition = routeCondition('if (isActiveCleaningTurnoverCandidate(row) && !cleanerTerminal')
const inspectorCondition = routeCondition('if ((!suppressStandaloneCheckin || inspectionSubmissionPending) && isActiveCleaningTurnoverCandidate(row) && !inspectorTerminal')
const roleContext = {
  row: {}, isActiveCleaningTurnoverCandidate: () => true,
  cleanerTerminal: false, inspectorTerminal: false, cancelled: false,
  taskDate: '2026-11-08', dateFrom: '2026-11-08', dateTo: '2026-11-08',
  effectiveCleanerId: 'cleaner-current', effectiveInspectionAssigneeId: 'inspector-current',
  allowAllCleaningTasks: false, manualCleaningAssigneeId: '', manualInspectionAssigneeId: '',
  managerCanSeeAllCleaningTaskPool: false, suppressStandaloneCheckin: false, inspectionSubmissionPending: false, inspectorDisplayDate: '2026-11-08',
}
for (const [condition, owner] of [[cleanerCondition, 'cleaner-current'], [inspectorCondition, 'inspector-current']]) {
  for (const userId of [owner, 'previous-assignee', 'unrelated-user']) {
    assert.equal(Boolean(vm.runInNewContext(condition, { ...roleContext, userId })), userId === owner)
  }
  assert.equal(Boolean(vm.runInNewContext(condition, { ...roleContext, userId: owner, cancelled: true })), false)
}
// The pending-submission exception added by MZ-077 preserves the same ownership
// and cancellation boundaries when a previously suppressed card remains live.
for (const userId of ['inspector-current', 'previous-assignee', 'unrelated-user']) {
  assert.equal(Boolean(vm.runInNewContext(inspectorCondition, {
    ...roleContext, userId, suppressStandaloneCheckin: true, inspectionSubmissionPending: true,
  })), userId === 'inspector-current')
}
assert.equal(Boolean(vm.runInNewContext(inspectorCondition, {
  ...roleContext, userId: 'inspector-current', suppressStandaloneCheckin: true,
  inspectionSubmissionPending: true, cancelled: true,
})), false)

async function main() {
  const client = new Client({ host: socket, port: 55438, database: 'postgres', user: process.env.USER,
    connectionTimeoutMillis: 3000, options: '-c statement_timeout=10000' })
  await client.connect()
  try {
    const identity = await client.query('SELECT inet_server_addr() AS address, current_setting(\'data_directory\') AS data_dir')
    assert.equal(identity.rows[0].address, null, 'refuse TCP database')
    assert.equal(fs.realpathSync(identity.rows[0].data_dir), fs.realpathSync(dataDir), 'refuse unexpected cluster')
    await client.query('BEGIN')
    await client.query(`CREATE TEMP TABLE cleaning_tasks(id text PRIMARY KEY, status text, execution_state text);
      CREATE TEMP TABLE work_task_events(task_id text, occurred_at timestamptz, sequence_no bigint,
        event_type text, payload jsonb, source_type text)`)
    const deleted = { patch: { status: 'cancelled', lifecycle_state: 'deleted' } }
    const restored = { patch: { status: 'assigned', execution_state: 'active' },
      arrangement_revision: { version: 'mz031-v1', before: { status: 'cancelled' }, after: { status: 'assigned' },
        reasons: ['scheduled_service_date_changed', 'management_reopened'] } }
    const time = (n: number) => `2026-11-08T00:00:${String(n).padStart(2, '0')}Z`
    type Event = { at?: number, seq?: number, task?: string, type?: string, source?: string, payload: any }
    let count = 0
    async function scenario(name: string, expected: boolean, events: Event[], status = 'assigned', state: string | null = 'active') {
      await client.query('TRUNCATE cleaning_tasks, work_task_events')
      await client.query('INSERT INTO cleaning_tasks VALUES ($1,$2,$3)', ['subject', status, state])
      for (const [i, event] of events.entries()) {
        await client.query('INSERT INTO work_task_events VALUES ($1,$2,$3,$4,$5,$6)', [
          event.task || 'cleaning_task:subject', time(event.at ?? i + 1), event.seq ?? i + 1,
          event.type || (event.payload === deleted ? 'TASK_REMOVED' : 'TASK_ASSIGNMENT_CHANGED'), event.payload, event.source || 'cleaning_tasks',
        ])
      }
      const before = await client.query('SELECT * FROM work_task_events ORDER BY sequence_no')
      const result = await client.query(`WITH latest_cancellation_ids AS MATERIALIZED (${cancellation![1]})
        SELECT t.id FROM cleaning_tasks t
        LEFT JOIN latest_cancellation_ids candidate_cancellation ON candidate_cancellation.id=t.id
        WHERE ${predicate}`)
      assert.equal(result.rowCount === 1, expected, name)
      assert.deepEqual((await client.query('SELECT * FROM work_task_events ORDER BY sequence_no')).rows, before.rows,
        `${name}: audit evidence is immutable`)
      count++
    }
    const d = { payload: deleted }
    const r = { payload: restored }
    await scenario('explicit restore after deletion', true, [d, r])
    await scenario('later ordinary assignment retains restore', true, [d, r, { payload: { patch: restored.patch } }])
    await scenario('active row without restore remains hidden', false, [d])
    await scenario('ordinary assignment is not restoration', false, [d, { payload: { patch: restored.patch } }])
    await scenario('older restore cannot undo deletion', false, [r, d])
    await scenario('different task restore cannot undo deletion', false, [d, { ...r, task: 'cleaning_task:other' }])
    await scenario('different task namespace cannot undo deletion', false, [d, { ...r, task: 'maintenance_task:subject' }])
    await scenario('repeat deletion after restore hides task', false, [d, r, d])
    await scenario('restore then ordinary cancellation retains cancellation history', true,
      [d, r, { payload: { patch: { status: 'cancelled', lifecycle_state: 'cancelled' } } }], 'cancelled', 'cancelled')
    await scenario('equal timestamps use greater sequence', true, [{ ...d, at: 1, seq: 5 }, { ...r, at: 1, seq: 6 }])
    await scenario('equal timestamps reject older sequence', false, [{ ...d, at: 1, seq: 6 }, { ...r, at: 1, seq: 5 }])
    await scenario('identical ordering is not later', false, [{ ...d, at: 1, seq: 5 }, { ...r, at: 1, seq: 5 }])
    await scenario('timestamp precedes sequence tie-breaker', false, [{ ...d, at: 2, seq: 5 }, { ...r, at: 1, seq: 6 }])
    await scenario('later timestamp cannot authorize older sequence', false, [{ ...d, at: 1, seq: 6 }, { ...r, at: 2, seq: 5 }])
    await scenario('clock-skewed second deletion still blocks restoration', false,
      [{ ...d, at: 2, seq: 5 }, { ...r, at: 3, seq: 6 }, { ...d, at: 1, seq: 7 }])
    await scenario('current superseded task stays hidden', false, [d, r], 'assigned', 'superseded')
    await scenario('current cancelled task stays hidden', false, [d, r], 'cancelled', 'active')
    await scenario('missing current execution state fails closed', false, [d, r], 'assigned', null)
    await scenario('unknown current status fails closed', false, [d, r], 'unknown')
    await scenario('current completed restore can retain evidence', true, [d, r], 'completed')
    await scenario('unknown event type fails closed', false, [d, { ...r, type: 'TASK_REMOVED' }])
    await scenario('TASK_UPDATED explicit restore supported', true, [d, { ...r, type: 'TASK_UPDATED' }])
    await scenario('wrong source type cannot reopen task', false, [d, { ...r, source: 'property_maintenance' }])
    for (const arrangement_revision of [
      { ...restored.arrangement_revision, version: 'unknown' },
      { ...restored.arrangement_revision, before: { status: 'assigned' } },
      { ...restored.arrangement_revision, after: { status: 'in_progress' } },
      { ...restored.arrangement_revision, reasons: ['scheduled_service_date_changed'] },
      { reasons: ['management_reopened'] },
    ]) {
      await scenario(`inconsistent restore evidence ${JSON.stringify(arrangement_revision)}`, false,
        [d, { payload: { ...restored, arrangement_revision } }])
    }
    for (const patch of [{ status: 'assigned' }, { execution_state: 'active' },
      { status: 'completed', execution_state: 'active' }, { status: 'assigned', execution_state: 'superseded' },
      { ...restored.patch, lifecycle_state: 'deleted' }, { ...restored.patch, status: 'unknown' }]) {
      await scenario(`invalid restore patch ${JSON.stringify(patch)}`, false, [d, { payload: { ...restored, patch } }])
    }
    await scenario('ordinary cancellation still eligible for historical projection', true,
      [{ payload: { patch: { status: 'cancelled', lifecycle_state: 'cancelled' } } }], 'cancelled', 'cancelled')
    await scenario('never deleted current task unchanged', true, [])
    await scenario('never deleted completion history unchanged', true, [], 'completed')
    for (const lifecycle_state of ['removed', 'tombstone']) {
      await scenario(`${lifecycle_state} remains hidden without restore`, false,
        [{ payload: { patch: { status: 'canceled', lifecycle_state } } }])
    }
    await client.query('ROLLBACK')
    console.log(`PASS ${count} restored-task PostgreSQL cases + 12 production role-ownership predicate cases; source SQL exercised; audit rows unchanged`)
  } finally { await client.end() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
