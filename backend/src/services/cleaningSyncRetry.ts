import { v4 as uuid } from 'uuid'
import { hasPg, pgPool } from '../dbAdapter'

let schemaEnsured: Promise<void> | null = null

export async function ensureCleaningSyncRetrySchema(): Promise<void> {
  if (!hasPg || !pgPool) return
  if (schemaEnsured) return schemaEnsured
  schemaEnsured = (async () => {
    const r = await pgPool.query(`SELECT to_regclass('public.cleaning_sync_retry_jobs') AS t`)
    const t = r?.rows?.[0]?.t
    if (!t) {
      const err: any = new Error('cleaning_sync_retry_jobs_missing')
      err.code = 'CLEANING_SCHEMA_MISSING'
      throw err
    }
  })().catch((e) => {
    schemaEnsured = null
    throw e
  })
  return schemaEnsured
}

export async function enqueueCleaningSyncRetry(params: { order_id: string; action: 'deleted' | 'sync'; error_code?: string; error_message?: string }) {
  if (!hasPg || !pgPool) return null
  await ensureCleaningSyncRetrySchema()
  const orderId = String(params.order_id || '').trim()
  const action = String(params.action || '').trim() as any
  if (!orderId || !action) return null
  const errCode = params.error_code ? String(params.error_code) : null
  const errMsg = params.error_message ? String(params.error_message) : null

  const existing = await pgPool.query(
    `SELECT id FROM cleaning_sync_retry_jobs
     WHERE order_id=$1 AND action=$2 AND status IN ('pending','running')
     ORDER BY created_at DESC
     LIMIT 1`,
    [orderId, action],
  )
  const existId = String(existing?.rows?.[0]?.id || '')
  if (existId) {
    await pgPool.query(
      `UPDATE cleaning_sync_retry_jobs
       SET status='pending', next_retry_at=now(), last_error_code=$2, last_error_message=$3, updated_at=now()
       WHERE id=$1`,
      [existId, errCode, errMsg],
    )
    return { id: existId, updated: true }
  }
  const id = uuid()
  await pgPool.query(
    `INSERT INTO cleaning_sync_retry_jobs(id, order_id, action, status, attempts, max_attempts, next_retry_at, last_error_code, last_error_message)
     VALUES($1,$2,$3,'pending',0,8,now(),$4,$5)`,
    [id, orderId, action, errCode, errMsg],
  )
  return { id, created: true }
}

export async function listCleaningSyncRetryJobs(opts: { status?: string; limit?: number } = {}) {
  if (!hasPg || !pgPool) return []
  await ensureCleaningSyncRetrySchema()
  const limit = Math.max(1, Math.min(200, Number(opts.limit || 50)))
  const st = String(opts.status || '').trim()
  if (st) {
    const r = await pgPool.query(
      `SELECT * FROM cleaning_sync_retry_jobs WHERE status=$1 ORDER BY next_retry_at ASC, created_at DESC LIMIT $2`,
      [st, limit],
    )
    return r?.rows || []
  }
  const r = await pgPool.query(`SELECT * FROM cleaning_sync_retry_jobs ORDER BY next_retry_at ASC, created_at DESC LIMIT $1`, [limit])
  return r?.rows || []
}

function backoffMinutes(attempts: number) {
  const n = Math.max(1, Number(attempts || 0))
  if (n <= 1) return 1
  if (n === 2) return 3
  if (n === 3) return 10
  if (n === 4) return 30
  return 60
}

export async function processDueCleaningSyncRetries(opts: { limit?: number } = {}) {
  if (!hasPg || !pgPool) return { processed: 0, ok: 0, failed: 0 }
  await ensureCleaningSyncRetrySchema()
  const limit = Math.max(1, Math.min(50, Number(opts.limit || 10)))
  const due = await pgPool.query(
    `SELECT id FROM cleaning_sync_retry_jobs
     WHERE status='pending' AND next_retry_at <= now()
     ORDER BY next_retry_at ASC, created_at ASC
     LIMIT $1`,
    [limit],
  )
  const ids = (due?.rows || []).map((r: any) => String(r.id || '')).filter(Boolean)
  let ok = 0, failed = 0
  for (const id of ids) {
    const claimed = await pgPool.query(
      `UPDATE cleaning_sync_retry_jobs
       SET status='running', attempts=attempts+1, updated_at=now()
       WHERE id=$1 AND status='pending'
       RETURNING *`,
      [id],
    )
    const job = claimed?.rows?.[0]
    if (!job) continue
    const orderId = String(job.order_id || '')
    const action = String(job.action || '')
    const attempts = Number(job.attempts || 0)
    const maxAttempts = Number(job.max_attempts || 8)

    try {
      const { syncOrderToCleaningTasks } = require('./cleaningSync')
      const run = action === 'deleted'
        ? syncOrderToCleaningTasks(orderId, { deleted: true })
        : syncOrderToCleaningTasks(orderId)
      await Promise.race([
        run,
        new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('sync_timeout'), { code: 'SYNC_TIMEOUT' })), 20000)),
      ])
      await pgPool.query(
        `UPDATE cleaning_sync_retry_jobs
         SET status='done', last_error_code=NULL, last_error_message=NULL, updated_at=now()
         WHERE id=$1`,
        [id],
      )
      ok++
    } catch (e: any) {
      const errCode = String(e?.code || '')
      const errMsg = String(e?.message || '')
      const nextMin = backoffMinutes(attempts)
      const nextStatus = attempts >= maxAttempts ? 'failed' : 'pending'
      if (nextStatus === 'pending') {
        await pgPool.query(
          `UPDATE cleaning_sync_retry_jobs
           SET status=$2, next_retry_at=now() + ($5 || ':minutes')::interval, last_error_code=$3, last_error_message=$4, updated_at=now()
           WHERE id=$1`,
          [id, nextStatus, errCode || null, errMsg || null, String(nextMin)],
        ).catch(async () => {
          await pgPool!.query(
            `UPDATE cleaning_sync_retry_jobs
             SET status=$2, next_retry_at=now() + interval '10 minutes', last_error_code=$3, last_error_message=$4, updated_at=now()
             WHERE id=$1`,
            [id, nextStatus, errCode || null, errMsg || null],
          )
        })
      } else {
        await pgPool.query(
          `UPDATE cleaning_sync_retry_jobs
           SET status=$2, last_error_code=$3, last_error_message=$4, updated_at=now()
           WHERE id=$1`,
          [id, nextStatus, errCode || null, errMsg || null],
        )
      }
      failed++
    }
  }
  return { processed: ids.length, ok, failed }
}

export async function setCleaningSyncRetryPending(id: string) {
  if (!hasPg || !pgPool) return null
  await ensureCleaningSyncRetrySchema()
  const rid = String(id || '').trim()
  if (!rid) return null
  const r = await pgPool.query(
    `UPDATE cleaning_sync_retry_jobs SET status='pending', next_retry_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
    [rid],
  )
  return r?.rows?.[0] || null
}
