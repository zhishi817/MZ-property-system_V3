import assert from 'assert'
import express from 'express'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), override: true })

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

const taskId = 'test-offline-assignment-first-patch'
const assigneeId = 'test-offline-assignment-first-patch-assignee'
const propertyId = 'P_TEST_OFFLINE_ASSIGNMENT_FIRST_PATCH'
const testRole = String(process.env.TEST_OFFLINE_ASSIGNMENT_ROLE || 'customer_service').trim()
assert(['customer_service', 'offline_manager', 'admin'].includes(testRole), `unsupported TEST_OFFLINE_ASSIGNMENT_ROLE: ${testRole}`)

async function request(app: express.Express) {
  const server = await new Promise<any>((resolve) => {
    const listener = app.listen(0, () => resolve(listener))
  })
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const response = await fetch(`http://127.0.0.1:${port}/cleaning/offline-tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-role': testRole },
      body: JSON.stringify({ assignee_id: assigneeId }),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function main() {
  const cleaningSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning.ts'), 'utf8')
  const patchStart = cleaningSource.indexOf("router.patch('/offline-tasks/:id'")
  const patchEnd = cleaningSource.indexOf("router.delete('/offline-tasks/:id'", patchStart)
  const patchSource = cleaningSource.slice(patchStart, patchEnd)
  assert(patchSource.includes('await ensureOfflineTasksTable()\n      await ensureWorkTasksTable()'), 'offline PATCH must ensure work_tasks before its first transaction lock')

  const { pgPool } = await import('../../src/dbAdapter')
  if (!pgPool) {
    process.stdout.write('test_offline_task_assignment_first_patch: skipped (pg not configured)\n')
    return
  }
  const { ensureCleaningSchemaV2 } = await import('../../src/services/cleaningSync')
  const { router: cleaningRouter } = await import('../../src/modules/cleaning')
  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    const role = String(req.headers['x-test-role'] || testRole)
    req.user = { sub: `test-${role}`, username: `test-${role}`, role, roles: [role] }
    next()
  })
  app.use('/cleaning', cleaningRouter)

  await ensureCleaningSchemaV2()
  try {
    await pgPool.query(`DELETE FROM work_tasks WHERE source_type='cleaning_offline_tasks' AND source_id=$1`, [taskId])
    await pgPool.query(`DELETE FROM cleaning_offline_tasks WHERE id=$1`, [taskId])
    await pgPool.query(`DELETE FROM users WHERE id=$1`, [assigneeId])
    await pgPool.query(`INSERT INTO properties(id, address) VALUES($1, 'Test first offline patch property') ON CONFLICT (id) DO NOTHING`, [propertyId])
    await pgPool.query(
      `INSERT INTO users(id, username, password_hash, role)
       VALUES($1, $1, 'test-only', 'cleaner')
       ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username, password_hash=EXCLUDED.password_hash, role=EXCLUDED.role`,
      [assigneeId],
    )
    await pgPool.query(
      `INSERT INTO cleaning_offline_tasks(id, date, task_type, title, content, kind, status, urgency, property_id, assignee_id)
       VALUES($1, '2026-06-29', 'property', 'First canonical patch', 'no prior projection', 'offline', 'todo', 'medium', $2, NULL)`,
      [taskId, propertyId],
    )

    const result = await request(app)
    assert.equal(result.status, 200)
    assert.equal(result.body?.assignee_id, assigneeId)
    assert.equal(result.body?.work_task_id, `cleaning_offline_tasks:${taskId}`)
    const canonical = await pgPool.query(`SELECT assignee_id, status FROM work_tasks WHERE source_type='cleaning_offline_tasks' AND source_id=$1`, [taskId])
    assert.equal(canonical.rows[0]?.assignee_id, assigneeId)
    assert.equal(canonical.rows[0]?.status, 'assigned')
  } finally {
    await pgPool.query(`DELETE FROM work_tasks WHERE source_type='cleaning_offline_tasks' AND source_id=$1`, [taskId])
    await pgPool.query(`DELETE FROM cleaning_offline_tasks WHERE id=$1`, [taskId])
    await pgPool.query(`DELETE FROM users WHERE id=$1`, [assigneeId])
    await pgPool.query(`DELETE FROM properties WHERE id=$1`, [propertyId])
    await pgPool.end()
  }
  process.stdout.write(`test_offline_task_assignment_first_patch: ${testRole} ok\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
