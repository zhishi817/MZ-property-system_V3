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
  } catch {}
}

router.get('/contacts', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  try {
    await ensureProfileColumns()
    if (hasPg) {
      const rows = (await pgSelect('users', 'id, username, phone_au, role') as any[]) || []
      return res.json(rows)
    }
    const rows = (db.users || []).map((u: any) => ({ id: u.id, username: u.username, phone_au: (u as any).phone_au, role: u.role }))
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
      const rows = (await pgSelect('users', 'id, username, role, phone_au, display_name, avatar_url', { id }) as any[]) || []
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
      const patch: any = {}
      if (parsed.data.display_name !== undefined) patch.display_name = parsed.data.display_name
      if (parsed.data.phone_au !== undefined) patch.phone_au = parsed.data.phone_au
      if (parsed.data.avatar_url !== undefined) patch.avatar_url = parsed.data.avatar_url
      const keys = Object.keys(patch)
      if (!keys.length) return res.json({ ok: true })
      const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(', ')
      const values = keys.map((k) => patch[k] === undefined ? null : patch[k])
      const sql = `UPDATE users SET ${set} WHERE id=$${keys.length + 1} RETURNING id, username, role, phone_au, display_name, avatar_url`
      const r = await pgPool.query(sql, [...values, id])
      const row = r?.rows?.[0]
      return res.json(row || { ok: true })
    }
    const row = (db.users || []).find((u: any) => String(u.id) === id)
    if (!row) return res.status(404).json({ message: 'user not found' })
    if (parsed.data.display_name !== undefined) (row as any).display_name = parsed.data.display_name
    if (parsed.data.phone_au !== undefined) (row as any).phone_au = parsed.data.phone_au
    if (parsed.data.avatar_url !== undefined) (row as any).avatar_url = parsed.data.avatar_url
    return res.json({
      id: row.id,
      username: row.username,
      role: row.role,
      phone_au: (row as any).phone_au || null,
      display_name: (row as any).display_name || null,
      avatar_url: (row as any).avatar_url || null,
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
      const rows = await pgSelect('users', 'id, username, email, phone_au, role, color_hex, created_at') as any[] || []
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
      const rows = await pgSelect('users', 'id, username, email, phone_au, role, color_hex, created_at', { id }) as any[] || []
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
