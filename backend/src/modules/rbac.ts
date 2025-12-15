import { Router } from 'express'
import { db } from '../store'
import { saveRolePermissions } from '../persistence'
import { z } from 'zod'
import { requirePerm, auth } from '../auth'
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
      let rows = await pgSelect('role_permissions', '*', role_id ? { role_id } : undefined) as any[] || []
      if (role_id && (!rows || rows.length === 0)) {
        const alt = role_id.startsWith('role.') ? role_id.replace(/^role\./, '') : `role.${role_id}`
        const altRows = await pgSelect('role_permissions', '*', { role_id: alt }) as any[] || []
        if (altRows && altRows.length) rows = altRows
      }
      return res.json(rows)
    }
  } catch (e: any) {
    try { console.error(`[RBAC] outer error role_id=${role_id} message=${String(e?.message || '')} stack=${String(e?.stack || '')}`) } catch {}
    return res.status(500).json({ message: e.message })
  }
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
      try {
        const { pgPool } = require('../dbAdapter')
        if (pgPool) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS role_permissions (
            id text PRIMARY KEY,
            role_id text NOT NULL,
            permission_code text NOT NULL,
            created_at timestamptz DEFAULT now()
          );`)
          await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_perm ON role_permissions(role_id, permission_code);')
        }
      } catch (e: any) {
        console.error(`[RBAC] schema ensure error message=${String(e?.message || '')} stack=${String(e?.stack || '')}`)
      }
      const { pgPool } = require('../dbAdapter')
      const { v4: uuid } = require('uuid')
      if (!pgPool) { console.error('[RBAC] no pgPool'); return res.status(500).json({ message: 'database not available' }) }
      const client = await pgPool.connect()
      let inserted = 0
      try {
        console.log(`[RBAC] txn begin role_id=${role_id}`)
        await client.query('BEGIN')
        const normalizedId = role_id.startsWith('role.') ? role_id : `role.${role_id}`
        const altId = role_id.startsWith('role.') ? role_id.replace(/^role\./, '') : role_id
        await client.query('DELETE FROM role_permissions WHERE role_id = $1 OR role_id = $2', [normalizedId, altId])
        for (const code of Array.from(set)) {
          const id = uuid()
          const sql = 'INSERT INTO role_permissions (id, role_id, permission_code) VALUES ($1,$2,$3) ON CONFLICT (role_id, permission_code) DO NOTHING RETURNING id'
          const r = await client.query(sql, [id, normalizedId, code])
          if (r && r.rows && r.rows[0]) inserted++
        }
        await client.query('COMMIT')
        console.log(`[RBAC] write done role_id=${role_id} inserted=${inserted}`)
      } catch (e: any) {
        try { await client.query('ROLLBACK') } catch {}
        console.error(`[RBAC] write error role_id=${role_id} message=${String(e?.message || '')} stack=${String(e?.stack || '')}`)
        return res.status(500).json({ message: e?.message || 'write failed' })
      } finally {
        client.release()
      }
      return res.json({ ok: true })
    }
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
  db.rolePermissions = db.rolePermissions.filter(rp => rp.role_id !== role_id)
  Array.from(set).forEach(code => db.rolePermissions.push({ role_id, permission_code: code }))
  try { if (!hasPg) saveRolePermissions(db.rolePermissions) } catch {}
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
      let rows = await pgSelect('role_permissions', 'permission_code', { role_id: role.id }) as any[] || []
      if (!rows || rows.length === 0) {
        const altRows = await pgSelect('role_permissions', 'permission_code', { role_id: role.name }) as any[] || []
        if (altRows && altRows.length) rows = altRows
      }
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
    // Supabase branch removed
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
    // Supabase branch removed
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
    // Supabase branch removed
    return res.json({ id, ...payload })
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
})

router.delete('/users/:id', requirePerm('rbac.manage'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) { await pgDelete('users', id); return res.json({ ok: true }) }
    // Supabase branch removed
    return res.json({ ok: true })
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
})
