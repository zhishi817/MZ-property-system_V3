import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })
dotenv.config()

import cron from 'node-cron'
import { hasPg, pgPool } from './dbAdapter'
import { runCleaningBackfillOnce } from './services/cleaningBackfillRunner'

function boolEnv(name: string, def: boolean): boolean {
  const v = process.env[name]
  if (v == null) return def
  const s = String(v).toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

async function main() {
  const fastEnabled = boolEnv('CLEANING_BACKFILL_FAST_ENABLED', false)
  const slowEnabled = boolEnv('CLEANING_BACKFILL_SLOW_ENABLED', false)

  if (!(fastEnabled || slowEnabled)) {
    console.log('[cleaning-backfill][worker] disabled')
    return
  }
  if (!hasPg || !pgPool) {
    console.log('[cleaning-backfill][worker] pg=false')
    return
  }
  console.log('[cleaning-backfill][worker] starting')
  const lockName = String(process.env.CLEANING_BACKFILL_LOCK_NAME || 'cleaning_backfill')
  const lockTtlMs = Math.max(60000, Number(process.env.CLEANING_BACKFILL_LOCK_TTL_MS || (6 * 60 * 60 * 1000)))
  const minIntervalMs = Math.max(0, Number(process.env.CLEANING_BACKFILL_MIN_INTERVAL_MS || 0))
  const timeZone = String(process.env.CLEANING_BACKFILL_TIME_ZONE || 'Australia/Sydney')
  const renewEveryMs = Math.max(60000, Number(process.env.CLEANING_BACKFILL_LOCK_RENEW_MS || (2 * 60 * 1000)))
  const state: { lastRunAt?: number } = {}

  if (fastEnabled) {
    const expr = String(process.env.CLEANING_BACKFILL_FAST_CRON || '0 */4 * * *')
    const pastDays = Math.max(0, Number(process.env.CLEANING_BACKFILL_FAST_PAST_DAYS || 1))
    const futureDays = Math.max(0, Number(process.env.CLEANING_BACKFILL_FAST_FUTURE_DAYS || 7))
    const concurrency = Math.max(1, Math.min(25, Number(process.env.CLEANING_BACKFILL_FAST_CONCURRENCY || 10)))
    console.log(`[cleaning-backfill][fast][worker] enabled cron=${expr}`)
    const task = cron.schedule(expr, async () => {
      const r = await runCleaningBackfillOnce({ scheduleName: 'fast', lockName, lockTtlMs, lockRenewIntervalMs: renewEveryMs, timeZone, pastDays, futureDays, concurrency, minIntervalMs, state, triggerSource: 'schedule' })
      if (r?.skipped) console.log(`[cleaning-backfill][fast][worker] skipped_reason=${String((r as any).skipped_reason || '')}`)
      else if (r?.ok) console.log(`[cleaning-backfill][fast][worker] ok run_id=${String((r as any).run_id || '')} scanned=${Number((r as any).orders_scanned || 0)} failed=${Number((r as any).orders_failed || 0)} duration_ms=${Number((r as any).duration_ms || 0)}`)
      else console.error(`[cleaning-backfill][fast][worker] failed run_id=${String((r as any).run_id || '')} message=${String((r as any).error || '')}`)
    }, { scheduled: true })
    task.start()
    if (boolEnv('CLEANING_BACKFILL_FAST_RUN_ON_START', false)) {
      try {
        const r = await runCleaningBackfillOnce({ scheduleName: 'fast', lockName, lockTtlMs, lockRenewIntervalMs: renewEveryMs, timeZone, pastDays, futureDays, concurrency, minIntervalMs, state, triggerSource: 'schedule' })
        if (r?.skipped) console.log(`[cleaning-backfill][fast][worker] skipped_reason=${String((r as any).skipped_reason || '')}`)
        else if (r?.ok) console.log(`[cleaning-backfill][fast][worker] ok run_id=${String((r as any).run_id || '')} scanned=${Number((r as any).orders_scanned || 0)} failed=${Number((r as any).orders_failed || 0)} duration_ms=${Number((r as any).duration_ms || 0)}`)
        else console.error(`[cleaning-backfill][fast][worker] failed run_id=${String((r as any).run_id || '')} message=${String((r as any).error || '')}`)
      } catch {}
    }
  } else {
    console.log('[cleaning-backfill][fast][worker] disabled')
  }

  if (slowEnabled) {
    const expr = String(process.env.CLEANING_BACKFILL_SLOW_CRON || '0 3 */2 * *')
    const pastDays = Math.max(0, Number(process.env.CLEANING_BACKFILL_SLOW_PAST_DAYS || 14))
    const futureDays = Math.max(0, Number(process.env.CLEANING_BACKFILL_SLOW_FUTURE_DAYS || 30))
    const concurrency = Math.max(1, Math.min(25, Number(process.env.CLEANING_BACKFILL_SLOW_CONCURRENCY || 10)))
    console.log(`[cleaning-backfill][slow][worker] enabled cron=${expr}`)
    const task = cron.schedule(expr, async () => {
      const r = await runCleaningBackfillOnce({ scheduleName: 'slow', lockName, lockTtlMs, lockRenewIntervalMs: renewEveryMs, timeZone, pastDays, futureDays, concurrency, minIntervalMs, state, triggerSource: 'schedule' })
      if (r?.skipped) console.log(`[cleaning-backfill][slow][worker] skipped_reason=${String((r as any).skipped_reason || '')}`)
      else if (r?.ok) console.log(`[cleaning-backfill][slow][worker] ok run_id=${String((r as any).run_id || '')} scanned=${Number((r as any).orders_scanned || 0)} failed=${Number((r as any).orders_failed || 0)} duration_ms=${Number((r as any).duration_ms || 0)}`)
      else console.error(`[cleaning-backfill][slow][worker] failed run_id=${String((r as any).run_id || '')} message=${String((r as any).error || '')}`)
    }, { scheduled: true })
    task.start()
    if (boolEnv('CLEANING_BACKFILL_SLOW_RUN_ON_START', false)) {
      try {
        const r = await runCleaningBackfillOnce({ scheduleName: 'slow', lockName, lockTtlMs, lockRenewIntervalMs: renewEveryMs, timeZone, pastDays, futureDays, concurrency, minIntervalMs, state, triggerSource: 'schedule' })
        if (r?.skipped) console.log(`[cleaning-backfill][slow][worker] skipped_reason=${String((r as any).skipped_reason || '')}`)
        else if (r?.ok) console.log(`[cleaning-backfill][slow][worker] ok run_id=${String((r as any).run_id || '')} scanned=${Number((r as any).orders_scanned || 0)} failed=${Number((r as any).orders_failed || 0)} duration_ms=${Number((r as any).duration_ms || 0)}`)
        else console.error(`[cleaning-backfill][slow][worker] failed run_id=${String((r as any).run_id || '')} message=${String((r as any).error || '')}`)
      } catch {}
    }
  } else {
    console.log('[cleaning-backfill][slow][worker] disabled')
  }
}

process.on('unhandledRejection', (reason: any) => {
  try { console.error(`[cleaning-backfill][worker] unhandledRejection reason=${String((reason as any)?.message || reason || '')}`) } catch {}
})
process.on('uncaughtException', (err: any) => {
  try { console.error(`[cleaning-backfill][worker] uncaughtException message=${String(err?.message || '')} code=${String(err?.code || '')}`) } catch {}
  process.exit(1)
})

main().catch((e: any) => {
  try { console.error(`[cleaning-backfill][worker] fatal message=${String(e?.message || '')}`) } catch {}
  try { pgPool?.end?.() } catch {}
  process.exit(1)
})
