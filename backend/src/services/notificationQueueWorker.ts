import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'
import { notifyExpoUsers } from '../modules/notifications'
import { ensureNotificationStorage } from './notificationEvents'

type QueueRow = {
  id: string
  user_notification_id: string
  user_id: string
  event_id: string
  title: string
  body: string
  data: any
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function delayMsForAttempt(attempt: number) {
  const a = clamp(attempt, 1, 5)
  return a * 60 * 1000
}

async function takePendingBatch(limit: number): Promise<QueueRow[]> {
  if (!hasPg || !pgPool) return []
  await ensureNotificationStorage()
  const rows = await pgRunInTransaction(async (client: any) => {
    const r = await client.query(
      `SELECT
         q.id,
         q.user_notification_id,
         q.user_id,
         q.event_id,
         n.title,
         n.body,
         n.data
       FROM event_queue q
       JOIN user_notifications n ON n.id = q.user_notification_id
       WHERE q.status = 'pending'
         AND q.run_after <= now()
       ORDER BY q.created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [Math.max(1, Math.min(200, Number(limit || 50)))],
    )
    const list: QueueRow[] = (r?.rows || []).map((x: any) => ({
      id: String(x.id || ''),
      user_notification_id: String(x.user_notification_id || ''),
      user_id: String(x.user_id || ''),
      event_id: String(x.event_id || ''),
      title: String(x.title || ''),
      body: String(x.body || ''),
      data: x.data,
    }))
    const ids = list.map((x) => x.id).filter(Boolean)
    if (ids.length) {
      await client.query(`UPDATE event_queue SET status='processing' WHERE id = ANY($1::text[])`, [ids])
    }
    return list
  })
  return Array.isArray(rows) ? rows : []
}

async function markSent(ids: string[]) {
  if (!hasPg || !pgPool) return
  const list = ids.map((x) => String(x || '').trim()).filter(Boolean)
  if (!list.length) return
  await pgPool.query(`UPDATE event_queue SET status='sent' WHERE id = ANY($1::text[])`, [list])
}

async function markFailed(rows: { id: string; error: string }[]) {
  if (!hasPg || !pgPool) return
  for (const it of rows) {
    const id = String(it.id || '').trim()
    if (!id) continue
    const err = String(it.error || '').slice(0, 500)
    try {
      const r = await pgPool.query(`SELECT attempts FROM event_queue WHERE id=$1 LIMIT 1`, [id])
      const prev = Number(r?.rows?.[0]?.attempts || 0)
      const next = prev + 1
      if (next < 3) {
        const delay = delayMsForAttempt(next)
        await pgPool.query(
          `UPDATE event_queue
           SET status='pending', attempts=$2, last_error=$3, run_after = now() + ($4::int * interval '1 millisecond')
           WHERE id=$1`,
          [id, next, err, delay],
        )
      } else {
        await pgPool.query(`UPDATE event_queue SET status='failed', attempts=$2, last_error=$3 WHERE id=$1`, [id, next, err])
      }
    } catch {}
  }
}

async function processOnce(batchSize: number) {
  const batch = await takePendingBatch(batchSize)
  if (!batch.length) return { taken: 0, sent: 0, failed: 0 }

  const byPayload = new Map<string, { title: string; body: string; data: any; userIds: string[]; queueIds: string[] }>()
  for (const row of batch) {
    const key = `${row.title}\n${row.body}\n${JSON.stringify(row.data || {})}`
    const cur = byPayload.get(key) || { title: row.title, body: row.body, data: row.data || {}, userIds: [], queueIds: [] }
    cur.userIds.push(row.user_id)
    cur.queueIds.push(row.id)
    byPayload.set(key, cur)
  }

  const sentIds: string[] = []
  const failed: { id: string; error: string }[] = []

  for (const [, group] of byPayload) {
    try {
      await notifyExpoUsers({ user_ids: group.userIds, title: group.title, body: group.body, data: group.data || {} })
      sentIds.push(...group.queueIds)
    } catch (e: any) {
      const msg = String(e?.message || 'send_failed')
      for (const id of group.queueIds) failed.push({ id, error: msg })
    }
  }

  if (sentIds.length) await markSent(sentIds)
  if (failed.length) await markFailed(failed)

  return { taken: batch.length, sent: sentIds.length, failed: failed.length }
}

export async function runNotificationQueueCleanup() {
  if (!hasPg || !pgPool) return { ok: true }
  await ensureNotificationStorage()
  try {
    await pgPool.query(`DELETE FROM event_queue WHERE status='sent' AND created_at < now() - interval '7 days'`)
  } catch {}
  try {
    await pgPool.query(`DELETE FROM event_queue WHERE status='failed' AND created_at < now() - interval '30 days'`)
  } catch {}
  try {
    await pgPool.query(`DELETE FROM user_notifications WHERE created_at < now() - interval '90 days'`)
  } catch {}
  return { ok: true }
}

export function startNotificationQueueWorker(params?: { intervalMs?: number; batchSize?: number }) {
  const intervalMs = Math.max(800, Math.min(30000, Number(params?.intervalMs || 2500)))
  const batchSize = Math.max(1, Math.min(200, Number(params?.batchSize || 50)))
  let stopped = false
  let running = false

  const timer = setInterval(() => {
    if (stopped) return
    if (running) return
    running = true
    processOnce(batchSize)
      .catch(() => null)
      .finally(() => {
        running = false
      })
  }, intervalMs)

  return () => {
    stopped = true
    try {
      clearInterval(timer)
    } catch {}
  }
}
