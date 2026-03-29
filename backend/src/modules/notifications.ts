import { Router } from 'express'
import { requireAnyPerm, requirePerm } from '../auth'
import { hasPg, pgInsert, pgPool, pgSelect } from '../dbAdapter'
import https from 'https'

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
        platform text,
        ua text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );`,
    )
    await pgPool.query(`CREATE INDEX IF NOT EXISTS expo_push_tokens_user_id_idx ON expo_push_tokens (user_id);`)
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
  const { expo_push_token, platform, ua } = req.body || {}
  const token = String(expo_push_token || '').trim()
  if (!token) return res.status(400).json({ message: 'missing expo_push_token' })
  if (!hasPg || !pgPool) return res.json({ ok: true })
  try {
    await ensureExpoPushTokensTable()
    await pgPool.query(
      `INSERT INTO expo_push_tokens (token, user_id, platform, ua, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (token)
       DO UPDATE SET user_id=EXCLUDED.user_id, platform=EXCLUDED.platform, ua=EXCLUDED.ua, updated_at=now()`,
      [token, userId, platform == null ? null : String(platform || ''), ua == null ? null : String(ua || '')],
    )
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'expo_register_failed' })
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
  if (!hasPg || !pgPool) return { sent: 0, failed: 0 }
  await ensureExpoPushTokensTable()
  const ids = Array.from(new Set((params.user_ids || []).map((x) => String(x || '').trim()).filter(Boolean)))
  if (!ids.length) return { sent: 0, failed: 0 }
  const rows = await pgPool.query(`SELECT token FROM expo_push_tokens WHERE user_id = ANY($1::text[])`, [ids])
  const tokens = (rows?.rows || []).map((x: any) => String(x.token || '').trim()).filter(Boolean)
  return await sendExpoPush(tokens, { title: params.title, body: params.body, data: params.data || {} })
}

export async function listManagerUserIds(params?: { roles?: string[] }) {
  if (!hasPg || !pgPool) return []
  const roles0 = Array.isArray(params?.roles) && params!.roles.length ? params!.roles : ['admin', 'offline_manager', 'customer_service']
  const roles = Array.from(new Set(roles0.map((x) => String(x || '').trim()).filter(Boolean)))
  if (!roles.length) return []
  const r = await pgPool.query(
    `SELECT DISTINCT u.id::text AS id
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id::text
     WHERE u.role = ANY($1::text[]) OR ur.role_name = ANY($1::text[])`,
    [roles],
  )
  return Array.from(new Set((r?.rows || []).map((x: any) => String(x.id || '').trim()).filter(Boolean)))
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
