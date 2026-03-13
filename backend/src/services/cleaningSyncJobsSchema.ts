import { hasPg, pgPool } from '../dbAdapter'

let schemaEnsured: Promise<void> | null = null

export async function ensureCleaningSyncJobsSchema(): Promise<void> {
  if (!hasPg || !pgPool) return
  if (schemaEnsured) return schemaEnsured
  schemaEnsured = (async () => {
    const r = await pgPool.query(`SELECT to_regclass('public.cleaning_sync_jobs') AS t`)
    const t = r?.rows?.[0]?.t
    if (!t) {
      const err: any = new Error('cleaning_sync_jobs_missing')
      err.code = 'CLEANING_SCHEMA_MISSING'
      throw err
    }
  })().catch((e) => {
    schemaEnsured = null
    throw e
  })
  return schemaEnsured
}

