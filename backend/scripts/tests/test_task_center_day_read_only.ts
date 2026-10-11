import assert from 'assert'

async function main() {
  process.env.DATABASE_URL = 'postgres://read-only-test.invalid/mz'
  const dbAdapter = await import('../../src/dbAdapter')
  assert.ok(dbAdapter.pgPool, 'test requires the PostgreSQL code path')
  const statements: string[] = []
  ;(dbAdapter.pgPool as any).query = async (sql0: unknown) => {
    const sql = String(sql0 || '')
    statements.push(sql)
    assert.equal(
      /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql),
      false,
      `GET projection attempted a mutating statement: ${sql.slice(0, 120)}`,
    )
    if (sql.includes('FROM schema_migrations')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
    if (sql.includes("to_regclass('public.property_maintenance')")) {
      return {
        rows: [{ has_maintenance: true, has_deep_cleaning: true, has_daily_necessities: true }],
        rowCount: 1,
      }
    }
    if (sql.includes('SELECT to_regclass($1) AS table_name')) return { rows: [{ table_name: null }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }
  const { warmupMaintenanceRuntimeSchema } = await import('../../src/lib/maintenanceRuntimeSchema')
  const { shouldTouchSessionForRequest } = await import('../../src/auth')
  assert.equal(shouldTouchSessionForRequest('GET', '/task-center/day?date=2026-10-12'), false)
  assert.equal(shouldTouchSessionForRequest('GET', '/TASK-CENTER/DAY/?date=2026-10-12'), false)
  assert.equal(shouldTouchSessionForRequest('POST', '/task-center/save-board'), true)
  assert.equal(shouldTouchSessionForRequest('GET', '/task-center/day-extra'), true)
  await warmupMaintenanceRuntimeSchema()
  const { buildTaskCenterDay } = await import('../../src/modules/task_center')
  const day = await buildTaskCenterDay('2026-10-12', false, true, false, true)
  assert.deepEqual(day.property_followups, [])
  assert.ok(statements.length > 8, 'exercise all task-center day read loaders')
  const propertyProjectionSql = statements.find((sql) => sql.includes('WITH active AS') && sql.includes('property_deep_cleaning')) || ''
  assert.match(
    propertyProjectionSql,
    /WHEN a\.source_type = 'property_deep_cleaning'[\s\S]*WHEN w\.id IS NOT NULL THEN NULLIF\(BTRIM\(w\.assignee_id::text\), ''\)[\s\S]*ELSE a\.source_assignee_id/,
    'PostgreSQL GET projection must make an existing deep-cleaning work projection authoritative',
  )
  assert.equal(
    statements.some((sql) => sql.includes('FROM task_center_task_flags') || sql.includes('FROM task_center_board_rows') || sql.includes('FROM task_center_board_items')),
    false,
    'missing optional layout tables degrade to empty read projections without DDL or failing the day GET',
  )
  await dbAdapter.pgPool?.end()
}

main()
  .then(() => process.stdout.write('test_task_center_day_read_only: ok\n'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
