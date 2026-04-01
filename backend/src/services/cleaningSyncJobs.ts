import crypto from 'crypto'
import { ensureCleaningSyncJobsSchema } from './cleaningSyncJobsSchema'

export type CleaningSyncJobAction = 'created' | 'updated' | 'deleted'

function stableStringify(v: any): string {
  const seen = new WeakSet()
  const walk = (x: any): any => {
    if (x === null || x === undefined) return x
    const t = typeof x
    if (t === 'string' || t === 'number' || t === 'boolean') return x
    if (x instanceof Date) return x.toISOString()
    if (Array.isArray(x)) return x.map(walk)
    if (t === 'object') {
      if (seen.has(x)) return '[Circular]'
      seen.add(x)
      const keys = Object.keys(x).sort()
      const out: any = {}
      for (const k of keys) out[k] = walk(x[k])
      return out
    }
    return String(x)
  }
  return JSON.stringify(walk(v))
}

function fingerprintOf(action: CleaningSyncJobAction, orderId: string, snapshot: any): string {
  const s = stableStringify({ action, order_id: orderId, snapshot })
  return crypto.createHash('sha1').update(s).digest('hex')
}

export async function enqueueCleaningSyncJobTx(
  client: any,
  params: {
    order_id: string
    action: CleaningSyncJobAction
    payload_snapshot?: any
  }
): Promise<{ id: string; merged: boolean }> {
  try {
    await ensureCleaningSyncJobsSchema()
  } catch (e: any) {
    if (String(e?.code || '') === 'CLEANING_SCHEMA_MISSING') return { id: '', merged: false }
    throw e
  }
  const orderId = String(params.order_id || '').trim()
  const action = String(params.action || '').trim() as CleaningSyncJobAction
  const snapshot = params.payload_snapshot ?? null
  if (!orderId) throw new Error('order_id_required')
  if (!action || !['created', 'updated', 'deleted'].includes(action)) throw new Error('action_required')

  const isInactiveOrderStatus = (raw: any): boolean => {
    const s = String(raw || '').trim().toLowerCase()
    if (!s) return false
    if (s.includes('cancel')) return true
    if (s === 'void') return true
    if (s === 'invalid') return true
    return false
  }

  if (action !== 'deleted') {
    try {
      const rs = await client.query(
        'SELECT lower(coalesce(status, \'\')) AS s FROM orders WHERE (id::text) = $1 LIMIT 1',
        [orderId]
      )
      const statusLower = String(rs?.rows?.[0]?.s || '')
      if (isInactiveOrderStatus(statusLower)) {
        try {
          await client.query(
            `UPDATE cleaning_sync_jobs
             SET status='skipped', updated_at=now(),
                 last_error_code='order_cancelled', last_error_message='order_status_cancelled'
             WHERE order_id=$1 AND status IN ('pending','running') AND action IN ('created','updated')`,
            [orderId]
          )
        } catch {}
        try {
          await client.query(
            `UPDATE cleaning_tasks
             SET status='cancelled', updated_at=now()
             WHERE (order_id::text) = $1 AND status <> 'cancelled'`,
            [orderId]
          )
        } catch {}
        return { id: '', merged: false }
      }
    } catch {}
  }

  const fp = fingerprintOf(action, orderId, snapshot)

  if (action === 'deleted') {
    try {
      await client.query(
        `UPDATE cleaning_sync_jobs
         SET status='done', updated_at=now(), last_error_code='superseded', last_error_message='superseded_by_delete'
         WHERE order_id=$1 AND status='pending' AND action IN ('created','updated')`,
        [orderId]
      )
    } catch {}
  }

  const existing = await client.query(
    `SELECT id, status
     FROM cleaning_sync_jobs
     WHERE order_id=$1 AND action=$2 AND status IN ('pending','running')
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [orderId, action]
  )
  const row = existing?.rows?.[0]
  const existingId = row ? String(row.id || '') : ''
  if (existingId) {
    await client.query(
      `UPDATE cleaning_sync_jobs
       SET fingerprint=$2, payload_snapshot=$3, next_retry_at=now(), updated_at=now()
       WHERE id=$1`,
      [existingId, fp, snapshot]
    )
    return { id: existingId, merged: true }
  }

  const { v4: uuid } = require('uuid')
  const id = uuid()
  await client.query(
    `INSERT INTO cleaning_sync_jobs(id, order_id, action, fingerprint, payload_snapshot, status, attempts, max_attempts, next_retry_at, running_started_at)
     VALUES($1,$2,$3,$4,$5,'pending',0,10,now(),NULL)`,
    [id, orderId, action, fp, snapshot]
  )
  return { id, merged: false }
}
