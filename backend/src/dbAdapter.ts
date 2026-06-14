import { Pool, types } from 'pg'

types.setTypeParser(1082, (val) => val)
types.setTypeParser(1114, (val) => val)
types.setTypeParser(1184, (val) => val)

const conn = process.env.DATABASE_URL || ''
const pgPoolMax = Number(process.env.PG_POOL_MAX || 10)
const pgPoolConfig: any = {
  connectionString: conn,
  ssl: { rejectUnauthorized: false },
  max: pgPoolMax,
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10000),
  keepAlive: true,
  keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_DELAY_MS || 10000),
  maxLifetimeSeconds: Number(process.env.PG_MAX_LIFETIME_SECONDS || 300),
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 60000),
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 45000),
  idle_in_transaction_session_timeout: Number(process.env.PG_IDLE_TX_TIMEOUT_MS || 60000),
}
export const pgPool = conn ? new Pool(pgPoolConfig) : null
export const hasPg = !!pgPool
const afterCommitCallbacksKey = Symbol.for('mz_pg_after_commit_callbacks')
const checkedOutClients = new Map<number, { id: number; at: number; stack: string }>()
let checkedOutSeq = 0

function normalizeBoolEnv(value: any, fallback = false): boolean {
  const s = String(value ?? '').trim().toLowerCase()
  if (!s) return fallback
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function trackCheckedOutClient(client: any) {
  if (!client) return client
  const id = ++checkedOutSeq
  const stack = String(new Error().stack || '').split('\n').slice(2, 10).join(' | ')
  checkedOutClients.set(id, { id, at: Date.now(), stack })
  // pg-pool replaces client.release with a fresh single-use closure on every
  // checkout. Always wrap that current closure; reusing an older one leaks the
  // client after its first trip through the pool.
  const rawRelease = client.release?.bind(client)
  let released = false
  client.release = (err?: any) => {
    if (released) return
    released = true
    checkedOutClients.delete(id)
    return rawRelease?.(err)
  }
  return client
}

function installPoolInstrumentation() {
  if (!pgPool) return
  const poolAny: any = pgPool as any
  if (poolAny.__mz_pool_instrumented) return
  poolAny.__mz_pool_instrumented = true
  const originalConnect = pgPool.connect.bind(pgPool)
  poolAny.connect = (callback?: any) => {
    if (typeof callback === 'function') {
      return originalConnect((err: any, client: any, done: any) => {
        if (err || !client) return callback(err, client, done)
        const tracked = trackCheckedOutClient(client)
        return callback(null, tracked, (releaseErr?: any) => tracked.release(releaseErr))
      })
    }
    return originalConnect().then((client: any) => trackCheckedOutClient(client))
  }
}

export function getPgPoolStats(includeStack = false) {
  const now = Date.now()
  const active = Array.from(checkedOutClients.values())
    .map((item) => ({ id: item.id, held_ms: now - item.at, stack: item.stack }))
    .sort((a, b) => b.held_ms - a.held_ms)
  return {
    configured_max: pgPoolMax,
    total: Number((pgPool as any)?.totalCount || 0),
    idle: Number((pgPool as any)?.idleCount || 0),
    waiting: Number((pgPool as any)?.waitingCount || 0),
    checked_out: active.length,
    oldest_checked_out_ms: active[0]?.held_ms || 0,
    ...(includeStack ? { oldest_checked_out_stack: active[0]?.stack || '' } : {}),
  }
}

try {
  if (pgPool) {
    installPoolInstrumentation()
    if (pgPoolMax < 3) {
      console.warn(`[pg] pool_max_low configured_max=${pgPoolMax} recommended_min=3`)
    }
    pgPool.on('error', (err) => {
      try { console.error(`[pg] pool_error message=${String((err as any)?.message || '')} code=${String((err as any)?.code || '')}`) } catch {}
    })
    const warnMs = Math.max(30000, Number(process.env.PG_POOL_HOLD_WARN_MS || 60000))
    const stuckMs = Math.max(30000, Number(process.env.PG_POOL_STUCK_RESTART_MS || 120000))
    const exitOnStuck = normalizeBoolEnv(process.env.PG_POOL_EXIT_ON_STUCK, false)
    let stuckSince = 0
    const interval = setInterval(() => {
      try {
        const stats = getPgPoolStats(true)
        if (stats.oldest_checked_out_ms >= warnMs) {
          console.warn(`[pg] checked_out_long held_ms=${stats.oldest_checked_out_ms} checked_out=${stats.checked_out} total=${stats.total} idle=${stats.idle} waiting=${stats.waiting} stack=${stats.oldest_checked_out_stack}`)
        }
        const saturated = stats.waiting > 0 && stats.idle === 0 && stats.total >= pgPoolMax
        if (saturated) {
          if (!stuckSince) stuckSince = Date.now()
          const stuckFor = Date.now() - stuckSince
          console.error(`[pg] pool_saturated waiting=${stats.waiting} total=${stats.total} checked_out=${stats.checked_out} oldest_ms=${stats.oldest_checked_out_ms} stuck_ms=${stuckFor}`)
          if (exitOnStuck && stuckFor >= stuckMs) {
            console.error(`[pg] pool_saturated_restart stuck_ms=${stuckFor} threshold_ms=${stuckMs}`)
            process.exit(1)
          }
        } else {
          stuckSince = 0
        }
      } catch {}
    }, Math.max(15000, Number(process.env.PG_POOL_WATCHDOG_INTERVAL_MS || 30000)))
    try { interval.unref?.() } catch {}
  }
} catch {}

export async function pgRunWithAdvisoryLock<T>(key: number | [number, number], label: string, cb: () => Promise<T>): Promise<{ locked: boolean; result?: T }> {
  if (!pgPool) return { locked: false }
  const client = await pgPool.connect()
  let locked = false
  const started = Date.now()
  const params = Array.isArray(key) ? key : [key]
  const lockSql = Array.isArray(key) ? 'SELECT pg_try_advisory_lock($1, $2) AS ok' : 'SELECT pg_try_advisory_lock($1) AS ok'
  const unlockSql = Array.isArray(key) ? 'SELECT pg_advisory_unlock($1, $2)' : 'SELECT pg_advisory_unlock($1)'
  try {
    const lock = await client.query(lockSql, params)
    locked = !!(lock?.rows?.[0]?.ok)
    if (!locked) return { locked: false }
    const result = await cb()
    return { locked: true, result }
  } finally {
    if (locked) {
      try { await client.query(unlockSql, params) } catch (e: any) {
        try { console.error(`[pg] advisory_unlock_failed label=${label} message=${String(e?.message || '')}`) } catch {}
      }
    }
    try {
      const heldMs = Date.now() - started
      if (heldMs >= Number(process.env.PG_ADVISORY_LOCK_WARN_MS || 60000)) console.warn(`[pg] advisory_lock_long label=${label} held_ms=${heldMs}`)
    } catch {}
    client.release()
  }
}

export function pgRunAfterCommit(client: any, callback: () => void): boolean {
  const callbacks = client?.[afterCommitCallbacksKey]
  if (!(callbacks instanceof Set)) return false
  callbacks.add(callback)
  return true
}

function buildWhere(filters?: Record<string, any>) {
  const keys = Object.keys(filters || {})
  if (!keys.length) return { clause: '', values: [] as any[] }
  const parts = keys.map((k, i) => `"${k}" = $${i + 1}`)
  const rawValues = keys.map((k) => (filters as any)[k])
  const values = rawValues.map((v) => (v === undefined ? null : v))
  return { clause: ` WHERE ${parts.join(' AND ')}`, values }
}

export async function pgSelect(table: string, columns = '*', filters?: Record<string, any>, client?: any) {
  const executor = client || pgPool
  if (!executor) return null
  const w = buildWhere(filters)
  const sql = `SELECT ${columns} FROM ${table}${w.clause}`
  const res = await executor.query(sql, w.values)
  return res.rows
}

export async function pgInsert(table: string, payload: Record<string, any>, client?: any) {
  const executor = client || pgPool
  if (!executor) return null
  const keys = Object.keys(payload)
  const cols = keys.map(k => `"${k}"`).join(',')
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(',')
  const values = keys.map((k) => payload[k]).map(v => (v === undefined ? null : v))
  const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`
  const res = await executor.query(sql, values)
  return res.rows[0]
}

export async function pgUpdate(table: string, id: string, payload: Record<string, any>, client?: any) {
  const executor = client || pgPool
  if (!executor) return null
  const keys = Object.keys(payload).filter(k => payload[k] !== undefined)
  if (!keys.length) {
    const res0 = await executor.query(`SELECT * FROM ${table} WHERE id = $1`, [id])
    return res0.rows[0] || null
  }
  const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
  const values = keys.map((k) => payload[k]).map(v => (v === undefined ? null : v))
  const sql = `UPDATE ${table} SET ${set} WHERE id = $${keys.length + 1} RETURNING *`
  const res = await executor.query(sql, [...values, id])
  return res.rows[0]
}

export async function pgDelete(table: string, id: string, client?: any) {
  const executor = client || pgPool
  if (!executor) return null
  const sql = `DELETE FROM ${table} WHERE id = $1 RETURNING *`
  const res = await executor.query(sql, [id])
  return res.rows[0]
}

export async function pgRunInTransaction<T>(cb: (client: any) => Promise<T>) {
  if (!pgPool) return null
  const client = await pgPool.connect()
  ;(client as any)[afterCommitCallbacksKey] = new Set<() => void>()
  try {
    const k = Symbol.for('mz_pg_client_error_listener_attached')
    if (!(client as any)[k]) {
      ;(client as any)[k] = true
      client.on('error', (err: any) => {
        try { console.error(`[pg] client_error message=${String(err?.message || '')} code=${String(err?.code || '')}`) } catch {}
      })
    }
  } catch {}
  try {
    await client.query('BEGIN')
    const result = await cb(client)
    await client.query('COMMIT')
    const callbacks = Array.from((client as any)[afterCommitCallbacksKey] || []) as Array<() => void>
    ;(client as any)[afterCommitCallbacksKey] = new Set<() => void>()
    for (const callback of callbacks) {
      try { callback() } catch {}
    }
    return result
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    try { delete (client as any)[afterCommitCallbacksKey] } catch {}
    client.release()
  }
}

export async function pgInsertOnConflictDoNothing(table: string, payload: Record<string, any>, conflictColumns: string[], client?: any) {
  if (!pgPool) return null
  const keys = Object.keys(payload)
  const cols = keys.map(k => `"${k}"`).join(',')
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(',')
  const values = keys.map((k) => payload[k]).map(v => (v === undefined ? null : v))
  const conflict = conflictColumns.map(k => `"${k}"`).join(',')
  const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT (${conflict}) DO NOTHING RETURNING *`
  const executor = client || pgPool
  const res = await executor.query(sql, values)
  return res.rows[0] || null
}

export async function pgDeleteWhere(table: string, filters: Record<string, any>, client?: any) {
  if (!pgPool) return null
  const w = buildWhere(filters)
  const sql = `DELETE FROM ${table}${w.clause}`
  const executor = client || pgPool
  await executor.query(sql, w.values)
}
