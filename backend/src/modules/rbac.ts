import { Router } from 'express'
import { db } from '../store'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { hasSupabase, supaSelect, supaInsert, supaUpdate, supaDelete } from '../supabase'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'
import bcrypt from 'bcryptjs'

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

// Users management
const userCreateSchema = z.object({ username: z.string().min(1), email: z.string().email(), role: z.string().min(1), password: z.string().min(6) })
const userUpdateSchema = z.object({ username: z.string().optional(), email: z.string().email().optional(), role: z.string().optional(), password: z.string().min(6).optional() })

router.get('/users', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (hasPg) { const rows = await pgSelect('users') as any[] || []; return res.json(rows) }
    if (hasSupabase) { const rows = await supaSelect('users') as any[] || []; return res.json(rows) }
    return res.json([])
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
})

router.post('/users', requirePerm('rbac.manage'), async (req, res) => {
  const parsed = userCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const hash = await bcrypt.hash(parsed.data.password, 10)
  const row = { id: uuid(), username: parsed.data.username, email: parsed.data.email, role: parsed.data.role, password_hash: hash }
  try {
    if (hasPg) { const created = await pgInsert('users', row as any); return res.status(201).json(created || row) }
    if (hasSupabase) { const created = await supaInsert('users', row); return res.status(201).json(created || row) }
    return res.status(201).json(row)
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
})

router.patch('/users/:id', requirePerm('rbac.manage'), async (req, res) => {
  const parsed = userUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const payload: any = { ...parsed.data }
  if (payload.password) { payload.password_hash = await bcrypt.hash(payload.password, 10); delete payload.password }
  const { id } = req.params
  try {
    if (hasPg) { const updated = await pgUpdate('users', id, payload as any); return res.json(updated || { id, ...payload }) }
    if (hasSupabase) { const updated = await supaUpdate('users', id, payload); return res.json(updated || { id, ...payload }) }
    return res.json({ id, ...payload })
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
})

router.delete('/users/:id', requirePerm('rbac.manage'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) { await pgDelete('users', id); return res.json({ ok: true }) }
    if (hasSupabase) { await supaDelete('users', id); return res.json({ ok: true }) }
    return res.json({ ok: true })
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
})
