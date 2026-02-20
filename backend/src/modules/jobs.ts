import { Router } from 'express'
import { z } from 'zod'
import { requirePerm, allowCronTokenOrPerm } from '../auth'
import { hasPg, pgPool, pgSelect, pgInsertOnConflictDoNothing, pgInsert, pgRunInTransaction } from '../dbAdapter'
import { v4 as uuid } from 'uuid'
import { PoolClient } from 'pg'

type JobMode = 'incremental' | 'backfill'

function toDateOnly(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}
function parseMonthStr(s: string): number | null { const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']; const idx = months.indexOf(s.toLowerCase().slice(0,3)); return idx >= 0 ? idx + 1 : null }
function round2(n?: number): number | undefined { if (n == null) return undefined; const x = Number(n); if (!isFinite(x)) return undefined; return Number(x.toFixed(2)) }

export function ymdInTz(d: Date, tz: string): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-AU', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
  const parts = fmt.formatToParts(d)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value || '0')
  return { year: get('year'), month: get('month'), day: get('day') }
}

export function inferYearByDelta(baseYear: number, baseMonth: number, parsedMonth: number): number {
  const bm = Number(baseMonth)
  const pm = Number(parsedMonth)
  if (bm === 12 && (pm === 1 || pm === 2)) return baseYear + 1
  if (bm === 11 && pm === 1) return baseYear + 1
  if (bm === 1 && (pm === 12 || pm === 11)) return baseYear - 1
  if (bm === 2 && pm === 12) return baseYear - 1
  return baseYear
}

async function withAdvisoryLock<T>(key1: number, key2: number, fn: (dbClient: PoolClient) => Promise<T>): Promise<T> {
  if (!pgPool) { const err: any = new Error('pg unavailable'); err.status = 400; throw err }
  const dbClient = await pgPool.connect()
  let locked = false
  try {
    const got = await dbClient.query('SELECT pg_try_advisory_lock($1,$2) AS ok', [key1, key2])
    const ok = !!(got?.rows?.[0]?.ok)
    if (!ok) { const err: any = new Error('job already running'); err.status = 409; err.reason = 'locked'; throw err }
    locked = true
    const res = await fn(dbClient)
    return res
  } finally {
    try { if (locked) await dbClient.query('SELECT pg_advisory_unlock($1,$2)', [key1, key2]) } catch {}
    try { dbClient.release() } catch {}
  }
}

type DbClient = { query: (sql: string, params?: any[]) => Promise<any> } | null | undefined
function dbq(dbClient?: DbClient) {
  if (dbClient) return dbClient
  if (!pgPool) throw new Error('pgPool not initialized')
  return pgPool
}
function safeDbLog(table: string, action: string, payload: any, info?: any) {
  try {
    const cols = Array.isArray(info?.columns) ? info.columns : Object.keys(payload || {})
    const extra = info && !Array.isArray(info.columns) ? info : undefined
    const sample = { uid: payload?.uid, message_id: payload?.message_id, subject: payload?.subject, account: payload?.account, run_id: payload?.run_id }
    console.log(JSON.stringify({ tag: 'db_write', table, action, columns: cols, payload_keys: Object.keys(payload || {}), payload_sample: sample, extra }))
  } catch {}
}

const LOG_BODY = String(process.env.LOG_EMAIL_BODY || '0') === '1'
const DEBUG_RAW = String(process.env.EMAIL_SYNC_DEBUG_RAW || '0') === '1'
const SNIP = Number(process.env.EMAIL_SYNC_BODY_SNIPPET || 300)
function snippet(s?: string | null): string | null {
  if (!s) return null
  const t = String(s)
  return t.length > SNIP ? (t.slice(0, SNIP) + `…(len=${t.length})`) : `${t} (len=${t.length})`
}

function assertItemStatus(status: string) {
  const ok = ['scanned','matched','raw_saved','parsed','mapped','inserted','updated','skipped','failed']
  if (!ok.includes(String(status))) {
    const err: any = new Error(`invalid_item_status: ${status}`)
    err.code = 'status_invalid'
    throw err
  }
}

async function ensureEmailState(account: string, dbClient?: PoolClient) {
  await dbq(dbClient).query('INSERT INTO email_sync_state(account, last_uid, last_checked_at) VALUES($1, 0, now()) ON CONFLICT(account) DO NOTHING', [account])
}
async function getEmailState(account: string, dbClient?: PoolClient): Promise<{ last_uid: number; last_checked_at?: string; last_backfill_at?: string; last_connected_at?: string; consecutive_failures?: number; cooldown_until?: string }> {
  const rs = await dbq(dbClient).query('SELECT last_uid, last_checked_at, last_backfill_at, last_connected_at, consecutive_failures, cooldown_until FROM email_sync_state WHERE account=$1', [account])
  const r = rs?.rows?.[0]
  return { last_uid: Number(r?.last_uid || 0), last_checked_at: r?.last_checked_at, last_backfill_at: r?.last_backfill_at, last_connected_at: r?.last_connected_at, consecutive_failures: Number(r?.consecutive_failures || 0), cooldown_until: r?.cooldown_until }
}
async function setEmailStateIncremental(account: string, lastUid: number, dbClient?: PoolClient) {
  await dbq(dbClient).query('UPDATE email_sync_state SET last_uid=$2, last_checked_at=now() WHERE account=$1', [account, lastUid])
}
async function setEmailStateBackfill(account: string, dbClient?: PoolClient) { await dbq(dbClient).query('UPDATE email_sync_state SET last_checked_at=now(), last_backfill_at=now() WHERE account=$1', [account]) }
async function setLastConnectedAt(account: string, dbClient?: PoolClient) { await dbq(dbClient).query('UPDATE email_sync_state SET last_connected_at=now() WHERE account=$1', [account]) }
async function resetFailures(account: string, dbClient?: PoolClient) { await dbq(dbClient).query('UPDATE email_sync_state SET consecutive_failures=0, cooldown_until=NULL WHERE account=$1', [account]) }
async function addFailureAndMaybeCooldown(account: string, threshold: number, cooldownMinutes: number): Promise<{ cooldown_until?: string }> {
  if (!pgPool) return {}
  const rs = await pgPool.query('UPDATE email_sync_state SET consecutive_failures = coalesce(consecutive_failures,0) + 1 WHERE account=$1 RETURNING consecutive_failures', [account])
  const n = Number(rs?.rows?.[0]?.consecutive_failures || 0)
  if (n >= threshold) {
    const crs = await pgPool.query("UPDATE email_sync_state SET cooldown_until = now() + ($2 || ':minutes')::interval WHERE account=$1 RETURNING cooldown_until", [account, String(cooldownMinutes)])
    const cd = crs?.rows?.[0]?.cooldown_until
    try { await logJobStateChange({ job_type: 'email_sync', account, event: 'cooldown_set', next: { cooldown_until: cd } }) } catch {}
    return { cooldown_until: cd }
  }
  return {}
}
async function logSyncRun(account: string, m: { scanned: number; matched: number; inserted: number; failed: number; skipped_duplicate: number; last_uid_before?: number; last_uid_after?: number; error_code?: string; duration_ms: number }, dbClient?: PoolClient) {
  await pgInsert('email_sync_runs', { account, scanned: m.scanned, matched: m.matched, inserted: m.inserted, failed: m.failed, skipped_duplicate: m.skipped_duplicate, last_uid_before: m.last_uid_before, last_uid_after: m.last_uid_after, error_code: m.error_code, duration_ms: m.duration_ms }, dbClient)
}
async function logSyncStart(account: string, last_uid_before: number | null, uid_range_queried: string, dbClient?: PoolClient, trigger_source?: string): Promise<string | number | null> {
  try {
    const check = await dbq(dbClient).query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='email_sync_runs'")
    const cols = (check?.rows || []).map((r: any) => String(r.column_name || ''))
    const isLegacy = cols.includes('run_id') && cols.includes('cursor_before') && cols.includes('uid_range_queried') && !cols.includes('id')
    if (isLegacy) {
      const { v4: uuidv4 } = require('uuid')
      const runIdVal: string = uuidv4()
      const sql = 'INSERT INTO email_sync_runs (run_id, account, cursor_before, uid_range_queried, last_uid_before, status, started_at) VALUES ($1,$2,$3,$4,$5,$6,now()) RETURNING run_id'
      const r = await dbq(dbClient).query(sql, [runIdVal, account, Number(last_uid_before || 0), String(uid_range_queried || ''), last_uid_before ?? null, 'running'])
      return String(r?.rows?.[0]?.run_id || runIdVal)
    }
    const r = await dbq(dbClient).query('INSERT INTO email_sync_runs (account, trigger_source, last_uid_before, status, started_at) VALUES ($1,$2,$3,$4,now()) RETURNING id, run_id', [account, trigger_source ?? null, last_uid_before ?? null, 'running'])
    const iid = r?.rows?.[0]?.id
    const rid = r?.rows?.[0]?.run_id
    try { await logJobStateChange({ job_type: 'email_sync', account, run_id: rid ?? iid, event: 'run_started', next: { status: 'running', last_uid_before } }, dbClient) } catch {}
    return (iid != null ? Number(iid) : (rid != null ? String(rid) : null))
  } catch (e) { return null }
}
async function logSyncFinish(runId: string | number | null, account: string, m: { scanned: number; matched: number; inserted: number; failed: number; skipped_duplicate: number; last_uid_before?: number; last_uid_after?: number; duration_ms: number; status?: string; cursor_after?: number; error_message?: string; skipped_reason_counts?: any; failed_reason_counts?: any }, dbClient?: PoolClient) {
  if (!runId) return
  const isStr = typeof runId === 'string'
  if (isStr) {
    {
      const cols = (await dbq(dbClient).query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='email_sync_runs'")).rows.map((r:any)=>String(r.column_name))
      const endCol = cols.includes('ended_at') ? 'ended_at' : (cols.includes('finished_at') ? 'finished_at' : null)
      const sets: string[] = []
      if (cols.includes('scanned')) sets.push('scanned=$2')
      if (cols.includes('matched')) sets.push('matched=$3')
      if (cols.includes('inserted')) sets.push('inserted=$4')
      if (cols.includes('failed')) sets.push('failed=$5')
      if (cols.includes('skipped_duplicate')) sets.push('skipped_duplicate=$6')
      if (cols.includes('found_uids_count')) sets.push('found_uids_count=$7')
      if (cols.includes('matched_count')) sets.push('matched_count=$8')
      if (cols.includes('failed_count')) sets.push('failed_count=$9')
      if (cols.includes('last_uid_before')) sets.push('last_uid_before=$10')
      if (cols.includes('last_uid_after')) sets.push('last_uid_after=$11')
      if (cols.includes('duration_ms')) sets.push('duration_ms=$12')
      if (cols.includes('status')) sets.push('status=$13')
      if (cols.includes('cursor_after')) sets.push('cursor_after=$14')
      if (cols.includes('error_message')) sets.push('error_message=$15')
      if (cols.includes('skipped_reason_counts')) sets.push('skipped_reason_counts=$16')
      if (cols.includes('failed_reason_counts')) sets.push('failed_reason_counts=$17')
      if (endCol) sets.push(`${endCol}=now()`)
      const sql = `UPDATE email_sync_runs SET ${sets.join(', ')} WHERE run_id=$1`
      await dbq(dbClient).query(sql, [runId, m.scanned, m.matched, m.inserted, m.failed, m.skipped_duplicate, m.scanned, m.matched, m.failed, m.last_uid_before, m.last_uid_after, m.duration_ms, String(m.status || (m.failed > 0 ? 'failed' : 'success')), m.cursor_after ?? m.last_uid_after ?? null, m.error_message ?? null, m.skipped_reason_counts ? JSON.stringify(m.skipped_reason_counts) : null, m.failed_reason_counts ? JSON.stringify(m.failed_reason_counts) : null])
      try { await logJobStateChange({ job_type: 'email_sync', account, run_id: runId, event: 'run_completed', prev: { status: 'running' }, next: { status: String(m.status || (m.failed > 0 ? 'failed' : 'success')), scanned: m.scanned, inserted: m.inserted, failed: m.failed, last_uid_after: m.last_uid_after } }, dbClient) } catch {}
    }
  } else {
    {
      const cols = (await dbq(dbClient).query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='email_sync_runs'")).rows.map((r:any)=>String(r.column_name))
      const endCol = cols.includes('ended_at') ? 'ended_at' : (cols.includes('finished_at') ? 'finished_at' : null)
      const sets: string[] = []
      if (cols.includes('scanned')) sets.push('scanned=$2')
      if (cols.includes('matched')) sets.push('matched=$3')
      if (cols.includes('inserted')) sets.push('inserted=$4')
      if (cols.includes('failed')) sets.push('failed=$5')
      if (cols.includes('skipped_duplicate')) sets.push('skipped_duplicate=$6')
      if (cols.includes('found_uids_count')) sets.push('found_uids_count=$7')
      if (cols.includes('matched_count')) sets.push('matched_count=$8')
      if (cols.includes('failed_count')) sets.push('failed_count=$9')
      if (cols.includes('last_uid_before')) sets.push('last_uid_before=$10')
      if (cols.includes('last_uid_after')) sets.push('last_uid_after=$11')
      if (cols.includes('duration_ms')) sets.push('duration_ms=$12')
      if (cols.includes('status')) sets.push('status=$13')
      if (cols.includes('cursor_after')) sets.push('cursor_after=$14')
      if (cols.includes('error_message')) sets.push('error_message=$15')
      if (cols.includes('skipped_reason_counts')) sets.push('skipped_reason_counts=$16')
      if (cols.includes('failed_reason_counts')) sets.push('failed_reason_counts=$17')
      if (endCol) sets.push(`${endCol}=now()`)
      const sql = `UPDATE email_sync_runs SET ${sets.join(', ')} WHERE id=$1`
      await dbq(dbClient).query(sql, [runId, m.scanned, m.matched, m.inserted, m.failed, m.skipped_duplicate, m.scanned, m.matched, m.failed, m.last_uid_before, m.last_uid_after, m.duration_ms, String(m.status || (m.failed > 0 ? 'failed' : 'success')), m.cursor_after ?? m.last_uid_after ?? null, m.error_message ?? null, m.skipped_reason_counts ? JSON.stringify(m.skipped_reason_counts) : null, m.failed_reason_counts ? JSON.stringify(m.failed_reason_counts) : null])
      try { await logJobStateChange({ job_type: 'email_sync', account, run_id: runId, event: 'run_completed', prev: { status: 'running' }, next: { status: String(m.status || (m.failed > 0 ? 'failed' : 'success')), scanned: m.scanned, inserted: m.inserted, failed: m.failed, last_uid_after: m.last_uid_after } }, dbClient) } catch {}
    }
  }
}
async function logSyncError(runId: string | number | null, account: string, error_code: string, error_message: string, duration_ms: number, last_uid_after?: number, dbClient?: PoolClient) {
  if (!runId) return
  const isStr = typeof runId === 'string'
  if (isStr) {
    {
      const cols = (await dbq(dbClient).query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='email_sync_runs'")).rows.map((r:any)=>String(r.column_name))
      const endCol = cols.includes('ended_at') ? 'ended_at' : (cols.includes('finished_at') ? 'finished_at' : null)
      const sets = ['error_code=$2','error_message=$3','duration_ms=$4','status=$5','last_uid_after=$6']
      if (endCol) sets.push(`${endCol}=now()`)
      const sql = `UPDATE email_sync_runs SET ${sets.join(', ')} WHERE run_id=$1`
      await dbq(dbClient).query(sql, [runId, error_code, error_message, duration_ms, 'failed', last_uid_after])
      try { await logJobStateChange({ job_type: 'email_sync', account, run_id: runId, event: 'run_failed', prev: { status: 'running' }, next: { status: 'failed', error_code, error_message } }, dbClient) } catch {}
    }
  } else {
    {
      const cols = (await dbq(dbClient).query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='email_sync_runs'")).rows.map((r:any)=>String(r.column_name))
      const endCol = cols.includes('ended_at') ? 'ended_at' : (cols.includes('finished_at') ? 'finished_at' : null)
      const sets = ['error_code=$2','error_message=$3','duration_ms=$4','status=$5','last_uid_after=$6']
      if (endCol) sets.push(`${endCol}=now()`)
      const sql = `UPDATE email_sync_runs SET ${sets.join(', ')} WHERE id=$1`
      await dbq(dbClient).query(sql, [runId, error_code, error_message, duration_ms, 'failed', last_uid_after])
      try { await logJobStateChange({ job_type: 'email_sync', account, run_id: runId, event: 'run_failed', prev: { status: 'running' }, next: { status: 'failed', error_code, error_message } }, dbClient) } catch {}
    }
  }
}

async function ensureEmailSyncTables() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS email_sync_state (
    account text PRIMARY KEY,
    last_uid bigint DEFAULT 0,
    last_checked_at timestamptz,
    last_backfill_at timestamptz,
    last_connected_at timestamptz,
    consecutive_failures integer DEFAULT 0,
    cooldown_until timestamptz
  );`)
  await pgPool.query('ALTER TABLE email_sync_state ADD COLUMN IF NOT EXISTS last_connected_at timestamptz')
  await pgPool.query('ALTER TABLE email_sync_state ADD COLUMN IF NOT EXISTS consecutive_failures integer DEFAULT 0')
  await pgPool.query('ALTER TABLE email_sync_state ADD COLUMN IF NOT EXISTS cooldown_until timestamptz')
  await pgPool.query(`CREATE TABLE IF NOT EXISTS email_sync_runs (
    id bigserial PRIMARY KEY,
    account text NOT NULL,
    trigger_source text,
    scanned integer DEFAULT 0,
    matched integer DEFAULT 0,
    inserted integer DEFAULT 0,
    failed integer DEFAULT 0,
    skipped_duplicate integer DEFAULT 0,
    last_uid_before bigint,
    last_uid_after bigint,
    error_code text,
    error_message text,
    duration_ms integer,
    status text,
    started_at timestamptz DEFAULT now(),
    ended_at timestamptz
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_email_sync_runs_account_started ON email_sync_runs(account, started_at)')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS trigger_source text')
  // Backfill columns for legacy schemas
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS scanned integer DEFAULT 0')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS matched integer DEFAULT 0')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS inserted integer DEFAULT 0')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS failed integer DEFAULT 0')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS skipped_duplicate integer DEFAULT 0')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS last_uid_before bigint')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS last_uid_after bigint')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS error_code text')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS error_message text')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS duration_ms integer')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS status text')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS started_at timestamptz DEFAULT now()')
  await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS ended_at timestamptz')
}

async function ensureJobStateChangesTable() {
  try { await pgPool!.query(`CREATE TABLE IF NOT EXISTS job_state_changes (
    id uuid PRIMARY KEY,
    job_type text,
    account text,
    run_id text,
    event text,
    prev jsonb,
    next jsonb,
    trigger_source text,
    reason text,
    created_at timestamptz DEFAULT now()
  );`) } catch {}
  try { await pgPool!.query('CREATE INDEX IF NOT EXISTS idx_job_state_changes_account_created ON job_state_changes(account, created_at)') } catch {}
}

async function logJobStateChange(payload: { job_type: string; account?: string; run_id?: string | number | null; event: string; prev?: any; next?: any; trigger_source?: string; reason?: string }, client?: PoolClient) {
  try {
    const enabled = String(process.env.JOB_STATE_LOG_ENABLED || 'true').toLowerCase() === 'true'
    if (!enabled || !pgPool) return
    await ensureJobStateChangesTable()
    const exec = client || pgPool!
    const id = require('uuid').v4()
    const row = { id, job_type: payload.job_type, account: payload.account || null, run_id: payload.run_id != null ? String(payload.run_id) : null, event: payload.event, prev: payload.prev ? JSON.stringify(payload.prev) : null, next: payload.next ? JSON.stringify(payload.next) : null, trigger_source: payload.trigger_source || null, reason: payload.reason || null }
    await exec.query('INSERT INTO job_state_changes (id, job_type, account, run_id, event, prev, next, trigger_source, reason) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)', [row.id, row.job_type, row.account, row.run_id, row.event, row.prev, row.next, row.trigger_source, row.reason])
  } catch {}
}

export async function resolveUidSinceDate(account: string, startDate: string): Promise<number> {
  const { ImapFlow } = require('imapflow')
  const accounts = getAccounts()
  const acc = accounts.find(a => String(a.user) === String(account))
  if (!acc) throw Object.assign(new Error('missing imap account'), { status: 400, reason: 'missing_account' })
  const imap = new ImapFlow({ host: 'imap.exmail.qq.com', port: 993, secure: true, auth: { user: acc.user, pass: acc.pass }, socketTimeout: Number(process.env.EMAIL_SYNC_SOCKET_TIMEOUT_MS || 120000) })
  try {
    await imap.connect()
    await imap.mailboxOpen(acc.folder)
    const sinceDate = new Date(`${startDate}T00:00:00`)
    const list: number[] = await imap.search({ since: sinceDate }, { uid: true })
    if (!Array.isArray(list) || list.length === 0) throw Object.assign(new Error('no uid since date'), { status: 404, reason: 'no_uid_since_date' })
    const minUid = Math.min(...list)
    if (!Number.isFinite(minUid)) throw Object.assign(new Error('invalid uid'), { status: 500, reason: 'invalid_uid' })
    return minUid
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (/auth/i.test(msg)) throw Object.assign(new Error('imap auth failed'), { status: 401, reason: 'imap_auth_failed' })
    if (/timeout|socket|network|unavailable/i.test(msg)) throw Object.assign(new Error('imap network error'), { status: 503, reason: 'imap_network_error' })
    throw Object.assign(new Error('imap search failed'), { status: Number(e?.status || 500), reason: e?.reason || 'imap_search_failed' })
  } finally {
    try { await imap.logout() } catch {}
  }
}

async function cleanupStaleRunning() {
  if (!pgPool) return
  try {
    await ensureEmailSyncTables()
    await pgPool.query("UPDATE email_sync_runs SET status='failed', error_code='stale_running', error_message='auto-fix: started_at older than 10 minutes', ended_at=now() WHERE status='running' AND started_at < now() - interval '10 minutes'")
  } catch {}
}

async function ensureEmailSyncItemsTables() {
  if (!pgPool) return
  try {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS email_sync_items (
      id bigserial PRIMARY KEY,
      run_id uuid,
      account text,
      uid bigint,
      status text,
      error_code text,
      error_message text,
      message_id text,
      mailbox text,
      subject text,
      sender text,
      header_date timestamptz,
      reason text,
      parse_preview text,
      order_id text,
      listing_name text,
      created_at timestamptz DEFAULT now()
    )`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_email_sync_items_run_uid ON email_sync_items(run_id, uid)')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS mailbox text')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS subject text')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS sender text')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS header_date timestamptz')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS reason text')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS parse_preview text')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS order_id text')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS listing_name text')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS parse_probe jsonb')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS confirmation_code text')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS error_code text')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS error_message text')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS account text')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS uid bigint')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS status text')
    await pgPool.query('ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS run_id uuid')
    try { await pgPool.query('ALTER TABLE email_sync_items ALTER COLUMN run_id SET NOT NULL') } catch {}
    await pgPool.query(`CREATE TABLE IF NOT EXISTS order_cancellations (
      id uuid PRIMARY KEY,
      confirmation_code text UNIQUE,
      message_id text,
      header_date timestamptz,
      subject text,
      sender text,
      source text,
      account text,
      created_at timestamptz DEFAULT now()
    )`)
    await pgPool.query(`CREATE TABLE IF NOT EXISTS email_orders_raw (
      source text NOT NULL,
      uid bigint,
      message_id text,
      header_date timestamptz,
      email_header_at timestamptz,
      envelope jsonb,
      html text,
      plain text,
      status text,
      subject text,
      sender text,
      confirmation_code text,
      guest_name text,
      listing_name text,
      checkin date,
      checkout date,
      price numeric,
      net_income numeric,
      account text,
      extra jsonb,
      created_at timestamptz DEFAULT now(),
      UNIQUE(source, uid),
      UNIQUE(message_id)
    )`)
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS status text')
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS subject text')
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS sender text')
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS confirmation_code text')
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS guest_name text')
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS listing_name text')
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS checkin date')
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS checkout date')
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS price numeric')
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS net_income numeric')
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS account text')
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS extra jsonb')
    await pgPool.query('ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS email_header_at timestamptz')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_email_orders_raw_email_header_at ON email_orders_raw(email_header_at)')
    try { await pgPool.query('CREATE INDEX IF NOT EXISTS idx_orders_email_header_at ON orders(email_header_at)') } catch {}
    await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS found_uids_count integer DEFAULT 0')
    await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS matched_count integer DEFAULT 0')
    await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS failed_count integer DEFAULT 0')
    await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS cursor_after bigint')
    await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS skipped_reason_counts jsonb')
    await pgPool.query('ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS failed_reason_counts jsonb')
  } catch {}
}

function getAccounts(): Array<{ user: string; pass: string; folder: string }> {
  const list: Array<{ user: string; pass: string; folder: string }> = []
  const u = String(process.env.AIRBNB_IMAP_USER || '').trim()
  const p = String(process.env.AIRBNB_IMAP_PASS || '').trim()
  const f = String(process.env.AIRBNB_IMAP_FOLDER || 'INBOX').trim()
  if (u && p) list.push({ user: u, pass: p, folder: f })
  const combo = String(process.env.AIRBNB_IMAP_ACCOUNTS || '').trim()
  if (combo) {
    combo.split(';').map(s => s.trim()).filter(Boolean).forEach(pair => {
      const [uu, pp] = pair.split(':')
      if (uu && pp) list.push({ user: uu.trim(), pass: pp.trim(), folder: f })
    })
  }
  return list
}

async function loadPropertyIndex(): Promise<Record<string, string>> {
  const byName: Record<string, string> = {}
  try {
    if (hasPg) {
      const rowsRaw: any = await pgSelect('properties', 'id,airbnb_listing_name')
      const rows: any[] = Array.isArray(rowsRaw) ? rowsRaw : []
      function normalizeIndexKey(s: string): string {
        const t = normalizeText(String(s || ''))
        const x = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
        return x.trim().toLowerCase()
      }
      rows.forEach((p: any) => {
        const nm = normalizeIndexKey(String(p.airbnb_listing_name || ''))
        if (nm) byName[nm] = String(p.id)
      })
    }
  } catch {}
  return byName
}

function normalizeText(s: string): string { return String(s || '').replace(/\s+/g, ' ').trim() }

export function extractFieldsFromHtml(html: string, headerDate: Date): {
  confirmation_code?: string
  guest_name?: string
  listing_name?: string
  checkin?: string
  checkout?: string
  nights?: number
  price?: number
  cleaning_fee?: number
  raw_checkin_text?: string
  raw_checkout_text?: string
  year_inferred?: boolean
  probe?: any
} {
  const cheerio = require('cheerio')
  const $ = cheerio.load(html || '')
  const bodyText = normalizeText(($('body').text() || ''))
  const mel = ymdInTz(headerDate, 'Australia/Melbourne')
  const baseYear = mel.year
  const baseMonth = mel.month
  let confirmation_code: string | undefined
  let guest_name: string | undefined
  let listing_name: string | undefined
  let checkin: string | undefined
  let checkout: string | undefined
  let nights: number | undefined
  let price: number | undefined
  let cleaning_fee: number | undefined
  let raw_checkin_text: string | undefined
  let raw_checkout_text: string | undefined
  let year_inferred: boolean | undefined
  function pickCodeCandidates(): string[] {
    const list: string[] = []
    $('p, div, td, span').each((_i: number, el: any) => {
      const t = normalizeText($(el).text() || '')
      if (!t) return
      if (/^[A-Z0-9]{6,12}$/.test(t)) list.push(t)
    })
    return Array.from(new Set(list))
  }
  function scoreCode(s: string): number {
    let sc = 0
    if (s.length >= 8 && s.length <= 10) sc += 10
    if (/[A-Z]/.test(s)) sc += 2
    if (/\d/.test(s)) sc += 2
    return sc
  }
  const codeCandidates = pickCodeCandidates().sort((a, b) => scoreCode(b) - scoreCode(a))
  confirmation_code = codeCandidates[0]
  const m2 = /New booking confirmed!\s*(.*?)\s+arrives/i.exec(bodyText)
  if (m2) guest_name = normalizeText(m2[1])
  function badHeading(t: string): boolean {
    const s = t.toLowerCase()
    if (!s) return true
    if (s.length < 6) return true
    if (/reservation confirmed|new booking confirmed|write a review|last chance|reminder to write a review|rated their stay|left a \d-star review|there are only/i.test(s)) return true
    if (/view listing|view details|learn more|see listing|open listing|details/i.test(s)) return true
    // allow headings that include room type; they will be cleaned later
    return false
  }
  function cleanListingName(s?: string): string {
    const t = normalizeText(String(s || ''))
    let x = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    // remove leading room-type prefix
    x = x.replace(/^(?:entire\s+(?:home(?:\/apt)?|apt|rental\s+unit|condo|apartment|place)|(?:private|shared|hotel)\s+room)\s*[·•\-|–—]?\s*/i, '')
    // remove trailing room-type suffix (sometimes concatenated without separator)
    x = x.replace(/\s*(?:[·•\-|–—]?\s*)?(?:entire\s+(?:home(?:\/apt)?|apt|rental\s+unit|condo|apartment|place)|(?:private|shared|hotel)\s+room)\s*$/i, '')
    // remove any mid-string lone separators at ends
    x = x.replace(/^[·•\-|–—\s]+/, '').replace(/[·•\-|–—\s]+$/,'')
    return normalizeText(x)
  }
  function findByRoomLink(): string | undefined {
    let cand: string | undefined
    const anchors = $('a[href*="airbnb.com/rooms"], a[href*="/rooms/"]')
    anchors.each((_i: number, a: any) => {
      const $a = $(a)
      const local = normalizeText(($a.attr('aria-label') || $a.attr('title') || $a.text() || ''))
      if (local && !badHeading(local)) { cand = local; return false }
      const scope = $a.closest('td,div,section')
      const near = scope.find('h1,h2,h3').filter((_j: number, el: any) => {
        const t = normalizeText($(el).text() || '')
        return !!t && !badHeading(t)
      }).first()
      if (near.length) { cand = normalizeText(near.text() || '') ; return false }
      const sib = $a.nextAll('h1,h2,h3').first()
      if (sib.length) {
        const t = normalizeText(sib.text() || '')
        if (t && !badHeading(t)) { cand = t; return false }
      }
      const h2c = scope.find('h2.heading2').first()
      const t2 = normalizeText(h2c.text() || '')
      if (t2 && !badHeading(t2)) { cand = t2; return false }
    })
    return cand
  }
  listing_name = findByRoomLink() || undefined
  if (!listing_name) {
    let firstGood = ''
    $('h1,h2,h3').each(( _i: number, el: any) => { const txt = normalizeText($(el).text()); if (!badHeading(txt) && !firstGood) firstGood = txt })
    if (firstGood) listing_name = firstGood
  }
  if (listing_name) listing_name = cleanListingName(listing_name)
  function pickDateFlexible(kind: 'checkin' | 'checkout'): { date?: string; raw?: string } {
    const labelRe = kind === 'checkin' ? /check\s*[--–—]?\s*in/i : /check\s*[--–—]?\s*out/i
    const idx = bodyText.search(labelRe)
    if (idx < 0) return {}
    const windowRaw = bodyText.slice(idx, idx + 120)
    const joinFix = kind === 'checkin'
      ? /(check\s*[--–—]?\s*in)(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/i
      : /(check\s*[--–—]?\s*out)(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/i
    const window = windowRaw.replace(joinFix, '$1 $2')
    const dayRe = /\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\s*(\d{1,2})\s+([A-Za-z]{3,9})/i
    const m = dayRe.exec(window)
    if (!m) return {}
    const day = Number(m[2])
    const mon = parseMonthStr(m[3] || '') || 0
    if (!mon || !day) return {}
    const y = inferYearByDelta(baseYear, baseMonth, mon)
    return { date: toDateOnly(y, mon, day), raw: normalizeText(m[0] || '') }
  }
  {
    const r = pickDateFlexible('checkin')
    if (r.date) { checkin = r.date; raw_checkin_text = r.raw }
  }
  {
    const r = pickDateFlexible('checkout')
    if (r.date) { checkout = r.date; raw_checkout_text = r.raw }
  }
  // Fallback: some templates show dates as headings without explicit labels
  function pickDatesFromHeadings(): Array<{ date: string; raw: string }> {
    const out: Array<{ date: string; raw: string }> = []
    $('p.heading2, h2.heading2, .heading2').each((_i: number, el: any) => {
      const t = normalizeText($(el).text() || '')
      if (!t) return
      const m = /([A-Za-z]{3,9}),?\s*(\d{1,2})\s+([A-Za-z]{3,9})/i.exec(t)
      if (!m) return
      const day = Number(m[2])
      const mon = parseMonthStr(m[3] || '') || 0
      if (!mon || !day) return
      const y = inferYearByDelta(baseYear, baseMonth, mon)
      out.push({ date: toDateOnly(y, mon, day), raw: normalizeText(m[0] || '') })
    })
    return out
  }
  if (!checkin || !checkout) {
    const ds = pickDatesFromHeadings()
    if (!checkin && ds[0]) { checkin = ds[0].date; raw_checkin_text = ds[0].raw }
    if (!checkout && ds[1]) { checkout = ds[1].date; raw_checkout_text = ds[1].raw }
  }
  const mx = /([0-9]+)\s+nights\s+room\s+fee/i.exec(bodyText)
  if (mx) nights = Number(mx[1])
  function parseAmountAfter(label: string): number | undefined {
    const re = new RegExp(label + '\\s*[$]?\\s*([0-9][0-9,.]*)', 'i')
    const m = re.exec(bodyText)
    if (!m) return undefined
    const v = Number(String(m[1]).replace(/[,]/g, ''))
    return isNaN(v) ? undefined : v
  }
  price = parseAmountAfter('You earn')
  cleaning_fee = parseAmountAfter('Cleaning fee') || 0
  const probe = { code_candidates: codeCandidates, listing_name_raw: listing_name, dates: { checkin_text: raw_checkin_text, checkout_text: raw_checkout_text }, amount: { price, cleaning_fee } }
  return { confirmation_code, guest_name, listing_name, checkin, checkout, nights, price, cleaning_fee, raw_checkin_text, raw_checkout_text, year_inferred, probe }
}

async function processMessage(acc: { user: string; pass: string; folder: string }, msg: any, propIndex: Record<string, string>, dryRun: boolean, sourceTag: string) {
  const mailparser = require('mailparser')
  let parsed: any
  try { parsed = await mailparser.simpleParser(msg.source) } catch { return { matched: false, inserted: false, skipped_duplicate: false, failed: false, reason: 'parse_error', last_uid: Number(msg.uid || 0) } }
  const from = String(parsed.from?.text || '')
  const subject = String(parsed.subject || '')
  const html = String(parsed.html || '')
  const headerDate: Date | null = parsed.date ? new Date(parsed.date) : null
  if (!headerDate) {
    if (!dryRun && hasPg) { try { await pgInsert('order_import_staging', { id: uuid(), channel: 'airbnb_email', raw_row: { message_id: String(parsed.messageId || ''), subject, from, html_snippet: (html || '').slice(0, 2000) }, reason: 'missing_header_date', status: 'unmatched' }) } catch {} }
    return { matched: false, inserted: false, skipped_duplicate: false, failed: false, reason: 'no_dates', last_uid: Number(msg.uid || 0) }
  }
  const fields = extractFieldsFromHtml(html, headerDate)
  const isAirbnb = /airbnb\.com/i.test(from)
  const subj = subject || ''
  const isReservationConfirmed = /reservation confirmed/i.test(subj)
  const isNewBookingConfirmed = /new booking confirmed/i.test(subj)
  const isReservationAltered = /reservation altered/i.test(subj)
  const isReservationCancelled = /reservation (cancelled|canceled)/i.test(subj)
  const isCancelViaSubject = /\bcancel\s+reservation\b/i.test(subj)
  const isCancelViaBody = /\bcancel\s+reservation\b/i.test(String((parsed.text || '') + ' ' + (parsed.html || '')))
  const isOrderMail = isReservationConfirmed || isNewBookingConfirmed || isReservationAltered || isReservationCancelled || isCancelViaSubject
  if (!isAirbnb || !isOrderMail) {
    return { matched: false, inserted: false, skipped_duplicate: false, failed: false, reason: 'not_whitelisted', last_uid: Number(msg.uid || 0) }
  }
  const isCancellationMail = isReservationCancelled || /^cancelled:\s*reservation/i.test(subj) || isCancelViaSubject || isCancelViaBody
  const cc = (String(fields.confirmation_code || '').match(/\b[A-Z0-9]{8,10}\b/)?.[0] || '').trim()
  if (!cc) {
    if (!dryRun && hasPg) {
      try { await pgInsert('order_import_staging', { id: uuid(), channel: 'airbnb_email', raw_row: { message_id: String(parsed.messageId || ''), subject, from, html_snippet: (html || '').slice(0, 2000) }, reason: 'missing_field:confirmation_code', status: 'unmatched' }) } catch {}
    }
    const sample = {
      confirmation_code: cc,
      guest_name: fields.guest_name,
      listing_name: fields.listing_name,
      checkin: fields.checkin,
      checkout: fields.checkout,
      nights: fields.nights,
      price: fields.price,
      cleaning_fee: fields.cleaning_fee,
      net_income: Number(((fields.price || 0) - (fields.cleaning_fee || 0)).toFixed?.(2) || ((fields.price || 0) - (fields.cleaning_fee || 0))),
      avg_nightly_price: (fields.nights && fields.nights > 0) ? Number((((fields.price || 0) - (fields.cleaning_fee || 0)) / fields.nights).toFixed(2)) : 0,
      property_match: false,
      property_id: undefined,
    }
    return { matched: false, inserted: false, skipped_duplicate: false, failed: false, reason: 'no_confirmation_code', sample, last_uid: Number(msg.uid || 0) }
  }
  if (isCancellationMail) {
    const ccCancel = (String(fields.confirmation_code || subj || '').match(/\b[A-Z0-9]{8,10}\b/)?.[0] || '').trim()
    if (!ccCancel) {
      return { matched: false, inserted: false, skipped_duplicate: false, failed: false, reason: 'no_confirmation_code', last_uid: Number(msg.uid || 0) }
    }
    if (dryRun) {
      const sample = { confirmation_code: ccCancel, cancelled: true }
      return { matched: true, inserted: false, skipped_duplicate: false, failed: false, updated: false, sample, last_uid: Number(msg.uid || 0) }
    }
    if (hasPg) {
      try {
        const payloadCancel = { id: uuid(), confirmation_code: ccCancel, message_id: String(parsed.messageId || ''), header_date: headerDate, subject, sender: from, source: sourceTag, account: acc.user }
        safeDbLog('order_cancellations','upsert', payloadCancel, { conflict: ['confirmation_code'] })
        await pgInsertOnConflictDoNothing('order_cancellations', payloadCancel, ['confirmation_code'])
      } catch (e: any) {
        console.error(JSON.stringify({ tag: 'db_write_failed', table: 'order_cancellations', code: String((e as any)?.code || ''), message: String(e?.message || '') }))
      }
      try {
        if (pgPool) {
          const upd = await pgPool.query('UPDATE orders SET status=$2 WHERE confirmation_code=$1 RETURNING id', [ccCancel, 'cancelled'])
          const oid = upd?.rows?.[0]?.id || null
          try {
            if (oid) {
              const { syncOrderToCleaningTasks } = require('../services/cleaningSync')
              await syncOrderToCleaningTasks(String(oid))
            }
          } catch {}
          return { matched: true, inserted: false, skipped_duplicate: false, failed: false, updated: !!oid, order_id: oid, last_uid: Number(msg.uid || 0) }
        }
      } catch (e: any) {
        console.error(JSON.stringify({ tag: 'db_write_failed', table: 'orders', action: 'set_cancelled', code: String((e as any)?.code || ''), message: String(e?.message || '') }))
        return { matched: true, inserted: false, skipped_duplicate: false, failed: true, reason: 'db_write_failed:orders_cancel', last_uid: Number(msg.uid || 0) }
      }
    }
    return { matched: true, inserted: false, skipped_duplicate: false, failed: true, reason: 'db_unavailable', last_uid: Number(msg.uid || 0) }
  }
  const ln = String(fields.listing_name || '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim().toLowerCase()
  const pid = ln ? propIndex[ln] : undefined
  if (!pid) {
    if (!dryRun && hasPg) {
      try { await pgInsert('order_import_staging', { id: uuid(), channel: 'airbnb_email', raw_row: { message_id: String(parsed.messageId || ''), subject, from, html_snippet: (html || '').slice(0, 2000), listing_name: fields.listing_name }, reason: 'unmatched_property', status: 'unmatched' }) } catch {}
    }
    const sample = {
      confirmation_code: cc,
      guest_name: fields.guest_name,
      listing_name: fields.listing_name,
      checkin: fields.checkin,
      checkout: fields.checkout,
      nights: fields.nights,
      price: fields.price,
      cleaning_fee: fields.cleaning_fee,
      net_income: Number(((fields.price || 0) - (fields.cleaning_fee || 0)).toFixed?.(2) || ((fields.price || 0) - (fields.cleaning_fee || 0))),
      avg_nightly_price: (fields.nights && fields.nights > 0) ? Number((((fields.price || 0) - (fields.cleaning_fee || 0)) / fields.nights).toFixed(2)) : 0,
      property_match: false,
      property_id: undefined,
    }
    return { matched: false, inserted: false, skipped_duplicate: false, failed: true, reason: 'property_not_found', sample, last_uid: Number(msg.uid || 0) }
  }
  const ci: string | null = fields.checkin ? String(fields.checkin) : null
  const co: string | null = fields.checkout ? String(fields.checkout) : null
  let nights = fields.nights
  if ((!nights || nights <= 0) && ci && co) {
    try { const a = new Date(ci); const b = new Date(co); const ms = b.getTime() - a.getTime(); nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0 } catch { nights = 0 }
  }
  const price = round2(fields.price || 0) || 0
  const cleaning = round2(fields.cleaning_fee || 0) || 0
  const net = round2(price - cleaning) || 0
  const avg = nights && nights > 0 ? (round2(price / nights) || 0) : 0
  const idempotency_key = `airbnb_email:${cc}`
  if (dryRun) {
    const sample = { confirmation_code: cc, guest_name: fields.guest_name, listing_name: fields.listing_name, checkin: ci, checkout: co, nights, price, cleaning_fee: cleaning, net_income: net, avg_nightly_price: avg, property_match: !!pid, property_id: pid }
    return { matched: true, inserted: false, skipped_duplicate: false, failed: false, sample, last_uid: Number(msg.uid || 0) }
  }
  if (hasPg) {
    try {
      const dup: any[] = await pgSelect('orders', 'id', { source: sourceTag, confirmation_code: cc, property_id: pid }) as any[] || []
      if (Array.isArray(dup) && dup[0]) {
        console.log(JSON.stringify({ tag: 'orders_write_done', action: 'duplicate_check', upserted: false, duplicate: true, order_id: dup[0].id }))
        try {
          const { syncOrderToCleaningTasks } = require('../services/cleaningSync')
          await syncOrderToCleaningTasks(String(dup[0].id))
        } catch {}
        try { if (pgPool) { await pgPool.query("UPDATE email_orders_raw SET status='resolved', extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('resolved_order_id', $2::text) WHERE uid=$1", [Number(msg.uid || 0), String(dup[0].id || '')]) } } catch {}
        return { matched: true, inserted: false, skipped_duplicate: true, failed: false, order_id: dup[0].id, last_uid: Number(msg.uid || 0) }
      }
    } catch {}
    const payload: any = { id: uuid(), source: sourceTag, external_id: cc, property_id: pid, guest_name: fields.guest_name, checkin: ci, checkout: co, price, cleaning_fee: cleaning, net_income: net, avg_nightly_price: avg, nights, currency: 'AUD', status: 'confirmed', confirmation_code: cc, idempotency_key, payment_currency: 'AUD', payment_received: false, email_header_at: headerDate?.toISOString?.() ? new Date(headerDate as Date) : undefined, year_inferred: !!fields.year_inferred, raw_checkin_text: fields.raw_checkin_text, raw_checkout_text: fields.raw_checkout_text }
    try {
      safeDbLog('orders','upsert', payload, { conflict: ['idempotency_key'] })
      const row = await pgInsertOnConflictDoNothing('orders', payload, ['idempotency_key'])
      let orderId = row?.id ? String(row.id) : ''
      if (!orderId) {
        try {
          const q = await pgPool!.query('SELECT id::text AS id FROM orders WHERE idempotency_key=$1 LIMIT 1', [String(payload.idempotency_key || '')])
          orderId = q?.rows?.[0]?.id ? String(q.rows[0].id) : ''
        } catch {}
      }
      console.log(JSON.stringify({ tag: 'orders_write_done', action: 'upsert', upserted: !!row, duplicate: !row, order_id: orderId || null }))
      try {
        const { syncOrderToCleaningTasks } = require('../services/cleaningSync')
        if (orderId) await syncOrderToCleaningTasks(String(orderId))
      } catch {}
      try { if (orderId && pgPool) { await pgPool.query("UPDATE email_orders_raw SET status='resolved', extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('resolved_order_id', $2::text) WHERE uid=$1", [Number(msg.uid || 0), String(orderId)]) } } catch {}
      return { matched: true, inserted: !!row, skipped_duplicate: !row, failed: false, order_id: orderId || null, last_uid: Number(msg.uid || 0) }
    } catch (e: any) {
      console.error(JSON.stringify({ tag: 'db_write_failed', table: 'orders', columns: Object.keys(payload), conflict: ['idempotency_key'], code: String((e as any)?.code || ''), message: String(e?.message || ''), payload_keys: Object.keys(payload), payload_sample: { idempotency_key, external_id: cc, property_id: pid, guest_name: fields.guest_name, checkin: ci, checkout: co } }))
      return { matched: true, inserted: false, skipped_duplicate: false, failed: true, reason: 'db_write_failed:orders', last_uid: Number(msg.uid || 0) }
    }
  }
  return { matched: true, inserted: false, skipped_duplicate: false, failed: true, reason: 'db_unavailable', last_uid: Number(msg.uid || 0) }
}

async function fetchUids(imap: any, q: { uidFrom?: number; since?: Date; before?: Date; limit: number }): Promise<number[]> {
  let uids: number[] = []
  if (q.uidFrom != null) {
    const from = Number(q.uidFrom)
    const rs = await imap.search({ uid: `${from + 1}:*` }, { uid: true })
    uids = (rs || []).map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
  } else {
    const rs = await imap.search({ since: q.since, before: q.before }, { uid: true })
    uids = (rs || []).map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
  }
  uids.sort((a, b) => a - b)
  const max = Number(q.limit || 200)
  return uids.slice(0, max)
}

export const router = Router()

const reqSchema = z.object({
  mode: z.enum(['incremental','backfill']).optional().default('incremental'),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  dry_run: z.boolean().optional().default(false),
  batch_tag: z.string().optional(),
  max_messages: z.coerce.number().optional().default(200),
  commit_every: z.coerce.number().optional().default(50),
  preview_limit: z.coerce.number().optional().default(20),
  uids: z.array(z.coerce.number()).optional(),
  max_per_run: z.coerce.number().optional().default(100),
  batch_size: z.coerce.number().optional().default(20),
  concurrency: z.coerce.number().optional().default(3),
  batch_sleep_ms: z.coerce.number().optional().default(500),
  min_interval_ms: z.coerce.number().optional().default(60000)
})

router.post('/email-sync-airbnb', requirePerm('order.manage'), async (req, res) => {
  const parsed = reqSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { mode, from_date, to_date, dry_run, batch_tag, max_messages, commit_every, max_per_run, batch_size, concurrency, batch_sleep_ms, min_interval_ms } = parsed.data
  const debugUidsRaw: number[] | null = Array.isArray((req.body || {}).uids) ? ((req.body || {}).uids as any[]).map((n: any) => Number(n)).filter(n => Number.isFinite(n)) : null
  const debugUids = (debugUidsRaw || undefined) ? (debugUidsRaw as number[]).slice(0, 50) : null
  if (!hasPg) return res.status(400).json({ message: 'pg required' })
  try { await ensureEmailSyncTables() } catch {}
  try { await cleanupStaleRunning() } catch {}
  try {
    if ((process.env.NODE_ENV || 'development') !== 'production') {
      const url = process.env.DATABASE_URL || ''
      if (url) { const u = new URL(url); console.log(`[Jobs Trigger] pg_host=${u.hostname} db=${(u.pathname||'').replace(/^\//,'')}`) }
    }
  } catch {}
  const rawPreview = Number(((req.query || {}) as any).preview_limit ?? (req.body || {})?.preview_limit ?? 0)
  const previewLimit = Number.isFinite(rawPreview) ? Math.min(50, rawPreview) : 0
  const reqMaxPerRun = Number(max_per_run || 100)
  const reqMaxMessages = Number(max_messages || 200)
  const maxPerRunFinal = previewLimit > 0 ? previewLimit : (Number.isFinite(reqMaxPerRun) ? Math.min(50, reqMaxPerRun) : 50)
  const maxMessagesFinal = Number.isFinite(reqMaxMessages) ? Math.min(50, reqMaxMessages) : 50
  try {
    const result = await runEmailSyncJob({ mode, from_date, to_date, dry_run, batch_tag, max_messages: maxMessagesFinal, commit_every, preview_limit: previewLimit, uids: debugUids || undefined, max_per_run: maxPerRunFinal, batch_size, concurrency, batch_sleep_ms, min_interval_ms })
    return res.json(result)
  } catch (e: any) {
    const status = Number(e?.status || 500)
    const reason = e?.reason || (status === 409 ? 'locked' : undefined)
    const payload: any = { message: e?.message || 'sync failed' }
    if (reason) payload.reason = reason
    if (e?.cooldown_until) payload.cooldown_until = e.cooldown_until
    if (e?.next_allowed_at) payload.next_allowed_at = e.next_allowed_at
    if (e?.running_since) payload.running_since = e.running_since
    if (reason === 'locked' && !payload.running_since) {
      try {
        const r = await pgPool!.query("SELECT started_at FROM email_sync_runs WHERE status='running' ORDER BY started_at DESC LIMIT 1")
        payload.running_since = r?.rows?.[0]?.started_at
      } catch {}
    }
    return res.status(status).json(payload)
  }
})

// Cron trigger for Render/externals: accepts JOB_CRON_TOKEN and bypasses min_interval
router.post('/email-sync/cron-trigger', require('../auth').allowCronTokenOrPerm('order.manage'), async (req, res) => {
  const body = req.body || {}
  const account = String(body.account || '')
  const max = Number(body.max_per_run || 50)
  try {
    const result = await runEmailSyncJob({ mode: 'incremental', account: account || undefined, max_per_run: Math.min(50, max), max_messages: Math.min(50, Number(body.max_messages || 50)), batch_size: Math.min(20, Number(body.batch_size || 20)), concurrency: 1, batch_sleep_ms: 0, min_interval_ms: 0, trigger_source: 'external_cron' })
    return res.json({ ok: true, stats: result?.stats || {}, schedule_runs: result?.schedule_runs || [] })
  } catch (e: any) {
    return res.status(Number(e?.status || 500)).json({ message: e?.message || 'cron-trigger failed', reason: e?.reason || 'unknown' })
  }
})

router.post('/email-sync/run', requirePerm('order.manage'), async (req, res) => {
  const parsed = reqSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { mode, from_date, to_date, dry_run, batch_tag, max_messages, commit_every, max_per_run, batch_size, concurrency, batch_sleep_ms, min_interval_ms } = parsed.data
  const account = String((req.body || {}).account || '') || undefined
  const start_uid = Number((req.body || {}).start_uid || 0) || undefined
  const uidsRaw = start_uid && Number.isFinite(start_uid) ? [start_uid] : (Array.isArray((req.body || {}).uids) ? ((req.body || {}).uids as any[]).map((n: any) => Number(n)).filter(Number.isFinite) : undefined)
  const uids = Array.isArray(uidsRaw) ? uidsRaw.slice(0, 50) : undefined
  if (!hasPg) return res.status(400).json({ message: 'pg required' })
  try { await ensureEmailSyncTables() } catch {}
  try { await cleanupStaleRunning() } catch {}
  try {
    const reqMaxPerRun = Number(((req.body || {}).max_per_run ?? max_per_run ?? 50))
    const reqMaxMessages = Number(((req.body || {}).max_messages ?? max_messages ?? 50))
    const maxPerRunFinal = Number.isFinite(reqMaxPerRun) ? Math.min(50, reqMaxPerRun) : 50
    const maxMessagesFinal = Number.isFinite(reqMaxMessages) ? Math.min(50, reqMaxMessages) : 50
    const result = await runEmailSyncJob({ mode, from_date, to_date, dry_run, batch_tag, max_messages: maxMessagesFinal, commit_every, uids, max_per_run: maxPerRunFinal, batch_size, concurrency, batch_sleep_ms, min_interval_ms, trigger_source: 'api_manual', account })
    return res.json(result)
  } catch (e: any) {
    const status = Number(e?.status || 500)
    const reason = e?.reason || (status === 409 ? 'locked' : undefined)
    const payload: any = { message: e?.message || 'sync failed' }
    if (reason) payload.reason = reason
    if (e?.cooldown_until) payload.cooldown_until = e.cooldown_until
    if (e?.next_allowed_at) payload.next_allowed_at = e.next_allowed_at
    if (e?.running_since) payload.running_since = e.running_since
    return res.status(status).json(payload)
  }
})

router.post('/email-sync/backfill', requirePerm('order.manage'), async (req, res) => {
  try {
    const body = req.body || {}
    const account = String(body.account || '').trim()
    const startDate = String(body.startDate || '').trim()
    if (!account || !startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return res.status(400).json({ message: 'account_and_startDate_required' })
    try { await ensureEmailSyncTables() } catch {}
    const minUid = await resolveUidSinceDate(account, startDate)
    const setLast = Number(minUid) - 1
    const prev = await pgPool!.query('SELECT last_uid FROM email_sync_state WHERE account=$1', [account])
    await pgPool!.query('UPDATE email_sync_state SET last_uid=$2, last_backfill_at=now() WHERE account=$1', [account, setLast])
    try { await logJobStateChange({ job_type: 'email_sync', account, event: 'last_uid_updated', prev: { last_uid: prev?.rows?.[0]?.last_uid ?? null }, next: { last_uid: setLast }, trigger_source: 'backfill_api' }) } catch {}
    const info = { tag: 'backfill_init', account, startDate, min_uid: minUid, set_last_uid: setLast, scan_limit: 50 }
    console.log(JSON.stringify(info))
    const result = await runEmailSyncJob({ mode: 'incremental', account, max_per_run: 50, max_messages: 50, batch_size: 20, concurrency: 1, batch_sleep_ms: 0, min_interval_ms: 0, trigger_source: 'backfill_api' })
    return res.json(Object.assign({}, info, { ok: true, schedule_runs: result?.schedule_runs || [], stats: result?.stats || {} }))
  } catch (e: any) {
    const status = Number(e?.status || 500)
    return res.status(status).json({ message: e?.message || 'backfill_failed', reason: e?.reason || 'unknown' })
  }
})

// 回填早期失败项到 email_orders_raw：按账户提取最近失败 uid 并重新处理
router.post('/email-sync/backfill-raw-failed', requirePerm('order.manage'), async (req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const body = req.body || {}
    const account = String(body.account || '').trim()
    const limit = Math.min(50, Number(body.limit || 50))
    const days = Math.min(180, Math.max(1, Number(body.days || 90)))
    const params: any[] = []
    let where = ["status='failed'", "reason IS DISTINCT FROM 'not_whitelisted'"]
    if (account) { where.push('account=$1'); params.push(account) }
    where.push(`created_at >= now() - interval '${days} days'`)
    where.push('COALESCE(confirmation_code, \'\') <> \'\'')
    const sql = `
      SELECT account, uid, message_id, header_date, subject, sender, reason, confirmation_code, listing_name, parse_preview, parse_probe
      FROM email_sync_items
      WHERE ${where.join(' AND ')}
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.confirmation_code = email_sync_items.confirmation_code)
      AND NOT EXISTS (SELECT 1 FROM email_orders_raw r WHERE r.message_id IS NOT NULL AND r.message_id = email_sync_items.message_id)
      AND NOT EXISTS (SELECT 1 FROM email_orders_raw r2 WHERE r2.source='imap' AND r2.uid = email_sync_items.uid)
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
    const rs = await pgPool!.query(sql, params)
    let inserted = 0, duplicate = 0, failed = 0
    for (const row of rs.rows || []) {
      try {
        const acc = String(row.account || '')
        const uid = Number(row.uid || 0) || null
        const mid = String(row.message_id || '') || null
        const headerDate = row.header_date || null
        const subject = String(row.subject || '')
        const sender = String(row.sender || '')
        const reason = String(row.reason || '')
        const cc = String(row.confirmation_code || '') || null
        const probe = typeof row.parse_probe === 'object' ? row.parse_probe : null
        const ln = String(row.listing_name || (probe?.fields_probe?.listing_name_raw || ''))
        const mci = String(row.parse_preview || '')
        const m1 = mci.match(/ci=(\d{4}-\d{2}-\d{2})/)
        const m2 = mci.match(/co=(\d{4}-\d{2}-\d{2})/)
        const checkin = m1 ? m1[1] : null
        const checkout = m2 ? m2[1] : null
        const price = Number(probe?.fields_probe?.amount?.price || 0)
        const cleaning = Number(probe?.fields_probe?.amount?.cleaning_fee || 0)
        const net = Number(((price || 0) - (cleaning || 0)).toFixed(2))
        let nights: number | null = null
        try {
          if (checkin && checkout) {
            const a = new Date(checkin as any)
            const b = new Date(checkout as any)
            const ms = b.getTime() - a.getTime()
            nights = ms > 0 ? Math.round(ms / (1000*60*60*24)) : 0
          }
        } catch { nights = null }
        const statusRaw = reason === 'property_not_found' ? 'unmatched_property' : 'parsed'
        const payload = {
          source: 'imap',
          uid,
          message_id: mid,
          header_date: headerDate,
          email_header_at: headerDate,
          envelope: {},
          html: null,
          plain: null,
          status: statusRaw,
          subject,
          sender,
          account: acc,
          confirmation_code: cc,
          guest_name: null,
          listing_name: ln || null,
          checkin,
          checkout,
          price: Number.isFinite(price) ? price : null,
          cleaning_fee: Number.isFinite(cleaning) ? cleaning : null,
          net_income: Number.isFinite(net) ? net : null,
          nights,
          extra: { source_from: 'items_failed_backfill', reason }
        }
        const conflictCols = mid ? ['message_id'] : ['source','uid']
        const rIns = await pgInsertOnConflictDoNothing('email_orders_raw', payload as any, conflictCols)
        if (rIns) inserted++
        else duplicate++
      } catch { failed++ }
    }
    return res.json({ ok: true, candidates: Number(rs.rowCount || 0), inserted, duplicates: duplicate, failed })
  } catch (e: any) {
    return res.status(500).json({ message: 'backfill_raw_failed', detail: String(e?.message || '') })
  }
})

router.post('/email-sync/run', allowCronTokenOrPerm('order.manage'), async (req, res) => {
  const parsed = reqSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { mode, from_date, to_date, dry_run, batch_tag, max_messages, commit_every, max_per_run, batch_size, concurrency, batch_sleep_ms, min_interval_ms } = parsed.data
  const account = String((req.body || {}).account || '') || undefined
  const start_uid = Number((req.body || {}).start_uid || 0) || undefined
  const uidsRaw = start_uid && Number.isFinite(start_uid) ? [start_uid] : (Array.isArray((req.body || {}).uids) ? ((req.body || {}).uids as any[]).map((n: any) => Number(n)).filter(Number.isFinite) : undefined)
  const uids = Array.isArray(uidsRaw) ? uidsRaw.slice(0, 50) : undefined
  if (!hasPg) return res.status(400).json({ message: 'pg required' })
  try { await ensureEmailSyncTables() } catch {}
  try { await cleanupStaleRunning() } catch {}
  try {
    const reqMaxPerRun = Number(((req.body || {}).max_per_run ?? max_per_run ?? 50))
    const reqMaxMessages = Number(((req.body || {}).max_messages ?? max_messages ?? 50))
    const maxPerRunFinal = Number.isFinite(reqMaxPerRun) ? Math.min(50, reqMaxPerRun) : 50
    const maxMessagesFinal = Number.isFinite(reqMaxMessages) ? Math.min(50, reqMaxMessages) : 50
    const result = await runEmailSyncJob({ mode, from_date, to_date, dry_run, batch_tag, max_messages: maxMessagesFinal, commit_every, uids, max_per_run: maxPerRunFinal, batch_size, concurrency, batch_sleep_ms, min_interval_ms, trigger_source: 'api_manual', account })
    return res.json(result)
  } catch (e: any) {
    const status = Number(e?.status || 500)
    const reason = e?.reason || (status === 409 ? 'locked' : undefined)
    const payload: any = { message: e?.message || 'sync failed' }
    if (reason) payload.reason = reason
    if (e?.cooldown_until) payload.cooldown_until = e.cooldown_until
    if (e?.next_allowed_at) payload.next_allowed_at = e.next_allowed_at
    if (e?.running_since) payload.running_since = e.running_since
    return res.status(status).json(payload)
  }
})

router.post('/email-sync/retry', requirePerm('order.manage'), async (req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const account = String((req.body || {}).account || '')
    const reasonRaw = (Array.isArray((req.body || {}).reasons) ? (req.body as any).reasons : [String((req.body || {}).reason || '')]).filter(Boolean).map((s: any) => String(s))
    const limit = Number((req.body || {}).limit || 100)
    const reasonsMap: Record<string, string[]> = {
      retryable: ['uid_processing_failed','raw_write_failed','db_error'],
      parse_failed: ['parse_error','missing_field'],
      property_not_mapped: ['property_not_found'],
      db_error: ['db_error']
    }
    let reasons: string[] = []
    for (const r of reasonRaw) { const k = String(r || '').toLowerCase(); reasons = reasons.concat(reasonsMap[k] || [k]) }
    reasons = Array.from(new Set(reasons.filter(Boolean)))
    if (!reasons.length) return res.status(400).json({ message: 'reasons_required' })
    const conds: any[] = []
    const where: string[] = ["status IN ('failed','skipped')", 'uid IS NOT NULL']
    if (account) { where.push('account=$1'); conds.push(account) }
    const placeholders = reasons.map((_, i) => `$${(conds.length + i + 1)}`)
    where.push(`reason = ANY(ARRAY[${placeholders.join(',')}])`)
    conds.push(...reasons)
    where.push('next_retry_at IS NULL OR next_retry_at < now()')
    const sel = await dbq().query(`SELECT DISTINCT uid, account FROM email_sync_items WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${conds.length + 1}`, [...conds, limit])
    const rows: Array<{ uid: number; account: string }> = sel?.rows || []
    const sched: Array<{ uid: number; account: string; next_retry_at: string }> = []
    for (const r of rows) {
      const adjust = await dbq().query('UPDATE email_sync_items SET status=\'retry\', retry_count=coalesce(retry_count,0), next_retry_at=COALESCE(next_retry_at, now()) WHERE account=$1 AND uid=$2 AND status IN (\'failed\',\'skipped\')', [String(r.account || ''), Number(r.uid || 0)])
      const q = await dbq().query('SELECT next_retry_at FROM email_sync_items WHERE account=$1 AND uid=$2 AND status=\'retry\' ORDER BY next_retry_at DESC LIMIT 1', [String(r.account||''), Number(r.uid||0)])
      const next = q?.rows?.[0]?.next_retry_at
      sched.push({ uid: Number(r.uid||0), account: String(r.account||''), next_retry_at: next })
    }
    return res.json({ ok: true, scheduled: sched.length, items: sched })
  } catch (e: any) {
    return res.status(500).json({ message: 'retry_failed', detail: String(e?.message || '') })
  }
})

 
// 查询最近运行记录（可观测性接口）
router.get('/email-sync-runs', requirePerm('order.manage'), async (req, res) => {
  try {
    try { await ensureEmailSyncTables() } catch {}
    const account = String((req.query || {}).account || '').trim()
    const limit = Number((req.query || {}).limit || 20)
    if (!hasPg) return res.json({ items: [], message: 'pg not configured' })
    let rows
    try {
      const chk = await pgPool!.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='email_sync_runs'")
      const cols = (chk?.rows || []).map((r:any)=> String(r.column_name||''))
      // Build selection dynamically to match actual columns; always prefer run_id and snake_case fields
      const selFields: string[] = []
      if (cols.includes('run_id')) selFields.push('run_id')
      if (cols.includes('account')) selFields.push('account')
      for (const k of ['scanned','matched','inserted','failed','skipped_duplicate','last_uid_before','last_uid_after','error_code','error_message','duration_ms','status','started_at','found_uids_count','matched_count','failed_count','skipped_reason_counts','failed_reason_counts']) {
        if (cols.includes(k)) selFields.push(k)
      }
      // finished_at vs ended_at compatibility
      if (cols.includes('ended_at')) selFields.push('ended_at')
      if (cols.includes('finished_at')) selFields.push('finished_at')
      // legacy cursor fields
      if (cols.includes('cursor_before')) selFields.push('cursor_before')
      if (cols.includes('cursor_after')) selFields.push('cursor_after')
      if (cols.includes('uid_range_queried')) selFields.push('uid_range_queried')
      // Fallback minimal set to avoid empty select
      if (!selFields.length) selFields.push('run_id', 'account', 'status', 'started_at')
      // add created_at alias for UI ordering/display
      if (!selFields.includes('started_at')) selFields.push('started_at')
      selFields.push('started_at AS created_at')
      // include primary id if exists
      if (cols.includes('id')) selFields.push('id')
      const sel = selFields.join(', ')
      rows = await pgPool!.query(`SELECT ${sel} FROM email_sync_runs ${account ? 'WHERE account=$1' : ''} ORDER BY started_at DESC LIMIT $${account ? 2 : 1}`, account ? [account, limit] : [limit])
    } catch {
      return res.json({ items: [] })
    }
    const empty = !(rows && rows.rows && rows.rows.length)
    return res.json({ items: rows.rows, notice: empty ? 'no_runs_yet' : undefined })
  } catch (e: any) {
    return res.status(500).json({ message: 'list_failed', detail: String(e?.message || '') })
  }
})

router.get('/state-changes', requirePerm('order.manage'), async (req, res) => {
  try {
    await ensureJobStateChangesTable()
    const account = String((req.query || {}).account || '')
    const limit = Math.min(200, Number((req.query || {}).limit || 50))
    const sql = account ? 'SELECT * FROM job_state_changes WHERE account=$1 ORDER BY created_at DESC LIMIT $2' : 'SELECT * FROM job_state_changes ORDER BY created_at DESC LIMIT $1'
    const rows = account ? (await pgPool!.query(sql, [account, limit])).rows : (await pgPool!.query(sql, [limit])).rows
    return res.json(rows)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'state-changes failed' })
  }
})

// Debug single UID
router.get('/debug/email-sync-item', requirePerm('order.manage'), async (req, res) => {
  try {
    const uid = Number((req.query || {}).uid || 0)
    const account = String((req.query || {}).account || '')
    if (!uid) return res.status(400).json({ message: 'uid_required' })
    if (!hasPg) return res.status(400).json({ message: 'pg_required' })
    const conds: any[] = []
    const where: string[] = ['uid = $1']
    conds.push(uid)
    if (account) { where.push('account = $2'); conds.push(account) }
    const items = await dbq().query(`SELECT id, run_id, account, uid, status, reason, message_id, mailbox, subject, sender, header_date, parse_preview, order_id, created_at FROM email_sync_items WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 5`, conds)
    const raws = await dbq().query('SELECT source, uid, message_id, header_date, status, subject, sender, confirmation_code, guest_name, listing_name, checkin, checkout, extra, created_at, length(html) AS html_len, length(plain) AS plain_len FROM email_orders_raw WHERE uid=$1 ORDER BY created_at DESC LIMIT 5', [uid])
    return res.json({ items: items?.rows || [], raws: raws?.rows || [] })
  } catch (e: any) {
    return res.status(500).json({ message: 'debug_failed', detail: String(e?.message || '') })
  }
})


// 汇总当前状态（running / last_run / cooldown）
router.get('/email-sync-status', requirePerm('order.manage'), async (_req, res) => {
  try {
    try { await ensureEmailSyncTables() } catch {}
    try { await cleanupStaleRunning() } catch {}
    if (!hasPg) return res.json({ items: [], message: 'pg not configured' })
    let accRows: any[] = []
    try {
      accRows = await pgSelect('email_sync_state', 'account,last_uid,last_connected_at,consecutive_failures,cooldown_until') as any[]
    } catch {
      return res.json({ items: [] })
    }
    let anyRuns = false
    try { const chk = await pgPool!.query('SELECT 1 FROM email_sync_runs LIMIT 1'); anyRuns = !!(chk && chk.rowCount) } catch {}
    let lockHeld = false
    try {
      const url = process.env.DATABASE_URL || ''
      if ((process.env.NODE_ENV || 'development') !== 'production' && url) { const u = new URL(url); console.log(`[Jobs Status] pg_host=${u.hostname} db=${(u.pathname||'').replace(/^\//,'')}`) }
      const ck = 918273645
      const test = await pgPool!.query('SELECT pg_try_advisory_lock($1) AS ok', [ck])
      const ok = !!(test?.rows?.[0]?.ok)
      if (ok) { try { await pgPool!.query('SELECT pg_advisory_unlock($1)', [ck]) } catch {} ; lockHeld = false } else { lockHeld = true }
    } catch {}
    const out: any[] = []
    for (const s of (accRows || [])) {
      const account = String(s.account)
      let lastRun, runningRow
      try { lastRun = await pgPool!.query('SELECT id, status, scanned, matched, inserted, failed, skipped_duplicate, error_code, error_message, started_at, ended_at, duration_ms, last_uid_before, last_uid_after FROM email_sync_runs WHERE account=$1 ORDER BY started_at DESC LIMIT 1', [account]) } catch {}
      try { runningRow = await pgPool!.query("SELECT id FROM email_sync_runs WHERE account=$1 AND status='running' AND started_at > now() - interval '10 minutes' ORDER BY started_at DESC LIMIT 1", [account]) } catch {}
      out.push({
        account,
        running: !!(runningRow?.rows?.[0]),
        last_run: lastRun?.rows?.[0] || null,
        last_uid: Number(s.last_uid || 0),
        last_connected_at: s.last_connected_at || null,
        consecutive_failures: Number(s.consecutive_failures || 0),
        cooldown_until: s.cooldown_until || null
      })
    }
    return res.json({ items: out, notice: anyRuns ? undefined : 'no_runs_yet' })
  } catch (e: any) {
    return res.status(500).json({ message: 'status_failed', detail: String(e?.message || '') })
  }
})
router.get('/email-orders-raw/failures', requirePerm('order.manage'), async (req, res) => {
  try {
    if (!hasPg) return res.json([])
    const sinceDays = Number(((req.query || {}) as any).since_days || 14)
    const limit = Math.min(500, Number(((req.query || {}) as any).limit || 200))
    try {
      await pgPool!.query(`
        UPDATE email_orders_raw r
        SET status='resolved',
            extra = COALESCE(r.extra, '{}'::jsonb) || jsonb_build_object('resolved_order_id', o.id::text)
        FROM orders o
        WHERE o.confirmation_code IS NOT NULL
          AND r.confirmation_code = o.confirmation_code
          AND r.created_at >= now() - ($1 || ':days')::interval
          AND COALESCE(r.status,'') IN ('failed','unmatched_property','parsed')
          AND COALESCE(r.extra->>'resolved_order_id','') = ''
      `, [String(sinceDays)])
    } catch {}
    const q = await pgPool!.query(`
      SELECT r.uid, r.message_id, r.subject, r.sender, r.header_date, r.confirmation_code, r.guest_name, r.listing_name, r.checkin, r.checkout, r.price, r.cleaning_fee, r.status,
        COALESCE(r.extra->>'reason', NULL) AS reason
      FROM email_orders_raw r
      WHERE r.created_at >= now() - ($1 || ':days')::interval
        AND COALESCE(r.status,'') IN ('failed','unmatched_property','parsed')
        AND COALESCE(r.extra->>'resolved_order_id','') = ''
      ORDER BY r.created_at DESC
      LIMIT $2
    `, [String(sinceDays), limit])
    const rows = (q.rows || []).map(r => {
      let nights = 0
      try { const a = r.checkin ? new Date(String(r.checkin)) : null; const b = r.checkout ? new Date(String(r.checkout)) : null; if (a && b) { const ms = b.getTime() - a.getTime(); nights = ms > 0 ? Math.round(ms / (1000*60*60*24)) : 0 } } catch {}
      return { uid: r.uid, id: r.message_id, message_id: r.message_id, subject: r.subject, from: r.sender, date: r.header_date, confirmation_code: r.confirmation_code, guest_name: r.guest_name, listing_name: r.listing_name, checkin: r.checkin, checkout: r.checkout, nights, price: r.price, cleaning_fee: r.cleaning_fee, status: r.status, reason: r.reason }
    })
    return res.json(rows)
  } catch (e: any) { return res.status(500).json({ message: 'list_failed', detail: String(e?.message || '') }) }
})

router.post('/email-orders-raw/reclassify', requirePerm('order.manage'), async (req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const sinceDays = Number(((req.body || {}) as any).since_days || 365)
    const { pgPool } = require('../dbAdapter')
    const sql = `UPDATE email_orders_raw SET status='unmatched_property'
      WHERE status='failed'
        AND listing_name IS NOT NULL
        AND confirmation_code IS NOT NULL
        AND checkin IS NOT NULL
        AND checkout IS NOT NULL
        AND (price IS NOT NULL OR net_income IS NOT NULL)
        AND created_at >= now() - ($1 || ':days')::interval`;
    const r = await pgPool!.query(sql, [String(sinceDays)])
    return res.json({ reclassified: Number(r.rowCount || 0), since_days: sinceDays })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reclassify_failed' })
  }
})
router.post('/email-orders-raw/resolve', requirePerm('order.manage'), async (req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const body: any = req.body || {}
    const uid = Number(body.uid || 0) || undefined
    const message_id = String(body.id || body.message_id || '') || undefined
    const property_id = String(body.property_id || '') || undefined
    if (!uid && !message_id) return res.status(400).json({ message: 'uid_or_message_id_required' })
    if (!property_id) return res.status(400).json({ message: 'property_id_required' })
    const client = await pgPool!.connect()
    let row: any = null
    if (uid) { const rs = await client.query('SELECT * FROM email_orders_raw WHERE uid=$1 ORDER BY created_at DESC LIMIT 1', [uid]); row = rs?.rows?.[0] }
    if (!row && message_id) { const rs2 = await client.query('SELECT * FROM email_orders_raw WHERE message_id=$1 ORDER BY created_at DESC LIMIT 1', [message_id]); row = rs2?.rows?.[0] }
    if (!row) { client.release(); return res.status(404).json({ message: 'raw_not_found' }) }
    function dayOnly(v: any): string | undefined {
      try { const d = new Date(v); if (!isNaN(d.getTime())) return d.toISOString().slice(0,10) } catch {}
      const s = String(v || '')
      const m = /^\d{4}-\d{2}-\d{2}/.exec(s)
      return m ? m[0] : undefined
    }
    const ci = row.checkin ? dayOnly(row.checkin) : undefined
    const co = row.checkout ? dayOnly(row.checkout) : undefined
    let nights = 0
    try { const a = row.checkin ? new Date(row.checkin) : null; const b = row.checkout ? new Date(row.checkout) : null; if (a && b) { const ms = b.getTime() - a.getTime(); nights = ms > 0 ? Math.round(ms / (1000*60*60*24)) : 0 } } catch {}
    const price = Number(row.price || 0)
    const cleaning = Number(row.cleaning_fee || 0)
    const net = Number((price - cleaning).toFixed(2))
    const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
    const payload: any = { id: uuid(), source: 'airbnb_email', property_id, guest_name: row.guest_name || null, checkin: ci, checkout: co, price, cleaning_fee: cleaning, net_income: net, avg_nightly_price: avg, nights, currency: 'AUD', status: 'confirmed', confirmation_code: row.confirmation_code || null, idempotency_key: `airbnb_email:${String(row.confirmation_code || '')}`, email_header_at: row.email_header_at || row.header_date || null }
    try {
      await client.query('BEGIN')
      if (payload.confirmation_code) {
        const dup = await client.query('SELECT id, property_id FROM orders WHERE confirmation_code=$1 LIMIT 1', [payload.confirmation_code])
        if (dup?.rows?.[0]) { await client.query('ROLLBACK'); client.release(); return res.status(409).json({ message: 'duplicate', existing_id: String(dup.rows[0].id || ''), existing_property_id: String(dup.rows[0].property_id || '') }) }
      }
      const propCheck = await client.query('SELECT id FROM properties WHERE id=$1 LIMIT 1', [property_id])
      if (!propCheck?.rows?.[0]) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ message: 'property_not_found' }) }
      const ins = await client.query('INSERT INTO orders (id, source, external_id, property_id, guest_name, checkin, checkout, price, cleaning_fee, net_income, avg_nightly_price, nights, currency, status, confirmation_code, idempotency_key, payment_currency, payment_received, email_header_at, year_inferred, raw_checkin_text, raw_checkout_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id', [payload.id, 'airbnb_email', payload.confirmation_code, property_id, payload.guest_name, payload.checkin, payload.checkout, payload.price, payload.cleaning_fee, payload.net_income, payload.avg_nightly_price, payload.nights, 'AUD', 'confirmed', payload.confirmation_code, payload.idempotency_key, 'AUD', false, payload.email_header_at, false, null, null])
      const newId = String(ins?.rows?.[0]?.id || '')
      try { if (newId) { const { syncOrderToCleaningTasks } = require('../services/cleaningSync'); await syncOrderToCleaningTasks(newId, { client }) } } catch {}
      await client.query(`UPDATE email_orders_raw SET status='resolved', extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('resolved_order_id', $2::text) WHERE (($1::bigint IS NOT NULL AND uid=$1::bigint) OR ($3::text IS NOT NULL AND message_id=$3::text))`, [uid ?? null, newId || null, message_id ?? null])
      await client.query('COMMIT')
      client.release()
      return res.status(201).json({ id: newId })
    } catch (e: any) {
      try { await client.query('ROLLBACK') } catch {}
      const msg = String(e?.message || '')
      // Unique constraint -> treat as duplicate
      if (/duplicate key value violates unique constraint/i.test(msg) && /idx_orders_confirmation_code_unique/i.test(msg)) {
        client.release()
        return res.status(409).json({ message: 'duplicate' })
      }
      // Missing column -> add and retry once
      if (/column\s+"confirmation_code"\s+of\s+relation\s+"orders"\s+does\s+not\s+exist/i.test(msg)) {
        try {
          const { pgPool } = require('../dbAdapter')
          await pgPool?.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text')
          await pgPool?.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_confirmation_code_unique ON orders(confirmation_code) WHERE confirmation_code IS NOT NULL')
          await client.query('BEGIN')
          const ins2 = await client.query('INSERT INTO orders (id, source, external_id, property_id, guest_name, checkin, checkout, price, cleaning_fee, net_income, avg_nightly_price, nights, currency, status, confirmation_code, idempotency_key, payment_currency, payment_received, email_header_at, year_inferred, raw_checkin_text, raw_checkout_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id', [payload.id, 'airbnb_email', payload.confirmation_code, property_id, payload.guest_name, payload.checkin, payload.checkout, payload.price, payload.cleaning_fee, payload.net_income, payload.avg_nightly_price, payload.nights, 'AUD', 'confirmed', payload.confirmation_code, payload.idempotency_key, 'AUD', false, payload.email_header_at, false, null, null])
          const newId2 = String(ins2?.rows?.[0]?.id || '')
          try { if (newId2) { const { syncOrderToCleaningTasks } = require('../services/cleaningSync'); await syncOrderToCleaningTasks(newId2, { client }) } } catch {}
          await client.query(`UPDATE email_orders_raw SET status='resolved', extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('resolved_order_id', $2::text) WHERE (($1::bigint IS NOT NULL AND uid=$1::bigint) OR ($3::text IS NOT NULL AND message_id=$3::text))`, [uid ?? null, newId2 || null, message_id ?? null])
          await client.query('COMMIT')
          client.release()
          return res.status(201).json({ id: newId2 })
        } catch (e2: any) {
          try { await client.query('ROLLBACK') } catch {}
          client.release()
          return res.status(500).json({ message: 'insert_failed', detail: String(e2?.message || '') })
        }
      }
      if (/column\s+"(email_header_at|year_inferred|raw_checkin_text|raw_checkout_text|cleaning_fee|net_income|avg_nightly_price|nights)"\s+of\s+relation\s+"orders"\s+does\s+not\s+exist/i.test(msg)) {
        try {
          const { pgPool } = require('../dbAdapter')
          await pgPool?.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS email_header_at timestamptz')
          await pgPool?.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS year_inferred boolean')
          await pgPool?.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_checkin_text text')
          await pgPool?.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_checkout_text text')
          await pgPool?.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS cleaning_fee numeric')
          await pgPool?.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS net_income numeric')
          await pgPool?.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS avg_nightly_price numeric')
          await pgPool?.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS nights integer')
          await client.query('BEGIN')
          const ins3 = await client.query('INSERT INTO orders (id, source, external_id, property_id, guest_name, checkin, checkout, price, cleaning_fee, net_income, avg_nightly_price, nights, currency, status, confirmation_code, idempotency_key, payment_currency, payment_received, email_header_at, year_inferred, raw_checkin_text, raw_checkout_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id', [payload.id, 'airbnb_email', payload.confirmation_code, property_id, payload.guest_name, payload.checkin, payload.checkout, payload.price, payload.cleaning_fee, payload.net_income, payload.avg_nightly_price, payload.nights, 'AUD', 'confirmed', payload.confirmation_code, payload.idempotency_key, 'AUD', false, payload.email_header_at, false, null, null])
          const newId3 = String(ins3?.rows?.[0]?.id || '')
          try { if (newId3) { const { syncOrderToCleaningTasks } = require('../services/cleaningSync'); await syncOrderToCleaningTasks(newId3, { client }) } } catch {}
          await client.query(`UPDATE email_orders_raw SET status='resolved', extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('resolved_order_id', $2::text) WHERE (($1::bigint IS NOT NULL AND uid=$1::bigint) OR ($3::text IS NOT NULL AND message_id=$3::text))`, [uid ?? null, newId3 || null, message_id ?? null])
          await client.query('COMMIT')
          client.release()
          return res.status(201).json({ id: newId3 })
        } catch (e3: any) {
          try { await client.query('ROLLBACK') } catch {}
          client.release()
          return res.status(500).json({ message: 'insert_failed', detail: String(e3?.message || '') })
        }
      }
      client.release()
      return res.status(500).json({ message: 'insert_failed', detail: String(e?.message || ''), code: String((e as any)?.code || '') })
    }
  } catch (e: any) { return res.status(500).json({ message: 'resolve_failed', detail: String(e?.message || '') }) }
})
router.post('/email-orders-raw/resolve-bulk', requirePerm('order.manage'), async (req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const body: any = req.body || {}
    const items: Array<{ uid?: number; message_id?: string; property_id: string }> = Array.isArray(body.items) ? body.items : []
    if (!items.length) return res.status(400).json({ message: 'items_required' })
    function dayOnly(v: any): string | undefined {
      try { const d = new Date(v); if (!isNaN(d.getTime())) return d.toISOString().slice(0,10) } catch {}
      const s = String(v || '')
      const m = /^\d{4}-\d{2}-\d{2}/.exec(s)
      return m ? m[0] : undefined
    }
    const results: Array<{ ok: boolean; uid?: number; message_id?: string; property_id?: string; id?: string; error?: string }> = []
    let inserted = 0, duplicate = 0, failed = 0, missing = 0
    for (const it of items) {
      try {
        const uid = Number(it?.uid || 0) || undefined
        const mid = String(it?.message_id || '') || undefined
        const pid = String(it?.property_id || '') || undefined
        if (!uid && !mid) { results.push({ ok: false, error: 'uid_or_message_id_required', property_id: pid }); missing++; continue }
        if (!pid) { results.push({ ok: false, error: 'property_id_required', uid, message_id: mid }); missing++; continue }
        const client = await pgPool!.connect()
        let row: any = null
        if (uid) { const rs = await client.query('SELECT * FROM email_orders_raw WHERE uid=$1 ORDER BY created_at DESC LIMIT 1', [uid]); row = rs?.rows?.[0] }
        if (!row && mid) { const rs2 = await client.query('SELECT * FROM email_orders_raw WHERE message_id=$1 ORDER BY created_at DESC LIMIT 1', [mid]); row = rs2?.rows?.[0] }
        if (!row) { results.push({ ok: false, error: 'raw_not_found', uid, message_id: mid, property_id: pid }); failed++; continue }
        const ci = row.checkin ? dayOnly(row.checkin) : undefined
        const co = row.checkout ? dayOnly(row.checkout) : undefined
        let nights = 0
        try { const a = row.checkin ? new Date(row.checkin) : null; const b = row.checkout ? new Date(row.checkout) : null; if (a && b) { const ms = b.getTime() - a.getTime(); nights = ms > 0 ? Math.round(ms / (1000*60*60*24)) : 0 } } catch {}
        const price = Number(row.price || 0)
        const cleaning = Number(row.cleaning_fee || 0)
        const net = Number((price - cleaning).toFixed(2))
        const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
        const payload: any = { id: uuid(), source: 'airbnb_email', property_id: pid, guest_name: row.guest_name || null, checkin: ci, checkout: co, price, cleaning_fee: cleaning, net_income: net, avg_nightly_price: avg, nights, currency: 'AUD', status: 'confirmed', confirmation_code: row.confirmation_code || null, idempotency_key: `airbnb_email:${String(row.confirmation_code || '')}`, email_header_at: row.email_header_at || row.header_date || null }
        try {
          await client.query('BEGIN')
          if (payload.confirmation_code) {
            const dup = await client.query('SELECT id, property_id FROM orders WHERE confirmation_code=$1 LIMIT 1', [payload.confirmation_code])
            if (dup?.rows?.[0]) { await client.query('ROLLBACK'); client.release(); results.push({ ok: false, error: 'duplicate', uid, message_id: mid, property_id: pid }); duplicate++; continue }
          }
          const propCheck = await client.query('SELECT id FROM properties WHERE id=$1 LIMIT 1', [pid])
          if (!propCheck?.rows?.[0]) { await client.query('ROLLBACK'); client.release(); results.push({ ok: false, error: 'property_not_found', uid, message_id: mid, property_id: pid }); failed++; continue }
          const ins = await client.query('INSERT INTO orders (id, source, external_id, property_id, guest_name, checkin, checkout, price, cleaning_fee, net_income, avg_nightly_price, nights, currency, status, confirmation_code, idempotency_key, payment_currency, payment_received, email_header_at, year_inferred, raw_checkin_text, raw_checkout_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id', [payload.id, 'airbnb_email', payload.confirmation_code, pid, payload.guest_name, payload.checkin, payload.checkout, payload.price, payload.cleaning_fee, payload.net_income, payload.avg_nightly_price, payload.nights, 'AUD', 'confirmed', payload.confirmation_code, payload.idempotency_key, 'AUD', false, payload.email_header_at, false, null, null])
          const newId = String(ins?.rows?.[0]?.id || '')
          try { if (newId) { const { syncOrderToCleaningTasks } = require('../services/cleaningSync'); await syncOrderToCleaningTasks(newId, { client }) } } catch {}
          await client.query(`UPDATE email_orders_raw SET status='resolved', extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('resolved_order_id', $2::text) WHERE (($1::bigint IS NOT NULL AND uid=$1::bigint) OR ($3::text IS NOT NULL AND message_id=$3::text))`, [uid ?? null, newId || null, mid ?? null])
          await client.query('COMMIT')
          client.release()
          results.push({ ok: true, uid, message_id: mid, property_id: pid, id: newId })
          inserted++
        } catch (e: any) {
          try { await client.query('ROLLBACK') } catch {}
          const msg = String(e?.message || '')
          if (/duplicate key value violates unique constraint/i.test(msg) && /idx_orders_confirmation_code_unique/i.test(msg)) {
            client.release()
            results.push({ ok: false, error: 'duplicate', uid, message_id: mid, property_id: pid })
            duplicate++
            continue
          }
          if (/column\s+"confirmation_code"\s+of\s+relation\s+"orders"\s+does\s+not\s+exist/i.test(msg)) {
            try {
              const { pgPool } = require('../dbAdapter')
              await pgPool?.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text')
              await pgPool?.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_confirmation_code_unique ON orders(confirmation_code) WHERE confirmation_code IS NOT NULL')
              await client.query('BEGIN')
              const ins2 = await client.query('INSERT INTO orders (id, source, external_id, property_id, guest_name, checkin, checkout, price, cleaning_fee, net_income, avg_nightly_price, nights, currency, status, confirmation_code, idempotency_key, payment_currency, payment_received, email_header_at, year_inferred, raw_checkin_text, raw_checkout_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id', [payload.id, 'airbnb_email', payload.confirmation_code, pid, payload.guest_name, payload.checkin, payload.checkout, payload.price, payload.cleaning_fee, payload.net_income, payload.avg_nightly_price, payload.nights, 'AUD', 'confirmed', payload.confirmation_code, payload.idempotency_key, 'AUD', false, payload.email_header_at, false, null, null])
              const newId2 = String(ins2?.rows?.[0]?.id || '')
              try { if (newId2) { const { syncOrderToCleaningTasks } = require('../services/cleaningSync'); await syncOrderToCleaningTasks(newId2, { client }) } } catch {}
              await client.query(`UPDATE email_orders_raw SET status='resolved', extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('resolved_order_id', $2::text) WHERE (($1::bigint IS NOT NULL AND uid=$1::bigint) OR ($3::text IS NOT NULL AND message_id=$3::text))`, [uid ?? null, newId2 || null, mid ?? null])
              await client.query('COMMIT')
              client.release()
              results.push({ ok: true, uid, message_id: mid, property_id: pid, id: newId2 })
              inserted++
              continue
            } catch (e2: any) {
              try { await client.query('ROLLBACK') } catch {}
              client.release()
              results.push({ ok: false, error: 'insert_failed', uid, message_id: mid, property_id: pid })
              failed++
              continue
            }
          }
          client.release()
          results.push({ ok: false, error: 'insert_failed', uid, message_id: mid, property_id: pid })
          failed++
        }
      } catch (e: any) {
        results.push({ ok: false, error: String(e?.message || 'error') })
        failed++
      }
    }
    return res.json({ inserted, duplicate, failed, missing, results })
  } catch (e: any) { return res.status(500).json({ message: 'resolve_bulk_failed', detail: String(e?.message || '') }) }
})
export type EmailSyncOptions = {
  mode?: 'incremental'|'backfill'
  from_date?: string
  to_date?: string
  dry_run?: boolean
  batch_tag?: string
  max_messages?: number
  commit_every?: number
  preview_limit?: number
  uids?: number[]
  max_per_run?: number
  batch_size?: number
  concurrency?: number
  batch_sleep_ms?: number
  min_interval_ms?: number
  trigger_source?: string
  account?: string
}

export async function runEmailSyncJob(opts: EmailSyncOptions = {}): Promise<any> {
  const { mode='incremental', from_date, to_date, dry_run=false, batch_tag, max_messages=200, commit_every=50, preview_limit=20, uids, max_per_run=100, batch_size=20, concurrency=3, batch_sleep_ms=500, min_interval_ms=60000, trigger_source, account } = opts
  const HARD_CAP = 50
  const max_messages_capped = Math.min(HARD_CAP, Number(max_messages || HARD_CAP))
  const max_per_run_capped = Math.min(HARD_CAP, Number(max_per_run || HARD_CAP))
  const uids_capped = Array.isArray(uids) ? (uids as number[]).slice(0, HARD_CAP) : undefined
  if (!hasPg) throw Object.assign(new Error('pg required'), { status: 400 })
  try { await ensureEmailSyncTables() } catch {}
  try { await cleanupStaleRunning() } catch {}
  try {
    if ((process.env.NODE_ENV || 'development') !== 'production') {
      const url = process.env.DATABASE_URL || ''
      if (url) { const u = new URL(url); console.log(`[Jobs Scheduler Trigger] pg_host=${u.hostname} db=${(u.pathname||'').replace(/^\//,'')}`) }
    }
  } catch {}
  let accounts = getAccounts()
  const allowListRaw = String(process.env.EMAIL_SYNC_ALLOWED_ACCOUNTS || '').trim()
  if (allowListRaw) {
    const allow = allowListRaw.split(',').map(s => s.trim()).filter(Boolean)
    accounts = accounts.filter(a => allow.includes(String(a.user)))
  }
  if (account) accounts = accounts.filter(a => String(a.user || '') === String(account))
  if (!accounts.length) throw Object.assign(new Error('missing imap accounts'), { status: 400 })
  const result = await (async () => {
    const propIdx = await loadPropertyIndex()
    const stats = { scanned: 0, matched: 0, inserted: 0, skipped_duplicate: 0, failed: 0 }
    const skippedReasons: Record<string, number> = {}
    const failedReasons: Record<string, number> = {}
    const failedDetails: Array<{ uid: number; subject?: string; from?: string; reason?: string }> = []
    const { ImapFlow } = require('imapflow')
    await ensureEmailSyncItemsTables()
    try { await detectHeaderDateCast() } catch {}
    const scheduleRuns: Array<{ account: string; run_id: string | number | null }> = []
    for (const acc of accounts) {
      const [k1,k2] = accountLockKey(acc.user)
      try {
      await withAdvisoryLock(k1, k2, async (dbClient) => {
      await ensureEmailState(acc.user, dbClient)
      const sourceTag = mode === 'backfill' ? String(batch_tag || 'airbnb_email_import_v1') : 'airbnb_email'
      const imap = new ImapFlow({ host: 'imap.exmail.qq.com', port: 993, secure: true, auth: { user: acc.user, pass: acc.pass }, socketTimeout: Number(process.env.EMAIL_SYNC_SOCKET_TIMEOUT_MS || 120000) })
      const st0 = await getEmailState(acc.user, dbClient)
      const lastBeforeInit = Number(st0?.last_uid || 0)
      const uidQueryStr = (Array.isArray(uids_capped) && (uids_capped as any[]).length) ? `uids=${(uids_capped as any[]).join(',')}` : (mode === 'incremental' ? `uid=${(lastBeforeInit + 1)}:*` : `since=${from_date||''}&before=${to_date||''}`)
      let startRunId: string | number | null = await logSyncStart(acc.user, lastBeforeInit, uidQueryStr, dbClient, trigger_source)
      scheduleRuns.push({ account: acc.user, run_id: startRunId })
      if (!startRunId) throw Object.assign(new Error('run insert failed'), { status: 500, reason: 'insert_failed' })
      let runIdKeyStr: string | null = (typeof startRunId === 'string') ? String(startRunId) : null
      try {
        if (!runIdKeyStr && startRunId != null) {
          const rs = await dbq(dbClient).query('SELECT run_id FROM email_sync_runs WHERE id=$1', [startRunId])
          const rid = String(rs?.rows?.[0]?.run_id || '')
          if (rid) runIdKeyStr = rid
          else {
            const { v4: uuidv4 } = require('uuid')
            runIdKeyStr = uuidv4()
            await dbq(dbClient).query('UPDATE email_sync_runs SET run_id=$2 WHERE id=$1', [startRunId, runIdKeyStr])
          }
        }
      } catch {}
      const lastConnAt = st0?.last_connected_at ? new Date(String(st0.last_connected_at)) : null
      const nowTs = Date.now()
      if (lastConnAt && (nowTs - new Date(lastConnAt).getTime()) < Number(min_interval_ms)) {
        const msg = `min_interval_ms=${min_interval_ms}`
        if (typeof startRunId === 'string') { await dbq(dbClient).query("UPDATE email_sync_runs SET status='skipped', error_code=$2, error_message=$3, ended_at=now() WHERE run_id=$1", [startRunId, 'min_interval', msg]); try { await logJobStateChange({ job_type: 'email_sync', account, run_id: startRunId, event: 'run_skipped_min_interval', next: { status: 'skipped', reason: 'min_interval' }, trigger_source }, dbClient) } catch {} }
        else { await dbq(dbClient).query("UPDATE email_sync_runs SET status='skipped', error_code=$2, error_message=$3, ended_at=now() WHERE id=$1", [startRunId, 'min_interval', msg]); try { await logJobStateChange({ job_type: 'email_sync', account, run_id: startRunId, event: 'run_skipped_min_interval', next: { status: 'skipped', reason: 'min_interval' }, trigger_source }, dbClient) } catch {} }
        const next_allowed_at = lastConnAt ? new Date(lastConnAt.getTime() + Number(min_interval_ms)).toISOString() : undefined
        throw Object.assign(new Error('min interval'), { status: 409, reason: 'min_interval', next_allowed_at })
      }
      if (st0?.cooldown_until && new Date(String(st0.cooldown_until)).getTime() > nowTs) {
        const msg = String(st0.cooldown_until || '')
        if (typeof startRunId === 'string') { await dbq(dbClient).query("UPDATE email_sync_runs SET status='skipped', error_code=$2, error_message=$3, ended_at=now() WHERE run_id=$1", [startRunId, 'cooldown', msg]) }
        else { await dbq(dbClient).query("UPDATE email_sync_runs SET status='skipped', error_code=$2, error_message=$3, ended_at=now() WHERE id=$1", [startRunId, 'cooldown', msg]) }
        throw Object.assign(new Error('cooldown'), { status: 409, reason: 'cooldown', cooldown_until: st0.cooldown_until })
      }
      function isAuthError(e: any): boolean { const m = String(e?.message || '').toLowerCase(); return /auth|authentication/i.test(m) }
      function isTransientNetworkError(e: any): boolean {
        const code = String((e && (e.code || e.errno)) || '').toUpperCase()
        const m = String(e?.message || '').toLowerCase()
        if (isAuthError(e)) return false
        if (['ETIMEDOUT','ECONNRESET','EPIPE','ENETUNREACH','EAI_AGAIN'].includes(code)) return true
        return /timeout|temporarily unavailable|socket hang up|network/i.test(m)
      }
      async function retry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
        let attempt = 0
        let lastErr: any
        while (attempt <= retries) {
          try { return await fn() } catch (e: any) {
            lastErr = e
            if (!isTransientNetworkError(e) || attempt === retries) throw e
            const base = 1000 * Math.pow(2, attempt)
            const jitter = Math.floor(Math.random() * 200)
            await new Promise(r => setTimeout(r, base + jitter))
            attempt++
          }
        }
        throw lastErr
      }
      try { await retry(() => imap.connect(), 1) } catch (e: any) { await logSyncError(startRunId, acc.user, 'imap_connect_failed', String(e?.message || ''), 0, Number(st0?.last_uid || 0), dbClient); try { await dbClient.query("UPDATE email_sync_state SET cooldown_until = now() + interval '2 minutes' WHERE account=$1", [acc.user]) } catch {}; return }
      await setLastConnectedAt(acc.user, dbClient)
      let mailbox: any
      try { mailbox = await retry(() => imap.mailboxOpen(acc.folder), 1) } catch (e: any) { try { await imap.logout() } catch {}; await logSyncError(startRunId, acc.user, 'imap_mailbox_open_failed', String(e?.message || ''), 0, Number(st0?.last_uid || 0), dbClient); try { await dbClient.query("UPDATE email_sync_state SET cooldown_until = now() + interval '2 minutes' WHERE account=$1", [acc.user]) } catch {}; return }
      const state = await getEmailState(acc.user, dbClient)
      let lastUid = Number(state.last_uid || 0)
      if (mode === 'incremental') { if (!lastUid || lastUid <= 0) { const initUid = Number(mailbox?.uidNext || 1) - 1; lastUid = initUid > 0 ? initUid : 0; await setEmailStateIncremental(acc.user, lastUid, dbClient) } }
      const windowFrom = from_date ? new Date(`${from_date}T00:00:00`) : undefined
      const windowTo = to_date ? new Date(`${to_date}T23:59:59`) : undefined
      const startedAt = Date.now()
      const lastBefore = lastUid
      let processedTotal = 0
      let hadFailure = false
      let insertedAny = false
      let failureCode: string | null = null
      let failureMessage: string | null = null
      let retryPhasePending = true
      let retryDueUids: number[] = []
      try {
        const rs = await dbq(dbClient).query('SELECT DISTINCT uid FROM email_sync_items WHERE account=$1 AND status=\'retry\' AND uid IS NOT NULL AND next_retry_at IS NOT NULL AND next_retry_at <= now() ORDER BY next_retry_at ASC LIMIT $2', [acc.user, HARD_CAP])
        retryDueUids = (rs?.rows || []).map((r: any) => Number(r.uid || 0)).filter((n: number) => Number.isFinite(n))
      } catch {}
      while (true) {
        const limit = Math.min(Number(max_messages_capped || HARD_CAP), Number(max_per_run_capped || HARD_CAP) - processedTotal)
        if (limit <= 0) break
        let uidList: number[]
        if (retryPhasePending && retryDueUids.length) {
          uidList = retryDueUids.slice(0, limit)
          retryDueUids = retryDueUids.slice(uidList.length)
          if (!retryDueUids.length) retryPhasePending = false
        } else {
          uidList = (Array.isArray(uids_capped) && uids_capped.length) ? (uids_capped as number[]) : await fetchUids(imap, mode === 'incremental' ? { uidFrom: lastUid, limit } : { since: windowFrom, before: windowTo, limit })
        }
        if (!uidList.length) break
        const batches: number[][] = []
        for (let i = 0; i < uidList.length; i += Number(batch_size)) batches.push(uidList.slice(i, i + Number(batch_size)))
        for (const batch of batches) {
          let idx = 0
          const worker = async () => {
            while (idx < batch.length) {
              const uid = Number(batch[idx++])
              let itemId: any = null
              try {
                const m = await retry(() => imap.fetchOne(String(uid), { envelope: true, internalDate: true, source: true }, { uid: true }))
                stats.scanned++; processedTotal++
                const env: any = (m as any)?.envelope || {}
                const messageId = String(env?.messageId || '')
                const headerDate = (m as any)?.internalDate ? new Date((m as any).internalDate) : null
                // initial audit item as fetched
                try {
                  const payload = { run_id: runIdKeyStr, account: acc.user, uid, status: 'scanned', message_id: messageId || null, mailbox: acc.folder, subject: String(env?.subject || ''), sender: String(env?.from?.text || ''), header_date: headerDate }
                  assertItemStatus(payload.status)
                  safeDbLog('email_sync_items','insert', payload)
                  let ins = await pgInsert('email_sync_items', payload, dbClient)
                  if (!ins || !ins.id) {
                    const msg = String((ins as any)?.message || '')
                    if (/null value in column\s+"id"/i.test(msg) || /requires non-null/i.test(msg)) {
                      const withId = { id: uuid(), ...payload }
                      safeDbLog('email_sync_items','insert_retry_with_id', withId)
                      ins = await pgInsert('email_sync_items', withId, dbClient)
                    }
                  }
                  itemId = (ins?.id ?? null)
                  console.log(JSON.stringify({ tag: 'items_insert_done', uid, run_id: runIdKeyStr, account: acc.user, item_id: itemId }))
                  insertedAny = true
                } catch (e: any) {
                  stats.failed++
                  hadFailure = true
                  if (!failureCode) failureCode = 'items_insert_failed'
                  if (!failureMessage) failureMessage = String(e?.message || '')
                  const payload = { run_id: runIdKeyStr, account: acc.user, uid, status: 'scanned', message_id: messageId || null, mailbox: acc.folder, subject: String(env?.subject || ''), sender: String(env?.from?.text || ''), header_date: headerDate }
                  console.error(JSON.stringify({ tag: 'db_write_failed', table: 'email_sync_items', columns: ['run_id','account','uid','status','message_id','mailbox','subject','sender','header_date'], code: String((e as any)?.code || ''), message: String(e?.message || ''), payload_keys: Object.keys(payload), payload_sample: { uid, message_id: messageId, subject: String(env?.subject||''), account: acc.user, run_id: startRunId } }))
                }
                const r = await processMessage(acc, m, propIdx, dry_run, sourceTag)
                if (r.matched) stats.matched++
                if (r.inserted) stats.inserted++
                if (r.skipped_duplicate) stats.skipped_duplicate++
                const notWhitelisted = String((r as any)?.reason || '') === 'not_whitelisted'
                if (notWhitelisted) {
                  try {
                    if (itemId) {
                      await dbq(dbClient).query('UPDATE email_sync_items SET status=$4, reason=$5::text WHERE account=$1 AND run_id::text=$2 AND uid=$3', [acc.user, runIdKeyStr, uid, 'skipped', 'not_whitelisted'])
                    }
                  } catch {}
                  continue
                }
                try {
                  if (itemId) {
                    assertItemStatus('parsed')
                    const confCodeP = ((String((r as any)?.sample?.confirmation_code || (r as any)?.confirmation_code || '')).match(/\b[A-Z0-9]{8,10}\b/)?.[0] || '') || null
                    const listingP = String((r as any)?.sample?.listing_name || '' || (r as any)?.listing_name || '' ) || null
                    const upd1 = await dbq(dbClient).query('UPDATE email_sync_items SET status=$4, confirmation_code=$5, listing_name=$6 WHERE account=$1 AND run_id::text=$2 AND uid=$3', [acc.user, runIdKeyStr, uid, 'parsed', confCodeP, listingP])
                    console.log(JSON.stringify({ tag: 'items_update_rowcount', step: 'parsed', account: acc.user, run_id: runIdKeyStr, uid, rowCount: (upd1 as any)?.rowCount || 0 }))
                  }
                } catch {}
                // write item audit (STEP5)
                try {
                  let statusItem = r.inserted ? 'inserted' : (r.updated ? 'updated' : (r.skipped_duplicate ? 'skipped' : (r.failed ? 'failed' : 'matched')))
                  function normalizeReason(raw: any, skippedDup: boolean): string | null {
                    if (r.inserted) return null
                    if (skippedDup) return 'duplicate'
                    const t = String(raw || '').toLowerCase()
                    if (!t) return null
                    if (/not_whitelisted/i.test(t)) return 'not_whitelisted'
                    if (/missing/i.test(t)) return 'missing_field'
                    if (/db/i.test(t)) return 'db_error'
                    if (/property/i.test(t)) return 'property_not_found'
                    if (/parse/i.test(t)) return 'parse_error'
                    return 'not_matched'
                  }
                  function safeReason(val: string | null, statusNow: string): string | null {
                    if (!val) return null
                    if (statusNow === 'inserted') return null
                    const ok = ['missing_field','db_error','property_not_found','parse_error','not_matched','duplicate','already_running','not_whitelisted']
                    if (statusNow === 'skipped') return ok.includes(String(val)) ? val : 'duplicate'
                    return ok.includes(String(val)) ? val : null
                  }
                  if (statusItem === 'matched' && String((r as any).reason || '') === 'not_whitelisted') statusItem = 'skipped'
                  const reasonRaw = normalizeReason((r as any).reason, !!r.skipped_duplicate)
                  const reason = safeReason(reasonRaw || (statusItem==='matched' ? null : null), statusItem)
                  if (reason) {
                    if (statusItem === 'skipped') skippedReasons[String(reason)] = (skippedReasons[String(reason)] || 0) + 1
                    else if (statusItem === 'failed') failedReasons[String(reason)] = (failedReasons[String(reason)] || 0) + 1
                  }
                  console.log(JSON.stringify({ tag: 'STEP5_ENTER', account: acc.user, run_id: runIdKeyStr, uid, final_status: statusItem, order_id: (r as any)?.order_id || null }))
                  if (itemId) {
                    const parsePreview = `cc=${String((r as any)?.sample?.confirmation_code || '')} ln=${String((r as any)?.sample?.listing_name || '')} ci=${String((r as any)?.sample?.checkin || '')} co=${String((r as any)?.sample?.checkout || '')}`
                  const subj2 = String(env?.subject || '')
                  const subjectOk = /(Reservation confirmed|New booking confirmed|Reservation altered|Reservation (cancelled|canceled))/i.test(subj2)
                    const senderOk = /airbnb\.com/i.test(String(env?.from?.text || ''))
                    const foundConf = !!((r as any)?.sample?.confirmation_code || (r as any)?.confirmation_code)
                    const foundDates = !!(((r as any)?.sample?.checkin) && ((r as any)?.sample?.checkout))
                    const foundListing = !!((r as any)?.sample?.listing_name || (r as any)?.listing_name)
                    const template = subjectOk ? (String(env?.subject||'').toLowerCase().includes('new booking confirmed') ? 'new_booking_confirmed' : 'reservation_confirmed') : 'unknown'
                  const parseProbeBase = { subject_ok: subjectOk, sender_ok: senderOk, found_conf_code: foundConf, found_dates: foundDates, found_listing: foundListing, template }
                  const fieldsProbe = (r as any)?.sample?.probe || (r as any)?.probe || null
                  const parseProbe = Object.assign({}, parseProbeBase, (typeof fieldsProbe === 'object' && fieldsProbe) ? { fields_probe: fieldsProbe } : {})
                  const confCode = ((String((r as any)?.sample?.confirmation_code || (r as any)?.confirmation_code || '')).match(/\b[A-Z0-9]{8,10}\b/)?.[0] || '') || null
                  const headerDateIso = headerDate ? new Date(headerDate as Date).toISOString() : null
                  const updPayload = { id: itemId, status: statusItem, reason: reason || null, error_code: (r as any).reason || null, error_message: (r as any).error_message || null, listing_name: String((r as any)?.sample?.listing_name || ''), header_date: headerDateIso, parse_preview: parsePreview, order_id: (r as any)?.order_id || null, confirmation_code: confCode }
                  safeDbLog('email_sync_items','update', updPayload, { columns: ['account','run_id','uid','status','reason','error_code','error_message','listing_name','header_date','parse_preview','order_id','confirmation_code'] })
                  let upd2
                  try {
                    upd2 = await dbq(dbClient).query(`UPDATE email_sync_items SET status=$4, reason=$5::text, error_code=$6::text, error_message=$7::text, listing_name=$8::text, header_date=$9${HEADER_DATE_CAST}, parse_preview=COALESCE(NULLIF($10,''), parse_preview), order_id=$11::text, parse_probe=$12, confirmation_code=$13::text WHERE account=$1 AND run_id::text=$2 AND uid=$3`, [acc.user, runIdKeyStr, uid, updPayload.status, updPayload.reason, updPayload.error_code, updPayload.error_message, updPayload.listing_name, updPayload.header_date, updPayload.parse_preview, updPayload.order_id, JSON.stringify(parseProbe), confCode])
                  } catch (e: any) {
                    const code = String((e && (e.code || (e as any).code)) || '')
                    if (code === '23514') {
                      upd2 = await dbq(dbClient).query(`UPDATE email_sync_items SET status=$4, reason=NULL, error_code=$6::text, error_message=$7::text, listing_name=$8::text, header_date=$9${HEADER_DATE_CAST}, parse_preview=COALESCE(NULLIF($10,''), parse_preview), order_id=$11::text, parse_probe=$12, confirmation_code=$13::text WHERE account=$1 AND run_id::text=$2 AND uid=$3`, [acc.user, runIdKeyStr, uid, updPayload.status, /* reason null */ null, updPayload.error_code, updPayload.error_message, updPayload.listing_name, updPayload.header_date, updPayload.parse_preview, updPayload.order_id, JSON.stringify(parseProbe), confCode])
                    } else { throw e }
                  }
                    const rc2 = (upd2 as any)?.rowCount || 0
                    if (rc2 === 0) {
                      console.error(JSON.stringify({ tag: 'items_update_rowcount_0', step: 'final', account: acc.user, run_id: runIdKeyStr, uid }))
                      hadFailure = true; if (!failureCode) failureCode = 'items_update_rowcount_0'; if (!failureMessage) failureMessage = `items_update_rowcount_0 uid=${uid}`
                    }
                    console.log(JSON.stringify({ tag: 'STEP5_ITEM_UPDATE_DONE', uid, run_id: runIdKeyStr, account: acc.user, rowCount: rc2 }))
                    if (rc2 !== 1) {
                      console.error(JSON.stringify({ tag: 'items_update_rowcount_error', account: acc.user, run_id: runIdKeyStr, uid, expected: 1, actual: rc2 }))
                      hadFailure = true; if (!failureCode) failureCode = 'items_update_rowcount_error'; if (!failureMessage) failureMessage = `items_update_rowcount_error uid=${uid}`
                    }
                    try {
                      if (statusItem !== 'failed') {
                        await dbq(dbClient).query("UPDATE email_sync_items SET status='skipped', reason='duplicate' WHERE account=$1 AND uid=$2 AND status='retry'", [acc.user, uid])
                      } else {
                        const inc = await dbq(dbClient).query('UPDATE email_sync_items SET retry_count=coalesce(retry_count,0)+1 WHERE account=$1 AND uid=$2 AND status=\'retry\'', [acc.user, uid])
                        const rq = await dbq(dbClient).query('SELECT retry_count FROM email_sync_items WHERE account=$1 AND uid=$2 AND status=\'retry\' ORDER BY next_retry_at DESC LIMIT 1', [acc.user, uid])
                        const rc = Number(rq?.rows?.[0]?.retry_count || 0)
                        let minutes = 5
                        if (rc >= 2) minutes = 15
                        if (rc >= 3) minutes = 60
                        await dbq(dbClient).query("UPDATE email_sync_items SET next_retry_at = now() + ($3 || ':minutes')::interval, status = CASE WHEN retry_count >= 3 THEN 'failed' ELSE 'retry' END WHERE account=$1 AND uid=$2 AND status='retry'", [acc.user, uid, String(minutes)])
                      }
                    } catch {}
                    console.log(JSON.stringify({ tag: 'STEP5_item_update_done', uid, run_id: startRunId, account: acc.user, item_id: itemId, status: updPayload.status, reason: updPayload.reason }))
                    try {
                      const parse_ok = !!r.matched
                      const subject = String(env?.subject || '')
                      const sender = String(env?.from?.text || '')
                      const summary = { tag: 'mail_parse_summary', account: acc.user, uid, mailbox: acc.folder, subject, sender, header_date: headerDate, status: updPayload.status, reason: updPayload.reason, parse_ok, extracted: { confirmation_code: (String((r as any)?.sample?.confirmation_code || (r as any)?.confirmation_code || '')).match(/\b[A-Z0-9]{8,10}\b/)?.[0] || null, listing_name: String((r as any)?.sample?.listing_name || '' || (r as any)?.listing_name || '' ) || null, checkin: (r as any)?.sample?.checkin || (r as any)?.checkin || null, checkout: (r as any)?.sample?.checkout || (r as any)?.checkout || null, amount: (r as any)?.sample?.price || (r as any)?.price || null }, lens: { html: 0, plain: 0 } }
                      if (LOG_BODY) {
                        const htmlStr = String((r as any)?.sample?.html || '')
                        const plainStr = String((r as any)?.sample?.plain || '')
                        summary.lens = { html: htmlStr.length || 0, plain: plainStr.length || 0 }
                        ;(summary as any).html_snip = snippet(htmlStr)
                        ;(summary as any).plain_snip = snippet(plainStr)
                      }
                      console.log(JSON.stringify(summary))
                    } catch {}
                  }
                } catch (e: any) {
                  stats.failed++
                  hadFailure = true
                  if (!failureCode) failureCode = 'items_update_failed'
                  if (!failureMessage) failureMessage = String(e?.message || '')
                  console.error(JSON.stringify({ tag: 'db_write_failed', table: 'email_sync_items', columns: ['status','reason','error_code','error_message'], code: String((e as any)?.code || ''), message: String(e?.message || ''), payload_sample: { uid, item_id: itemId, account: acc.user, run_id: startRunId } }))
                  try {
                    if (itemId) {
                      await dbq(dbClient).query('UPDATE email_sync_items SET status=$2, reason=$3::text WHERE id=$1', [itemId, 'skipped', 'db_error'])
                    }
                  } catch {}
                }
                // upsert raw only for candidate order failures或显式调试；
                // 非订单邮件（not_whitelisted）完全跳过 raw/parse pipeline，避免产生 db_error
                const isNotWhitelisted = String((r as any)?.reason || '') === 'not_whitelisted'
                if (!dry_run && !isNotWhitelisted) {
                  try {
                    const mailparser = require('mailparser')
                    const p2 = await mailparser.simpleParser((m as any).source)
                    const headerDate2 = (p2?.date ? new Date(p2.date as any) : ((m as any)?.internalDate ? new Date((m as any).internalDate) : null))
                    const messageId2 = String(((m as any)?.envelope?.messageId) || '')
                    const envelope = (m as any)?.envelope || null
                    const fields2 = extractFieldsFromHtml(String(p2?.html || ''), headerDate2 || new Date())
                    const src = (m as any)?.source
                    const bodyLen = Buffer.isBuffer(src) ? src.length : (typeof src === 'string' ? src.length : 0)
                    const htmlLen = String(p2?.html || '').length
                    const plainLen = String(p2?.text || '').length
                    console.log(JSON.stringify({ tag: 'STEP2_fetch_body_done', uid, run_id: startRunId, account: acc.user, bodyLen, htmlLen, plainLen, hasHtml: htmlLen > 0, hasPlain: plainLen > 0 }))
                    console.log(JSON.stringify({ tag: 'STEP3_parse_done', uid, run_id: startRunId, account: acc.user, conf_ok: !!fields2.confirmation_code, checkin_ok: !!fields2.checkin, checkout_ok: !!fields2.checkout, listing_ok: !!fields2.listing_name }))
                    try {
                      if (itemId) {
                        assertItemStatus('parsed')
                        await dbq(dbClient).query('UPDATE email_sync_items SET status=$2 WHERE id=$1 AND (status IS NULL OR status = $3)', [itemId, 'parsed', 'scanned'])
                      }
                    } catch {}
                    const subj3 = String(env?.subject || '')
                    const subjectOk = /(Reservation confirmed|New booking confirmed|Reservation altered|Reservation (cancelled|canceled))/i.test(subj3)
                    const foundConf = !!((String(fields2.confirmation_code || '')).match(/\b[A-Z0-9]{8,10}\b/))
                    const foundDates = !!(fields2.checkin && fields2.checkout)
                    const isCandidateStrict = !!(subjectOk && foundConf && foundDates)
                    const isCandidateLoose = !!(subjectOk && foundConf)
                    const shouldWriteRaw = (!!r.failed || DEBUG_RAW)
                    if (shouldWriteRaw) {
                      const priceVal = Number(fields2.price || 0)
                      const cleanVal = Number(fields2.cleaning_fee || 0)
                      const netVal = Number((priceVal - cleanVal).toFixed(2))
                      const statusRaw = (String((r as any)?.reason || '') === 'property_not_found') ? 'unmatched_property' : 'parsed'
                    const rawPayload = { source: 'imap', uid, message_id: messageId2 || null, header_date: headerDate2 || null, email_header_at: headerDate2 || null, envelope: JSON.stringify(envelope || {}), html: String(p2?.html || ''), plain: String(p2?.text || ''), status: statusRaw, subject: String(env?.subject || ''), sender: String(env?.from?.text || ''), account: acc.user, confirmation_code: (String(fields2.confirmation_code || '')).match(/\b[A-Z0-9]{8,10}\b/)?.[0] || null, guest_name: fields2.guest_name || null, listing_name: fields2.listing_name || null, checkin: fields2.checkin || null, checkout: fields2.checkout || null, price: isFinite(priceVal) ? priceVal : null, cleaning_fee: isFinite(cleanVal) ? cleanVal : null, net_income: isFinite(netVal) ? netVal : null, nights: fields2.nights || null, extra: { parse_ok: isCandidateStrict || isCandidateLoose, reason: (r as any).reason || null } }
                      safeDbLog('email_orders_raw','upsert', rawPayload, { conflict: messageId2 ? ['message_id'] : ['source','uid'] })
                      const rawRes = await pgInsertOnConflictDoNothing('email_orders_raw', rawPayload, messageId2 ? ['message_id'] : ['source','uid'], dbClient)
                      console.log(JSON.stringify({ tag: 'STEP4_raw_upsert_done', uid, run_id: startRunId, account: acc.user, inserted: !!rawRes, conflict: messageId2 ? 'message_id' : 'source+uid', candidate: (isCandidateStrict || isCandidateLoose), failed_order: !!r.failed }))
                      insertedAny = insertedAny || !!rawRes
                    }
                    // always reinforce parse_preview from final fields, only if new value is non-empty
                    try {
                      const ccFinal = (String(fields2.confirmation_code || '')).match(/\b[A-Z0-9]{8,10}\b/)?.[0] || ''
                      const lnFinal = String(fields2.listing_name || '')
                      const ciFinal = String(fields2.checkin || '')
                      const coFinal = String(fields2.checkout || '')
                      const previewFinal = `cc=${ccFinal} ln=${lnFinal} ci=${ciFinal} co=${coFinal}`
                      if (itemId) {
                        await dbq(dbClient).query('UPDATE email_sync_items SET parse_preview=COALESCE(NULLIF($2,\'\'), parse_preview) WHERE id=$1', [itemId, previewFinal])
                      }
                    } catch {}
                  } catch (e: any) {
                    stats.failed++
                    hadFailure = true
                    if (!failureCode) failureCode = 'raw_write_failed'
                    if (!failureMessage) failureMessage = String(e?.message || '')
                    const payloadR = { source: 'imap', uid, subject: String(env?.subject || ''), account: acc.user }
                    console.error(JSON.stringify({ tag: 'db_write_failed', table: 'email_orders_raw', columns: ['source','uid','message_id','header_date','envelope','html','plain','status','subject','sender','account'], code: String((e as any)?.code || ''), message: String(e?.message || ''), payload_keys: Object.keys(payloadR), payload_sample: { uid, subject: String(env?.subject||''), account: acc.user, run_id: startRunId } }))
                    try {
                    const updFail = await dbq(dbClient).query('UPDATE email_sync_items SET status=$4, reason=$5 WHERE account=$1 AND run_id::text=$2 AND uid=$3', [acc.user, runIdKeyStr, uid, 'skipped', 'db_write_failed'])
                      console.log(JSON.stringify({ tag: 'items_update_rowcount', step: 'raw_fail', account: acc.user, run_id: runIdKeyStr, uid, rowCount: (updFail as any)?.rowCount || 0 }))
                    } catch {}
                  }
                }
              } catch (e: any) {
                stats.failed++
                hadFailure = true
                if (!failureCode) failureCode = 'uid_processing_failed'
                if (!failureMessage) failureMessage = String(e?.message || '')
                try {
                  const updUidFail = await dbq(dbClient).query('UPDATE email_sync_items SET status=$4, reason=$5, error_code=$6, error_message=$7 WHERE account=$1 AND run_id::text=$2 AND uid=$3', [acc.user, runIdKeyStr, uid, 'skipped', 'uid_processing_failed', 'uid_processing_failed', String(e?.message || '')])
                  console.error(JSON.stringify({ tag: 'uid_failed_item_update', uid, run_id: runIdKeyStr, account: acc.user, rowCount: (updUidFail as any)?.rowCount || 0, code: 'uid_processing_failed', message: String(e?.message || '') }))
                } catch {}
              } finally { if (mode === 'incremental') { if (uid > lastUid) lastUid = uid } }
            }
          }
          const workers: Promise<void>[] = []
          const c = 1
          for (let i = 0; i < c; i++) workers.push(worker())
          await Promise.all(workers)
          // defer last_uid update to end; do not advance if had failures
          if (Number(batch_sleep_ms) > 0) { await new Promise(r => setTimeout(r, Number(batch_sleep_ms))) }
          if (processedTotal >= Number(max_per_run_capped)) break
        }
        if (processedTotal >= Number(max_per_run_capped)) break
      }
      const duration = Date.now() - startedAt
      const statusFinal = hadFailure ? 'failed' : 'success'
      try {
        await logSyncFinish(startRunId, acc.user, { scanned: stats.scanned, matched: stats.matched, inserted: stats.inserted, failed: stats.failed, skipped_duplicate: stats.skipped_duplicate, last_uid_before: lastBefore, last_uid_after: lastUid, duration_ms: duration, status: statusFinal, skipped_reason_counts: skippedReasons, failed_reason_counts: failedReasons }, dbClient)
      } catch {}
      try {
        if (!hadFailure && Number(stats.scanned || 0) === 0) {
          if (typeof startRunId === 'string') {
            await dbq(dbClient).query("UPDATE email_sync_runs SET error_code='no_new_uid', error_message=$2 WHERE run_id=$1", [startRunId, `no new uid (last_uid=${lastBefore})`])
          } else {
            await dbq(dbClient).query("UPDATE email_sync_runs SET error_code='no_new_uid', error_message=$2 WHERE id=$1", [startRunId, `no new uid (last_uid=${lastBefore})`])
          }
        }
      } catch {}
      try {
        if (statusFinal === 'failed' && failureCode) {
          if (typeof startRunId === 'string') {
            await dbq(dbClient).query('UPDATE email_sync_runs SET error_code=$2, error_message=$3 WHERE run_id=$1', [startRunId, failureCode, failureMessage])
          } else {
            await dbq(dbClient).query('UPDATE email_sync_runs SET error_code=$2, error_message=$3 WHERE id=$1', [startRunId, failureCode, failureMessage])
          }
        }
      } catch {}
      try { await imap.logout() } catch {}
      await resetFailures(acc.user, dbClient)
      if (mode === 'incremental' && !dry_run) { try { await setEmailStateIncremental(acc.user, lastUid, dbClient) } catch {} }
      try {
        if (typeof startRunId === 'string') {
          await dbq(dbClient).query("UPDATE email_sync_runs SET status=$2, finished_at=COALESCE(finished_at, now()) WHERE run_id=$1 AND status='running'", [startRunId, statusFinal])
        } else {
          await dbq(dbClient).query("UPDATE email_sync_runs SET status=$2, ended_at=COALESCE(ended_at, now()) WHERE id=$1 AND status='running'", [startRunId, statusFinal])
        }
      } catch {}
      })
      } catch (e: any) {
        if (String(e?.reason || '').toLowerCase() === 'locked') {
          try {
            const st = await getEmailState(acc.user)
            const lastBefore = Number(st?.last_uid || 0)
            const rid = await logSyncStart(acc.user, lastBefore, 'locked', undefined, trigger_source)
            scheduleRuns.push({ account: acc.user, run_id: rid })
            await logSyncFinish(rid, acc.user, { scanned: 0, matched: 0, inserted: 0, failed: 0, skipped_duplicate: 0, last_uid_before: lastBefore, last_uid_after: lastBefore, duration_ms: 0, status: 'skipped', error_message: 'already_running' })
          } catch {}
          continue
        }
        throw e
      }
    }
    return { ok: true, schedule_runs: scheduleRuns, stats }
  })()
  return result
}
function accountLockKey(account: string): [number, number] {
  let h1 = 5381
  for (let i = 0; i < account.length; i++) { h1 = ((h1 << 5) + h1) + account.charCodeAt(i) }
  let h2 = 0
  for (let i = 0; i < account.length; i++) { h2 = account.charCodeAt(i) + (h2 << 6) + (h2 << 16) - h2 }
  return [(h1 | 0), (h2 | 0)]
}
let HEADER_DATE_CAST: '::timestamptz' | '::timestamp' = '::timestamptz'
async function detectHeaderDateCast(dbClient?: PoolClient) {
  try {
    const rs = await dbq(dbClient).query("SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='email_sync_items' AND column_name='header_date' LIMIT 1")
    const dt = String(rs?.rows?.[0]?.data_type || '').toLowerCase()
    if (dt.includes('timestamp with time zone')) HEADER_DATE_CAST = '::timestamptz'
    else if (dt.includes('timestamp')) HEADER_DATE_CAST = '::timestamp'
  } catch {}
}
