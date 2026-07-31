import assert from 'assert'
import express from 'express'

const testDatabaseUrl = String(process.env.TEST_DATABASE_URL || '').trim()
const testWriteEnabled = String(process.env.TEST_ALLOW_NONPROD_DB_WRITE || '').trim() === '1'
if (!testDatabaseUrl || !testWriteEnabled) {
  process.stdout.write('test_offline_task_assignment_patch: skipped (explicit TEST_DATABASE_URL and TEST_ALLOW_NONPROD_DB_WRITE=1 required)\n')
  process.exit(0)
}

function dbIdentity(value: any) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.hostname}:${url.port || '5432'}${url.pathname}`
  } catch {
    return raw
  }
}

const activeDbIdentity = dbIdentity(testDatabaseUrl)
const prodDbIdentity = dbIdentity(process.env.NEON_DATABASE_URL_PROD || process.env.DATABASE_URL_PROD)
if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {
  throw new Error('Refusing to run write tests when NODE_ENV=production')
}
if (!prodDbIdentity) {
  throw new Error('Refusing to run write tests without NEON_DATABASE_URL_PROD or DATABASE_URL_PROD for a fail-closed production identity check')
}
if (activeDbIdentity && prodDbIdentity && activeDbIdentity === prodDbIdentity) {
  throw new Error('Refusing to run write tests because DATABASE_URL matches production database URL')
}
process.env.DATABASE_URL = testDatabaseUrl

const taskId = 'test-offline-assignment-patch'
const assigneeId = 'test-offline-assignment-patch-assignee'
const secondAssigneeId = 'test-offline-assignment-patch-second-assignee'
const propertyId = 'P_TEST_OFFLINE_ASSIGNMENT_PATCH'

async function request(app: express.Express, body: any, role = 'admin') {
  const server = await new Promise<any>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const response = await fetch(`http://127.0.0.1:${port}/cleaning/offline-tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-role': role },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function main() {
  const { pgPool } = await import('../../src/dbAdapter')
  if (!pgPool) {
    process.stdout.write('test_offline_task_assignment_patch: skipped (pg not configured)\n')
    return
  }
  const { ensureCleaningSchemaV2 } = await import('../../src/services/cleaningSync')
  const { router: cleaningRouter, upsertWorkTaskFromOfflineTask } = await import('../../src/modules/cleaning')
  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    const role = String(req.headers['x-test-role'] || 'admin')
    req.user = { sub: `test-${role}`, username: `test-${role}`, role, roles: [role] }
    next()
  })
  app.use('/cleaning', cleaningRouter)

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

  try {
    await pgPool.query(`DELETE FROM work_tasks WHERE source_type='cleaning_offline_tasks' AND source_id=$1`, [taskId])
    await pgPool.query(`DELETE FROM cleaning_offline_tasks WHERE id=$1`, [taskId])
    await pgPool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[assigneeId, secondAssigneeId]])
    await pgPool.query(`INSERT INTO properties(id, address) VALUES($1, 'Test offline assignment property') ON CONFLICT (id) DO NOTHING`, [propertyId])
    await pgPool.query(
      `INSERT INTO users(id, username, password_hash, role)
       VALUES($1, $1, 'test-only', 'cleaner'), ($2, $2, 'test-only', 'cleaner')
       ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username, password_hash=EXCLUDED.password_hash, role=EXCLUDED.role`,
      [assigneeId, secondAssigneeId],
    )
    await pgPool.query(
      `INSERT INTO cleaning_offline_tasks(id, date, task_type, title, content, kind, status, urgency, property_id, assignee_id)
       VALUES($1, '2026-06-29', 'property', 'Patch assignment', 'before', 'offline', 'todo', 'medium', $2, NULL)`,
      [taskId, propertyId],
    )
    await upsertWorkTaskFromOfflineTask({
      id: taskId,
      date: '2026-06-29',
      property_id: propertyId,
      title: 'Patch assignment',
      content: 'before',
      assignee_id: null,
      status: 'todo',
      photo_urls: [],
    }, 'todo', { syncAssignmentStatus: true })

    const roleAssignments: Array<[string, string]> = [
      ['customer_service', assigneeId],
      ['offline_manager', secondAssigneeId],
      ['admin', assigneeId],
    ]
    const requestedRole = String(process.env.TEST_OFFLINE_ASSIGNMENT_ROLE || '').trim()
    const selectedRoleAssignments = requestedRole
      ? roleAssignments.filter(([role]) => role === requestedRole)
      : roleAssignments
    assert.ok(selectedRoleAssignments.length, `unsupported TEST_OFFLINE_ASSIGNMENT_ROLE: ${requestedRole}`)
    for (const [role, expectedAssigneeId] of selectedRoleAssignments) {
      process.stdout.write(`test_offline_task_assignment_patch: testing ${role}\n`)
      const assigned = await request(app, { assignee_id: expectedAssigneeId }, role)
      assert.equal(assigned.status, 200, `${role} should be allowed to update an offline executor`)
      assert.equal(assigned.body?.assignee_id, expectedAssigneeId)
      assert.equal(assigned.body?.assignment_status, 'assigned')
      assert.equal(assigned.body?.work_task_id, `cleaning_offline_tasks:${taskId}`)
    }
    const source = await pgPool.query(`SELECT assignee_id FROM cleaning_offline_tasks WHERE id=$1`, [taskId])
    const canonical = await pgPool.query(`SELECT assignee_id, status FROM work_tasks WHERE source_type='cleaning_offline_tasks' AND source_id=$1`, [taskId])
    const finalAssigneeId = selectedRoleAssignments[selectedRoleAssignments.length - 1][1]
    assert.equal(source.rows[0]?.assignee_id, finalAssigneeId)
    assert.equal(canonical.rows[0]?.assignee_id, finalAssigneeId)
    assert.equal(canonical.rows[0]?.status, 'assigned')

    const verificationRole = selectedRoleAssignments[0][0]
    const contentOnly = await request(app, { content: 'must keep assignment' }, verificationRole)
    assert.equal(contentOnly.status, 200)
    assert.equal(contentOnly.body?.assignee_id, finalAssigneeId)
    const rejected = await request(app, { assignee_id: null }, verificationRole)
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body?.code, 'OFFLINE_TASK_ASSIGNEE_REQUIRED')
    const retained = await pgPool.query(`SELECT assignee_id FROM work_tasks WHERE source_type='cleaning_offline_tasks' AND source_id=$1`, [taskId])
    assert.equal(retained.rows[0]?.assignee_id, finalAssigneeId)

  } finally {
    await pgPool.query(`DELETE FROM work_tasks WHERE source_type='cleaning_offline_tasks' AND source_id=$1`, [taskId])
    await pgPool.query(`DELETE FROM cleaning_offline_tasks WHERE id=$1`, [taskId])
    await pgPool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[assigneeId, secondAssigneeId]])
    await pgPool.query(`DELETE FROM properties WHERE id=$1`, [propertyId])
    await pgPool.end()
  }
  process.stdout.write('test_offline_task_assignment_patch: ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
