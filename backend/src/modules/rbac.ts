import { Router } from 'express'
import { db } from '../store'
import { saveRolePermissions } from '../persistence'
import { z } from 'zod'
import { requirePerm, auth } from '../auth'
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

router.get('/role-permissions', async (req, res) => {
  const { role_id } = req.query as { role_id?: string }
  try {
    if (hasPg) {
      const rows = await pgSelect('role_permissions', '*', role_id ? { role_id } : undefined) as any[] || []
      return res.json(rows)
    }
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
  const list = role_id ? db.rolePermissions.filter(rp => rp.role_id === role_id) : db.rolePermissions
  res.json(list)
})

const setSchema = z.object({ role_id: z.string(), permissions: z.array(z.string().min(1)) })
router.post('/role-permissions', requirePerm('rbac.manage'), async (req, res) => {
  const parsed = setSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { role_id, permissions } = parsed.data
  const set = new Set<string>(permissions)
  const submenuToResources: Record<string, string[]> = {
    'menu.properties.list.visible': ['properties'],
    'menu.properties.maintenance.visible': ['property_maintenance'],
    'menu.properties.keys.visible': [], // 动作型留在“其他功能”
    'menu.landlords.visible': ['landlords'],
    'menu.cleaning.visible': ['cleaning_tasks'],
    'menu.finance.expenses.visible': ['property_expenses'],
    'menu.finance.recurring.visible': ['recurring_payments'],
    'menu.finance.orders.visible': ['orders'],
    'menu.finance.company_overview.visible': ['finance_transactions','orders','properties','property_expenses'],
    'menu.finance.company_revenue.visible': ['company_incomes','company_expenses'],
    'menu.cms.visible': ['cms_pages'],
    'menu.rbac.visible': ['users'],
  }
  // 仅当勾选“查看数据/编辑/删除/归档”时派生资源权限；父级 group 不派生
  // 注：可见本身不派生任何资源 view
  Object.entries(submenuToResources).forEach(([menuVisible, resources]) => {
    const base = menuVisible.replace(/\.visible$/, '')
    const wantView = set.has(`${base}.view`)
    const wantWrite = set.has(`${base}.write`)
    const wantDelete = set.has(`${base}.delete`)
    const wantArchive = set.has(`${base}.archive`)
    if (wantView || wantWrite || wantDelete || wantArchive) {
      // 自动确保可见
      set.add(menuVisible)
      resources.forEach((res) => {
        if (wantView) set.add(`${res}.view`)
        if (wantWrite) set.add(`${res}.write`)
        if (wantDelete) set.add(`${res}.delete`)
        if (wantArchive) set.add(`${res}.archive`)
      })
      // 将菜单层面的操作位移除，仅保留资源位与 .visible
      set.delete(`${base}.view`); set.delete(`${base}.write`); set.delete(`${base}.delete`); set.delete(`${base}.archive`)
    }
  })
  try {
    if (hasPg) {
      try {
        const conn = process.env.DATABASE_URL || ''
        let host = ''
        let dbname = ''
        try {
          const u = new URL(conn)
          host = u.hostname
          dbname = (u.pathname || '').replace(/^\//, '')
        } catch {}
        console.log(`[RBAC] write start env=${process.env.NODE_ENV} hasPg=${hasPg} host=${host} db=${dbname} role_id=${role_id} count=${set.size}`)
      } catch {}
      const { pgRunInTransaction, pgDeleteWhere, pgInsertOnConflictDoNothing } = require('../dbAdapter')
      const { v4: uuid } = require('uuid')
      await pgRunInTransaction(async (client: any) => {
        try {
          await pgDeleteWhere('role_permissions', { role_id }, client)
          let inserted = 0
          for (const code of Array.from(set)) {
            const r = await pgInsertOnConflictDoNothing('role_permissions', { id: uuid(), role_id, permission_code: code }, ['role_id', 'permission_code'], client)
            if (r) inserted++
          }
          console.log(`[RBAC] write done role_id=${role_id} inserted=${inserted}`)
        } catch (e: any) {
          console.error(`[RBAC] write error role_id=${role_id} message=${String(e?.message || '')}`)
          throw e
        }
      })
      return res.json({ ok: true })
    }
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
  db.rolePermissions = db.rolePermissions.filter(rp => rp.role_id !== role_id)
  Array.from(set).forEach(code => db.rolePermissions.push({ role_id, permission_code: code }))
  try { if (!hasPg && !hasSupabase) saveRolePermissions(db.rolePermissions) } catch {}
  res.json({ ok: true })
})

// current user's permissions
router.get('/my-permissions', auth, async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const roleName = String(user.role || '')
  const role = db.roles.find(r => r.name === roleName)
  if (!role) return res.json([])
  try {
    if (hasPg) {
      const rows = await pgSelect('role_permissions', 'permission_code', { role_id: role.id }) as any[] || []
      const list = rows.map((r: any) => r.permission_code)
      return res.json(list)
    }
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
  const list = db.rolePermissions.filter(rp => rp.role_id === role.id).map(rp => rp.permission_code)
  return res.json(list)
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
