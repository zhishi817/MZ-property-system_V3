import assert from 'node:assert/strict'
import express from 'express'

// No real pool, database, storage or production API: only loopback HTTP.
for (const key of ['DATABASE_URL', 'PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPORT']) process.env[key] = ''
process.env.MZ_DEV_PREVIEW_DISABLE_RUNTIME_DDL = '1'
const day = '2026-11-09', at = `${day}T01:00:00.000Z`
type Row = Record<string, any>
let fixture: Row[] = [], evidence: Row[] = []
const unknown: string[] = []
const result = (rows: Row[] = []) => ({ rows, rowCount: rows.length })
const db = require('../../src/dbAdapter')
assert.equal(db.pgPool, null)
db.hasPg = true
db.pgPool = {
  connect() { throw new Error('Real database connections forbidden') },
  async query(sql0: string, params: any[] = []) {
    const sql = String(sql0).replace(/\s+/g, ' ').trim()
    // This legacy luggage warmup ignores the runtime-DDL flag. These four
    // exact in-memory no-ops cannot reach a database; all other writes throw.
    if (/^CREATE TABLE IF NOT EXISTS guest_luggage_(notices|acknowledgements) \(/.test(sql) || /^CREATE INDEX IF NOT EXISTS idx_guest_luggage_(notices_task|ack_user) ON guest_luggage_/.test(sql)) return result()
    if (/^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|TRUNCATE|REPLACE|MERGE|GRANT|REVOKE)\b/i.test(sql) || /\bAS\s*\(\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) throw new Error(`Write SQL forbidden: ${sql.slice(0, 180)}`)
    if (/^SELECT 1 FROM schema_migrations WHERE version=\$1 LIMIT 1/.test(sql)) return result([{ exists: 1 }])
    if (/LIMIT 0/.test(sql) && /FROM (property_maintenance|external_maintenance_orders|maintenance_workflow_events|work_tasks)/.test(sql)) return result()
    if (/^WITH scheduled_match_ids AS MATERIALIZED/.test(sql)) {
      const actor = String(params[2]), manager = params[3] === true
      // Feed SQL-shaped evidence to the real route, never synthesize cards.
      // This tests post-query behavior; PostgreSQL CTE semantics require the
      // separate guarded SQL/contract regression, not this in-memory fixture.
      return result(fixture.map(row => ({ ...row,
        cleaner_record_at: manager || row.cleaner_record_actor_user_id === actor ? row.cleaner_record_at : null,
        inspector_record_at: manager || row.inspector_record_actor_user_id === actor ? row.inspector_record_at : null,
        lockbox_record_at: manager || row.lockbox_record_actor_user_id === actor ? row.lockbox_record_at : null,
        lockbox_video_url: actor === 'cleaner' || actor === 'outsider' ? null : row.lockbox_video_url,
      })))
    }
    if (/^SELECT id FROM roles WHERE name=/.test(sql)) return result([{ id: params[0] }])
    if (/^SELECT permission_code FROM role_permissions/.test(sql)) {
      const roles = Array.isArray(params[0]) ? params[0] : []
      return result(roles.some((role: string) => ['cleaning_inspector', 'admin'].includes(role))
        ? [{ permission_code: 'cleaning_app.inspect.finish' }]
        : [])
    }
    if (/^WITH raw_evidence AS/.test(sql)) return result(evidence.filter(row => row.record_date >= params[0] && row.record_date <= params[1]))
    if (/^WITH normalized_arrangement_tasks AS MATERIALIZED/.test(sql)) return result()
    if (/END AS cleaning_submission_ready FROM cleaning_tasks t/.test(sql)) return result(params[0].map((id: string) => ({ id, cleaning_submission_ready: true })))
    if (/FROM cleaning_tasks WHERE execution_state = 'superseded'/.test(sql)) return result()
    if (/FROM cleaning_consumable_usages WHERE task_id::text = ANY/.test(sql)) return result()
    if (/FROM cleaning_task_media WHERE task_id::text = ANY/.test(sql) && /type LIKE 'completion_%'/.test(sql)) return result()
    if (/FROM work_task_action_audits WHERE source_type='cleaning_tasks'/.test(sql) && /completion_photo_exception/.test(sql)) return result()
    if (/FROM guest_luggage_notices WHERE property_id::text = ANY/.test(sql)) return result()
    if (/^WITH source_tasks AS MATERIALIZED/.test(sql) && /m.type LIKE 'restock_proof:%'/.test(sql)) return result()
    if (/FROM work_task_participants/.test(sql)) return result()
    // Empty unrelated task families / event streams, not a catch-all SELECT.
    if (/FROM property_maintenance|FROM external_maintenance_orders|FROM work_task_events/.test(sql)) return result()
    unknown.push(sql)
    throw new Error(`Unexpected fixture query: ${sql.slice(0, 300)}`)
  },
}
const { warmupR5TaskRuntimeSchema } = require('../../src/lib/r5RequestSchema')
const { warmupPasswordAuthoritySchema } = require('../../src/lib/passwordAuthoritySchema')
const { warmupMaintenanceRuntimeSchema } = require('../../src/lib/maintenanceRuntimeSchema')
const { router } = require('../../src/modules/mzapp')
function setFixture(overrides: Row = {}) {
  const row: Row = {
    id: 'checkout', task_date: day, task_type: 'checkout_clean', status: 'keys_hung', execution_state: 'active',
    property_id: 'property-1', property_code: 'FIXTURE-101', order_id: null,
    cleaner_id: 'cleaner', cleaner_name: 'Cleaner A', inspector_id: 'inspector', inspector_name: 'Inspector B', assignee_id: null,
    inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang', keys_required: 1, order_keys_required: 1,
    cleaner_record_at: at, cleaner_record_date: day, cleaner_record_actor_user_id: 'cleaner', cleaner_record_actor_name: 'Cleaner A', has_cleaner_completion_evidence: true,
    inspector_record_at: null, inspector_record_date: null, inspector_record_actor_user_id: null,
    lockbox_video_url: 'fixture/current-video.mp4', has_current_lockbox_video: true, has_current_manual_key_handover: false,
    lockbox_record_at: at, lockbox_record_actor_user_id: 'inspector', lockbox_record_actor_name: 'Inspector B', executor_record_confirmation_source: 'video',
    lockbox_audit_action: 'upload_access_video', lockbox_audit_performed_at: at, lockbox_audit_status_before: 'cleaned', lockbox_audit_status_after: 'keys_hung', lockbox_audit_metadata: {},
    formal_inspection_submitted_at: null, updated_at: at, ...overrides,
  }
  fixture = [row]
  evidence = [
    ...(row.cleaner_record_at ? [{ task_id: row.id, role_kind: 'cleaner', performed_at: row.cleaner_record_at, record_date: row.cleaner_record_date, actor_user_id: row.cleaner_record_actor_user_id, actor_name: row.cleaner_record_actor_name }] : []),
    ...(row.lockbox_record_at ? [{ task_id: row.id, role_kind: 'executor', performed_at: row.lockbox_record_at, record_date: day, actor_user_id: row.lockbox_record_actor_user_id, actor_name: 'Inspector B' }] : []),
    ...(row.inspector_record_at ? [{ task_id: row.id, role_kind: 'inspector', performed_at: row.inspector_record_at, record_date: day, actor_user_id: row.inspector_record_actor_user_id, actor_name: 'Inspector B' }] : []),
  ]
}
const history = (rows: Row[]) => rows.filter(row => row.work_record_read_only === true)
const live = (rows: Row[]) => rows.filter(row => row.work_record_read_only !== true)
async function main() {
  await warmupR5TaskRuntimeSchema(); await warmupPasswordAuthoritySchema(); await warmupMaintenanceRuntimeSchema()
  const app = express()
  app.use((req: any, _res, next) => { const role = String(req.headers['x-test-role']); req.user = { sub: String(req.headers['x-test-user']), role, roles: [role] }; next() })
  app.use('/mzapp', router)
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
  const failures: string[] = []; let passed = 0
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const list = async (id: string, role: string): Promise<Row[]> => {
      const response = await fetch(`http://127.0.0.1:${address.port}/mzapp/work-tasks?date_from=${day}&date_to=${day}${role === 'admin' ? '&view=all' : ''}`, { headers: { 'x-test-user': id, 'x-test-role': role } })
      const body: any = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.ok(Array.isArray(body)); return body
    }
    const test = async (name: string, run: () => Promise<void>) => { try { await run(); passed++; console.log(`PASS ${name}`) } catch (error: any) { failures.push(`${name}: ${error.message}`); console.error(`FAIL ${name}: ${error.message}`) } }
    await test('cleaner personal history retains no video permission', async () => {
      setFixture(); const rows = await list('cleaner', 'cleaner')
      assert.equal(history(rows).length, 1); assert.equal(live(rows).length, 0)
      assert.equal(history(rows)[0].lockbox_video_url ?? null, null); assert.equal(history(rows)[0].read_only_views.lockbox_video, false)
    })
    await test('video uploader without inspection audit retains one history', async () => {
      setFixture({ inspector_id: null }); const rows = await list('inspector', 'cleaning_inspector')
      assert.equal(history(rows).length, 1); assert.equal(live(rows).length, 0); assert.equal(history(rows)[0].completed_by_user_id, 'inspector')
    })
    await test('manager sees cleaner and handover actors', async () => {
      setFixture({ inspector_id: null }); const rows = await list('manager', 'admin')
      assert.equal(history(rows).length, 1, 'manager retains one merged business/date card')
      assert.deepEqual(history(rows)[0].phase_history.map((phase: Row) => phase.actor_user_id).sort(), ['cleaner', 'inspector'])
    })
    await test('pending inspection receipt plus video stays actionable without history duplicate', async () => {
      setFixture({ status: 'in_progress', formal_inspection_submitted_at: `${day}T00:00:00.000Z`, lockbox_audit_metadata: { finalization_pending: true, missing_requirements: ['inspection_photos'] } })
      const rows = await list('inspector', 'cleaning_inspector')
      assert.equal(live(rows).length, 1); assert.equal(history(rows).length, 0); assert.equal(live(rows)[0].key_handover?.state, 'completed')
      assert.ok(live(rows)[0].available_actions.some((action: Row) => action.id === 'submit_inspection' && action.enabled === true))
      assert.equal(live(rows)[0].available_actions.some((action: Row) => action.id === 'upload_access_video' && action.enabled === true), false)
      assert.deepEqual(live(rows)[0].key_handover.source_task_ids || [live(rows)[0].key_handover.source_task_id], ['checkout'])
      const managerRows = await list('manager', 'admin')
      assert.equal(managerRows.length, 1, 'manager merges the completed cleaner into active inspection')
      assert.equal(live(managerRows).length, 1)
      assert.equal(managerRows[0].key_handover.state, 'completed')
      // Manager view must retain the pending task, but must not acquire
      // the assigned inspector's execution permission merely from view=all.
      assert.equal(managerRows[0].work_record_read_only === true, false)
      assert.equal(managerRows[0].phase_history.filter((phase: Row) => phase.actor_user_id === 'inspector' && phase.work_record_state).length, 0)
    })
    await test('formal submit replaces active with exactly one actor history', async () => {
      setFixture({ inspector_record_at: at, inspector_record_date: day, inspector_record_actor_user_id: 'inspector', formal_inspection_submitted_at: at })
      const rows = await list('inspector', 'cleaning_inspector'); assert.equal(live(rows).length, 0); assert.equal(history(rows).length, 1)
      const managerRows = await list('manager', 'admin')
      assert.equal(live(managerRows).length, 0)
      assert.equal(history(managerRows).length, 1)
      assert.equal(history(managerRows)[0].phase_history.filter((phase: Row) => phase.actor_user_id === 'inspector').length, 1, 'formal inspection and video must not duplicate the same actor history')
    })

    await test('ordinary checkin inspect-and-hang retains uploader history', async () => {
      setFixture({ id: 'checkin', task_type: 'checkin_clean', cleaner_id: null, cleaner_record_at: null, inspector_id: null })
      const rows = await list('inspector', 'cleaning_inspector')
      assert.equal(rows.length, 1); assert.equal(history(rows).length, 1)
      assert.equal(rows[0].phase_history[0].source_id, 'checkin')
      assert.equal(rows[0].phase_history[0].actor_user_id, 'inspector')
    })
    await test('formal inspection wins over same actor earlier video', async () => {
      const submitted = `${day}T02:00:00.000Z`
      setFixture({ inspector_record_at: submitted, inspector_record_date: day, inspector_record_actor_user_id: 'inspector', formal_inspection_submitted_at: submitted })
      for (const [id, role] of [['inspector', 'cleaning_inspector'], ['manager', 'admin']]) {
        const rows = await list(id, role)
        const phases = rows.flatMap(row => row.phase_history).filter(phase => phase.actor_user_id === 'inspector')
        assert.equal(phases.length, 1); assert.equal(phases[0].occurred_at, submitted); assert.equal(live(rows).length, 0)
      }
    })
    await test('different inspection and video actors each retain exact execution evidence', async () => {
      setFixture({ inspector_record_at: `${day}T02:00:00.000Z`, inspector_record_date: day, inspector_record_actor_user_id: 'other-inspector', formal_inspection_submitted_at: `${day}T02:00:00.000Z` })
      const rows = await list('manager', 'admin')
      assert.equal(rows.length, 1)
      assert.deepEqual(rows[0].phase_history.map((phase: Row) => phase.actor_user_id).sort(), ['cleaner', 'inspector', 'other-inspector'])
      const personal = await list('inspector', 'cleaning_inspector')
      assert.equal(history(personal).length, 1)
      assert.equal(personal[0].phase_history.some((phase: Row) => phase.actor_user_id === 'other-inspector'), false)
    })
    await test('same-property different source cannot borrow handover completion', async () => {
      setFixture({ inspector_id: null })
      const original = fixture[0], originalEvidence = evidence
      setFixture({ id: 'unrelated-checkin', task_type: 'checkin_clean', status: 'in_progress', inspector_id: 'other-inspector', cleaner_id: null, cleaner_record_at: null, lockbox_record_at: null, lockbox_record_actor_user_id: null, lockbox_video_url: null, has_current_lockbox_video: false, lockbox_audit_action: null, lockbox_audit_metadata: {} })
      fixture.unshift(original); evidence = [...originalEvidence, ...evidence]
      const rows = await list('inspector', 'cleaning_inspector')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].phase_history.some((phase: Row) => phase.source_id === 'unrelated-checkin'), false)
      const otherRows = await list('other-inspector', 'cleaning_inspector')
      assert.equal(otherRows.some(row => row.key_handover?.state === 'completed'), false)
    })
    await test('deferred prior-day cleaner does not hide next-day uploader', async () => {
      setFixture({ task_date: '2026-11-08', inspection_mode: 'deferred', inspection_due_date: day, inspector_id: null, cleaner_record_at: '2026-11-08T01:00:00.000Z', cleaner_record_date: '2026-11-08' })
      for (const [id, role] of [['inspector', 'cleaning_inspector'], ['manager', 'admin']]) {
        const rows = await list(id, role)
        assert.equal(rows.length, 1)
        assert.equal(history(rows).length, 1)
        assert.deepEqual(rows[0].phase_history.map((phase: Row) => phase.actor_user_id), ['inspector'])
        assert.equal(rows[0].work_record_date, day)
      }
    })
    await test('manual confirmation without video keeps one inspector history', async () => {
      setFixture({
        has_current_lockbox_video: false, lockbox_video_url: null,
        has_current_manual_key_handover: true, current_manual_key_handover_at: at,
        executor_record_confirmation_source: 'manual', lockbox_audit_action: null,
      })
      // The manager SQL classifies ordinary manual confirmations as inspection
      // evidence, not as video executor evidence.
      evidence = evidence.map(row => row.role_kind === 'executor' ? { ...row, role_kind: 'inspector' } : row)
      for (const [id, role] of [['inspector', 'cleaning_inspector'], ['manager', 'admin']]) {
        const rows = await list(id, role)
        assert.equal(rows.length, 1); assert.equal(history(rows).length, 1)
        const phases = rows.flatMap(row => row.phase_history).filter(phase => phase.actor_user_id === 'inspector')
        assert.equal(phases.length, 1)
        assert.equal(phases[0].role, 'inspector')
        assert.equal(rows[0].phase_history.some((phase: Row) => phase.role === 'executor'), false)
      }
    })
    await test('different uploader history cannot override current pending inspector', async () => {
      setFixture({
        status: 'in_progress', task_type: 'checkin_clean', cleaner_id: null, cleaner_record_at: null,
        inspector_id: 'current-inspector', inspector_name: 'Inspector C',
        lockbox_audit_metadata: { finalization_pending: true, missing_requirements: ['inspection_photos'] },
      })
      const uploader = await list('inspector', 'cleaning_inspector')
      assert.equal(uploader.length, 1); assert.equal(history(uploader).length, 1)
      assert.equal(uploader[0].execution_role, 'execution')
      const current = await list('current-inspector', 'cleaning_inspector')
      assert.equal(current.length, 1); assert.equal(live(current).length, 1)
      assert.equal(current[0].task_kind, 'inspection')
      assert.ok(current[0].available_actions.some((action: Row) => action.id === 'submit_inspection' && action.enabled))
      const managerRows = await list('manager', 'admin')
      assert.equal(managerRows.length, 1); assert.equal(live(managerRows).length, 1)
      assert.equal(managerRows[0].task_kind, 'inspection', 'manager task kind')
      assert.equal(managerRows[0].execution_semantics, current[0].execution_semantics, 'manager execution semantics')
      assert.equal(managerRows[0].inspector_id, 'current-inspector')
      assert.equal(managerRows[0].phase_history.filter((phase: Row) => phase.actor_user_id === 'inspector' && phase.role === 'executor').length, 1)
      // Compare identical manager permissions with and without the historical
      // executor projection. Only phase history may be enriched by uploader B.
      fixture[0].lockbox_record_at = null
      evidence = evidence.filter(row => row.role_kind !== 'executor')
      const managerWithoutUploaderHistory = await list('manager', 'admin')
      assert.equal(managerWithoutUploaderHistory.length, 1)
      assert.deepEqual(managerRows[0].available_actions, managerWithoutUploaderHistory[0].available_actions)
      assert.equal(managerRows[0].status, managerWithoutUploaderHistory[0].status)
    })
    await test('inspector-only actor keeps video history when former cleaner history is invisible', async () => {
      setFixture({ inspector_id: null, cleaner_id: 'inspector', cleaner_record_actor_user_id: 'inspector', cleaner_record_actor_name: 'Former cleaner B' })
      const rows = await list('inspector', 'cleaning_inspector')
      assert.equal(rows.length, 1); assert.equal(history(rows).length, 1)
      assert.equal(rows[0].execution_role, 'execution')
      assert.deepEqual(rows[0].phase_history.map((phase: Row) => phase.role), ['executor'])
      assert.equal(rows[0].read_only_views.cleaner_photos, false)
      assert.equal(rows[0].capabilities.base_permissions.finish, false)
      assert.equal(rows[0].available_actions.some((action: Row) => ['complete_cleaning', 'start_cleaning'].includes(action.id) && action.enabled), false)
    })
    await test('cleaner-only uploader history is not swallowed by invisible active inspection', async () => {
      setFixture({
        task_type: 'checkin_clean', status: 'in_progress', cleaner_id: null, cleaner_record_at: null,
        lockbox_audit_metadata: { finalization_pending: true, missing_requirements: ['inspection_photos'] },
      })
      const rows = await list('inspector', 'cleaner')
      assert.equal(rows.length, 1); assert.equal(history(rows).length, 1); assert.equal(live(rows).length, 0)
      assert.equal(rows[0].execution_role, 'execution')
      assert.deepEqual(rows[0].phase_history.map((phase: Row) => phase.role), ['executor'])
      assert.equal(rows[0].read_only_views.lockbox_video, false)
      assert.equal(rows[0].capabilities.base_permissions.inspect, false)
      assert.equal(rows[0].available_actions.some((action: Row) => action.id === 'submit_inspection' && action.enabled), false)
    })
    await test('cleaner role cannot inherit uploader video permission', async () => {
      setFixture({ inspector_id: null }); const rows = await list('inspector', 'cleaner')
      assert.equal(rows.some(row => row.read_only_views?.lockbox_video === true), false)
      assert.equal(rows.some(row => row.available_actions.some((action: Row) => action.id === 'submit_inspection' && action.enabled)), false)
    })
    await test('unrelated actor gains no records', async () => { setFixture({ inspector_id: null }); assert.deepEqual(await list('outsider', 'cleaning_inspector'), []) })
    for (const state of ['cancelled', 'deleted', 'superseded']) await test(`${state} source cannot produce active work`, async () => {
      setFixture({ execution_state: state, ...(state === 'cancelled' ? { status: 'cancelled' } : {}) }); assert.equal(live(await list('inspector', 'cleaning_inspector')).length, 0)
    })
    assert.deepEqual(unknown, [], 'unknown SQL must fail even if swallowed by route')
    assert.equal(failures.length, 0, failures.join('\n')); console.log(`test_handover_visibility_routes: ${passed} cases passed (in-memory only)`)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
