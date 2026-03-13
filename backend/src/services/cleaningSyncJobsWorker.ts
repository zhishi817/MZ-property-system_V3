import { hasPg, pgPool } from '../dbAdapter'
import { ensureCleaningSyncJobsSchema } from './cleaningSyncJobsSchema'

export type CleaningSyncWorkerResult = { processed: number; ok: number; failed: number; reclaimed: number }

let schemaMissingLogged = false

function msEnv(name: string, defMs: number): number {
  const raw = Number(process.env[name] || defMs)
  if (!Number.isFinite(raw)) return defMs
  return Math.max(0, Math.floor(raw))
}

async function applyTxTimeouts(client: any) {
  const lockTimeoutMs = msEnv('CLEANING_SYNC_JOBS_LOCK_TIMEOUT_MS', 2000)
  const statementTimeoutMs = msEnv('CLEANING_SYNC_JOBS_STATEMENT_TIMEOUT_MS', 30000)
  const idleTimeoutMs = msEnv('CLEANING_SYNC_JOBS_IDLE_IN_TX_TIMEOUT_MS', 60000)
  if (lockTimeoutMs) await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`)
  if (statementTimeoutMs) await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`)
  if (idleTimeoutMs) await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${idleTimeoutMs}`)
}

function backoffMinutes(attempts: number) {
  const n = Math.max(1, Number(attempts || 0))
  if (n <= 1) return 1
  if (n === 2) return 3
  if (n === 3) return 10
  if (n === 4) return 30
  return 60
}

function classifyError(e: any): { retriable: boolean; code: string; message: string } {
  const code = String(e?.code || '')
  const message = String(e?.message || '')
  const retriableCodes = new Set(['40001', '40P01', '55P03', '57014', '53300', '57P01', '57P02', '57P03'])
  const nonRetriableCodes = new Set(['23503', '23505', '42501', '42P01', '42703'])
  if (code === 'CLEANING_SCHEMA_MISSING' || code === 'JOB_INVALID') return { retriable: false, code, message }
  if (nonRetriableCodes.has(code)) return { retriable: false, code, message }
  if (retriableCodes.has(code)) return { retriable: true, code, message }
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') return { retriable: true, code, message }
  if (/timeout/i.test(message)) return { retriable: true, code, message }
  return { retriable: true, code, message }
}

async function reclaimStuckRunning(timeoutMinutes: number): Promise<number> {
  if (!hasPg || !pgPool) return 0
  const m = Math.max(1, Number(timeoutMinutes || 10))
  const r = await pgPool.query(
    `UPDATE cleaning_sync_jobs
     SET status='pending',
         next_retry_at=now(),
         running_started_at=NULL,
         last_error_code='worker_timeout_reclaimed',
         last_error_message='running_job_reclaimed',
         updated_at=now()
     WHERE status='running'
       AND running_started_at IS NOT NULL
       AND running_started_at < now() - ($1 || ':minutes')::interval`,
    [String(m)]
  )
  return Number(r?.rowCount || 0)
}

async function claimJobs(limit: number): Promise<any[]> {
  if (!hasPg || !pgPool) return []
  const n = Math.max(1, Math.min(50, Number(limit || 10)))
  const client = await pgPool.connect()
  let locked = false
  try {
    client.on('error', (err: any) => {
      try { console.error(`[cleaning-sync][worker] client_error message=${String(err?.message || '')} code=${String(err?.code || '')}`) } catch {}
    })
    const lockKey = Number(process.env.CLEANING_SYNC_JOBS_LOCK_KEY || 246813580)
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [lockKey])
    locked = !!(got?.rows?.[0]?.ok)
    if (!locked) return []
    await client.query('BEGIN')
    await applyTxTimeouts(client)
    const r = await client.query(
      `WITH picked AS (
         SELECT id
         FROM cleaning_sync_jobs
         WHERE status='pending' AND next_retry_at <= now()
         ORDER BY next_retry_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE cleaning_sync_jobs j
       SET status='running',
           attempts=j.attempts+1,
           running_started_at=now(),
           updated_at=now()
       FROM picked
       WHERE j.id = picked.id
       RETURNING j.*`,
      [n]
    )
    await client.query('COMMIT')
    return r?.rows || []
  } catch (e: any) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock($1)', [Number(process.env.CLEANING_SYNC_JOBS_LOCK_KEY || 246813580)]) } catch {}
    try { client.release() } catch {}
  }
}

async function markDone(id: string) {
  await pgPool!.query(
    `UPDATE cleaning_sync_jobs
     SET status='done', running_started_at=NULL, last_error_code=NULL, last_error_message=NULL, updated_at=now()
     WHERE id=$1`,
    [id]
  )
}

async function markFailedOrRetry(job: any, info: { retriable: boolean; code: string; message: string }) {
  const id = String(job?.id || '')
  const attempts = Number(job?.attempts || 0)
  const maxAttempts = Number(job?.max_attempts || 10)
  const willRetry = info.retriable && attempts < maxAttempts
  if (willRetry) {
    const nextMin = backoffMinutes(attempts)
    await pgPool!.query(
      `UPDATE cleaning_sync_jobs
       SET status='pending',
           next_retry_at=now() + ($2 || ':minutes')::interval,
           running_started_at=NULL,
           last_error_code=$3,
           last_error_message=$4,
           updated_at=now()
       WHERE id=$1`,
      [id, String(nextMin), info.code || null, info.message || null]
    )
    return
  }
  await pgPool!.query(
    `UPDATE cleaning_sync_jobs
     SET status='failed',
         running_started_at=NULL,
         last_error_code=$2,
         last_error_message=$3,
         updated_at=now()
     WHERE id=$1`,
    [id, info.code || null, info.message || null]
  )
}

async function runOne(job: any) {
  const id = String(job?.id || '')
  const orderId = String(job?.order_id || '')
  const action = String(job?.action || '')
  if (!id || !orderId || !action) throw Object.assign(new Error('invalid_job'), { code: 'JOB_INVALID' })

  const client = await pgPool!.connect()
  try {
    await client.query('BEGIN')
    await applyTxTimeouts(client)
    if (action === 'deleted') {
      try { await client.query(`DELETE FROM finance_transactions WHERE ref_type='order' AND ref_id=$1`, [orderId]) } catch {}
      try { await client.query(`DELETE FROM company_incomes WHERE ref_type='order' AND ref_id=$1`, [orderId]) } catch {}
    }
    const { syncOrderToCleaningTasks } = require('./cleaningSync')
    if (action === 'deleted') {
      await syncOrderToCleaningTasks(orderId, { deleted: true, client, jobId: id })
      await client.query('COMMIT')
      return
    }
    await syncOrderToCleaningTasks(orderId, { client, jobId: id })
    await client.query('COMMIT')
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    try { client.release() } catch {}
  }
}

export async function processCleaningSyncJobsOnce(opts: { limit?: number; reclaim_timeout_minutes?: number } = {}): Promise<CleaningSyncWorkerResult> {
  if (!hasPg || !pgPool) return { processed: 0, ok: 0, failed: 0, reclaimed: 0 }
  try {
    await ensureCleaningSyncJobsSchema()
  } catch (e: any) {
    if (String(e?.code || '') === 'CLEANING_SCHEMA_MISSING') {
      if (!schemaMissingLogged) {
        schemaMissingLogged = true
        try { console.error('[cleaning-sync][worker] schema_missing table=cleaning_sync_jobs') } catch {}
      }
      return { processed: 0, ok: 0, failed: 0, reclaimed: 0 }
    }
    throw e
  }
  const reclaimMin = Math.max(1, Number(opts.reclaim_timeout_minutes || process.env.CLEANING_SYNC_JOBS_RECLAIM_MINUTES || 10))
  const reclaimed = await reclaimStuckRunning(reclaimMin).catch(() => 0)
  const jobs = await claimJobs(Number(opts.limit || 10))
  let ok = 0, failed = 0
  for (const job of jobs) {
    const jobId = String(job?.id || '')
    const orderId = String(job?.order_id || '')
    const action = String(job?.action || '')
    try {
      console.log(`[cleaning-sync][worker] run start jobId=${jobId} orderId=${orderId} action=${action} attempts=${Number(job?.attempts || 0)}`)
      await runOne(job)
      await markDone(jobId)
      console.log(`[cleaning-sync][worker] run done jobId=${jobId} orderId=${orderId} action=${action}`)
      ok++
    } catch (e: any) {
      const info = classifyError(e)
      console.log(`[cleaning-sync][worker] run failed jobId=${jobId} orderId=${orderId} action=${action} code=${info.code} retriable=${info.retriable} message=${info.message}`)
      await markFailedOrRetry(job, info).catch(() => {})
      failed++
    }
  }
  return { processed: jobs.length, ok, failed, reclaimed }
}
