import { hasPg, pgPool } from '../dbAdapter'

let schemaEnsured: Promise<void> | null = null

export async function ensureJobLocksSchema(): Promise<void> {
  if (!hasPg || !pgPool) return
  if (schemaEnsured) return schemaEnsured
  schemaEnsured = (async () => {
    const r = await pgPool.query(`SELECT to_regclass('public.job_locks') AS job_locks`)
    const jl = r?.rows?.[0]?.job_locks
    if (!jl) {
      const err: any = new Error('job_locks_missing')
      err.code = 'JOB_LOCKS_SCHEMA_MISSING'
      throw err
    }
  })().catch((e) => {
    schemaEnsured = null
    throw e
  })
  return schemaEnsured
}

export async function tryAcquireJobLock(params: { name: string; ttl_ms: number; locked_by?: string | null }) {
  if (!hasPg || !pgPool) return { acquired: false, reason: 'pg=false' as const }
  await ensureJobLocksSchema()
  const name = String(params.name || '').trim()
  if (!name) return { acquired: false, reason: 'name_missing' as const }
  const ttl = Math.max(1000, Number(params.ttl_ms || 0))
  const lockedBy = params.locked_by != null ? String(params.locked_by) : ''
  if (!lockedBy) return { acquired: false, reason: 'owner_missing' as const }
  const sql = `
    INSERT INTO job_locks(name, locked_until, locked_by, heartbeat_at, updated_at)
    VALUES($1, now() + ($2::bigint) * interval '1 millisecond', $3, now(), now())
    ON CONFLICT (name) DO UPDATE
    SET locked_until = EXCLUDED.locked_until,
        locked_by = EXCLUDED.locked_by,
        heartbeat_at = now(),
        updated_at = now()
    WHERE job_locks.locked_until < now()
    RETURNING name, locked_until, locked_by
  `
  const r = await pgPool.query(sql, [name, ttl, lockedBy])
  if ((r?.rowCount || 0) > 0) return { acquired: true as const, row: r.rows[0] }
  return { acquired: false as const, reason: 'already_running' as const }
}

export async function renewJobLock(params: { name: string; ttl_ms: number; locked_by: string }) {
  if (!hasPg || !pgPool) return { renewed: false, reason: 'pg=false' as const }
  await ensureJobLocksSchema()
  const name = String(params.name || '').trim()
  if (!name) return { renewed: false, reason: 'name_missing' as const }
  const lockedBy = String(params.locked_by || '').trim()
  if (!lockedBy) return { renewed: false, reason: 'owner_missing' as const }
  const ttl = Math.max(1000, Number(params.ttl_ms || 0))
  const sql = `
    UPDATE job_locks
    SET locked_until = now() + ($3::bigint) * interval '1 millisecond',
        heartbeat_at = now(),
        updated_at = now()
    WHERE name = $1 AND locked_by = $2 AND locked_until >= now()
    RETURNING name, locked_until, locked_by
  `
  const r = await pgPool.query(sql, [name, lockedBy, ttl])
  return { renewed: (r?.rowCount || 0) > 0 }
}

export async function releaseJobLock(params: { name: string; locked_by: string }) {
  if (!hasPg || !pgPool) return { released: false, reason: 'pg=false' as const }
  await ensureJobLocksSchema()
  const name = String(params.name || '').trim()
  if (!name) return { released: false, reason: 'name_missing' as const }
  const lockedBy = String(params.locked_by || '').trim()
  if (!lockedBy) return { released: false, reason: 'owner_missing' as const }
  const r = await pgPool.query(
    'UPDATE job_locks SET locked_until = now(), heartbeat_at = now(), updated_at = now() WHERE name = $1 AND locked_by = $2',
    [name, lockedBy]
  )
  return { released: (r?.rowCount || 0) > 0 }
}
