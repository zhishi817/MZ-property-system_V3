import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config({ path: path.resolve(__dirname, '../.env.local'), override: true })
dotenv.config()

import cron from 'node-cron'
import { hasPg, pgPool } from './dbAdapter'

function boolEnv(name: string, def: boolean): boolean {
  const v = process.env[name]
  if (v == null) return def
  const s = String(v).toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

async function runOnce() {
  const { processCleaningSyncJobsOnce } = require('./services/cleaningSyncJobsWorker')
  const r = await processCleaningSyncJobsOnce({
    limit: Math.min(20, Number(process.env.CLEANING_SYNC_JOBS_BATCH || 10)),
    reclaim_timeout_minutes: Math.min(120, Math.max(1, Number(process.env.CLEANING_SYNC_JOBS_RECLAIM_MINUTES || 10))),
  })
  console.log(`[cleaning-sync-jobs][run-once] processed=${r.processed || 0} ok=${r.ok || 0} failed=${r.failed || 0} reclaimed=${r.reclaimed || 0}`)
}

async function main() {
  const enabled = boolEnv('CLEANING_SYNC_JOBS_ENABLED', true)
  if (!enabled) {
    console.log('[cleaning-sync-jobs][worker] disabled')
    return
  }
  if (!hasPg) {
    console.log('[cleaning-sync-jobs][worker] pg=false')
    return
  }
  console.log('[cleaning-sync-jobs][worker] starting')
  try {
    const expr = String(process.env.CLEANING_SYNC_JOBS_CRON || '*/1 * * * *')
    console.log(`[cleaning-sync-jobs][worker] cron=${expr}`)
    let inFlight = false
    const task = cron.schedule(expr, async () => {
      if (inFlight) return
      inFlight = true
      try {
        await runOnce()
      } catch (e: any) {
        console.error(`[cleaning-sync-jobs][worker] error message=${String(e?.message || '')} code=${String(e?.code || '')}`)
      } finally {
        inFlight = false
      }
    }, { scheduled: true })
    task.start()
    if (boolEnv('CLEANING_SYNC_JOBS_RUN_ON_START', false)) {
      try { await runOnce() } catch (e: any) { console.error(`[cleaning-sync-jobs][worker] run_on_start_failed message=${String(e?.message || '')}`) }
    }
  } catch (e: any) {
    console.error(`[cleaning-sync-jobs][worker] init error message=${String(e?.message || '')}`)
  }
}

process.on('unhandledRejection', (reason: any) => {
  try { console.error(`[cleaning-sync-jobs][worker] unhandledRejection reason=${String((reason as any)?.message || reason || '')}`) } catch {}
})
process.on('uncaughtException', (err: any) => {
  try { console.error(`[cleaning-sync-jobs][worker] uncaughtException message=${String(err?.message || '')} code=${String(err?.code || '')}`) } catch {}
  process.exit(1)
})

main().catch((e: any) => {
  try { console.error(`[cleaning-sync-jobs][worker] fatal message=${String(e?.message || '')}`) } catch {}
  try { pgPool?.end?.() } catch {}
  process.exit(1)
})

