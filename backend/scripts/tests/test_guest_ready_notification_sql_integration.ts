import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'

const connectionString = String(process.env.MZ010_TEST_DATABASE_URL || '').trim()
const schema = `mz010_${process.pid}_${Date.now()}`
const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`

async function currentRequirementVersion(client: Client, taskId: string) {
  const result = await client.query(
    `SELECT guest_ready_checkin_requirement_version AS version FROM cleaning_tasks WHERE id=$1`,
    [taskId],
  )
  assert.equal(result.rowCount, 1, 'the synthetic check-in task must exist')
  return Number(result.rows[0]?.version)
}

function assertSafeLocalTarget(target = connectionString) {
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    throw new Error('MZ010 SQL test refuses NODE_ENV=production')
  }
  if (!target) throw new Error('MZ010_TEST_DATABASE_URL is required')
  const url = new URL(target)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('MZ010 SQL test requires PostgreSQL')
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase())) {
    throw new Error('MZ010 SQL test accepts localhost only')
  }
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase() !== 'sslmode') {
      throw new Error(`MZ010 SQL test rejects connection query parameter: ${key}`)
    }
  }
  const sslModes = url.searchParams.getAll('sslmode')
  if (sslModes.length > 1 || (sslModes[0] && sslModes[0].toLowerCase() !== 'disable')) {
    throw new Error('MZ010 SQL test accepts only sslmode=disable')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!/^mz010_test_[a-z0-9_]+$/i.test(database)) {
    throw new Error('MZ010 SQL test database name must start with mz010_test_')
  }
  if (process.env.MZ010_TEST_DATABASE_WRITE !== 'yes') {
    throw new Error('MZ010_TEST_DATABASE_WRITE=yes is required')
  }
}

async function main() {
  assertSafeLocalTarget()
  for (const key of ['host', 'hostaddr', 'service', 'port', 'user', 'password', 'options', 'database', 'dbname']) {
    assert.throws(
      () => assertSafeLocalTarget(`postgresql://127.0.0.1/mz010_test_guard?${key}=shared.invalid`),
      /rejects connection query parameter/,
      `${key} must not be able to redirect or redefine the guarded local target`,
    )
  }
  process.env.DATABASE_URL = ''
  process.env.DATABASE_DIRECT_URL = ''
  const client = new Client({ connectionString, ssl: false })
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}, pg_catalog`)
    await client.query(`
      CREATE TABLE schema_migrations(version text PRIMARY KEY);
      CREATE TABLE users(id text PRIMARY KEY, display_name text, username text, email text);
      CREATE TABLE cleaning_tasks(
        id text PRIMARY KEY,
        order_id text,
        task_type text,
        type text,
        task_date date,
        date date,
        checkin_time text,
        status text,
        execution_state text,
        property_id text,
        assignee_id text,
        cleaner_id text,
        inspector_id text,
        guest_ready_checkin_requirement_version bigint NOT NULL DEFAULT 0
      );
      CREATE TABLE cleaning_task_media(
        id text PRIMARY KEY,
        task_id text NOT NULL,
        type text NOT NULL,
        url text,
        captured_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        uploader_id text
      );
      CREATE TABLE work_task_action_audits(
        id text PRIMARY KEY,
        source_type text NOT NULL,
        source_id text NOT NULL,
        performed_by_user_id text,
        performed_as_action text NOT NULL,
        performed_at timestamptz NOT NULL,
        actor_user_id text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE work_task_events(
        id text PRIMARY KEY,
        task_id text NOT NULL,
        sequence_no bigint NOT NULL UNIQUE,
        occurred_at timestamptz NOT NULL,
        caused_by_user_id text,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb
      );
    `)

    const migrationPath = path.resolve(__dirname, '../migrations/20261101_manual_task_guest_ready_notification.sql')
    const migration = fs.readFileSync(migrationPath, 'utf8')
      .replaceAll('public.schema_migrations', `${schema}.schema_migrations`)
      .replaceAll('public.cleaning_tasks', `${schema}.cleaning_tasks`)
    await client.query(migration)
    await client.query(migration)

    const taskId = `manual-checkin-${randomUUID()}`
    await client.query(
      `INSERT INTO users(id, display_name) VALUES ('cs-1', 'Synthetic Support'), ('executor-1', 'Synthetic Executor')`,
    )
    await client.query(
      `INSERT INTO cleaning_tasks(
         id, task_type, task_date, status, execution_state, property_id, assignee_id,
         guest_ready_checkin_requirement_version
       ) VALUES ($1, 'checkin_clean', '2026-11-01', 'keys_hung', 'active', 'property-1', 'executor-1', 0)`,
      [taskId],
    )
    await client.query(
      `INSERT INTO cleaning_task_media(id, task_id, type, url, captured_at, uploader_id)
       VALUES ($1, $2, 'lockbox_video', 'synthetic://lockbox', '2026-11-01T01:00:00Z', 'executor-1')`,
      [randomUUID(), taskId],
    )
    await client.query(
      `INSERT INTO work_task_action_audits(
         id, source_type, source_id, performed_by_user_id, performed_as_action, performed_at, actor_user_id, metadata
       ) VALUES ($1, 'cleaning_tasks', $2, 'executor-1', 'upload_access_video', '2026-11-01T01:00:00Z', 'executor-1', $3::jsonb)`,
      [randomUUID(), taskId, JSON.stringify({
        task_snapshot: { scheduled_service_date: '2026-11-01' },
        property_snapshot: { property_id: 'property-1' },
      })],
    )

    const {
      loadGuestReadyNotificationTaskStates,
      lockGuestReadyTaskNotificationContext,
    } = await import('../../src/lib/guestReadyNotification')
    let state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.key_handover_complete, true, 'exact legacy generation-zero evidence remains usable')

    await client.query(
      `UPDATE work_task_action_audits
          SET metadata = metadata || '{"guest_ready_requirement_version":null}'::jsonb
        WHERE source_id=$1`,
      [taskId],
    )
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.key_handover_complete, false, 'an explicit null generation is malformed, not an absent legacy key')
    await client.query(
      `UPDATE work_task_action_audits SET metadata = metadata - 'guest_ready_requirement_version' WHERE source_id=$1`,
      [taskId],
    )

    await client.query(
      `UPDATE cleaning_tasks SET guest_ready_checkin_requirement_version=1, task_date='2026-11-02' WHERE id=$1`,
      [taskId],
    )
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.key_handover_complete, false, 'legacy evidence cannot cross a changed task generation')

    await client.query(
      `UPDATE work_task_action_audits
          SET metadata = metadata || jsonb_build_object('guest_ready_requirement_version', repeat('9', 200))
        WHERE source_id=$1`,
      [taskId],
    )
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.key_handover_complete, false, 'oversized generation metadata is rejected without a bigint cast failure')

    await client.query(
      `UPDATE cleaning_tasks SET task_date='2026-11-01' WHERE id=$1`,
      [taskId],
    )
    const currentGeneration = await currentRequirementVersion(client, taskId)
    await client.query(
      `UPDATE work_task_action_audits
          SET performed_at='2026-11-01T02:00:00Z',
              metadata = metadata || jsonb_build_object('guest_ready_requirement_version', $2::bigint)
        WHERE source_id=$1`,
      [taskId, currentGeneration],
    )
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.key_handover_complete, true, 'current-generation evidence remains usable')
    let lockedContext = await lockGuestReadyTaskNotificationContext(client, taskId)
    assert.equal(lockedContext?.key_handover_complete, true, 'the mutation helper exposes exact current-performer video evidence')
    const laterFormerAuditId = randomUUID()
    await client.query(
      `INSERT INTO work_task_action_audits(
         id, source_type, source_id, performed_by_user_id, performed_as_action, performed_at, actor_user_id, metadata
       ) VALUES ($1, 'cleaning_tasks', $2, 'former-executor', 'upload_access_video', '2026-11-01T02:30:00Z', 'former-executor', $3::jsonb)`,
      [laterFormerAuditId, taskId, JSON.stringify({ guest_ready_requirement_version: currentGeneration })],
    )
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.key_handover_complete, false, 'list projection uses the latest qualifying audit actor, not any older current-performer audit')
    lockedContext = await lockGuestReadyTaskNotificationContext(client, taskId)
    assert.equal(lockedContext?.key_handover_complete, false, 'locked mutation and list projection agree for multiple qualifying audits')
    await client.query(`DELETE FROM work_task_action_audits WHERE id=$1`, [laterFormerAuditId])
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.key_handover_complete, true, 'removing the newer stale-actor fixture restores the current-performer audit')
    await client.query(
      `UPDATE work_task_action_audits
          SET performed_by_user_id='former-executor', actor_user_id='former-executor'
        WHERE source_id=$1`,
      [taskId],
    )
    lockedContext = await lockGuestReadyTaskNotificationContext(client, taskId)
    assert.equal(lockedContext?.key_handover_complete, false, 'the mutation helper rejects a video from a replaced performer')
    await client.query(
      `UPDATE work_task_action_audits
          SET performed_by_user_id='executor-1', actor_user_id='executor-1'
        WHERE source_id=$1`,
      [taskId],
    )

    await client.query(
      `INSERT INTO cleaning_task_guest_ready_notifications(
         task_id, notified_at, notified_by_user_id, notified_requirement_version, version,
         last_action, last_action_at, last_actor_user_id
       ) VALUES ($1, now(), 'cs-1', 0, 1, 'mark', now(), 'cs-1')`,
      [taskId],
    )
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.notification_binding_current, false, 'an old task marker stays historical after a generation change')
    await client.query(
      `UPDATE cleaning_task_guest_ready_notifications SET notified_requirement_version=$2 WHERE task_id=$1`,
      [taskId, currentGeneration],
    )
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.notification_binding_current, true)

    await assert.rejects(
      client.query(
        `UPDATE cleaning_task_guest_ready_notifications
            SET notified_requirement_version=NULL
          WHERE task_id=$1`,
        [taskId],
      ),
      /cleaning_task_guest_ready_notification_binding_check/,
    )

    const eventValues = [randomUUID(), taskId, 'operation-0001']
    await client.query(
      `INSERT INTO cleaning_task_guest_ready_notification_events(
         id, task_id, task_id_snapshot, action, changed, actor_user_id, operation_id,
         expected_version, resulting_version, property_id, task_date
       ) VALUES ($1, $2, $2, 'revoke', false, 'cs-1', $3, 1, 1, 'property-1', '2026-11-01')`,
      eventValues,
    )
    await assert.rejects(
      client.query(
        `INSERT INTO cleaning_task_guest_ready_notification_events(
           id, task_id, task_id_snapshot, action, changed, actor_user_id, operation_id,
           expected_version, resulting_version, property_id, task_date
         ) VALUES ($1, $2, $2, 'revoke', false, 'cs-1', $3, 1, 1, 'property-1', '2026-11-01')`,
        [randomUUID(), taskId, 'operation-0001'],
      ),
      /uniq_cleaning_task_guest_ready_notification_operation/,
    )

    await client.query('BEGIN')
    await client.query(
      `UPDATE cleaning_task_guest_ready_notifications SET notified_at=NULL, notified_by_user_id=NULL,
         notified_requirement_version=NULL, version=version+1, last_action='revoke' WHERE task_id=$1`,
      [taskId],
    )
    await client.query('ROLLBACK')
    const rolledBack = await client.query(
      `SELECT notified_at, version FROM cleaning_task_guest_ready_notifications WHERE task_id=$1`,
      [taskId],
    )
    assert.ok(rolledBack.rows[0]?.notified_at)
    assert.equal(Number(rolledBack.rows[0]?.version), 1, 'transaction rollback preserves the prior state')

    await client.query(`DELETE FROM cleaning_task_media WHERE task_id=$1`, [taskId])
    await client.query(`DELETE FROM work_task_action_audits WHERE source_id=$1`, [taskId])
    await client.query(
      `INSERT INTO work_task_events(id, task_id, sequence_no, occurred_at, caused_by_user_id, payload)
       VALUES ($1, 'cleaning_task:' || $2, 1, '2026-11-01T03:00:00Z', 'manager-1', $3::jsonb)`,
      [randomUUID(), taskId, JSON.stringify({
        arrangement_revision: {
          reasons: ['keys_hung_confirmed'],
          guest_ready_requirement_version: currentGeneration,
          after: {
            scheduled_service_date: '2026-11-01',
            property_id: 'property-1',
            cleaner_id: null,
            assignee_id: 'executor-1',
            inspector_id: null,
          },
        },
      })],
    )
    await client.query('BEGIN')
    const initiallyLocked = await lockGuestReadyTaskNotificationContext(client, taskId)
    assert.equal(initiallyLocked?.has_current_manual_key_handover, true)
    assert.equal(initiallyLocked?.key_handover_complete, true, 'the mutation helper exposes exact current-generation manager confirmation')
    await client.query(`UPDATE cleaning_tasks SET status='assigned' WHERE id=$1`, [taskId])
    await client.query(
      `INSERT INTO work_task_events(id, task_id, sequence_no, occurred_at, caused_by_user_id, payload)
       VALUES ($1, 'cleaning_task:' || $2, 2, '2026-11-01T04:00:00Z', 'manager-1', $3::jsonb)`,
      [randomUUID(), taskId, JSON.stringify({
        arrangement_revision: {
          reasons: ['keys_hung_reopened'],
          guest_ready_requirement_version: currentGeneration,
          after: {
            scheduled_service_date: '2026-11-01',
            property_id: 'property-1',
            cleaner_id: null,
            assignee_id: 'executor-1',
            inspector_id: null,
          },
        },
      })],
    )
    const waiter = new Client({ connectionString, ssl: false })
    await waiter.connect()
    try {
      await waiter.query(`SET search_path TO ${quoteIdentifier(schema)}, pg_catalog`)
      await waiter.query('BEGIN')
      const waitState = { value: 'pending' }
      const waitingContext = lockGuestReadyTaskNotificationContext(waiter, taskId).then((value) => {
        waitState.value = 'resolved'
        return value
      })
      await new Promise((resolve) => setTimeout(resolve, 75))
      assert.equal(waitState.value, 'pending', 'the mark-side context must wait for the task row lock')
      await client.query('COMMIT')
      const afterReopen = await waitingContext
      assert.equal(afterReopen?.has_current_manual_key_handover, false, 'a fresh post-lock snapshot must observe the committed reopen event')
      assert.equal(afterReopen?.key_handover_complete, false, 'a committed reopen revokes the helper-level handover result')
      await waiter.query('ROLLBACK')
    } finally {
      await waiter.query('ROLLBACK').catch(() => undefined)
      await waiter.end()
    }

    const replayA = new Client({ connectionString, ssl: false })
    const replayB = new Client({ connectionString, ssl: false })
    await replayA.connect()
    await replayB.connect()
    try {
      await replayA.query(`SET search_path TO ${quoteIdentifier(schema)}, pg_catalog`)
      await replayB.query(`SET search_path TO ${quoteIdentifier(schema)}, pg_catalog`)
      await replayA.query('BEGIN')
      await replayB.query('BEGIN')
      await replayA.query(`SELECT id FROM cleaning_tasks WHERE id=$1 FOR UPDATE`, [taskId])
      const replayWaitState = { value: 'pending' }
      const secondReplayLock = replayB.query(
        `SELECT id FROM cleaning_tasks WHERE id=$1 FOR UPDATE`,
        [taskId],
      ).then((value) => {
        replayWaitState.value = 'resolved'
        return value
      })
      await new Promise((resolve) => setTimeout(resolve, 75))
      assert.equal(replayWaitState.value, 'pending', 'the second existing-receipt replay waits before taking the exclusive task lock')
      const firstReplayContext = await lockGuestReadyTaskNotificationContext(replayA, taskId)
      assert.equal(firstReplayContext?.task_id, taskId, 'the first replay may safely re-enter the helper after its initial exclusive lock')
      await replayA.query('COMMIT')
      await secondReplayLock
      const secondReplayContext = await lockGuestReadyTaskNotificationContext(replayB, taskId)
      assert.equal(secondReplayContext?.task_id, taskId, 'the second replay proceeds after serialization without a SHARE-to-UPDATE deadlock')
      await replayB.query('ROLLBACK')
    } finally {
      await replayA.query('ROLLBACK').catch(() => undefined)
      await replayB.query('ROLLBACK').catch(() => undefined)
      await replayA.end()
      await replayB.end()
    }

    await client.query(
      `INSERT INTO cleaning_task_media(id, task_id, type, url, captured_at, uploader_id)
       VALUES ($1, $2, 'lockbox_video', 'synthetic://pre-assignment-boundary', '2026-11-01T04:30:00Z', 'executor-1')`,
      [randomUUID(), taskId],
    )
    await client.query(
      `INSERT INTO work_task_action_audits(
         id, source_type, source_id, performed_by_user_id, performed_as_action, performed_at, actor_user_id, metadata
       ) VALUES ($1, 'cleaning_tasks', $2, 'executor-1', 'upload_access_video', '2026-11-01T04:30:00Z', 'executor-1', $3::jsonb)`,
      [randomUUID(), taskId, JSON.stringify({ guest_ready_requirement_version: currentGeneration })],
    )
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.key_handover_complete, true, 'current-generation evidence is valid before a historical assignment boundary')
    assert.equal(state?.notification_binding_current, true, 'the marker is current before assignment qualification changes')
    lockedContext = await lockGuestReadyTaskNotificationContext(client, taskId)
    assert.equal(lockedContext?.key_handover_complete, true, 'the locked helper agrees before the assignment boundary')

    await client.query(
      `INSERT INTO work_task_events(id, task_id, sequence_no, occurred_at, caused_by_user_id, payload)
       VALUES ($1, 'cleaning_task:' || $2, 10, '2026-11-01T05:00:00Z', 'manager-1', $3::jsonb)`,
      [randomUUID(), taskId, JSON.stringify({
        arrangement_revision: { reasons: ['assignment_changed'] },
      })],
    )
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.key_handover_complete, false, 'pre-boundary evidence cannot survive an audited historical assignment change')
    lockedContext = await lockGuestReadyTaskNotificationContext(client, taskId)
    assert.equal(lockedContext?.key_handover_complete, false, 'the locked helper applies the same latest-assignment boundary')

    await client.query(
      `INSERT INTO work_task_events(id, task_id, sequence_no, occurred_at, caused_by_user_id, payload)
       VALUES ($1, 'cleaning_task:' || $2, 9, '2026-11-01T05:00:00Z', 'manager-1', $3::jsonb)`,
      [randomUUID(), taskId, JSON.stringify({
        arrangement_revision: {
          reasons: ['keys_hung_confirmed'],
          guest_ready_requirement_version: currentGeneration,
          after: {
            scheduled_service_date: '2026-11-01',
            property_id: 'property-1',
            cleaner_id: null,
            assignee_id: 'executor-1',
            inspector_id: null,
          },
        },
      })],
    )
    lockedContext = await lockGuestReadyTaskNotificationContext(client, taskId)
    assert.equal(lockedContext?.has_current_manual_key_handover, false, 'an earlier same-time confirmation is before the assignment event tuple')

    await client.query(`UPDATE cleaning_tasks SET assignee_id='executor-2' WHERE id=$1`, [taskId])
    const combinedGeneration = await currentRequirementVersion(client, taskId)
    assert.equal(combinedGeneration, currentGeneration + 1, 'the combined assignment advances the database generation before its event is appended')
    await client.query(
      `INSERT INTO work_task_events(id, task_id, sequence_no, occurred_at, caused_by_user_id, payload)
       VALUES ($1, 'cleaning_task:' || $2, 11, '2026-11-01T05:00:00Z', 'manager-1', $3::jsonb)`,
      [randomUUID(), taskId, JSON.stringify({
        arrangement_revision: {
          reasons: ['assignment_changed', 'keys_hung_confirmed'],
          guest_ready_requirement_version: combinedGeneration,
          after: {
            scheduled_service_date: '2026-11-01',
            property_id: 'property-1',
            cleaner_id: null,
            assignee_id: 'executor-2',
            inspector_id: null,
          },
        },
      })],
    )
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.key_handover_complete, true, 'a combined assignment and keys-hung event remains valid in list projections')
    lockedContext = await lockGuestReadyTaskNotificationContext(client, taskId)
    assert.equal(lockedContext?.has_current_manual_key_handover, true, 'a combined assignment and keys-hung event remains valid in locked mutations')

    await client.query(
      `INSERT INTO work_task_action_audits(
         id, source_type, source_id, performed_by_user_id, performed_as_action, performed_at, actor_user_id, metadata
       ) VALUES ($1, 'cleaning_tasks', $2, 'executor-2', 'upload_access_video', '2026-11-01T06:00:00Z', 'executor-2', $3::jsonb)`,
      [randomUUID(), taskId, JSON.stringify({ guest_ready_requirement_version: combinedGeneration })],
    )
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.key_handover_complete, true, 'fresh current-performer evidence after the assignment boundary remains valid')
    assert.equal(state?.notification_binding_current, false, 'the assignment generation invalidates the old task marker')
    lockedContext = await lockGuestReadyTaskNotificationContext(client, taskId)
    assert.equal(lockedContext?.key_handover_complete, true, 'the locked helper accepts fresh post-assignment evidence')

    await client.query(
      `UPDATE cleaning_task_guest_ready_notifications
          SET notified_at=clock_timestamp(), notified_requirement_version=$2
        WHERE task_id=$1`,
      [taskId, combinedGeneration],
    )
    state = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(state?.notification_binding_current, true, 'a fresh marker can bind to the post-assignment generation')

    const beforeAbaVersion = await currentRequirementVersion(client, taskId)
    await client.query(`UPDATE cleaning_tasks SET assignee_id='executor-3' WHERE id=$1`, [taskId])
    await client.query(`UPDATE cleaning_tasks SET assignee_id='executor-2' WHERE id=$1`, [taskId])
    const afterAbaVersion = await currentRequirementVersion(client, taskId)
    assert.equal(afterAbaVersion, beforeAbaVersion + 2, 'A -> B -> A assignment changes advance the monotonic qualification generation twice')
    const abaState = (await loadGuestReadyNotificationTaskStates(client, [taskId])).get(taskId)
    assert.equal(abaState?.key_handover_complete, false, 'old handover evidence cannot revive when a prior performer is assigned again')
    assert.equal(abaState?.notification_binding_current, false, 'an old task notification marker cannot revive after assignment ABA')
    const abaContext = await lockGuestReadyTaskNotificationContext(client, taskId)
    assert.equal(abaContext?.key_handover_complete, false, 'the mutation helper rejects pre-ABA evidence after the performer returns')

    const readyTaskId = `ready-row-${randomUUID()}`
    await client.query(
      `INSERT INTO cleaning_tasks(id, task_type, task_date, status, execution_state, property_id)
       VALUES ($1, 'checkout_clean', '2026-11-01', 'ready', 'active', 'property-1')`,
      [readyTaskId],
    )
    const readyWaiter = new Client({ connectionString, ssl: false })
    await readyWaiter.connect()
    try {
      await readyWaiter.query(`SET search_path TO ${quoteIdentifier(schema)}, pg_catalog`)
      await client.query('BEGIN')
      await client.query(
        `SELECT ready_task.id FROM cleaning_tasks ready_task WHERE ready_task.id=$1 FOR SHARE OF ready_task`,
        [readyTaskId],
      )
      await readyWaiter.query('BEGIN')
      const readyWaitState = { value: 'pending' }
      const readyUpdate = readyWaiter.query(
        `UPDATE cleaning_tasks SET status='assigned' WHERE id=$1`,
        [readyTaskId],
      ).then((value) => {
        readyWaitState.value = 'resolved'
        return value
      })
      await new Promise((resolve) => setTimeout(resolve, 75))
      assert.equal(readyWaitState.value, 'pending', 'the selected ready row remains stable while an order notification transaction is open')
      await client.query('COMMIT')
      await readyUpdate
      await readyWaiter.query('ROLLBACK')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      await readyWaiter.query('ROLLBACK').catch(() => undefined)
      await readyWaiter.end()
    }
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
    await client.end()
  }
  console.log('guest-ready task notification SQL integration: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
