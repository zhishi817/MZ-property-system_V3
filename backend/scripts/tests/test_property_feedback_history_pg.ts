import assert from 'node:assert/strict'
import { Pool, PoolClient } from 'pg'
import { assertPropertyFeedbackExpenseReferenceUnchanged, enrichPropertyFeedbackLocks, lockPropertyFeedbackExpenseReferences, lockPropertyFeedbackMutationSource, propertyFeedbackMutationLocked } from '../../src/lib/propertyFeedbackPolicy'

// Deliberately no DATABASE_URL or .env support. Only a freshly created local
// Unix-socket cluster is accepted; every fixture lives in a generated schema.
const socket = String(process.env.MZ084_TEST_PG_SOCKET || '')
if (process.env.MZ084_TEST_PG_EPHEMERAL !== '1' || !/^\/tmp\/mz084-pg-[A-Za-z0-9_-]+\/socket$/.test(socket)) {
  throw new Error('Explicit MZ084_TEST_PG_EPHEMERAL=1 and /tmp/mz084-pg-*/socket required')
}
const schema = `mz084_${process.pid}_${Date.now()}`
const pool = new Pool({ host: socket, port: 55484, database: 'postgres', user: process.env.USER || 'zhishi', max: 4, connectionTimeoutMillis: 3000, options: `-c search_path=${schema} -c statement_timeout=8000` })
const kinds = ['maintenance', 'deep_cleaning', 'daily_necessities'] as const
async function row(client: PoolClient, kind: typeof kinds[number], id: string) {
  return (await client.query(`SELECT * FROM property_${kind} WHERE id=$1`, [id])).rows[0]
}
async function locked(client: PoolClient, kind: typeof kinds[number], id: string) {
  return propertyFeedbackMutationLocked(await enrichPropertyFeedbackLocks(client, kind, await row(client, kind, id)))
}
async function waitForLock(observer: PoolClient, pid: number) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const value = (await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]
    if (value?.wait_event_type === 'Lock') return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error('Concurrent helper did not wait on source row lock')
}
async function main() {
  const admin = await pool.connect()
  let first: PoolClient | undefined
  let second: PoolClient | undefined
  try {
    assert.equal((await admin.query('SHOW listen_addresses')).rows[0].listen_addresses, '', 'test server must have TCP disabled')
    assert.equal((await admin.query('SELECT inet_server_addr() AS address')).rows[0].address, null)
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.query(`CREATE TABLE work_tasks (id text PRIMARY KEY, source_type text, source_id text, assignee_id text, status text);
      CREATE TABLE maintenance_workflow_events (maintenance_domain text, record_id text, to_status text, event_type text);
      CREATE TABLE audit_logs (id text PRIMARY KEY, entity text, entity_id text, action text, actor_id text, before_json jsonb, after_json jsonb, created_at timestamptz);
      CREATE TABLE work_task_events (source_type text, source_ref_ids text[], payload jsonb);
      CREATE TABLE property_expenses (id text, ref_id text, ref_type text, generated_from text, amount numeric);
      CREATE TABLE company_expenses (id text, ref_id text, ref_type text, generated_from text, amount numeric);`)
    for (const kind of kinds) await admin.query(`CREATE TABLE property_${kind} (id text PRIMARY KEY, status text DEFAULT 'pending', assignee_id text, assigned_at timestamptz, completed_at timestamptz, deleted_at timestamptz, amount numeric, project_items jsonb DEFAULT '[]')`)
    let checks = 0
    let expenseAuditChecks = 0
    for (const kind of kinds) {
      const id = `${kind}-policy`
      await admin.query(`INSERT INTO property_${kind} (id) VALUES ($1)`, [id])
      assert.equal(await locked(admin, kind, id), false)
      for (const table of ['property_expenses', 'company_expenses']) {
        for (const ref of [kind, `property_${kind}`]) {
          await admin.query(`INSERT INTO ${table} (ref_id,ref_type) VALUES ($1,$2)`, [id, ref])
          assert.equal(await locked(admin, kind, id), true, `${kind} ${table} ${ref}`)
          await admin.query(`DELETE FROM ${table}`)
          checks++
        }
        await admin.query(`INSERT INTO ${table} (generated_from) VALUES ($1)`, [id])
        assert.equal(await locked(admin, kind, id), true)
        await admin.query(`DELETE FROM ${table}`)
        checks++
      }
      await admin.query('INSERT INTO work_task_events VALUES ($1,$2,$3)', ['work_tasks', [`property_${kind}:${id}`], { patch: { assignee_id: 'worker' } }])
      assert.equal(await locked(admin, kind, id), true, 'durable assignment event survives projection removal')
      await admin.query('DELETE FROM work_task_events')
      await admin.query('INSERT INTO audit_logs (id,entity,entity_id,before_json,after_json) VALUES ($1,$2,$3,$4,$5)', ['audit', kind === 'daily_necessities' ? 'DailyReplacement' : `property_${kind}`, id, {}, { status: 'completed' }])
      assert.equal(await locked(admin, kind, id), true)
      await admin.query('DELETE FROM audit_logs')
      // An unrelated receipt must not lock this record.
      await admin.query('INSERT INTO company_expenses (ref_id,ref_type) VALUES ($1,$2)', ['other-record', kind])
      assert.equal(await locked(admin, kind, id), false)
      await admin.query('DELETE FROM company_expenses')
      if (kind === 'maintenance') {
        await admin.query('INSERT INTO maintenance_workflow_events VALUES ($1,$2,$3,$4)', ['internal', id, 'assigned', 'assigned'])
        assert.equal(await locked(admin, kind, id), true)
        await admin.query('DELETE FROM maintenance_workflow_events')
      }
      // Removed/zero-value expenses still count through either audit image.
      for (const table of ['property_expenses', 'company_expenses']) {
        for (const side of ['before_json', 'after_json']) {
          for (const reference of [{ ref_type: kind, ref_id: id, amount: 0 }, { ref_type: `property_${kind}`, ref_id: id, amount: 0 }, { generated_from: id, amount: 0 }]) {
            await admin.query(`INSERT INTO audit_logs (id,entity,entity_id,${side}) VALUES ($1,$2,$3,$4)`, ['removed-expense', table, 'expense-id', reference])
            assert.equal(await locked(admin, kind, id), true, `${kind} removed zero expense ${table}/${side}`)
            await admin.query('DELETE FROM audit_logs')
            expenseAuditChecks++
          }
        }
      }
      // Preserve a lock receipt before correction clears the original evidence.
      await admin.query(`UPDATE property_${kind} SET amount=25 WHERE id=$1`, [id])
      await admin.query('BEGIN')
      assert.equal(await lockPropertyFeedbackMutationSource(admin, `property_${kind}`, id, 'manager'), true)
      await admin.query(`UPDATE property_${kind} SET amount=NULL WHERE id=$1`, [id])
      await admin.query('COMMIT')
      const receipt = (await admin.query('SELECT before_json FROM audit_logs WHERE entity_id=$1', [id])).rows
      assert.equal(receipt.length, 1)
      assert.equal(receipt[0].before_json.feedback_history_locked, true)
      assert.equal(await locked(admin, kind, id), true, 'clearing cost cannot enable later deletion')
      await lockPropertyFeedbackMutationSource(admin, `property_${kind}`, id, 'manager')
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM audit_logs WHERE entity_id=$1', [id])).rows[0].count, 1, 'receipt is not duplicated')
      await admin.query('DELETE FROM audit_logs')
    }
    first = await pool.connect()
    second = await pool.connect()
    const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    for (const kind of kinds) {
      const id = `${kind}-race`
      await admin.query(`INSERT INTO property_${kind} (id) VALUES ($1)`, [id])
      // Delete acquires source lock first: assignment must wait, then reject.
      await first.query('BEGIN')
      await first.query(`SELECT * FROM property_${kind} WHERE id=$1 FOR UPDATE`, [id])
      await first.query(`UPDATE property_${kind} SET deleted_at=now() WHERE id=$1`, [id])
      await second.query('BEGIN')
      const pending = lockPropertyFeedbackMutationSource(second, `property_${kind}`, id, 'assigner')
      await waitForLock(admin, secondPid)
      await first.query('COMMIT')
      assert.equal(await pending, false, `${kind}: helper must reject a concurrently deleted source`)
      await second.query('ROLLBACK')
      await admin.query(`UPDATE property_${kind} SET deleted_at=NULL WHERE id=$1`, [id])
      // Assignment locks source first: deletion cannot inspect stale evidence.
      await first.query('BEGIN')
      assert.equal(await lockPropertyFeedbackMutationSource(first, `property_${kind}`, id, 'assigner'), true)
      await first.query('INSERT INTO work_tasks VALUES ($1,$2,$3,$4,$5)', [`task-${kind}`, `property_${kind}`, id, 'worker', 'assigned'])
      await second.query('BEGIN')
      const deleting = second.query(`SELECT * FROM property_${kind} WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [id])
      await waitForLock(admin, secondPid)
      await first.query('COMMIT')
      const source = (await deleting).rows[0]
      assert.equal(propertyFeedbackMutationLocked(await enrichPropertyFeedbackLocks(second, kind, source)), true, `${kind}: delete sees committed assignment`)
      await second.query('ROLLBACK')
    }
    for (const kind of kinds) {
      const id = `${kind}-expense-race`
      const newId = `${kind}-relinked`
      await admin.query(`INSERT INTO property_${kind} (id) VALUES ($1),($2)`, [id, newId])
      // A concurrent source deletion wins before expense creation: the expense
      // helper waits, then throws, so callers cannot insert dangling references.
      await first.query('BEGIN')
      await first.query(`SELECT * FROM property_${kind} WHERE id=$1 FOR UPDATE`, [id])
      await first.query(`UPDATE property_${kind} SET deleted_at=now() WHERE id=$1`, [id])
      await second.query('BEGIN')
      const expensePending = lockPropertyFeedbackExpenseReferences(second, [{ ref_type: kind, ref_id: id }]).then(() => null, error => error)
      await waitForLock(admin, secondPid)
      await first.query('COMMIT')
      assert.equal((await expensePending)?.message, 'property_feedback_not_found')
      await second.query('ROLLBACK')
      await admin.query(`UPDATE property_${kind} SET deleted_at=NULL WHERE id=$1`, [id])
      // Expense creation wins first: deletion sees the committed zero expense.
      await first.query('BEGIN')
      await lockPropertyFeedbackExpenseReferences(first, [{ ref_type: `property_${kind}`, ref_id: id }])
      await first.query('INSERT INTO property_expenses (ref_type,ref_id,amount) VALUES ($1,$2,0)', [kind, id])
      await second.query('BEGIN')
      const deletionPending = second.query(`SELECT * FROM property_${kind} WHERE id=$1 FOR UPDATE`, [id])
      await waitForLock(admin, secondPid)
      await first.query('COMMIT')
      const source = (await deletionPending).rows[0]
      assert.equal(propertyFeedbackMutationLocked(await enrichPropertyFeedbackLocks(second, kind, source)), true)
      await second.query('ROLLBACK')
      // Relinking must lock both old and new source; the previous source keeps a
      // durable receipt even after its only expense is moved elsewhere.
      await admin.query('BEGIN')
      await lockPropertyFeedbackExpenseReferences(admin, [{ ref_type: kind, ref_id: id }, { ref_type: kind, ref_id: newId }])
      await admin.query('UPDATE property_expenses SET ref_id=$1 WHERE ref_id=$2', [newId, id])
      await admin.query('COMMIT')
      assert.equal(await locked(admin, kind, id), true, 'old reference stays locked after relink')
      assert.equal(await locked(admin, kind, newId), true, 'new reference has linked expense')
      await admin.query('BEGIN')
      await lockPropertyFeedbackExpenseReferences(admin, [{ ref_type: kind, ref_id: newId }, { ref_type: null, ref_id: null }])
      await admin.query('DELETE FROM property_expenses WHERE ref_id=$1', [newId])
      await admin.query('COMMIT')
      assert.equal(await locked(admin, kind, newId), true, 'reference clear/delete keeps lock receipt')
      const legacyId = `${kind}-generated`
      await admin.query(`INSERT INTO property_${kind} (id) VALUES ($1)`, [legacyId])
      await admin.query('INSERT INTO company_expenses (generated_from,amount) VALUES ($1,0)', [legacyId])
      await admin.query('BEGIN')
      await lockPropertyFeedbackExpenseReferences(admin, [{ generated_from: legacyId }])
      await admin.query('DELETE FROM company_expenses WHERE generated_from=$1', [legacyId])
      await admin.query('COMMIT')
      assert.equal(await locked(admin, kind, legacyId), true, 'legacy generated reference removal keeps receipt')
    }
    let staleChecks = 0
    for (const table of ['property_expenses', 'company_expenses'] as const) {
      for (const kind of kinds) {
        for (const operation of ['relink', 'delete', 'already_deleted']) {
          const expenseId = `stale-${table}-${kind}-${operation}`
          const a = `${expenseId}-a`
          const b = `${expenseId}-b`
          const c = `${expenseId}-c`
          await admin.query(`INSERT INTO property_${kind} (id) VALUES ($1),($2),($3)`, [a, b, c])
          await admin.query(`INSERT INTO ${table} (id,ref_id,ref_type,amount) VALUES ($1,$2,$3,0)`, [expenseId, a, kind])
          await first.query('BEGIN')
          const previous = (await first.query(`SELECT * FROM ${table} WHERE id=$1`, [expenseId])).rows[0]
          await lockPropertyFeedbackExpenseReferences(first, [previous, { ref_type: kind, ref_id: b }], [previous])
          await assertPropertyFeedbackExpenseReferenceUnchanged(first, table, expenseId, previous)
          if (operation === 'already_deleted') await first.query(`DELETE FROM ${table} WHERE id=$1`, [expenseId])
          else await first.query(`UPDATE ${table} SET ref_id=$1 WHERE id=$2`, [b, expenseId])
          // This SELECT observes A while the first transaction's B/delete is uncommitted.
          await second.query('BEGIN')
          const stale = (await second.query(`SELECT * FROM ${table} WHERE id=$1`, [expenseId])).rows[0]
          assert.equal(stale.ref_id, a)
          const proposed = operation === 'relink' ? { ...stale, ref_id: c } : null
          const waiting = lockPropertyFeedbackExpenseReferences(second, [stale, proposed], [stale])
          await waitForLock(admin, secondPid)
          await first.query('COMMIT')
          await waiting
          await assert.rejects(assertPropertyFeedbackExpenseReferenceUnchanged(second, table, expenseId, stale), /feedback_expense_reference_conflict/)
          await second.query('ROLLBACK')
          const committed = (await admin.query(`SELECT * FROM ${table} WHERE id=$1`, [expenseId])).rows[0]
          if (operation === 'already_deleted') assert.equal(committed, undefined)
          else {
            assert.equal(committed.ref_id, b, 'stale relink/delete must not overwrite the winning B reference')
            assert.equal(await locked(admin, kind, b), true, 'winning B source remains expense-locked')
          }
          assert.equal(await locked(admin, kind, a), true, 'first relink/delete retains A receipt')
          staleChecks++
        }
      }
    }
    // Existing orphan references can be corrected; the same missing reference
    // cannot be newly attached by omitting existingRows.
    for (const kind of kinds) {
      const orphan = { ref_type: kind, ref_id: `missing-${kind}` }
      await admin.query('BEGIN')
      await lockPropertyFeedbackExpenseReferences(admin, [orphan], [orphan])
      await admin.query('ROLLBACK')
      await admin.query('BEGIN')
      await assert.rejects(lockPropertyFeedbackExpenseReferences(admin, [orphan]), /property_feedback_not_found/)
      await admin.query('ROLLBACK')
    }
    console.log(`property feedback PostgreSQL: PASS (${checks} expense linkage cases; ${expenseAuditChecks} removed/zero expense audit cases; all 3 kinds relink/clear/generated receipts; 12 concurrent task/expense lock orderings; ${staleChecks} stale relink/delete races; 3 orphan correction/new-ref checks; TCP disabled; generated isolated schema)`)
  } finally {
    for (const client of [first, second]) if (client) { await client.query('ROLLBACK').catch(() => undefined); client.release() }
    await admin.query('ROLLBACK').catch(() => undefined)
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    admin.release()
    await pool.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
