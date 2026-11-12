import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { updatePasswordOnlyTaskSortOrder } from '../../src/services/passwordOnlyTaskReorder'

async function run() {
  const mzapp = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
  const mixedReorder = mzapp.slice(
    mzapp.indexOf("router.post('/work-tasks/mixed-reorder'"),
    mzapp.indexOf('const workTaskPhotosSchema'),
  )

  assert.match(mzapp, /kind: z\.enum\(\['work', 'cleaner', 'inspector', 'executor'\]\)/)
  assert.match(mixedReorder, /const executorEntries = entriesForKind\('executor'\)/)
  assert.match(
    mixedReorder,
    /client\.query\('BEGIN'\)[\s\S]*?updatePasswordOnlyTaskSortOrder\(\{[\s\S]*?client,[\s\S]*?entries: executorEntries,[\s\S]*?date,[\s\S]*?userId,[\s\S]*?client\.query\('COMMIT'\)/,
    'password-only ordering must execute inside the existing mixed-reorder transaction',
  )
  assert.match(
    mixedReorder,
    /catch \(e\) \{[\s\S]*?client\.query\('ROLLBACK'\)[\s\S]*?throw e/,
    'any failed mixed item must roll the full batch back',
  )
  assert.match(
    mixedReorder,
    /inspection_scope \|\| 'inspect_and_hang'[\s\S]*?!== 'password_only'/,
    'MZ-092 deferred inspection takeover must continue to exclude password-only work',
  )
  assert.match(mzapp, /const executorTerminal = \[[\s\S]*?'done', 'completed'[\s\S]*?\]\.includes\(raw_status\)/, 'terminal password-only sources must not remain in the active executor projection')
  assert.match(mzapp, /__executor_reorderable: !!effectiveExecutorId && String\(row\.assignee_id \|\| ''\)\.trim\(\) === effectiveExecutorId/, 'unassigned, legacy inspector fallback and manual action grants must stay visible without receiving reorder ownership')
  assert.match(mzapp, /executor_reorderable: roleKind === 'executor'[\s\S]*?!isWorkRecordGroup[\s\S]*?__executor_reorderable === true/, 'the public projection must expose an explicit source-assignee reorder capability')

  const queries: Array<{ sql: string; params: any[] }> = []
  const client = {
    async query(sql: string, params: any[] = []) {
      queries.push({ sql, params })
      return { rowCount: 2 }
    },
  }
  const entries = [
    { id: 'password-a', sort_index: 1 },
    { id: 'password-b', sort_index: 3 },
  ]
  await updatePasswordOnlyTaskSortOrder({ client, entries, date: '2026-11-01', userId: 'executor-1' })
  assert.strictEqual(queries.length, 1)
  assert.deepStrictEqual(queries[0].params, [JSON.stringify(entries), '2026-11-01', 'executor-1'])
  assert.match(queries[0].sql, /SET sort_index_inspector = v\.sort_index/)
  assert.match(queries[0].sql, /COALESCE\(t\.task_date, t\.date\)::date = \$2::date/)
  assert.match(queries[0].sql, /NOT IN \('done', 'completed', 'ready', 'inspected', 'keys_hung', 'pending_review', 'review_pending', 'awaiting_review', 'closed', 'replaced', 'cancelled', 'canceled'\)/)
  assert.match(queries[0].sql, /COALESCE\([\s\S]*?t\.execution_state,[\s\S]*?\) = 'active'/, 'superseded or cancelled source rows must fail closed even if their legacy status remains active-looking')
  assert.match(queries[0].sql, /COALESCE\(t\.task_type, t\.type, ''\)\) = 'checkin_clean'/)
  assert.match(queries[0].sql, /COALESCE\(t\.inspection_scope, 'inspect_and_hang'\)\) = 'password_only'/)
  assert.match(queries[0].sql, /t\.assignee_id::text = \$3::text/)

  const duplicateQueries: Array<{ params: any[] }> = []
  await updatePasswordOnlyTaskSortOrder({
    client: {
      async query(_sql: string, params: any[] = []) {
        duplicateQueries.push({ params })
        return { rowCount: 1 }
      },
    },
    entries: [
      { id: 'password-a', sort_index: 1 },
      { id: 'password-a', sort_index: 4 },
    ],
    date: '2026-11-01',
    userId: 'executor-1',
  })
  assert.deepStrictEqual(JSON.parse(duplicateQueries[0].params[0]), [{ id: 'password-a', sort_index: 4 }], 'a repeated source id must produce one deterministic update')

  let repeatCalls = 0
  const repeatClient = {
    async query() {
      repeatCalls += 1
      await Promise.resolve()
      return { rowCount: 1 }
    },
  }
  const repeated = { client: repeatClient, entries: [{ id: 'password-a', sort_index: 2 }], date: '2026-11-01', userId: 'executor-1' }
  await Promise.all([
    updatePasswordOnlyTaskSortOrder(repeated),
    updatePasswordOnlyTaskSortOrder(repeated),
  ])
  assert.strictEqual(repeatCalls, 2, 'concurrent retries stay idempotent and do not share request-local state')

  await assert.rejects(
    updatePasswordOnlyTaskSortOrder({
      client: { async query() { return { rowCount: 0 } } },
      entries: [{ id: 'password-other-user', sort_index: 1 }],
      date: '2026-11-01',
      userId: 'executor-1',
    }),
    (error: any) => error?.statusCode === 403 && error?.message === 'forbidden',
    'another assignee, a cross-day row, or a concurrently terminal row must fail the guarded write',
  )
}

run().then(() => {
  console.log('password-only task reorder tests passed')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
