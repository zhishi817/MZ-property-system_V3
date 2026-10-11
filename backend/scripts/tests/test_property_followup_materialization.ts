import assert from 'assert'

type SourceState = 'pending' | 'completed'

async function main() {
  process.env.DATABASE_URL = 'postgres://materialization-test.invalid/mz'
  const dbAdapter = await import('../../src/dbAdapter')
  assert.ok(dbAdapter.pgPool, 'test requires the PostgreSQL code path')
  ;(dbAdapter.pgPool as any).query = async (sql0: unknown) => {
    const sql = String(sql0 || '')
    if (sql.includes('FROM schema_migrations')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }
  const { warmupMaintenanceRuntimeSchema } = await import('../../src/lib/maintenanceRuntimeSchema')
  await warmupMaintenanceRuntimeSchema()
  const {
    lockAndValidateTaskCenterAssignmentUsers,
    materializeLegacyOfflineAssignments,
    materializePropertyFollowupAssignments,
  } = await import('../../src/modules/task_center')

  function fakeClient(sourceState: SourceState, deletedAt: string | null = null) {
    const statements: string[] = []
    let inserts = 0
    return {
      statements,
      get inserts() { return inserts },
      async query(sql0: unknown) {
        const sql = String(sql0 || '')
        statements.push(sql)
        if (sql.includes('FROM property_deep_cleaning') && sql.includes('FOR UPDATE')) {
          return {
            rows: [{ id: 'deep-1', status: sourceState, review_status: null, deleted_at: deletedAt }],
            rowCount: 1,
          }
        }
        if (/\bLIMIT 0\b/i.test(sql)) return { rows: [], rowCount: 0 }
        if (sql.includes("to_regclass('public.property_maintenance')")) {
          return {
            rows: [{ has_maintenance: false, has_deep_cleaning: true, has_daily_necessities: false }],
            rowCount: 1,
          }
        }
        if (sql.includes('WITH active AS')) {
          return {
            rows: [{
              source_type: 'property_deep_cleaning',
              source_id: 'deep-1',
              task_kind: 'deep_cleaning',
              property_id: 'property-1',
              title: '深度清洁',
              summary: '测试项目',
              urgency: 'medium',
              source_assignee_id: null,
              source_scheduled_date: null,
              source_task_status: 'todo',
              existing_work_id: null,
              assignee_id: null,
              task_status: 'todo',
              scheduled_date: '2026-10-12',
              property_code: 'P-1',
              property_region: 'TEST',
              sort_index: null,
            }],
            rowCount: 1,
          }
        }
        if (/^\s*INSERT INTO work_tasks/i.test(sql)) {
          inserts += 1
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`unexpected query: ${sql.slice(0, 120)}`)
      },
    }
  }

  const activeClient = fakeClient('pending')
  await materializePropertyFollowupAssignments(
    activeClient,
    '2026-10-12',
    [{ task_id: 'property_deep_cleaning:deep-1' }],
    'user-1',
  )
  assert.equal(activeClient.inserts, 1)
  const lockIndex = activeClient.statements.findIndex((sql) => sql.includes('FOR UPDATE'))
  const insertIndex = activeClient.statements.findIndex((sql) => /^\s*INSERT INTO work_tasks/i.test(sql))
  assert.ok(lockIndex >= 0 && insertIndex > lockIndex, 'source row is locked before materialization')
  assert.match(activeClient.statements[lockIndex], /ORDER BY id::text\s+FOR UPDATE/)

  const racedClosedClient = fakeClient('completed')
  await assert.rejects(
    materializePropertyFollowupAssignments(
      racedClosedClient,
      '2026-10-12',
      [{ task_id: 'property_deep_cleaning:deep-1' }],
      'user-1',
    ),
    /property_followup_not_available/,
  )
  assert.equal(racedClosedClient.inserts, 0, 'a source closed before lock acquisition is never materialized')

  const racedDeletedClient = fakeClient('pending', '2026-10-11T00:00:00Z')
  await assert.rejects(
    materializePropertyFollowupAssignments(
      racedDeletedClient,
      '2026-10-12',
      [{ task_id: 'property_deep_cleaning:deep-1' }],
      'user-1',
    ),
    /property_followup_not_available/,
  )
  assert.equal(racedDeletedClient.inserts, 0, 'a soft-deleted source is never materialized')

  function fakeOfflineClient(sourceExists: boolean, status = 'todo', scheduledDate = '2026-10-12') {
    const statements: string[] = []
    let inserts = 0
    return {
      statements,
      get inserts() { return inserts },
      async query(sql0: unknown) {
        const sql = String(sql0 || '')
        statements.push(sql)
        if (sql.startsWith('SELECT id::text AS id, source_type')) return { rows: [], rowCount: 0 }
        if (sql.includes("to_regclass('public.cleaning_offline_tasks')")) {
          return { rows: [{ table_name: 'cleaning_offline_tasks' }], rowCount: 1 }
        }
        if (sql.includes('FROM cleaning_offline_tasks') && sql.includes('FOR UPDATE')) {
          return {
            rows: sourceExists ? [{ id: 'offline-1', status, scheduled_date: scheduledDate }] : [],
            rowCount: sourceExists ? 1 : 0,
          }
        }
        if (/^\s*INSERT INTO work_tasks/i.test(sql)) {
          inserts += 1
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`unexpected offline query: ${sql.slice(0, 120)}`)
      },
    }
  }

  const offlineClient = fakeOfflineClient(true)
  await materializeLegacyOfflineAssignments(
    offlineClient,
    '2026-10-12',
    [{ task_id: 'cleaning_offline_tasks:offline-1' }],
    'user-1',
  )
  assert.equal(offlineClient.inserts, 1)
  assert.ok(
    offlineClient.statements.findIndex((sql) => sql.includes('FOR UPDATE'))
      < offlineClient.statements.findIndex((sql) => /^\s*INSERT INTO work_tasks/i.test(sql)),
    'legacy offline source is locked before explicit-save materialization',
  )
  assert.match(
    offlineClient.statements.find((sql) => sql.includes('FROM cleaning_offline_tasks') && sql.includes('FOR UPDATE')) || '',
    /ORDER BY id::text\s+FOR UPDATE/,
  )

  const missingOfflineClient = fakeOfflineClient(false)
  await assert.rejects(
    materializeLegacyOfflineAssignments(
      missingOfflineClient,
      '2026-10-12',
      [{ task_id: 'cleaning_offline_tasks:offline-1' }],
      'user-1',
    ),
    /offline_task_not_available/,
  )
  assert.equal(missingOfflineClient.inserts, 0)

  for (const staleClient of [
    fakeOfflineClient(true, 'cancelled'),
    fakeOfflineClient(true, 'todo', '2026-10-13'),
  ]) {
    await assert.rejects(
      materializeLegacyOfflineAssignments(
        staleClient,
        '2026-10-12',
        [{ task_id: 'cleaning_offline_tasks:offline-1' }],
        'user-1',
      ),
      /offline_task_not_available/,
    )
    assert.equal(staleClient.inserts, 0, 'terminal or rescheduled legacy source is never materialized')
  }

  function fakeUserLockClient(users: Array<{ id: string; role: string }>, roles: Array<{ user_id: string; role_name: string }>) {
    const statements: string[] = []
    return {
      statements,
      async query(sql0: unknown) {
        const sql = String(sql0 || '')
        statements.push(sql)
        if (sql.includes('FROM users')) return { rows: users, rowCount: users.length }
        if (sql.includes('FROM user_roles')) return { rows: roles, rowCount: roles.length }
        throw new Error(`unexpected user-lock query: ${sql.slice(0, 120)}`)
      },
    }
  }

  const validUserClient = fakeUserLockClient([
    { id: 'cleaner-1', role: 'cleaner' },
    { id: 'maintenance-1', role: 'customer_service' },
  ], [])
  await lockAndValidateTaskCenterAssignmentUsers(validUserClient, ['cleaner-1'], ['maintenance-1'])
  assert.match(validUserClient.statements[0], /ORDER BY id::text\s+FOR UPDATE/)
  assert.match(validUserClient.statements[1], /ORDER BY user_id::text, role_name\s+FOR SHARE/)

  const changedRoleClient = fakeUserLockClient([{ id: 'cleaner-1', role: 'finance' }], [])
  await assert.rejects(
    lockAndValidateTaskCenterAssignmentUsers(changedRoleClient, ['cleaner-1'], []),
    /task_assignee_invalid/,
  )
  const deletedMaintenanceUserClient = fakeUserLockClient([], [])
  await assert.rejects(
    lockAndValidateTaskCenterAssignmentUsers(deletedMaintenanceUserClient, [], ['maintenance-1']),
    /maintenance_assignee_not_found/,
  )

  await dbAdapter.pgPool?.end()
}

main()
  .then(() => process.stdout.write('test_property_followup_materialization: ok\n'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
