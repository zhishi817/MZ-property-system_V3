import { Router } from 'express'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { hasPg } from '../dbAdapter'
import { decryptCompanySecret, encryptCompanySecret, hasCompanySecretKey } from '../lib/companySecretCrypto'

export const router = Router()

async function ensureTables() {
  if (!hasPg) return
  try {
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return
    await pgPool.query(`CREATE TABLE IF NOT EXISTS company_secret_items (
      id text PRIMARY KEY,
      title text NOT NULL,
      username text,
      secret_enc text NOT NULL,
      note text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      updated_by text
    );`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_company_secret_items_updated ON company_secret_items(updated_at DESC);`)
    await pgPool.query(`CREATE TABLE IF NOT EXISTS company_secret_access_logs (
      id text PRIMARY KEY,
      secret_item_id text NOT NULL REFERENCES company_secret_items(id) ON DELETE CASCADE,
      user_id text,
      action text NOT NULL,
      created_at timestamptz DEFAULT now()
    );`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_company_secret_logs_item ON company_secret_access_logs(secret_item_id, created_at DESC);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_company_secret_logs_user ON company_secret_access_logs(user_id, created_at DESC);`)
  } catch {}
}

const createSchema = z.object({
  title: z.string().min(1),
  username: z.string().optional(),
  secret: z.string().min(1),
  note: z.string().optional(),
}).strict()

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  username: z.string().optional(),
  secret: z.string().optional(),
  note: z.string().optional(),
}).strict()

async function insertLog(secretItemId: string, userId: string | null, action: string) {
  try {
    const { pgInsert } = require('../dbAdapter')
    const { v4: uuid } = require('uuid')
    await pgInsert('company_secret_access_logs', { id: uuid(), secret_item_id: secretItemId, user_id: userId, action })
  } catch {}
}

router.get('/company/secrets', requirePerm('company_secret_items.view'), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })
  try {
    const includeSecret = String((req.query as any)?.include_secret || '').trim() === '1'
    const actor = (req as any).user
    const userId = actor?.sub ? String(actor.sub) : null
    const r = await pgPool.query('SELECT id, title, username, note, secret_enc, created_at, updated_at, updated_by FROM company_secret_items ORDER BY updated_at DESC NULLS LAST, created_at DESC')
    const rows = (r.rows || []) as any[]
    if (!includeSecret) {
      return res.json(rows.map((x) => ({ id: x.id, title: x.title, note: x.note, created_at: x.created_at, updated_at: x.updated_at, updated_by: x.updated_by })))
    }
    const hasKey = hasCompanySecretKey()
    const out = rows.map((x) => {
      const enc = String(x.secret_enc || '')
      const plain = enc && hasKey ? decryptCompanySecret(enc) : null
      return { id: x.id, title: x.title, note: x.note, secret: plain, has_key: hasKey, created_at: x.created_at, updated_at: x.updated_at, updated_by: x.updated_by }
    })
    try {
      for (const x of rows) { await insertLog(String(x.id), userId, 'view_list') }
    } catch {}
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'list_failed') })
  }
})

router.get('/company/secrets/app-list', async (req, res) => {
  const actor = (req as any).user
  if (!actor) return res.status(401).json({ message: 'unauthorized' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })
  try {
    const userId = actor?.sub ? String(actor.sub) : null
    const r = await pgPool.query('SELECT id, title, username, note, secret_enc, updated_at FROM company_secret_items ORDER BY updated_at DESC NULLS LAST, created_at DESC')
    const rows = (r.rows || []) as any[]
    const hasKey = hasCompanySecretKey()
    const out = rows.map((x) => {
      const enc = String(x.secret_enc || '')
      const plain = enc && hasKey ? decryptCompanySecret(enc) : null
      return { id: x.id, title: x.title, username: x.username, note: x.note, secret: plain, has_key: hasKey, updated_at: x.updated_at }
    })
    try {
      for (const x of rows) { await insertLog(String(x.id), userId, 'view_list_app') }
    } catch {}
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'list_failed') })
  }
})

router.post('/company/secrets/:id/log-copy-app', async (req, res) => {
  const actor = (req as any).user
  if (!actor) return res.status(401).json({ message: 'unauthorized' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })
  const userId = actor?.sub ? String(actor.sub) : null
  try {
    const r0 = await pgPool.query('SELECT id FROM company_secret_items WHERE id=$1 LIMIT 1', [id])
    if (!r0?.rows?.[0]) return res.status(404).json({ message: 'not found' })
    await insertLog(id, userId, 'copy_app')
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'log_failed') })
  }
})

router.post('/company/secrets', requirePerm('company_secret_items.write'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasCompanySecretKey()) return res.status(500).json({ message: 'missing CMS_SECRET_KEY' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })

  const { v4: uuid } = require('uuid')
  const id = uuid()
  const enc = encryptCompanySecret(parsed.data.secret)
  if (!enc) return res.status(500).json({ message: 'encrypt_failed' })

  const actor = (req as any).user
  const userId = actor?.sub ? String(actor.sub) : null
  const now = new Date().toISOString()

  try {
    const row = {
      id,
      title: String(parsed.data.title).trim(),
      username: parsed.data.username ? String(parsed.data.username).trim() : null,
      secret_enc: enc,
      note: parsed.data.note ? String(parsed.data.note) : null,
      updated_at: now,
      updated_by: userId,
    }
    const keys = Object.keys(row)
    const cols = keys.map((k) => `"${k}"`).join(',')
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',')
    const values = keys.map((k) => (row as any)[k] === undefined ? null : (row as any)[k])
    const sql = `INSERT INTO company_secret_items (${cols}) VALUES (${placeholders}) RETURNING id, title, username, note, created_at, updated_at, updated_by`
    const r = await pgPool.query(sql, values)
    await insertLog(id, userId, 'create')
    return res.status(201).json(r.rows?.[0] || { ...row, created_at: now })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'create_failed') })
  }
})

router.patch('/company/secrets/:id', requirePerm('company_secret_items.write'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  const parsed = patchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })

  const actor = (req as any).user
  const userId = actor?.sub ? String(actor.sub) : null
  const now = new Date().toISOString()

  try {
    const r0 = await pgPool.query('SELECT id FROM company_secret_items WHERE id=$1 LIMIT 1', [id])
    if (!r0?.rows?.[0]) return res.status(404).json({ message: 'not found' })

    const patch: any = {}
    if (parsed.data.title !== undefined) patch.title = String(parsed.data.title).trim()
    if (parsed.data.username !== undefined) patch.username = parsed.data.username ? String(parsed.data.username).trim() : null
    if (parsed.data.note !== undefined) patch.note = parsed.data.note ? String(parsed.data.note) : null
    if (parsed.data.secret !== undefined) {
      if (!hasCompanySecretKey()) return res.status(500).json({ message: 'missing CMS_SECRET_KEY' })
      const enc = encryptCompanySecret(String(parsed.data.secret))
      if (!enc) return res.status(500).json({ message: 'encrypt_failed' })
      patch.secret_enc = enc
    }
    patch.updated_at = now
    patch.updated_by = userId

    const keys = Object.keys(patch)
    if (!keys.length) return res.json({ ok: true })
    const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(', ')
    const values = keys.map((k) => patch[k] === undefined ? null : patch[k])
    const sql = `UPDATE company_secret_items SET ${set} WHERE id=$${keys.length + 1} RETURNING id, title, username, note, created_at, updated_at, updated_by`
    const r1 = await pgPool.query(sql, [...values, id])
    await insertLog(id, userId, 'update')
    return res.json(r1.rows?.[0] || { ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'update_failed') })
  }
})

router.delete('/company/secrets/:id', requirePerm('company_secret_items.delete'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })

  const actor = (req as any).user
  const userId = actor?.sub ? String(actor.sub) : null

  try {
    const r0 = await pgPool.query('SELECT id FROM company_secret_items WHERE id=$1 LIMIT 1', [id])
    if (!r0?.rows?.[0]) return res.status(404).json({ message: 'not found' })
    await pgPool.query('DELETE FROM company_secret_items WHERE id=$1', [id])
    await insertLog(id, userId, 'delete')
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'delete_failed') })
  }
})

router.get('/company/secrets/:id/reveal', requirePerm('company_secret_items.view'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  res.setHeader('Cache-Control', 'no-store')
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })

  const actor = (req as any).user
  const userId = actor?.sub ? String(actor.sub) : null

  try {
    const r0 = await pgPool.query('SELECT id, title, username, note, secret_enc, created_at, updated_at, updated_by FROM company_secret_items WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0]
    if (!row) return res.status(404).json({ message: 'not found' })
    const enc = String(row.secret_enc || '')
    const plain = enc ? decryptCompanySecret(enc) : null
    await insertLog(id, userId, 'view')
    return res.json({ id, title: row.title, username: row.username, note: row.note, secret: plain, has_key: hasCompanySecretKey(), updated_at: row.updated_at, updated_by: row.updated_by, created_at: row.created_at })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'reveal_failed') })
  }
})

router.post('/company/secrets/:id/log-copy', requirePerm('company_secret_items.view'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })

  const actor = (req as any).user
  const userId = actor?.sub ? String(actor.sub) : null

  try {
    const r0 = await pgPool.query('SELECT id FROM company_secret_items WHERE id=$1 LIMIT 1', [id])
    if (!r0?.rows?.[0]) return res.status(404).json({ message: 'not found' })
    await insertLog(id, userId, 'copy')
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'log_failed') })
  }
})
