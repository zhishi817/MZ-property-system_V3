import { hasPg, pgPool } from '../dbAdapter'
import { emitNotificationEvent } from '../services/notificationEvents'

async function ensureCustomerServiceMemoReminderColumns() {
  if (!hasPg || !pgPool) return
  await pgPool.query(`ALTER TABLE mzapp_customer_service_memos ADD COLUMN IF NOT EXISTS reminder_at timestamptz;`)
  await pgPool.query(`ALTER TABLE mzapp_customer_service_memos ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mzapp_customer_service_memos_reminder_due ON mzapp_customer_service_memos(reminder_at, reminder_sent_at);`)
}

export async function runCustomerServiceMemoReminderJob() {
  if (!hasPg || !pgPool) return { skipped: 'pg=false' }
  await ensureCustomerServiceMemoReminderColumns()
  const r = await pgPool.query(
    `SELECT id, user_id, content, reminder_at::text AS reminder_at
     FROM mzapp_customer_service_memos
     WHERE reminder_at IS NOT NULL
       AND reminder_sent_at IS NULL
       AND is_done = false
       AND reminder_at <= now()
     ORDER BY reminder_at ASC
     LIMIT 100`,
  )
  const rows = Array.isArray(r?.rows) ? r.rows : []
  let sent = 0
  for (const row of rows) {
    const memoId = String(row?.id || '').trim()
    const userId = String(row?.user_id || '').trim()
    const content = String(row?.content || '').trim()
    const reminderAt = String(row?.reminder_at || '').trim()
    if (!memoId || !userId) continue
    const eventId = `customer_service_memo_reminder:${memoId}:${reminderAt || 'now'}`
    const result = await emitNotificationEvent({
      type: 'CUSTOMER_SERVICE_MEMO_REMINDER',
      entity: 'work_task',
      entityId: memoId,
      eventId,
      updatedAt: reminderAt || new Date().toISOString(),
      title: '客服备忘录提醒',
      body: content ? `提醒你处理：${content.slice(0, 80)}` : '你有一条客服备忘录需要处理。',
      recipientUserIds: [userId],
      priority: 'high',
      data: {
        kind: 'customer_service_memo_reminder',
        memo_id: memoId,
        memo_content: content,
        reminder_at: reminderAt || null,
        action: 'open_customer_service_memo',
        event_id: eventId,
      },
      excludeActor: false,
    })
    await pgPool.query(
      `UPDATE mzapp_customer_service_memos
       SET reminder_sent_at = now(), updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [memoId, userId],
    )
    sent += Number((result as any)?.sent || 0)
  }
  return { ok: true, processed: rows.length, sent }
}
