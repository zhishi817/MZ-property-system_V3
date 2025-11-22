import { Router } from 'express'
import { db, getRoleIdByName } from '../store'
import { z } from 'zod'
import { requirePerm } from '../auth'

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