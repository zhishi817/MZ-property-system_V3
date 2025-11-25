import { Router } from 'express'
import { db, getRoleIdByName } from '../store'
import { z } from 'zod'
import { requirePerm } from '../auth'
import bcrypt from 'bcryptjs'
import { hasPg, pgSelect, pgInsert, pgUpdate } from '../dbAdapter'
import { hasSupabase, supaSelect, supaInsert, supaUpdate } from '../supabase'
import { v4 as uuid } from 'uuid'
import { pgDelete } from '../dbAdapter'
import { supaDelete } from '../supabase'

export const router = Router()

router.get('/roles', (req, res) => {
  res.json(db.roles)
})

router.get('/permissions', (req, res) => {
  res.json(db.permissions)
})

router.get('/role-permissions', (req, res) => {
  const { role_id } = req.query as { role_id?: string }
  const list = role_id ? db.rolePermissions.filter(rp => rp.role_id === role_id) : db.rolePermissions
  res.json(list)
})

const setSchema = z.object({ role_id: z.string(), permissions: z.array(z.string()) })
router.post('/role-permissions', requirePerm('rbac.manage'), (req, res) => {
  const parsed = setSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { role_id, permissions } = parsed.data
  // remove old
  db.rolePermissions = db.rolePermissions.filter(rp => rp.role_id !== role_id)
  permissions.forEach(code => db.rolePermissions.push({ role_id, permission_code: code }))
  res.json({ ok: true })
})

router.get('/my-permissions', (req, res) => {
  const user: any = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const rid = getRoleIdByName(user.role)
  if (!rid) return res.json([])
  const list = db.rolePermissions.filter(rp => rp.role_id === rid).map(rp => rp.permission_code)
  res.json(list)
})

const userUpsertSchema = z.object({ email: z.string().email(), username: z.string().optional(), role: z.string(), password: z.string().optional() })
router.post('/users', requirePerm('rbac.manage'), async (req, res) => {
  const parsed = userUpsertSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { email, username, role, password } = parsed.data
  const payload: any = { email, role }
  if (username) payload.username = username
  if (password) payload.password_hash = await bcrypt.hash(password, 10)
  if (!payload.password_hash) payload.password_hash = await bcrypt.hash('managed-by-auth', 10)
  if (!payload.id) payload.id = uuid()
  try {
    if (hasSupabase) {
      const existingByEmail: any = await supaSelect('users', '*', { email })
      const row = existingByEmail && existingByEmail[0]
      if (row) {
        const updated = await supaUpdate('users', row.id, payload)
        return res.json(updated || { id: row.id, ...payload })
      }
      const created = await supaInsert('users', { ...payload })
      return res.status(201).json(created || payload)
    }
    if (hasPg) {
      const existingByEmail = await pgSelect('users', '*', { email })
      const row = existingByEmail && existingByEmail[0]
      if (row) {
        const updated = await pgUpdate('users', row.id, payload)
        return res.json(updated || { id: row.id, ...payload })
      }
      const created = await pgInsert('users', { ...payload })
      return res.status(201).json(created || payload)
    }
    // fallback to local store
    const existing = db.users.find(u => u.email === email)
    if (existing) { Object.assign(existing, payload); return res.json(existing) }
    const created = { id: uuid(), ...payload }
    db.users.push(created)
    return res.status(201).json(created)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'user upsert failed' })
  }
})

router.get('/users', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (hasSupabase) {
      const rows: any = await supaSelect('users')
      return res.json((rows || []).map((u: any) => ({ id: u.id, email: u.email, username: u.username, role: u.role })))
    }
    if (hasPg) {
      const rows = await pgSelect('users')
      return res.json((rows || []).map((u: any) => ({ id: u.id, email: u.email, username: u.username, role: u.role })))
    }
    return res.json(db.users.map(u => ({ id: u.id, email: u.email, username: u.username, role: u.role })))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list users failed' })
  }
})

const userPatchSchema = z.object({ role: z.string().optional(), password: z.string().optional() })
router.patch('/users/:id', requirePerm('rbac.manage'), async (req, res) => {
  const parsed = userPatchSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { role, password } = parsed.data
  const payload: any = {}
  if (role) payload.role = role
  if (password) payload.password_hash = await bcrypt.hash(password, 10)
  try {
    if (hasSupabase) {
      const updated = await supaUpdate('users', req.params.id, payload)
      return res.json(updated || { id: req.params.id, ...payload })
    }
    if (hasPg) {
      const updated = await pgUpdate('users', req.params.id, payload)
      return res.json(updated || { id: req.params.id, ...payload })
    }
    const u = db.users.find(x => x.id === req.params.id)
    if (!u) return res.status(404).json({ message: 'not found' })
    Object.assign(u, payload)
    return res.json(u)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update user failed' })
  }
})

router.delete('/users/:id', requirePerm('rbac.manage'), async (req, res) => {
  try {
    if (hasSupabase) {
      await supaDelete('users', req.params.id)
      return res.json({ ok: true })
    }
    if (hasPg) {
      await pgDelete('users', req.params.id)
      return res.json({ ok: true })
    }
    const idx = db.users.findIndex(u => u.id === req.params.id)
    if (idx !== -1) db.users.splice(idx, 1)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'delete user failed' })
  }
})