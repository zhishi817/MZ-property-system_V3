import { Router } from 'express'
import { login, me, setDeletePassword } from '../auth'
import { hasPg, pgSelect } from '../dbAdapter'
import { z } from 'zod'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { sendMail } from '../services/mailer'

export const router = Router()

router.post('/login', login)
router.get('/me', me)
router.post('/delete-password', setDeletePassword)

function sha256Hex(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

async function ensurePasswordResetTables() {
  if (!hasPg) return
  try {
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return
    await pgPool.query(`CREATE TABLE IF NOT EXISTS password_resets (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL,
      created_at timestamptz DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      ip text,
      user_agent text
    );`)
    await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_password_resets_token_hash ON password_resets(token_hash);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_password_resets_expires_at ON password_resets(expires_at);')
  } catch {}
}

const forgotSchema = z.object({ email: z.string().email() })
const resetSchema = z.object({ token: z.string().min(16), password: z.string().min(6) })

router.post('/forgot', async (req, res) => {
  const parsed = forgotSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ message: 'invalid email' })
  const email = String(parsed.data.email || '').trim()

  if (!hasPg) return res.status(500).json({ message: 'database_not_configured' })
  await ensurePasswordResetTables()

  let user: any = null
  try {
    const rows = await pgSelect('users', '*', { email })
    user = rows && (rows as any[])[0]
  } catch {}

  if (!user || !user.id) return res.json({ ok: true })

  const token = crypto.randomBytes(32).toString('hex')
  const tokenHash = sha256Hex(token)
  const ttlMin = Number(process.env.PASSWORD_RESET_TTL_MINUTES || 60)
  const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000).toISOString()
  const ip = String((req.ip || req.socket?.remoteAddress || '')).slice(0, 255)
  const ua = String(req.headers['user-agent'] || '').slice(0, 255)

  try {
    const { pgInsert } = require('../dbAdapter')
    const { v4: uuid } = require('uuid')
    await pgInsert('password_resets', { id: uuid(), user_id: user.id, token_hash: tokenHash, expires_at: expiresAt, ip, user_agent: ua })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'reset_create_failed') })
  }

  const front = String(process.env.FRONTEND_BASE_URL || req.headers.origin || '').trim().replace(/\/+$/g, '')
  if (!front) return res.status(500).json({ message: 'missing FRONTEND_BASE_URL' })
  const link = `${front}/reset-password?token=${encodeURIComponent(token)}`

  try {
    const subject = 'MZ Property - 重置密码'
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6">
        <p>你好，</p>
        <p>我们收到了你的密码重置请求。请点击下面的链接设置新密码（${ttlMin} 分钟内有效）：</p>
        <p><a href="${link}">${link}</a></p>
        <p>如果你并未发起此请求，请忽略本邮件。</p>
      </div>
    `
    await sendMail({ to: email, subject, html, text: `重置密码链接（${ttlMin} 分钟内有效）：${link}` })
    return res.json({ ok: true })
  } catch (e: any) {
    try { console.error(`[auth] forgot_send_failed message=${String(e?.message || '')}`) } catch {}
    return res.status(500).json({ message: 'send_failed' })
  }
})

router.post('/reset', async (req, res) => {
  const parsed = resetSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ message: 'invalid payload' })
  if (!hasPg) return res.status(500).json({ message: 'database_not_configured' })
  await ensurePasswordResetTables()

  const tokenHash = sha256Hex(String(parsed.data.token))
  const pwHash = await bcrypt.hash(parsed.data.password, 10)

  try {
    const { pgRunInTransaction } = require('../dbAdapter')
    const result = await pgRunInTransaction(async (client: any) => {
      const r = await client.query('SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash=$1 LIMIT 1', [tokenHash])
      const row = r?.rows?.[0]
      if (!row || row.used_at) return { ok: false, reason: 'invalid' }
      const exp = new Date(row.expires_at).getTime()
      if (!Number.isFinite(exp) || exp < Date.now()) return { ok: false, reason: 'expired' }

      await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [pwHash, String(row.user_id)])
      await client.query('UPDATE password_resets SET used_at=now() WHERE id=$1', [String(row.id)])
      try { await client.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND revoked=false', [String(row.user_id)]) } catch {}
      return { ok: true }
    })

    if (!result?.ok) return res.status(400).json({ message: 'invalid_or_expired' })
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'reset_failed') })
  }
})
