import dotenv from 'dotenv'
import path from 'path'
const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
if (!isProd) {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: false })
  dotenv.config({ path: path.resolve(__dirname, '../.env.local'), override: false })
  dotenv.config()
}

import cron from 'node-cron'
import { hasPg, pgPool } from './dbAdapter'

function boolEnv(name: string, def: boolean): boolean {
  const v = process.env[name]
  if (v == null) return def
  const s = String(v).toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

async function runOnce() {
  const { processPdfJobsOnce } = require('./services/pdfJobsWorker')
  const r = await processPdfJobsOnce({
    limit: Math.min(5, Math.max(1, Number(process.env.PDF_JOBS_BATCH || 2))),
  })
  console.log(`[pdf-jobs][run-once] processed=${r.processed || 0} ok=${r.ok || 0} failed=${r.failed || 0} reclaimed=${r.reclaimed || 0}`)
}

async function main() {
  const enabled = boolEnv('PDF_JOBS_ENABLED', true)
  if (!enabled) {
    console.log('[pdf-jobs][worker] disabled')
    return
  }
  if (!hasPg) {
    console.log('[pdf-jobs][worker] pg=false')
    return
  }
  const apiBase = String(
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_DEV ||
    process.env.NEXT_PUBLIC_API_BASE ||
    process.env.API_BASE ||
    process.env.FRONTEND_BASE_URL ||
    ''
  ).trim()
  const front = String(process.env.FRONTEND_BASE_URL || '').trim()
  const workerId = String(process.env.PDF_JOBS_WORKER_ID || '') || `pdf_worker_${process.pid}`
  console.log('[pdf-jobs][worker] starting')
  console.log(`[pdf-jobs][worker] worker_mode=dedicated worker_id=${workerId} API_BASE_RESOLVED=${apiBase || '(empty)'} FRONTEND_BASE_URL=${front || '(empty)'}`)
  try {
    const expr = String(process.env.PDF_JOBS_CRON || '*/1 * * * *')
    console.log(`[pdf-jobs][worker] cron=${expr}`)
    let inFlight = false
    const task = cron.schedule(expr, async () => {
      if (inFlight) return
      inFlight = true
      try {
        await runOnce()
      } catch (e: any) {
        console.error(`[pdf-jobs][worker] error message=${String(e?.message || '')} code=${String(e?.code || '')}`)
      } finally {
        inFlight = false
      }
    }, { scheduled: true })
    task.start()
    if (boolEnv('PDF_JOBS_RUN_ON_START', true)) {
      try { await runOnce() } catch (e: any) { console.error(`[pdf-jobs][worker] run_on_start_failed message=${String(e?.message || '')}`) }
    }
  } catch (e: any) {
    console.error(`[pdf-jobs][worker] init error message=${String(e?.message || '')}`)
  }
}

process.on('unhandledRejection', (reason: any) => {
  try { console.error(`[pdf-jobs][worker] unhandledRejection reason=${String((reason as any)?.message || reason || '')}`) } catch {}
})
process.on('uncaughtException', (err: any) => {
  try { console.error(`[pdf-jobs][worker] uncaughtException message=${String(err?.message || '')} code=${String(err?.code || '')}`) } catch {}
  process.exit(1)
})

main().catch((e: any) => {
  try { console.error(`[pdf-jobs][worker] fatal message=${String(e?.message || '')}`) } catch {}
  try { pgPool?.end?.() } catch {}
  process.exit(1)
})
