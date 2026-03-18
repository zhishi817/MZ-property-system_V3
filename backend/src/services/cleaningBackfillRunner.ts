import { v4 as uuid } from 'uuid'
import { tryAcquireJobLock, renewJobLock, releaseJobLock } from './jobLocks'
import { createJobRun, finishJobRun } from './jobRuns'

function formatYmdInTz(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return fmt.format(date)
}

function addDaysFromYmd(ymd: string, days: number, timeZone: string) {
  const baseUtcMidday = new Date(`${ymd}T12:00:00Z`)
  baseUtcMidday.setUTCDate(baseUtcMidday.getUTCDate() + days)
  return formatYmdInTz(baseUtcMidday, timeZone)
}

export function resolveBackfillWindow(params: { pastDays: number; futureDays: number; timeZone: string; now?: Date }) {
  const timeZone = String(params.timeZone || '').trim() || 'Australia/Sydney'
  const now = params.now || new Date()
  const today = formatYmdInTz(now, timeZone)
  const pastDays = Math.max(0, Math.floor(Number(params.pastDays || 0)))
  const futureDays = Math.max(0, Math.floor(Number(params.futureDays || 0)))
  const dateFrom = addDaysFromYmd(today, -pastDays, timeZone)
  const dateTo = addDaysFromYmd(today, futureDays, timeZone)
  return { dateFrom, dateTo, timeZone }
}

const inFlightByName: Record<string, boolean> = {}

export async function runCleaningBackfillOnce(params: {
  scheduleName: string
  lockName: string
  lockTtlMs: number
  lockRenewIntervalMs: number
  timeZone: string
  pastDays: number
  futureDays: number
  concurrency: number
  minIntervalMs?: number
  state?: { lastRunAt?: number }
  triggerSource: 'schedule' | 'cron_trigger' | 'manual' | 'external_cron'
}) {
  const scheduleName = String(params.scheduleName || '').trim() || 'unknown'
  const lockName = String(params.lockName || '').trim() || 'cleaning_backfill'
  const lockTtlMs = Math.max(60000, Number(params.lockTtlMs || 0))
  const renewEveryMs = Math.max(60000, Number(params.lockRenewIntervalMs || 0))
  const concurrency = Math.max(1, Math.min(25, Number(params.concurrency || 10)))
  const minIntervalMs = Math.max(0, Number(params.minIntervalMs || 0))
  const state = params.state || {}

  const { dateFrom, dateTo, timeZone } = resolveBackfillWindow({ pastDays: params.pastDays, futureDays: params.futureDays, timeZone: params.timeZone })
  const runId = uuid()
  const lockedBy = `pid:${process.pid}`
  const startedAt = Date.now()
  let jobRunRowId: string | null = null
  try {
    const jr = await createJobRun({
      job_name: 'cleaning_backfill',
      schedule_name: scheduleName,
      trigger_source: params.triggerSource,
      run_id: runId,
      lock_name: lockName,
      date_from: dateFrom,
      date_to: dateTo,
      time_zone: timeZone,
      concurrency,
    })
    jobRunRowId = jr?.id ? String(jr.id) : null
  } catch {}

  if (inFlightByName[lockName]) {
    const res = {
      ok: false as const,
      skipped: true as const,
      skipped_reason: 'in_flight' as const,
      run_id: runId,
      schedule_name: scheduleName,
      trigger_source: params.triggerSource,
      lock_name: lockName,
      lock_acquired: false,
      date_from: dateFrom,
      date_to: dateTo,
      time_zone: timeZone,
      concurrency,
      duration_ms: Date.now() - startedAt,
    }
    try {
      if (jobRunRowId) {
        await finishJobRun({
          id: jobRunRowId,
          lock_acquired: false,
          skipped: true,
          skipped_reason: res.skipped_reason,
          duration_ms: res.duration_ms,
          result: res,
        })
      }
    } catch {}
    return res
  }
  const nowTs = Date.now()
  if (minIntervalMs > 0 && (state.lastRunAt || 0) > 0 && (nowTs - (state.lastRunAt || 0)) < minIntervalMs) {
    const remainingMs = minIntervalMs - (nowTs - (state.lastRunAt || 0))
    const res = {
      ok: false as const,
      skipped: true as const,
      skipped_reason: 'min_interval' as const,
      remaining_ms: remainingMs,
      run_id: runId,
      schedule_name: scheduleName,
      trigger_source: params.triggerSource,
      lock_name: lockName,
      lock_acquired: false,
      date_from: dateFrom,
      date_to: dateTo,
      time_zone: timeZone,
      concurrency,
      duration_ms: Date.now() - startedAt,
    }
    try {
      if (jobRunRowId) {
        await finishJobRun({
          id: jobRunRowId,
          lock_acquired: false,
          skipped: true,
          skipped_reason: res.skipped_reason,
          duration_ms: res.duration_ms,
          result: res,
        })
      }
    } catch {}
    return res
  }

  inFlightByName[lockName] = true
  let acquired = false
  let renewTimer: any = null
  try {
    const lr = await tryAcquireJobLock({ name: lockName, ttl_ms: lockTtlMs, locked_by: lockedBy })
    if (!lr?.acquired) {
      const res = { ok: true as const, skipped: true as const, skipped_reason: String((lr as any)?.reason || 'already_running'), run_id: runId, date_from: dateFrom, date_to: dateTo, time_zone: timeZone }
      try {
        if (jobRunRowId) {
          await finishJobRun({
            id: jobRunRowId,
            lock_acquired: false,
            skipped: true,
            skipped_reason: res.skipped_reason,
            duration_ms: Date.now() - startedAt,
            result: res,
          })
        }
      } catch {}
      return res
    }
    acquired = true
    renewTimer = setInterval(async () => {
      try { await renewJobLock({ name: lockName, ttl_ms: lockTtlMs, locked_by: lockedBy }) } catch {}
    }, renewEveryMs)
    if (renewTimer && typeof renewTimer.unref === 'function') renewTimer.unref()

    const { backfillCleaningTasks } = require('./cleaningSync')
    const r = await backfillCleaningTasks({ dateFrom, dateTo, concurrency })
    const durationMs = Date.now() - startedAt
    state.lastRunAt = Date.now()
    const res = {
      ok: true as const,
      skipped: false as const,
      run_id: runId,
      schedule_name: scheduleName,
      trigger_source: params.triggerSource,
      lock_name: lockName,
      lock_acquired: true,
      date_from: dateFrom,
      date_to: dateTo,
      time_zone: timeZone,
      concurrency,
      orders_scanned: r.total || 0,
      orders_failed: r.failed || 0,
      orders_succeeded: Math.max(0, (r.total || 0) - (r.failed || 0)),
      tasks_created: r.created || 0,
      tasks_updated: r.updated || 0,
      tasks_cancelled: r.cancelled || 0,
      tasks_skipped_locked: r.skipped_locked || 0,
      tasks_no_change: r.no_change || 0,
      duration_ms: durationMs,
      tasks_before: r.tasks_before ?? null,
      tasks_after: r.tasks_after ?? null,
    }
    try {
      if (jobRunRowId) {
        await finishJobRun({
          id: jobRunRowId,
          lock_acquired: true,
          skipped: false,
          orders_scanned: res.orders_scanned,
          orders_succeeded: res.orders_succeeded,
          orders_failed: res.orders_failed,
          tasks_created: res.tasks_created,
          tasks_updated: res.tasks_updated,
          tasks_cancelled: res.tasks_cancelled,
          tasks_skipped_locked: res.tasks_skipped_locked,
          tasks_no_change: res.tasks_no_change,
          duration_ms: res.duration_ms,
          result: res,
        })
      }
    } catch {}
    return res
  } catch (e: any) {
    const durationMs = Date.now() - startedAt
    const res = {
      ok: false as const,
      skipped: false as const,
      run_id: runId,
      schedule_name: scheduleName,
      trigger_source: params.triggerSource,
      lock_name: lockName,
      lock_acquired: acquired,
      date_from: dateFrom,
      date_to: dateTo,
      time_zone: timeZone,
      concurrency,
      duration_ms: durationMs,
      error: String(e?.message || ''),
    }
    try {
      if (jobRunRowId) {
        await finishJobRun({ id: jobRunRowId, lock_acquired: acquired, skipped: false, duration_ms: durationMs, error_message: res.error, result: res })
      }
    } catch {}
    return res
  } finally {
    if (renewTimer) { try { clearInterval(renewTimer) } catch {} }
    if (acquired) { try { await releaseJobLock({ name: lockName, locked_by: lockedBy }) } catch {} }
    inFlightByName[lockName] = false
  }
}
