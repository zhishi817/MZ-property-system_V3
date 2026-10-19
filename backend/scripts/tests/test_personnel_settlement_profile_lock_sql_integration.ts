import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import {
  lockPersonnelSettlementUserScope,
  lockPersonnelSettlementUserScopeForSettlement,
  lockPersonnelSettlementUserSessionScope,
  requirePersonnelSettlementSessionAffineDatabaseUrl,
  unlockPersonnelSettlementUserSessionScope,
} from '../../src/lib/personnelSettlementUserLock'

export function personnelSettlementTestDatabaseIdentityFingerprint(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('MZ_PROFILE_LOCK_TEST_DATABASE_URL_invalid')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol.toLowerCase())) {
    throw new Error('MZ_PROFILE_LOCK_TEST_DATABASE_URL_invalid')
  }
  let databasePath: string
  try {
    databasePath = decodeURIComponent(url.pathname)
  } catch {
    throw new Error('MZ_PROFILE_LOCK_TEST_DATABASE_URL_invalid')
  }
  const rawHostname = url.hostname.toLowerCase()
  const normalizedHostname = rawHostname.replace(/-pooler(?=\.)/i, '')
  const normalizedPort = rawHostname !== normalizedHostname || url.port === '6543'
    ? '5432'
    : (url.port || '5432')
  const identity = `postgresql://${normalizedHostname}:${normalizedPort}${databasePath}`
  return createHash('sha256').update(identity).digest('hex')
}

export function assertSafeEphemeralTarget(env: Record<string, string | undefined> = process.env) {
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    throw new Error('MZ_PROFILE_LOCK_TEST_refuses_NODE_ENV_production')
  }
  const connectionString = String(env.MZ_PROFILE_LOCK_TEST_DATABASE_URL || '').trim()
  if (!connectionString) throw new Error('MZ_PROFILE_LOCK_TEST_DATABASE_URL_required')
  requirePersonnelSettlementSessionAffineDatabaseUrl({
    DATABASE_DIRECT_URL: connectionString,
    DATABASE_URL: connectionString,
    PERSONNEL_SETTLEMENT_DIRECT_SESSION_AFFINITY_CONFIRMED: '1',
  })
  const url = new URL(connectionString)
  const database = url.pathname.replace(/^\//, '')
  if (!/(test|staging|dev|local|ephemeral)/i.test(database)) {
    throw new Error('MZ_PROFILE_LOCK_TEST_DATABASE_URL_must_name_non_production_database')
  }
  if (env.MZ_PROFILE_LOCK_TEST_WRITE !== '1') throw new Error('MZ_PROFILE_LOCK_TEST_WRITE=1_required')
  if (env.MZ_PROFILE_LOCK_TEST_CONFIRM_EPHEMERAL !== '1') {
    throw new Error('MZ_PROFILE_LOCK_TEST_CONFIRM_EPHEMERAL=1_required')
  }
  const activeFingerprint = personnelSettlementTestDatabaseIdentityFingerprint(connectionString)
  const enrolledFingerprint = String(env.MZ_PROFILE_LOCK_TEST_DATABASE_FINGERPRINT || '').trim().toLowerCase()
  const productionFingerprint = String(env.MZ_PROFILE_LOCK_TEST_PRODUCTION_DATABASE_FINGERPRINT || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(enrolledFingerprint) || enrolledFingerprint !== activeFingerprint) {
    throw new Error('MZ_PROFILE_LOCK_TEST_DATABASE_FINGERPRINT_must_match_target')
  }
  if (!/^[a-f0-9]{64}$/.test(productionFingerprint)) {
    throw new Error('MZ_PROFILE_LOCK_TEST_PRODUCTION_DATABASE_FINGERPRINT_required')
  }
  if (activeFingerprint === productionFingerprint) {
    throw new Error('MZ_PROFILE_LOCK_TEST_refuses_production_database_identity')
  }
  return { connectionString, activeFingerprint }
}

const schema = `mz_profile_lock_${process.pid}_${Date.now()}`
const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`
const userId = `synthetic-user-${randomUUID()}`
const settlementId = `synthetic-settlement-${randomUUID()}`

async function begin(client: PoolClient) {
  await client.query('BEGIN')
  await client.query(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_catalog`)
  await client.query("SET LOCAL lock_timeout='5s'")
  await client.query("SET LOCAL statement_timeout='15s'")
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function assertStillWaiting(state: { value: string }, label: string) {
  await delay(100)
  assert.equal(state.value, 'pending', `${label} must wait on the shared user advisory lock`)
}

async function resetFixture(pool: Pool) {
  await pool.query(
    `UPDATE ${quoteIdentifier(schema)}.personnel_profiles SET value='old', revision=0 WHERE user_id=$1`,
    [userId],
  )
  await pool.query(
    `UPDATE ${quoteIdentifier(schema)}.personnel_weekly_settlements SET status='confirmed' WHERE id=$1`,
    [settlementId],
  )
}

async function profileFirstInterleaving(pool: Pool) {
  await resetFixture(pool)
  const profileClient = await pool.connect()
  const approvalClient = await pool.connect()
  try {
    await begin(profileClient)
    await lockPersonnelSettlementUserScope(profileClient, userId)
    await profileClient.query('UPDATE personnel_profiles SET value=\'new\', revision=revision+1 WHERE user_id=$1', [userId])

    await begin(approvalClient)
    const state = { value: 'pending' }
    const lockPromise = lockPersonnelSettlementUserScopeForSettlement(approvalClient, settlementId).then(
      () => { state.value = 'resolved' },
      (error) => { state.value = 'rejected'; throw error },
    )
    await assertStillWaiting(state, 'finance approval behind profile save')
    await profileClient.query('COMMIT')
    await lockPromise

    const liveProfile = await approvalClient.query('SELECT value FROM personnel_profiles WHERE user_id=$1', [userId])
    assert.equal(liveProfile.rows[0]?.value, 'new', 'approval must re-read the committed profile after waiting')
    const originalSnapshot = 'old'
    if (liveProfile.rows[0]?.value === originalSnapshot) {
      await approvalClient.query("UPDATE personnel_weekly_settlements SET status='finance_approved' WHERE id=$1", [settlementId])
    }
    await approvalClient.query('COMMIT')
    const status = await pool.query(
      `SELECT status FROM ${quoteIdentifier(schema)}.personnel_weekly_settlements WHERE id=$1`,
      [settlementId],
    )
    assert.equal(status.rows[0]?.status, 'confirmed', 'approval must not commit against a stale profile snapshot')
  } finally {
    await profileClient.query('ROLLBACK').catch(() => undefined)
    await approvalClient.query('ROLLBACK').catch(() => undefined)
    profileClient.release()
    approvalClient.release()
  }
}

async function approvalFirstInterleaving(pool: Pool) {
  await resetFixture(pool)
  const approvalClient = await pool.connect()
  const profileClient = await pool.connect()
  try {
    await begin(approvalClient)
    await lockPersonnelSettlementUserScopeForSettlement(approvalClient, settlementId)
    const liveProfile = await approvalClient.query('SELECT value FROM personnel_profiles WHERE user_id=$1', [userId])
    assert.equal(liveProfile.rows[0]?.value, 'old')
    await approvalClient.query("UPDATE personnel_weekly_settlements SET status='finance_approved' WHERE id=$1", [settlementId])

    await begin(profileClient)
    const state = { value: 'pending' }
    const lockPromise = lockPersonnelSettlementUserScope(profileClient, userId).then(
      () => { state.value = 'resolved' },
      (error) => { state.value = 'rejected'; throw error },
    )
    await assertStillWaiting(state, 'profile save behind finance approval')
    await approvalClient.query('COMMIT')
    await lockPromise

    const status = await profileClient.query('SELECT status FROM personnel_weekly_settlements WHERE id=$1', [settlementId])
    assert.equal(status.rows[0]?.status, 'finance_approved')
    if (!['finance_approved', 'paid'].includes(String(status.rows[0]?.status))) {
      await profileClient.query('UPDATE personnel_profiles SET value=\'new\', revision=revision+1 WHERE user_id=$1', [userId])
    }
    await profileClient.query('COMMIT')
    const profile = await pool.query(
      `SELECT value FROM ${quoteIdentifier(schema)}.personnel_profiles WHERE user_id=$1`,
      [userId],
    )
    assert.equal(profile.rows[0]?.value, 'old', 'a committed finance lock must reject the later profile mutation')
  } finally {
    await approvalClient.query('ROLLBACK').catch(() => undefined)
    await profileClient.query('ROLLBACK').catch(() => undefined)
    approvalClient.release()
    profileClient.release()
  }
}

async function serializablePaymentSnapshotAfterProfile(pool: Pool) {
  await resetFixture(pool)
  const profileClient = await pool.connect()
  const paymentClient = await pool.connect()
  let paymentSessionLockHeld = false
  try {
    await begin(profileClient)
    await lockPersonnelSettlementUserScope(profileClient, userId)
    await profileClient.query('UPDATE personnel_profiles SET value=\'new\', revision=revision+1 WHERE user_id=$1', [userId])

    const state = { value: 'pending' }
    const sessionLockPromise = lockPersonnelSettlementUserSessionScope(paymentClient, userId).then(
      () => { state.value = 'resolved'; paymentSessionLockHeld = true },
      (error) => { state.value = 'rejected'; throw error },
    )
    await assertStillWaiting(state, 'serializable payment snapshot behind profile save')
    await profileClient.query('COMMIT')
    await sessionLockPromise

    await paymentClient.query('BEGIN')
    await paymentClient.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
    await lockPersonnelSettlementUserScope(paymentClient, userId)
    await unlockPersonnelSettlementUserSessionScope(paymentClient, userId)
    paymentSessionLockHeld = false
    const profile = await paymentClient.query(
      `SELECT value FROM ${quoteIdentifier(schema)}.personnel_profiles WHERE user_id=$1`,
      [userId],
    )
    assert.equal(profile.rows[0]?.value, 'new', 'SERIALIZABLE payment snapshot must start after the prior profile commit')
    await paymentClient.query('COMMIT')
  } finally {
    await profileClient.query('ROLLBACK').catch(() => undefined)
    await paymentClient.query('ROLLBACK').catch(() => undefined)
    if (paymentSessionLockHeld) {
      await unlockPersonnelSettlementUserSessionScope(paymentClient, userId).catch(() => undefined)
    }
    profileClient.release()
    paymentClient.release()
  }
}

async function deadlockRegression(pool: Pool) {
  await resetFixture(pool)
  const runs = Array.from({ length: 12 }, (_, index) => index)
  await Promise.all(runs.map(async (index) => {
    const client = await pool.connect()
    try {
      await begin(client)
      if (index % 2 === 0) {
        await lockPersonnelSettlementUserScope(client, userId)
        await client.query('SELECT user_id FROM personnel_profiles WHERE user_id=$1 FOR UPDATE', [userId])
        await client.query('UPDATE personnel_profiles SET revision=revision+1 WHERE user_id=$1', [userId])
      } else {
        await lockPersonnelSettlementUserScopeForSettlement(client, settlementId)
        await client.query('SELECT id FROM personnel_weekly_settlements WHERE id=$1 FOR UPDATE', [settlementId])
        await client.query('SELECT user_id FROM personnel_profiles WHERE user_id=$1 FOR UPDATE', [userId])
      }
      await client.query('COMMIT')
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => undefined)
      assert.notEqual(String(error?.code || ''), '40P01', 'shared advisory-first order must not deadlock')
      throw error
    } finally {
      client.release()
    }
  }))
  const result = await pool.query(
    `SELECT revision FROM ${quoteIdentifier(schema)}.personnel_profiles WHERE user_id=$1`,
    [userId],
  )
  assert.equal(Number(result.rows[0]?.revision), 6)
}

async function main() {
  const { connectionString } = assertSafeEphemeralTarget()
  const pool = new Pool({
    connectionString,
    max: 16,
    application_name: 'mz-profile-lock-isolated-concurrency',
  })
  try {
    await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
    await pool.query(`
      CREATE TABLE ${quoteIdentifier(schema)}.personnel_profiles (
        user_id text PRIMARY KEY,
        value text NOT NULL,
        revision integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${quoteIdentifier(schema)}.personnel_weekly_settlements (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        status text NOT NULL
      );
    `)
    await pool.query(
      `INSERT INTO ${quoteIdentifier(schema)}.personnel_profiles(user_id,value) VALUES ($1,'old')`,
      [userId],
    )
    await pool.query(
      `INSERT INTO ${quoteIdentifier(schema)}.personnel_weekly_settlements(id,user_id,status) VALUES ($1,$2,'confirmed')`,
      [settlementId, userId],
    )
    await profileFirstInterleaving(pool)
    await approvalFirstInterleaving(pool)
    await serializablePaymentSnapshotAfterProfile(pool)
    await deadlockRegression(pool)
    console.log('personnel settlement profile-lock SQL concurrency integration: PASS')
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
    await pool.end()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
