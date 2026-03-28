import { pgPool, hasPg } from '../dbAdapter'

type Level = 'remind' | 'escalate'

function melbourneYmd(d: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const m: any = {}
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value
  return `${m.year}-${m.month}-${m.day}`
}

async function ensureMzappAlertsTable() {
  if (!hasPg || !pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS mzapp_alerts (
    id text PRIMARY KEY,
    kind text NOT NULL,
    target_user_id text NOT NULL,
    level text NOT NULL,
    date date,
    position integer,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz
  );`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mzapp_alerts_target_unread ON mzapp_alerts(target_user_id, read_at, created_at);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mzapp_alerts_kind ON mzapp_alerts(kind);`)
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_mzapp_alerts_dedupe ON mzapp_alerts(kind, target_user_id, date, position, level);`)
}

async function ensureKeyUploadDeps() {
  if (!hasPg || !pgPool) return
  await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS key_photo_uploaded_at timestamptz`)
  await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS sort_index_cleaner integer`)
  await pgPool.query(`CREATE TABLE IF NOT EXISTS cleaning_task_media (
    id text primary key,
    task_id text not null,
    type text not null,
    url text not null,
    created_at timestamptz not null default now(),
    note text
  )`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task_type ON cleaning_task_media(task_id, type)`)
}

export async function runKeyUploadSlaCheck(position: number, level: Level) {
  if (!hasPg || !pgPool) return { ok: false, skipped: 'no_pg' as const }
  await ensureMzappAlertsTable()
  await ensureKeyUploadDeps()

  const date = melbourneYmd(new Date())

  const sql = `
    WITH base AS (
      SELECT
        t.id,
        COALESCE(t.cleaner_id, t.assignee_id) AS cleaner_id,
        t.property_id,
        COALESCE(t.task_date, t.date) AS task_date,
        t.sort_index_cleaner,
        t.key_photo_uploaded_at,
        EXISTS(SELECT 1 FROM cleaning_task_media m WHERE m.task_id=t.id AND m.type='key_photo') AS has_key_photo,
        COALESCE(p_id.code, p_code.code, '') AS property_code,
        COALESCE(p_id.address, p_code.address, '') AS property_address
      FROM cleaning_tasks t
      LEFT JOIN properties p_id ON p_id.id = t.property_id::uuid
      LEFT JOIN properties p_code ON p_code.code = t.property_id::text
      WHERE COALESCE(t.task_date, t.date) = $1::date
        AND COALESCE(t.cleaner_id, t.assignee_id) IS NOT NULL
        AND COALESCE(t.status,'') <> 'cancelled'
    ),
    grp AS (
      SELECT
        cleaner_id,
        COALESCE(NULLIF(property_code,''), property_id::text) AS room_key,
        MAX(property_code) AS property_code,
        MAX(property_address) AS property_address,
        ARRAY_AGG(id) AS task_ids,
        MIN(COALESCE(sort_index_cleaner, 2147483647)) AS group_sort,
        BOOL_OR(has_key_photo OR key_photo_uploaded_at IS NOT NULL) AS uploaded
      FROM base
      GROUP BY cleaner_id, COALESCE(NULLIF(property_code,''), property_id::text)
    ),
    ranked AS (
      SELECT
        g.*,
        ROW_NUMBER() OVER (PARTITION BY g.cleaner_id ORDER BY g.group_sort ASC, g.room_key ASC) AS pos
      FROM grp g
    )
    SELECT
      r.cleaner_id,
      r.property_code,
      r.property_address,
      r.task_ids,
      r.pos
    FROM ranked r
    WHERE r.pos = $2::int
      AND r.uploaded = false
  `
  const rs = await pgPool.query(sql, [date, position])
  const rows = rs?.rows || []

  if (!rows.length) return { ok: true, created: 0 }

  const managers = await pgPool.query(
    `SELECT DISTINCT u.id, u.username, u.phone_au, u.role
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id::text
     WHERE u.role IN ('admin','offline_manager') OR ur.role_name IN ('admin','offline_manager')`,
  )
  const managersRows = managers?.rows || []

  for (const r of rows) {
    const cleanerId = String(r.cleaner_id || '')
    if (!cleanerId) continue

    const cleanerInfo = await pgPool.query(`SELECT id, username, phone_au FROM users WHERE id=$1 LIMIT 1`, [cleanerId])
    const cleaner = cleanerInfo?.rows?.[0] || null
    const cleaner_username = String(cleaner?.username || '')
    const cleaner_phone_au = cleaner?.phone_au == null ? null : String(cleaner.phone_au || '').trim() || null
    const property_code = String(r.property_code || '').trim() || null
    const property_address = String(r.property_address || '').trim() || null
    const task_ids = Array.isArray(r.task_ids) ? r.task_ids.map((x: any) => String(x)) : []
    const payload = {
      date,
      position,
      level,
      property_code,
      property_address,
      cleaner_id: cleanerId,
      cleaner_username,
      cleaner_phone_au,
      cleaning_task_ids: task_ids,
    }

    const kind = 'key_upload_sla'
    if (level === 'remind') {
      const id = `${kind}:${date}:${position}:${level}:${cleanerId}`
      const ins = await pgPool.query(
        `INSERT INTO mzapp_alerts (id, kind, target_user_id, level, date, position, payload)
         VALUES ($1,$2,$3,$4,$5::date,$6::int,$7::jsonb)
         ON CONFLICT DO NOTHING`,
        [id, kind, cleanerId, level, date, position, JSON.stringify(payload)],
      )
      if (ins?.rowCount) {
        try {
          const { notifyExpoUsers } = require('../modules/notifications')
          const title = '上传钥匙提醒'
          const body = `${property_code || '房源'}：请尽快上传钥匙照片（第 ${position} 个任务）`
          await notifyExpoUsers({ user_ids: [cleanerId], title, body, data: { kind, level, position, event_id: id, cleaning_task_ids: task_ids, property_code } })
        } catch {}
      }
    } else {
      const notifyIds: string[] = []
      for (const m of managersRows) {
        const mid = String(m.id || '').trim()
        if (!mid) continue
        const id = `${kind}:${date}:${position}:${level}:${mid}:${cleanerId}`
        const ins = await pgPool.query(
          `INSERT INTO mzapp_alerts (id, kind, target_user_id, level, date, position, payload)
           VALUES ($1,$2,$3,$4,$5::date,$6::int,$7::jsonb)
           ON CONFLICT DO NOTHING`,
          [id, kind, mid, level, date, position, JSON.stringify(payload)],
        )
        if (ins?.rowCount) notifyIds.push(mid)
      }
      if (notifyIds.length) {
        try {
          const { notifyExpoUsers } = require('../modules/notifications')
          const title = '上传钥匙超时提醒'
          const body = `${property_code || '房源'}：清洁员未按时上传钥匙照片（第 ${position} 个任务）`
          await notifyExpoUsers({
            user_ids: notifyIds,
            title,
            body,
            data: { kind, level, position, event_id: `${kind}:${date}:${position}:${level}:${cleanerId}`, cleaning_task_ids: task_ids, property_code, cleaner_id: cleanerId },
          })
        } catch {}
      }
    }
  }

  return { ok: true, created: rows.length }
}
