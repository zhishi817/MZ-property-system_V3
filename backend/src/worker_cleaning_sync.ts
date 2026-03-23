import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config({ path: path.resolve(__dirname, '../.env.local'), override: true })
dotenv.config()

import cron from 'node-cron'
import { hasPg, pgPool } from './dbAdapter'
import { v4 as uuid } from 'uuid'

function boolEnv(name: string, def: boolean): boolean {
  const v = process.env[name]
  if (v == null) return def
  const s = String(v).toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

async function runOnce() {
  let jr: any = null
  const startedAt = Date.now()
  try {
    const { createJobRun } = require('./services/jobRuns')
    jr = await createJobRun({ job_name: 'cleaning_sync_jobs', schedule_name: 'cron', trigger_source: 'schedule', run_id: uuid() })
  } catch {}
  const { processCleaningSyncJobsOnce } = require('./services/cleaningSyncJobsWorker')
  try {
    const r = await processCleaningSyncJobsOnce({
      limit: Math.min(20, Number(process.env.CLEANING_SYNC_JOBS_BATCH || 10)),
      reclaim_timeout_minutes: Math.min(120, Math.max(1, Number(process.env.CLEANING_SYNC_JOBS_RECLAIM_MINUTES || 10))),
    })
    try {
      if (jr?.id) {
        const { finishJobRun } = require('./services/jobRuns')
        await finishJobRun({
          id: String(jr.id),
          orders_scanned: Number(r.processed || 0),
          orders_succeeded: Number(r.ok || 0),
          orders_failed: Number(r.failed || 0),
          duration_ms: Date.now() - startedAt,
          result: r,
        })
      }
    } catch {}
    console.log(`[cleaning-sync-jobs][run-once] processed=${r.processed || 0} ok=${r.ok || 0} failed=${r.failed || 0} reclaimed=${r.reclaimed || 0}`)
    return
  } catch (e: any) {
    try {
      if (jr?.id) {
        const { finishJobRun } = require('./services/jobRuns')
        await finishJobRun({ id: String(jr.id), duration_ms: Date.now() - startedAt, error_message: String(e?.message || ''), result: { message: String(e?.message || ''), code: String(e?.code || '') } })
      }
    } catch {}
    throw e
  }
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
