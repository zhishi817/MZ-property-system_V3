import { Router } from 'express'
import { z } from 'zod'
import { requireAnyPerm, requirePerm } from '../auth'
import { hasPg, pgSelect, pgUpdate } from '../dbAdapter'
import { db } from '../store'
import bcrypt from 'bcryptjs'

export const router = Router()

const colorSchema = z.object({ color_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict()
const mePatchSchema = z
  .object({
    display_name: z.string().trim().min(1).max(40).optional(),
    phone_au: z.string().trim().max(32).optional().nullable(),
    avatar_url: z.string().trim().max(500).optional().nullable(),
    legal_name: z.string().trim().max(80).optional().nullable(),
    bank_account_name: z.string().trim().max(120).optional().nullable(),
    bank_bsb: z.string().trim().max(32).optional().nullable(),
    bank_account_number: z.string().trim().max(64).optional().nullable(),
    personal_abn: z.string().trim().max(32).optional().nullable(),
    photo_id_url: z.string().trim().max(500).optional().nullable(),
  })
  .strict()

const changePasswordSchema = z
  .object({
    old_password: z.string().min(1),
    new_password: z.string().min(6).max(128),
  })
  .strict()

async function ensureProfileColumns() {
  if (!hasPg) return
  try {
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return
    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text')
    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text')
    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_au text')
    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS legal_name text')
    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_account_name text')
    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_bsb text')
    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_account_number text')
    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_abn text')
    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_id_url text')
  } catch {}
}

let usersColumnCache: { expiresAt: number; columns: Set<string> } | null = null

async function getUsersColumns() {
  if (!hasPg) return new Set<string>()
  const now = Date.now()
  if (usersColumnCache && usersColumnCache.expiresAt > now) return usersColumnCache.columns
  try {
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return new Set<string>()
    const rs = await pgPool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='users'`,
    )
    const columns = new Set<string>(((rs?.rows || []) as any[]).map((row) => String(row?.column_name || '').trim()).filter(Boolean))
    usersColumnCache = { expiresAt: now + 60_000, columns }
    return columns
  } catch {
    return new Set<string>()
  }
}

function buildUserSelect(columns: Set<string>, required: string[], optional: readonly string[]) {
  const selected = [...required]
  for (const name of optional) {
    selected.push(columns.has(name) ? name : `NULL AS ${name}`)
  }
  return selected.join(', ')
}

function filterPatchByExistingColumns(patch: Record<string, any>, columns: Set<string>) {
  const next: Record<string, any> = {}
  for (const key of Object.keys(patch)) {
    if (columns.has(key)) next[key] = patch[key]
  }
  return next
}

router.get('/contacts', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  try {
    await ensureProfileColumns()
    if (hasPg) {
      const columns = await getUsersColumns()
      const rows = (await pgSelect(
        'users',
        buildUserSelect(columns, ['id', 'username', 'role'], ['phone_au', 'display_name', 'avatar_url']),
      ) as any[]) || []
      return res.json(rows)
    }
    const rows = (db.users || []).map((u: any) => ({
      id: u.id,
      username: u.username,
      phone_au: (u as any).phone_au,
      role: u.role,
      display_name: (u as any).display_name,
      avatar_url: (u as any).avatar_url,
    }))
    return res.json(rows)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'users_contacts_failed' })
  }
})

router.get('/me', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const id = String(user.sub || '').trim()
  if (!id) return res.status(401).json({ message: 'unauthorized' })
  try {
    await ensureProfileColumns()
    if (hasPg) {
      const columns = await getUsersColumns()
      const rows = (await pgSelect(
        'users',
        buildUserSelect(
          columns,
          ['id', 'username', 'role'],
          ['phone_au', 'display_name', 'avatar_url', 'legal_name', 'bank_account_name', 'bank_bsb', 'bank_account_number', 'personal_abn', 'photo_id_url'],
        ),
        { id },
      ) as any[]) || []
      const row = rows[0]
      if (!row) return res.status(404).json({ message: 'user not found' })
      return res.json(row)
    }
    const row = (db.users || []).find((u: any) => String(u.id) === id)
    if (!row) return res.status(404).json({ message: 'user not found' })
    return res.json({
      id: row.id,
      username: row.username,
      role: row.role,
      phone_au: (row as any).phone_au || null,
      display_name: (row as any).display_name || null,
      avatar_url: (row as any).avatar_url || null,
      legal_name: (row as any).legal_name || null,
      bank_account_name: (row as any).bank_account_name || null,
      bank_bsb: (row as any).bank_bsb || null,
      bank_account_number: (row as any).bank_account_number || null,
      personal_abn: (row as any).personal_abn || null,
      photo_id_url: (row as any).photo_id_url || null,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'user_failed' })
  }
})

router.patch('/me', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const id = String(user.sub || '').trim()
  if (!id) return res.status(401).json({ message: 'unauthorized' })
  const parsed = mePatchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    await ensureProfileColumns()
    if (hasPg) {
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'no database configured' })
      const columns = await getUsersColumns()
      const patch: any = {}
      if (parsed.data.display_name !== undefined) patch.display_name = parsed.data.display_name
      if (parsed.data.phone_au !== undefined) patch.phone_au = parsed.data.phone_au
      if (parsed.data.avatar_url !== undefined) patch.avatar_url = parsed.data.avatar_url
      if (parsed.data.legal_name !== undefined) patch.legal_name = parsed.data.legal_name
      if (parsed.data.bank_account_name !== undefined) patch.bank_account_name = parsed.data.bank_account_name
      if (parsed.data.bank_bsb !== undefined) patch.bank_bsb = parsed.data.bank_bsb
      if (parsed.data.bank_account_number !== undefined) patch.bank_account_number = parsed.data.bank_account_number
      if (parsed.data.personal_abn !== undefined) patch.personal_abn = parsed.data.personal_abn
      if (parsed.data.photo_id_url !== undefined) patch.photo_id_url = parsed.data.photo_id_url
      const safePatch = filterPatchByExistingColumns(patch, columns)
      const keys = Object.keys(safePatch)
      if (!keys.length) return res.json({ ok: true })
      const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(', ')
      const values = keys.map((k) => safePatch[k] === undefined ? null : safePatch[k])
      const returning = buildUserSelect(
        columns,
        ['id', 'username', 'role'],
        ['phone_au', 'display_name', 'avatar_url', 'legal_name', 'bank_account_name', 'bank_bsb', 'bank_account_number', 'personal_abn', 'photo_id_url'],
      )
      const sql = `UPDATE users SET ${set} WHERE id=$${keys.length + 1} RETURNING ${returning}`
      const r = await pgPool.query(sql, [...values, id])
      const row = r?.rows?.[0]
      return res.json(row || { ok: true })
    }
    const row = (db.users || []).find((u: any) => String(u.id) === id)
    if (!row) return res.status(404).json({ message: 'user not found' })
    if (parsed.data.display_name !== undefined) (row as any).display_name = parsed.data.display_name
    if (parsed.data.phone_au !== undefined) (row as any).phone_au = parsed.data.phone_au
    if (parsed.data.avatar_url !== undefined) (row as any).avatar_url = parsed.data.avatar_url
    if (parsed.data.legal_name !== undefined) (row as any).legal_name = parsed.data.legal_name
    if (parsed.data.bank_account_name !== undefined) (row as any).bank_account_name = parsed.data.bank_account_name
    if (parsed.data.bank_bsb !== undefined) (row as any).bank_bsb = parsed.data.bank_bsb
    if (parsed.data.bank_account_number !== undefined) (row as any).bank_account_number = parsed.data.bank_account_number
    if (parsed.data.personal_abn !== undefined) (row as any).personal_abn = parsed.data.personal_abn
    if (parsed.data.photo_id_url !== undefined) (row as any).photo_id_url = parsed.data.photo_id_url
    return res.json({
      id: row.id,
      username: row.username,
      role: row.role,
      phone_au: (row as any).phone_au || null,
      display_name: (row as any).display_name || null,
      avatar_url: (row as any).avatar_url || null,
      legal_name: (row as any).legal_name || null,
      bank_account_name: (row as any).bank_account_name || null,
      bank_bsb: (row as any).bank_bsb || null,
      bank_account_number: (row as any).bank_account_number || null,
      personal_abn: (row as any).personal_abn || null,
      photo_id_url: (row as any).photo_id_url || null,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update_failed' })
  }
})

router.post('/me/change-password', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const id = String(user.sub || '').trim()
  if (!id) return res.status(401).json({ message: 'unauthorized' })
  const parsed = changePasswordSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const oldPwd = String(parsed.data.old_password)
  const newPwd = String(parsed.data.new_password)
  try {
    if (hasPg) {
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'no database configured' })
      const r0 = await pgPool.query('SELECT password_hash FROM users WHERE id=$1 LIMIT 1', [id])
      const row = r0?.rows?.[0]
      if (!row) return res.status(404).json({ message: 'user not found' })
      const hash = String(row.password_hash || '')
      const ok = hash ? await bcrypt.compare(oldPwd, hash) : false
      if (!ok) return res.status(400).json({ message: 'invalid password' })
      const nextHash = await bcrypt.hash(newPwd, 10)
      await pgPool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [nextHash, id])
      return res.json({ ok: true })
    }
    const row = (db.users || []).find((u: any) => String(u.id) === id)
    if (!row) return res.status(404).json({ message: 'user not found' })
    const hash = String((row as any).password_hash || '')
    const ok = hash ? await bcrypt.compare(oldPwd, hash) : false
    if (!ok) return res.status(400).json({ message: 'invalid password' })
    ;(row as any).password_hash = await bcrypt.hash(newPwd, 10)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'change_password_failed' })
  }
})

router.get('/', requireAnyPerm(['rbac.manage', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (_req, res) => {
  try {
    if (hasPg) {
      const columns = await getUsersColumns()
      const rows = await pgSelect(
        'users',
        buildUserSelect(columns, ['id', 'username', 'role'], ['email', 'phone_au', 'color_hex', 'created_at']),
      ) as any[] || []
      return res.json(rows)
    }
    const rows = (db.users || []).map((u: any) => ({ id: u.id, username: u.username, email: u.email, phone_au: (u as any).phone_au, role: u.role, color_hex: u.color_hex, created_at: u.created_at }))
    return res.json(rows)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'users_failed' })
  }
})

router.get('/:id', requireAnyPerm(['rbac.manage', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })
  try {
    if (hasPg) {
      const columns = await getUsersColumns()
      const rows = await pgSelect(
        'users',
        buildUserSelect(columns, ['id', 'username', 'role'], ['email', 'phone_au', 'color_hex', 'created_at']),
        { id },
      ) as any[] || []
      const row = rows[0]
      if (!row) return res.status(404).json({ message: 'user not found' })
      return res.json(row)
    }
    const row = (db.users || []).find((u: any) => String(u.id) === id)
    if (!row) return res.status(404).json({ message: 'user not found' })
    return res.json({ id: row.id, username: (row as any).username, email: (row as any).email, phone_au: (row as any).phone_au, role: (row as any).role, color_hex: (row as any).color_hex, created_at: (row as any).created_at })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'user_failed' })
  }
})

router.patch('/:id', requirePerm('rbac.manage'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })
  const parsed = colorSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg) {
      const updated = await pgUpdate('users', id, { color_hex: parsed.data.color_hex } as any)
      return res.json(updated || { id, color_hex: parsed.data.color_hex })
    }
    const u = (db.users || []).find((x: any) => String(x.id) === id)
    if (!u) return res.status(404).json({ message: 'user not found' })
    ;(u as any).color_hex = parsed.data.color_hex
    return res.json(u)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update_failed' })
  }
})
