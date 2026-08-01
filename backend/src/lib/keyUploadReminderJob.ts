import { hasPg, pgPool } from '../dbAdapter'
import { listManagerUserIds } from '../modules/notifications'
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

  const pendingTasksRes = await pgPool.query(
    `SELECT t.id::text AS task_id,
            COALESCE(NULLIF(TRIM(t.cleaner_id::text), ''), NULLIF(TRIM(t.assignee_id::text), '')) AS cleaner_id,
            NULLIF(TRIM(t.inspector_id::text), '') AS inspector_id
     FROM cleaning_tasks t
     WHERE COALESCE(t.task_date, t.date) = $1::date
       AND lower(COALESCE(t.status, '')) NOT IN ('cancelled', 'canceled')
       AND lower(COALESCE(t.task_kind, '')) = 'cleaning'
       AND COALESCE(NULLIF(TRIM(t.cleaner_id::text), ''), NULLIF(TRIM(t.assignee_id::text), '')) IS NOT NULL
       AND NOT (
         t.key_photo_uploaded_at IS NOT NULL
         OR EXISTS (
           SELECT 1
           FROM cleaning_task_media m
           WHERE m.task_id = t.id
             AND m.type = 'key_photo'
         )
       )`,
    [date],
  )
  const pendingTasks = (pendingTasksRes?.rows || [])
    .map((row: any) => ({
      taskId: String(row.task_id || '').trim(),
      cleanerId: String(row.cleaner_id || '').trim(),
      inspectorId: String(row.inspector_id || '').trim(),
    }))
    .filter((row: { taskId: string; cleanerId: string }) => !!row.taskId && !!row.cleanerId)
  const managerIds = pendingTasks.length ? await listManagerUserIds() : []

  const t0 = Date.now()
  let taskParticipantSent = 0
  for (const task of pendingTasks) {
    const eventId = `key_upload_reminder:${date}:${at}:task:${task.taskId}`
    const recipientUserIds = Array.from(new Set([task.cleanerId, task.inspectorId].filter(Boolean)))
    const r = await emitNotificationEvent({
      type: 'KEY_UPLOAD_REMINDER',
      policyKey: 'key_upload_reminder',
      entity: 'cleaning_task',
      entityId: task.taskId,
      eventId,
      title: '提醒：上传钥匙照片',
      body: `请检查并上传今日任务的钥匙照片（${at}）`,
      recipientUserIds,
      priority: 'high',
      data: {
        entity: 'cleaning_task',
        entityId: task.taskId,
        action: 'open_task',
        kind: 'key_upload_reminder',
        at,
        date,
        audience: 'task_participants',
        task_id: task.taskId,
        cleaning_task_ids: [task.taskId],
        event_id: eventId,
      },
    })
    taskParticipantSent += Number((r as any)?.sent || 0)
  }
  let managerSent = 0
  for (const userId of managerIds) {
    const eventId = `key_upload_reminder:${date}:${at}:manager:${userId}`
    const r = await emitNotificationEvent({
      type: 'KEY_UPLOAD_REMINDER',
      policyKey: 'key_upload_reminder',
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
  return {
    ok: true,
    at,
    date,
    duration_ms: Date.now() - t0,
    task_participants: { tasks: pendingTasks.length, sent: taskParticipantSent },
    managers: { recipients: managerIds.length, sent: managerSent },
  }
}
