import { hasPg, pgPool } from '../dbAdapter'
import { listCleanerUserIds, listManagerUserIds } from '../modules/notifications'
import { emitNotificationEvent } from '../services/notificationEvents'

function melbourneYmd(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const m: Record<string, string> = {}
  for (const p of parts) {
    if (p.type !== 'literal') m[p.type] = p.value
  }
  return `${m.year || '1970'}-${m.month || '01'}-${m.day || '01'}`
}

export async function runKeyUploadReminder(params: { at: string }) {
  if (!hasPg || !pgPool) return { skipped: 'pg=false' }
  const at = String(params.at || '').trim() || 'now'
  const date = melbourneYmd()

  const cleanerIds = await listCleanerUserIds()
  const managerIds = await listManagerUserIds()

  const t0 = Date.now()
  let cleanerSent = 0
  for (const userId of cleanerIds) {
    const eventId = `key_upload_reminder:${date}:${at}:cleaner:${userId}`
    const r = await emitNotificationEvent({
      type: 'KEY_UPLOAD_REMINDER',
      entity: 'work_task',
      entityId: eventId,
      eventId,
      title: '提醒：上传钥匙照片',
      body: `请检查并上传今日任务的钥匙照片（${at}）`,
      recipientUserIds: [userId],
      priority: 'high',
      data: { kind: 'key_upload_reminder', at, date, audience: 'cleaner', event_id: eventId },
    })
    cleanerSent += Number((r as any)?.sent || 0)
  }
  let managerSent = 0
  for (const userId of managerIds) {
    const eventId = `key_upload_reminder:${date}:${at}:manager:${userId}`
    const r = await emitNotificationEvent({
      type: 'KEY_UPLOAD_REMINDER',
      entity: 'work_task',
      entityId: eventId,
      eventId,
      title: '提醒：检查钥匙照片',
      body: `请检查今日清洁任务钥匙照片是否已上传（${at}）`,
      recipientUserIds: [userId],
      priority: 'high',
      data: { kind: 'key_upload_reminder', at, date, audience: 'manager', event_id: eventId },
    })
    managerSent += Number((r as any)?.sent || 0)
  }
  return { ok: true, at, date, duration_ms: Date.now() - t0, cleaners: { recipients: cleanerIds.length, sent: cleanerSent }, managers: { recipients: managerIds.length, sent: managerSent } }
}
