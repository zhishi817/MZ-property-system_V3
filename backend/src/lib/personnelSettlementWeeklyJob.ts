import { randomUUID } from 'crypto'
import { pgPool } from '../dbAdapter'
import {
  PERSONNEL_SETTLEMENT_CALCULATION_VERSION,
  buildSettlementPeriod,
  getMelbourneDate,
  getSettlementWeekStart,
} from './personnelSettlement'
import { assertPersonnelSettlementPhase5SchemaReady } from './personnelSettlementPhase5Schema'
import { listPersonnelWeeklySettlements } from './personnelSettlementWorkflow'

const WEEKLY_JOB_LOCK_KEY = 205091105
const SYSTEM_ACTOR = 'system:personnel-settlement-weekly'

async function runWithWeeklyJobLock<T>(callback: () => Promise<T>): Promise<{ locked: boolean; result?: T }> {
  if (!pgPool) return { locked: false }
  const client = await pgPool.connect()
  let transactionOpen = false
  try {
    await client.query('BEGIN')
    transactionOpen = true
    const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [WEEKLY_JOB_LOCK_KEY])
    if (!lock.rows?.[0]?.ok) {
      await client.query('ROLLBACK')
      transactionOpen = false
      return { locked: false }
    }
    const result = await callback()
    await client.query('COMMIT')
    transactionOpen = false
    return { locked: true, result }
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function dateDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export function previousCompletedPersonnelSettlementWeek(now = new Date()) {
  return dateDays(getSettlementWeekStart(getMelbourneDate(now)), -7)
}

export async function listPersonnelSettlementJobRuns(limit = 30) {
  if (!pgPool) throw new Error('pg_required')
  await assertPersonnelSettlementPhase5SchemaReady(pgPool)
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit || 30))))
  const result = await pgPool.query(
    `SELECT id, week_start::text, week_end::text, trigger_source, status,
            started_at::text, finished_at::text, generated_count, issued_count,
            skipped_count, error_summary, initiated_by, calculation_version
       FROM personnel_settlement_job_runs
      ORDER BY started_at DESC
      LIMIT $1`,
    [safeLimit],
  )
  return (result.rows || []).map((row: any) => ({
    ...row,
    generated_count: Number(row.generated_count || 0),
    issued_count: Number(row.issued_count || 0),
    skipped_count: Number(row.skipped_count || 0),
  }))
}

export async function runPersonnelSettlementWeeklyJob(input?: {
  triggerSource?: 'scheduled' | 'manual'
  actorUserId?: string
  weekStart?: string
}) {
  if (!pgPool) throw new Error('pg_required')
  await assertPersonnelSettlementPhase5SchemaReady(pgPool)
  const triggerSource = input?.triggerSource || 'scheduled'
  const actorUserId = String(input?.actorUserId || SYSTEM_ACTOR).trim() || SYSTEM_ACTOR
  const weekStart = input?.weekStart || previousCompletedPersonnelSettlementWeek()
  const period = buildSettlementPeriod(weekStart)
  const runId = randomUUID()
  await pgPool.query(
    `INSERT INTO personnel_settlement_job_runs (
       id, week_start, week_end, trigger_source, status, initiated_by, started_at
     ) VALUES ($1,$2::date,$3::date,$4,'running',$5,now())`,
    [runId, period.week_start, period.week_end, triggerSource, actorUserId],
  )

  const lockedRun = await runWithWeeklyJobLock(async () => {
    try {
      const settlements = await listPersonnelWeeklySettlements({ weekStart: period.week_start })
      const generatedCount = 0
      const issuedCount = 0
      const skippedCount = settlements.length
      const allErrors: Array<{ code: string }> = []
      const status = 'succeeded'
      await pgPool!.query(
        `UPDATE personnel_settlement_job_runs
            SET status=$1, finished_at=now(), generated_count=$2,
                issued_count=$3, skipped_count=$4, error_summary=$5::jsonb,
                calculation_version=$6
          WHERE id=$7`,
        [status, generatedCount, issuedCount, skippedCount, JSON.stringify(allErrors), PERSONNEL_SETTLEMENT_CALCULATION_VERSION, runId],
      )
      return { run_id: runId, status, generated_count: generatedCount, issued_count: issuedCount, skipped_count: skippedCount, errors: allErrors }
    } catch (error: any) {
      const code = String(error?.message || 'personnel_settlement_weekly_failed')
      await pgPool!.query(
        `UPDATE personnel_settlement_job_runs
            SET status='failed', finished_at=now(), error_summary=$1::jsonb
          WHERE id=$2`,
        [JSON.stringify([{ code }]), runId],
      )
      throw error
    }
  })
  if (!lockedRun.locked) {
    await pgPool.query(
      `UPDATE personnel_settlement_job_runs
          SET status='skipped', finished_at=now(), error_summary=$1::jsonb
        WHERE id=$2`,
      [JSON.stringify([{ code: 'already_running' }]), runId],
    )
    return { run_id: runId, status: 'skipped', generated_count: 0, issued_count: 0, skipped_count: 0, errors: [{ code: 'already_running' }] }
  }
  return lockedRun.result
}
