import { v4 as uuid } from 'uuid'
import { hasPg, pgPool } from '../dbAdapter'

let schemaEnsured: Promise<void> | null = null

export async function ensureJobRunsSchema(): Promise<void> {
  if (!hasPg || !pgPool) return
  if (schemaEnsured) return schemaEnsured
  schemaEnsured = (async () => {
    const r = await pgPool.query(`SELECT to_regclass('public.job_runs') AS job_runs`)
    const jr = r?.rows?.[0]?.job_runs
    if (!jr) {
      const err: any = new Error('job_runs_missing')
      err.code = 'JOB_RUNS_SCHEMA_MISSING'
      throw err
    }
  })().catch((e) => {
    schemaEnsured = null
    throw e
  })
  return schemaEnsured
}

export async function createJobRun(params: {
  job_name: string
  schedule_name?: string | null
  trigger_source?: string | null
  run_id?: string | null
  lock_name?: string | null
  date_from?: string | null
  date_to?: string | null
  time_zone?: string | null
  concurrency?: number | null
}) {
  if (!hasPg || !pgPool) return null
  await ensureJobRunsSchema()
  const id = uuid()
  const jobName = String(params.job_name || '').trim()
  const row = {
    id,
    job_name: jobName,
    schedule_name: params.schedule_name != null ? String(params.schedule_name) : null,
    trigger_source: params.trigger_source != null ? String(params.trigger_source) : null,
    run_id: params.run_id != null ? String(params.run_id) : null,
    lock_name: params.lock_name != null ? String(params.lock_name) : null,
    date_from: params.date_from != null ? String(params.date_from).slice(0, 10) : null,
    date_to: params.date_to != null ? String(params.date_to).slice(0, 10) : null,
    time_zone: params.time_zone != null ? String(params.time_zone) : null,
    concurrency: params.concurrency != null ? Number(params.concurrency) : null,
  }
  const keys = Object.keys(row)
  const cols = keys.map((k) => `"${k}"`).join(',')
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(',')
  const values = keys.map((k) => (row as any)[k]).map((v) => (v === undefined ? null : v))
  const sql = `INSERT INTO job_runs (${cols}) VALUES (${placeholders}) RETURNING *`
  const r = await pgPool.query(sql, values)
  return r?.rows?.[0] || null
}

export async function finishJobRun(params: {
  id: string
  lock_acquired?: boolean | null
  skipped?: boolean | null
  skipped_reason?: string | null
  orders_scanned?: number | null
  orders_succeeded?: number | null
  orders_failed?: number | null
  tasks_created?: number | null
  tasks_updated?: number | null
  tasks_cancelled?: number | null
  tasks_skipped_locked?: number | null
  tasks_no_change?: number | null
  duration_ms?: number | null
  error_message?: string | null
  result?: any
}) {
  if (!hasPg || !pgPool) return null
  await ensureJobRunsSchema()
  const id = String(params.id || '').trim()
  if (!id) return null

  const set: string[] = []
  const values: any[] = []
  const put = (k: string, v: any) => {
    values.push(v === undefined ? null : v)
    set.push(`"${k}" = $${values.length}`)
  }

  if (params.lock_acquired !== undefined) put('lock_acquired', params.lock_acquired)
  if (params.skipped !== undefined) put('skipped', params.skipped)
  if (params.skipped_reason !== undefined) put('skipped_reason', params.skipped_reason)
  if (params.orders_scanned !== undefined) put('orders_scanned', params.orders_scanned)
  if (params.orders_succeeded !== undefined) put('orders_succeeded', params.orders_succeeded)
  if (params.orders_failed !== undefined) put('orders_failed', params.orders_failed)
  if (params.tasks_created !== undefined) put('tasks_created', params.tasks_created)
  if (params.tasks_updated !== undefined) put('tasks_updated', params.tasks_updated)
  if (params.tasks_cancelled !== undefined) put('tasks_cancelled', params.tasks_cancelled)
  if (params.tasks_skipped_locked !== undefined) put('tasks_skipped_locked', params.tasks_skipped_locked)
  if (params.tasks_no_change !== undefined) put('tasks_no_change', params.tasks_no_change)
  if (params.duration_ms !== undefined) put('duration_ms', params.duration_ms)
  if (params.error_message !== undefined) put('error_message', params.error_message)
  if (params.result !== undefined) put('result', params.result != null ? params.result : null)

  put('finished_at', new Date().toISOString())
  put('updated_at', new Date().toISOString())

  values.push(id)
  const sql = `UPDATE job_runs SET ${set.join(', ')} WHERE id = $${values.length} RETURNING *`
  const r = await pgPool.query(sql, values)
  return r?.rows?.[0] || null
}

export async function listJobRuns(params: { job_name: string; limit?: number; schedule_name?: string | null; ok?: boolean | null }) {
  if (!hasPg || !pgPool) return []
  await ensureJobRunsSchema()
  const jobName = String(params.job_name || '').trim()
  const limit = Math.max(1, Math.min(200, Number(params.limit || 50)))
  const where: string[] = ['job_name = $1']
  const values: any[] = [jobName]
  if (params.schedule_name) { values.push(String(params.schedule_name)); where.push(`schedule_name = $${values.length}`) }
  if (params.ok === true) where.push(`COALESCE(error_message,'') = '' AND COALESCE(skipped,false) = false`)
  if (params.ok === false) where.push(`COALESCE(error_message,'') <> ''`)
  values.push(limit)
  const sql = `SELECT * FROM job_runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT $${values.length}`
  const r = await pgPool.query(sql, values)
  return r?.rows || []
}

