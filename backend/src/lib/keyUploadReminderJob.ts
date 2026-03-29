import { hasPg, pgPool } from '../dbAdapter'
import { listCleanerUserIds, listManagerUserIds, notifyExpoUsers } from '../modules/notifications'

export async function runKeyUploadReminder(params: { at: string }) {
  if (!hasPg || !pgPool) return { skipped: 'pg=false' }
  const at = String(params.at || '').trim() || 'now'

  const cleanerIds = await listCleanerUserIds()
  const managerIds = await listManagerUserIds({ roles: ['admin', 'customer_service'] })

  const t0 = Date.now()
  const r1 = await notifyExpoUsers({
    user_ids: cleanerIds,
    title: '提醒：上传钥匙照片',
    body: `请检查并上传今日任务的钥匙照片（${at}）`,
    data: { kind: 'key_upload_reminder', at, audience: 'cleaner', event_id: `key_upload_reminder:${at}:cleaner` },
  })
  const r2 = await notifyExpoUsers({
    user_ids: managerIds,
    title: '提醒：检查钥匙照片',
    body: `请检查今日清洁任务钥匙照片是否已上传（${at}）`,
    data: { kind: 'key_upload_reminder', at, audience: 'manager', event_id: `key_upload_reminder:${at}:manager` },
  })
  return { ok: true, at, duration_ms: Date.now() - t0, cleaners: r1, managers: r2 }
}

