import { Pool } from 'pg'

const conn = process.env.DATABASE_URL || ''
export const pgPool = conn ? new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: Number(process.env.PG_POOL_MAX || 10), idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000), connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10000) }) : null
export const hasPg = !!pgPool

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
  try {
    await client.query('BEGIN')
    const result = await cb(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
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
