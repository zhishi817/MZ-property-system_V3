import { hasPg, pgPool } from '../dbAdapter'
import { emitNotificationEvent } from '../services/notificationEvents'
import { listManagerUserIds } from '../modules/notifications'

function melbourneYmd(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const y = parts.find((part) => part.type === 'year')?.value || '1970'
  const m = parts.find((part) => part.type === 'month')?.value || '01'
  const d = parts.find((part) => part.type === 'day')?.value || '01'
  return `${y}-${m}-${d}`
}

async function listPendingDayEndHandoverUsers(date: string) {
  if (!hasPg || !pgPool) return []
  await pgPool.query(
    `CREATE TABLE IF NOT EXISTS cleaning_day_end_handover (
      user_id text NOT NULL,
      date date NOT NULL,
      no_dirty_linen boolean DEFAULT false,
      submitted_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (user_id, date)
    );`,
  )
  const result = await pgPool.query(
    `
      WITH active_task_users AS (
        SELECT DISTINCT user_id, task_kind
        FROM (
          SELECT NULLIF(TRIM(cleaner_id::text), '') AS user_id, 'cleaning' AS task_kind
          FROM cleaning_tasks
          WHERE COALESCE(task_date, date) = $1::date
            AND lower(COALESCE(status, '')) NOT IN ('cancelled', 'canceled')
            AND lower(COALESCE(task_kind, '')) = 'cleaning'

          UNION ALL

          SELECT NULLIF(TRIM(assignee_id::text), '') AS user_id, lower(COALESCE(task_kind, '')) AS task_kind
          FROM cleaning_tasks
          WHERE COALESCE(task_date, date) = $1::date
            AND lower(COALESCE(status, '')) NOT IN ('cancelled', 'canceled')
            AND lower(COALESCE(task_kind, '')) IN ('cleaning', 'inspection')

          UNION ALL

          SELECT NULLIF(TRIM(inspector_id::text), '') AS user_id, 'inspection' AS task_kind
          FROM cleaning_tasks
          WHERE COALESCE(task_date, date) = $1::date
            AND lower(COALESCE(status, '')) NOT IN ('cancelled', 'canceled')
            AND lower(COALESCE(task_kind, '')) = 'inspection'
        ) q
        WHERE user_id IS NOT NULL
          AND task_kind IN ('cleaning', 'inspection')
      )
      SELECT DISTINCT t.user_id, COALESCE(NULLIF(TRIM(u.username), ''), NULLIF(TRIM(u.legal_name), ''), NULLIF(TRIM(u.email), ''), t.user_id) AS user_name
      FROM active_task_users t
      JOIN users u
        ON u.id::text = t.user_id
      LEFT JOIN cleaning_day_end_handover h
        ON h.user_id = t.user_id
       AND h.date = $1::date
       AND h.submitted_at IS NOT NULL
      WHERE h.user_id IS NULL
        AND (
          (
            t.task_kind = 'cleaning'
            AND (
              u.role IN ('cleaner', 'cleaner_inspector')
              OR EXISTS (
                SELECT 1
                FROM user_roles ur
                WHERE ur.user_id = u.id::text
                  AND ur.role_name IN ('cleaner', 'cleaner_inspector')
              )
            )
          )
          OR
          (
            t.task_kind = 'inspection'
            AND (
              u.role IN ('cleaning_inspector', 'cleaner_inspector')
              OR EXISTS (
                SELECT 1
                FROM user_roles ur
                WHERE ur.user_id = u.id::text
                  AND ur.role_name IN ('cleaning_inspector', 'cleaner_inspector')
              )
            )
          )
        )
    `,
    [date],
  )
  return Array.from(
    new Map(
      (result?.rows || [])
        .map((row: any) => ({
          user_id: String(row.user_id || '').trim(),
          user_name: String(row.user_name || '').trim(),
        }))
        .filter((row: any) => !!row.user_id)
        .map((row: any) => [row.user_id, row]),
    ).values(),
  )
}

export async function runDayEndHandoverReminder(params?: { at?: string; date?: string }) {
  if (!hasPg || !pgPool) return { skipped: 'pg=false' }
  const at = String(params?.at || '').trim() || '15:00'
  const date = String(params?.date || '').trim() || melbourneYmd()
  const pendingUsers = await listPendingDayEndHandoverUsers(date)
  const userIds = pendingUsers.map((x) => x.user_id)
  if (!userIds.length) return { ok: true, skipped: 'no_pending_users', date, at, sent: 0 }
  const title = '提醒：提交日终交接'
  const body = `请在今天 ${at} 前后完成并提交日终交接任务`
  const updatedAt = `${date}T${at}:00+10:00`
  const result = await emitNotificationEvent({
    type: 'WORK_TASK_UPDATED',
    entity: 'work_task',
    entityId: `day_end_handover_reminder:${date}:${at}`,
    updatedAt,
    title,
    body,
    recipientUserIds: userIds,
    priority: 'high',
    data: {
      kind: 'day_end_handover_reminder',
      date,
      at,
      action: 'open_day_end_handover',
      event_id: `day_end_handover_reminder:${date}:${at}`,
    },
  })
  return { ok: true, date, at, recipients: userIds.length, sent: Number((result as any)?.sent || 0) }
}

export async function runDayEndHandoverManagerReminder(params?: { at?: string; date?: string }) {
  if (!hasPg || !pgPool) return { skipped: 'pg=false' }
  const at = String(params?.at || '').trim() || '16:00'
  const date = String(params?.date || '').trim() || melbourneYmd()
  const pendingUsers = await listPendingDayEndHandoverUsers(date)
  if (!pendingUsers.length) return { ok: true, skipped: 'no_pending_users', date, at, sent: 0 }
  const managerIds = await listManagerUserIds({ roles: ['admin', 'offline_manager'] })
  if (!managerIds.length) return { ok: true, skipped: 'no_manager_users', date, at, sent: 0 }
  let sent = 0
  for (const user of pendingUsers) {
    const title = '提醒：有人未提交日终交接'
    const name = String(user.user_name || user.user_id).trim()
    const body = `${name} 在今天 ${at} 仍未提交日终交接，请及时跟进。`
    const updatedAt = `${date}T${at}:00+10:00`
    const result = await emitNotificationEvent({
      type: 'WORK_TASK_UPDATED',
      entity: 'work_task',
      entityId: `day_end_handover_manager_reminder:${date}:${at}:${user.user_id}`,
      updatedAt,
      title,
      body,
      recipientUserIds: managerIds,
      priority: 'high',
      data: {
        kind: 'day_end_handover_manager_reminder',
        date,
        at,
        action: 'open_day_end_handover',
        event_id: `day_end_handover_manager_reminder:${date}:${at}:${user.user_id}`,
        target_user_id: user.user_id,
        target_user_name: name,
        handover_status: 'pending',
      },
    })
    sent += Number((result as any)?.sent || 0)
  }
  return { ok: true, date, at, recipients: managerIds.length, pending_users: pendingUsers.length, sent }
}
