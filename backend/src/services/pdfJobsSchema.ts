import { hasPg, pgPool } from '../dbAdapter'

let schemaEnsured: Promise<void> | null = null

export async function ensurePdfJobsSchema(): Promise<void> {
  if (!hasPg || !pgPool) return
  if (schemaEnsured) return schemaEnsured
  schemaEnsured = (async () => {
    const r = await pgPool.query(`SELECT to_regclass('public.pdf_jobs') AS t`)
    const t = r?.rows?.[0]?.t
    if (!t) {
      const err: any = new Error('pdf_jobs_missing')
      err.code = 'PDF_JOBS_SCHEMA_MISSING'
      throw err
    }
  })().catch((e) => {
    schemaEnsured = null
    throw e
  })
  return schemaEnsured
}

