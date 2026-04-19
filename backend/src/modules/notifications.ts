import { Router } from 'express'
import { requireAnyPerm, requirePerm } from '../auth'
import { hasPg, pgInsert, pgPool, pgSelect } from '../dbAdapter'
import https from 'https'
import { ensureNotificationStorage } from '../services/notificationEvents'

export const router = Router()

let expoTokensEnsured = false
let expoTokensEnsuring: Promise<void> | null = null

async function ensureExpoPushTokensTable() {
  if (!hasPg || !pgPool) return
  if (expoTokensEnsured) return
  if (expoTokensEnsuring) return expoTokensEnsuring
  expoTokensEnsuring = (async () => {
    await pgPool.query(
      `CREATE TABLE IF NOT EXISTS expo_push_tokens (
        token text PRIMARY KEY,
        user_id text NOT NULL,
        device_id text,
        platform text,
        ua text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );`,
    )
    await pgPool.query(`ALTER TABLE expo_push_tokens ADD COLUMN IF NOT EXISTS device_id text;`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS expo_push_tokens_user_id_idx ON expo_push_tokens (user_id);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS expo_push_tokens_user_device_idx ON expo_push_tokens (user_id, device_id);`)
    expoTokensEnsured = true
  })()
    .catch(() => {})
    .finally(() => {
      expoTokensEnsuring = null
    })
  return expoTokensEnsuring
}

async function postJson(urlStr: string, body: any) {
  const u = new URL(urlStr)
  const data = Buffer.from(JSON.stringify(body || {}), 'utf8')
  return await new Promise<any>((resolve, reject) => {
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port ? Number(u.port) : 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(data.length),
        },
        timeout: 15000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))))
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8')
          let parsed: any = null
          try {
            parsed = txt ? JSON.parse(txt) : null
          } catch {
            parsed = null
          }
          resolve({ status: res.statusCode || 0, json: parsed, text: txt })
        })
      },
    )
    req.on('timeout', () => {
      try {
        req.destroy(new Error('timeout'))
      } catch {}
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function sendExpoPush(tokens: string[], payload: { title: string; body: string; data?: any }) {
  const list = (tokens || []).map((x) => String(x || '').trim()).filter(Boolean)
  if (!list.length) return { sent: 0, failed: 0 }
  const url = 'https://exp.host/--/api/v2/push/send'
  let sent = 0
  let failed = 0
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90)
    const messages = chunk.map((to) => ({
      to,
      title: payload.title,
      body: payload.body,
      sound: 'default',
      data: payload.data || {},
    }))
    try {
      const r = await postJson(url, messages)
      const j = r?.json
      const arr = Array.isArray(j?.data) ? j.data : []
      sent += chunk.length
      for (const it of arr) {
        if (String(it?.status || '') !== 'ok') failed++
      }
    } catch {
      failed += chunk.length
    }
  }
  return { sent, failed }
}

router.post('/push/subscribe', requireAnyPerm(['cleaning_app.push.subscribe','cleaning_app.sse.subscribe']), async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const { endpoint, keys, ua } = req.body || {}
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) return res.status(400).json({ message: 'invalid subscription' })
  try {
    if (hasPg) {
      const rec = { user_id: String(user.sub || ''), endpoint: String(endpoint), p256dh: String(keys.p256dh), auth: String(keys.auth), ua: String(ua || '') }
      await pgInsert('push_subscriptions', rec as any, true)
      return res.json({ ok: true })
    }
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

router.post('/expo/register', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const { expo_push_token, device_id, platform, ua } = req.body || {}
  const token = String(expo_push_token || '').trim()
  const deviceId = String(device_id || '').trim() || null
  const platformText = platform == null ? null : String(platform || '')
  const uaText = ua == null ? null : String(ua || '')
  if (!token) return res.status(400).json({ message: 'missing expo_push_token' })
  if (!hasPg || !pgPool) return res.json({ ok: true })
  try {
    await ensureExpoPushTokensTable()
    await pgPool.query(
      `INSERT INTO expo_push_tokens (token, user_id, device_id, platform, ua, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (token)
       DO UPDATE SET user_id=EXCLUDED.user_id, device_id=EXCLUDED.device_id, platform=EXCLUDED.platform, ua=EXCLUDED.ua, updated_at=now()`,
      [token, userId, deviceId, platformText, uaText],
    )
    if (deviceId) {
      await pgPool.query(
        `DELETE FROM expo_push_tokens
         WHERE user_id = $1
           AND token <> $2
           AND (
             device_id = $3
             OR (
               device_id IS NULL
               AND COALESCE(platform, '') = COALESCE($4, '')
               AND COALESCE(ua, '') = COALESCE($5, '')
             )
           )`,
        [userId, token, deviceId, platformText, uaText],
      )
    }
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'expo_register_failed' })
  }
})

router.post('/expo/unregister', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '').trim()
  const token = String(req.body?.expo_push_token || '').trim()
  if (!token) return res.status(400).json({ message: 'missing expo_push_token' })
  if (!hasPg || !pgPool) return res.json({ ok: true })
  try {
    await ensureExpoPushTokensTable()
    await pgPool.query(`DELETE FROM expo_push_tokens WHERE token = $1 AND user_id = $2`, [token, userId])
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'expo_unregister_failed' })
  }
})

router.get('/inbox', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!hasPg || !pgPool) return res.json({ items: [], next_cursor: null })
  await ensureNotificationStorage()

  const userId = String(user.sub || '').trim()
  const limit0 = Number((req.query as any)?.limit || 50)
  const limit = Math.max(1, Math.min(200, Number.isFinite(limit0) ? limit0 : 50))
  const unreadOnly = String((req.query as any)?.unread_only || '').toLowerCase() === 'true'
  const cursorRaw = String((req.query as any)?.cursor || '').trim()
  const cursorParts = cursorRaw ? cursorRaw.split('|') : []
  const cursorCreatedAt = cursorParts[0] ? String(cursorParts[0]) : ''
  const cursorId = cursorParts[1] ? String(cursorParts[1]) : ''

  const wh: string[] = [`user_id = $1`]
  const args: any[] = [userId]
  if (unreadOnly) wh.push('read_at IS NULL')
  if (cursorCreatedAt && cursorId) {
    args.push(cursorCreatedAt)
    args.push(cursorId)
    wh.push(`(created_at, id) < ($${args.length - 1}::timestamptz, $${args.length}::text)`)
  }

  const sql = `
    SELECT id, event_id, type, entity, entity_id, changes, title, body, data, priority, created_at, read_at
    FROM user_notifications
    WHERE ${wh.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT $${args.length + 1}`
  const r = await pgPool.query(sql, [...args, limit])
  const items = (r?.rows || []).map((x: any) => ({
    id: String(x.id || ''),
    event_id: String(x.event_id || ''),
    type: String(x.type || ''),
    entity: String(x.entity || ''),
    entity_id: String(x.entity_id || ''),
    changes: Array.isArray(x.changes) ? x.changes.map((v: any) => String(v || '').trim()).filter(Boolean) : [],
    title: String(x.title || ''),
    body: String(x.body || ''),
    data: x.data || {},
    priority: String(x.priority || 'low'),
    created_at: x.created_at ? String(x.created_at) : null,
    read_at: x.read_at ? String(x.read_at) : null,
  }))
  const last = items[items.length - 1] || null
  const nextCursor = last && last.created_at && last.id ? `${last.created_at}|${last.id}` : null
  return res.json({ items, next_cursor: nextCursor })
})

router.get('/unread-count', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!hasPg || !pgPool) return res.json({ unread: 0 })
  await ensureNotificationStorage()
  const userId = String(user.sub || '').trim()
  const r = await pgPool.query(`SELECT COUNT(1) AS c FROM user_notifications WHERE user_id=$1 AND read_at IS NULL`, [userId])
  const unread = Number(r?.rows?.[0]?.c || 0)
  return res.json({ unread: Number.isFinite(unread) ? unread : 0 })
})

router.post('/mark-read', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!hasPg || !pgPool) return res.json({ ok: true })
  await ensureNotificationStorage()
  const userId = String(user.sub || '').trim()
  const body = req.body || {}
  const all = body?.all === true
  const ids0 = Array.isArray(body?.ids) ? body.ids : []
  const ids = Array.from(new Set(ids0.map((x: any) => String(x || '').trim()).filter(Boolean)))
  if (!all && !ids.length) return res.status(400).json({ message: 'missing ids' })
  try {
    if (all) {
      await pgPool.query(`UPDATE user_notifications SET read_at = COALESCE(read_at, now()), updated_at=now() WHERE user_id=$1`, [userId])
      return res.json({ ok: true })
    }
    await pgPool.query(
      `UPDATE user_notifications
       SET read_at = COALESCE(read_at, now()), updated_at=now()
       WHERE user_id=$1 AND id = ANY($2::text[])`,
      [userId, ids],
    )
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'update_failed') })
  }
})

router.post('/push/send', requirePerm('guest.notify'), async (req, res) => {
  const { user_id, payload } = req.body || {}
  if (!user_id) return res.status(400).json({ message: 'missing user_id' })
  try {
    if (hasPg) {
      const rows = await pgSelect('push_subscriptions', '*', { user_id }) as any[]
      return res.json({ sent_to: (rows || []).length })
    }
    return res.json({ sent_to: 0 })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

export async function notifyExpoAll(params: { exclude_user_id?: string; title: string; body: string; data?: any }) {
  if (!hasPg || !pgPool) return { sent: 0, failed: 0 }
  await ensureExpoPushTokensTable()
  const exclude = String(params.exclude_user_id || '').trim()
  const rows = exclude
    ? await pgPool.query(`SELECT token FROM expo_push_tokens WHERE user_id <> $1`, [exclude])
    : await pgPool.query(`SELECT token FROM expo_push_tokens`)
  const tokens = (rows?.rows || []).map((x: any) => String(x.token || '').trim()).filter(Boolean)
  return await sendExpoPush(tokens, { title: params.title, body: params.body, data: params.data || {} })
}

export async function notifyExpoUsers(params: { user_ids: string[]; title: string; body: string; data?: any }) {
  // Keep push delivery behind the notification queue worker. Business code should use emitNotificationEvent instead.
  if (!hasPg || !pgPool) return { sent: 0, failed: 0 }
  await ensureExpoPushTokensTable()
  const ids = Array.from(new Set((params.user_ids || []).map((x) => String(x || '').trim()).filter(Boolean)))
  if (!ids.length) return { sent: 0, failed: 0 }
  const rows = await pgPool.query(`SELECT token FROM expo_push_tokens WHERE user_id = ANY($1::text[])`, [ids])
  const tokens = (rows?.rows || []).map((x: any) => String(x.token || '').trim()).filter(Boolean)
  return await sendExpoPush(tokens, { title: params.title, body: params.body, data: params.data || {} })
}

export async function listUserIdsByRoles(roles0: string[], opts?: { excludeRoles?: string[] }) {
  if (!hasPg || !pgPool) return []
  const roles = Array.from(new Set((roles0 || []).map((x) => String(x || '').trim()).filter(Boolean)))
  const excludeRoles = Array.from(new Set((opts?.excludeRoles || []).map((x) => String(x || '').trim()).filter(Boolean)))
  if (!roles.length) return []
  const r = await pgPool.query(
    `SELECT DISTINCT u.id::text AS id
     FROM users u
     WHERE
       (
         u.role = ANY($1::text[])
         OR EXISTS (
           SELECT 1
           FROM user_roles ur
           WHERE ur.user_id = u.id::text
             AND ur.role_name = ANY($1::text[])
         )
       )
       AND (
         COALESCE(array_length($2::text[], 1), 0) = 0
         OR (
           u.role <> ALL($2::text[])
           AND NOT EXISTS (
             SELECT 1
             FROM user_roles urx
             WHERE urx.user_id = u.id::text
               AND urx.role_name = ANY($2::text[])
           )
         )
       )`,
    [roles, excludeRoles],
  )
  return Array.from(new Set((r?.rows || []).map((x: any) => String(x.id || '').trim()).filter(Boolean)))
}

export async function listManagerUserIds(params?: { roles?: string[]; excludeRoles?: string[] }) {
  if (!hasPg || !pgPool) return []
  const roles0 = Array.isArray(params?.roles) && params!.roles.length ? params!.roles : ['admin', 'offline_manager', 'customer_service']
  return await listUserIdsByRoles(roles0, { excludeRoles: params?.excludeRoles || [] })
}

export async function listCleanerUserIds() {
  return await listUserIdsByRoles(['cleaner', 'cleaner_inspector'])
}

export async function listCleaningTaskUserIds(task_id: string) {
  if (!hasPg || !pgPool) return []
  const id = String(task_id || '').trim()
  if (!id) return []
  const r = await pgPool.query(
    `SELECT cleaner_id::text AS cleaner_id, inspector_id::text AS inspector_id, assignee_id::text AS assignee_id
     FROM cleaning_tasks
     WHERE id::text = $1
     LIMIT 1`,
    [id],
  )
  const row = r?.rows?.[0] || null
  if (!row) return []
  const ids = [row.cleaner_id, row.inspector_id, row.assignee_id]
    .map((x: any) => String(x || '').trim())
    .filter(Boolean)
  return Array.from(new Set(ids))
}

export async function listInspectionTaskUserIds(task_id: string) {
  if (!hasPg || !pgPool) return []
  const id = String(task_id || '').trim()
  if (!id) return []
  const r = await pgPool.query(
    `SELECT inspector_id::text AS inspector_id, assignee_id::text AS assignee_id
     FROM cleaning_tasks
     WHERE id::text = $1
     LIMIT 1`,
    [id],
  )
  const row = r?.rows?.[0] || null
  if (!row) return []
  const ids = [row.inspector_id, row.assignee_id]
    .map((x: any) => String(x || '').trim())
    .filter(Boolean)
  return Array.from(new Set(ids))
}

export async function listWorkTaskUserIds(task_id: string) {
  if (!hasPg || !pgPool) return []
  const id = String(task_id || '').trim()
  if (!id) return []
  const r = await pgPool.query(
    `SELECT assignee_id::text AS assignee_id
     FROM work_tasks
     WHERE id::text = $1
     LIMIT 1`,
    [id],
  )
  const row = r?.rows?.[0] || null
  if (!row) return []
  const assigneeId = String(row.assignee_id || '').trim()
  return assigneeId ? [assigneeId] : []
}

export async function listCleaningTaskUserIdsBulk(task_ids: string[]) {
  if (!hasPg || !pgPool) return []
  const ids0 = Array.from(new Set((task_ids || []).map((x) => String(x || '').trim()).filter(Boolean)))
  if (!ids0.length) return []
  const r = await pgPool.query(
    `SELECT cleaner_id::text AS cleaner_id, inspector_id::text AS inspector_id, assignee_id::text AS assignee_id
     FROM cleaning_tasks
     WHERE id::text = ANY($1::text[])`,
    [ids0],
  )
  const out: string[] = []
  for (const row of r?.rows || []) {
    for (const v of [row.cleaner_id, row.inspector_id, row.assignee_id]) {
      const s = String(v || '').trim()
      if (s) out.push(s)
    }
  }
  return Array.from(new Set(out))
}

export function excludeUserIds(user_ids: string[], exclude_user_id?: string) {
  const ex = String(exclude_user_id || '').trim()
  const ids = Array.from(new Set((user_ids || []).map((x) => String(x || '').trim()).filter(Boolean)))
  if (!ex) return ids
  return ids.filter((x) => x !== ex)
}

export default router
