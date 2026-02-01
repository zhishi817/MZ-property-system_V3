import { Router } from 'express'
import { db } from '../store'
import { saveRolePermissions, saveRoles } from '../persistence'
import { z } from 'zod'
import { requirePerm, auth } from '../auth'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'
import bcrypt from 'bcryptjs'
import { getPermissionMeta } from '../permissionsCatalog'

export const router = Router()

function expandPermissionSynonyms(codes: string[]): string[] {
  const acts = ['view', 'write', 'delete', 'archive']
  const s = new Set<string>((codes || []).map((c) => String(c || '')).filter(Boolean))
  acts.forEach((a) => {
    if (s.has(`orders.${a}`) && !s.has(`order.${a}`)) s.add(`order.${a}`)
    if (s.has(`order.${a}`) && !s.has(`orders.${a}`)) s.add(`orders.${a}`)
    if (s.has(`properties.${a}`) && !s.has(`property.${a}`)) s.add(`property.${a}`)
    if (s.has(`property.${a}`) && !s.has(`properties.${a}`)) s.add(`properties.${a}`)
  })
  return Array.from(s)
}

async function ensureRolesTable() {
  if (!hasPg) return
  try {
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return
    await pgPool.query(`CREATE TABLE IF NOT EXISTS roles (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text,
      created_at timestamptz DEFAULT now()
    );`)
    await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_roles_name ON roles(name);')
  } catch {}
}

router.get('/roles', async (_req, res) => {
  try {
    if (hasPg) {
      await ensureRolesTable()
      let rows = await pgSelect('roles', '*') as any[] || []
      if (!rows || rows.length === 0) {
        try {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            for (const r of db.roles) {
              await pgPool.query(
                'INSERT INTO roles(id, name, description) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING',
                [r.id, r.name, r.description || null]
              )
            }
          }
        } catch {}
        rows = await pgSelect('roles', '*') as any[] || []
      }
      return res.json(rows)
    }
  } catch {}
  return res.json(db.roles)
})

const roleCreateSchema = z.object({
  name: z.string().min(1).max(64).transform((s) => s.trim()),
  description: z.string().max(200).optional().transform((s) => (typeof s === 'string' ? s.trim() : s)),
})

router.post('/roles', requirePerm('rbac.manage'), async (req, res) => {
  const parsed = roleCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const name = parsed.data.name
  if (!/^[a-z][a-z0-9_]*$/i.test(name)) return res.status(400).json({ message: '角色名仅支持字母/数字/下划线，且需以字母开头' })
  const role = { id: `role.${name}`, name, description: parsed.data.description || undefined }
  try {
    if (hasPg) {
      await ensureRolesTable()
      try {
        const created = await pgInsert('roles', role as any)
        return res.status(201).json(created || role)
      } catch (e: any) {
        const code = String((e && (e as any).code) || '')
        const msg = String((e && (e as any).message) || '')
        if (code === '23505' || /duplicate key value|unique constraint/i.test(msg)) {
          return res.status(409).json({ message: '角色名已存在' })
        }
        return res.status(500).json({ message: msg || '创建失败' })
      }
    }
    if (db.roles.find((r) => r.name === name || r.id === role.id)) return res.status(409).json({ message: '角色名已存在' })
    db.roles.push(role)
    try { saveRoles(db.roles) } catch {}
    return res.status(201).json(role)
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
})

router.get('/permissions', (req, res) => {
  res.json(db.permissions.map((p: any) => {
    const code = String(p.code || '')
    const meta = getPermissionMeta(code)
    return { ...p, name: p?.name || meta.displayName, meta }
  }))
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
      if (role_id) {
        const codes = expandPermissionSynonyms(rows.map((r: any) => String(r?.permission_code || '')))
        return res.json(codes.map((permission_code) => ({ role_id, permission_code })))
      }
      return res.json(rows)
    }
  } catch (e: any) {
    try { console.error(`[RBAC] outer error role_id=${role_id} message=${String(e?.message || '')} stack=${String(e?.stack || '')}`) } catch {}
    return res.status(500).json({ message: e.message })
  }
  if (role_id) {
    const codes = expandPermissionSynonyms(db.rolePermissions.filter(rp => rp.role_id === role_id).map(rp => rp.permission_code))
    return res.json(codes.map((permission_code) => ({ role_id, permission_code })))
  }
  res.json(db.rolePermissions)
})

const setSchema = z.object({ role_id: z.string(), permissions: z.array(z.string().min(1)) })
router.post('/role-permissions', requirePerm('rbac.manage'), async (req, res) => {
  const parsed = setSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { role_id, permissions } = parsed.data
  const set = new Set<string>(expandPermissionSynonyms(permissions))
  const submenuToResources: Record<string, string[]> = {
    'menu.properties.list.visible': ['properties'],
    'menu.properties.maintenance.visible': ['property_maintenance'],
    'menu.properties.deep_cleaning.visible': ['property_deep_cleaning'],
    'menu.properties.keys.visible': [], // 动作型留在“其他功能”
    'menu.landlords.visible': ['landlords'],
    'menu.cleaning.visible': ['cleaning_tasks'],
    'menu.finance.expenses.visible': ['property_expenses'],
    'menu.finance.recurring.visible': ['recurring_payments'],
    'menu.finance.orders.visible': ['order'],
    'menu.finance.company_overview.visible': ['finance_transactions','order','properties','property_expenses'],
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
      if (menuVisible === 'menu.finance.orders.visible' && (wantWrite || wantDelete || wantArchive)) {
        set.add('order.deduction.manage')
      }
      // 将菜单层面的操作位移除，仅保留资源位与 .visible
      set.delete(`${base}.view`); set.delete(`${base}.write`); set.delete(`${base}.delete`); set.delete(`${base}.archive`)
    }
  })
  const finalCodes = expandPermissionSynonyms(Array.from(set))
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
        for (const code of finalCodes) {
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
  finalCodes.forEach(code => db.rolePermissions.push({ role_id, permission_code: code }))
  try { if (!hasPg) saveRolePermissions(db.rolePermissions) } catch {}
  res.json({ ok: true })
})

// current user's permissions
router.get('/my-permissions', auth, async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const roleName = String(user.role || '')
  let roleId = db.roles.find(r => r.name === roleName)?.id
  try {
    if (hasPg) {
      try {
        await ensureRolesTable()
        const rr = await pgSelect('roles', 'id,name', { name: roleName }) as any[] || []
        if (rr && rr[0] && rr[0].id) roleId = String(rr[0].id)
      } catch {}
      const roleIds = Array.from(new Set([roleId, roleName].filter(Boolean))) as string[]
      if (!roleIds.length) return res.json([])
      let rows: any[] = []
      for (const rid of roleIds) {
        const r0 = await pgSelect('role_permissions', 'permission_code', { role_id: rid }) as any[] || []
        if (r0 && r0.length) { rows = r0; break }
      }
      if (!rows || rows.length === 0) {
        const altCandidates = roleIds.flatMap((rid) => (String(rid).startsWith('role.') ? [String(rid).replace(/^role\./, '')] : [`role.${rid}`]))
        for (const rid of altCandidates) {
          const r0 = await pgSelect('role_permissions', 'permission_code', { role_id: rid }) as any[] || []
          if (r0 && r0.length) { rows = r0; break }
        }
      }
      const list = expandPermissionSynonyms(rows.map((r: any) => r.permission_code))
      const normalized = new Set<string>(list)
      ;['view','write','delete','archive'].forEach(act => {
        const plural = `orders.${act}`
        const singular = `order.${act}`
        if (normalized.has(plural) && !normalized.has(singular)) normalized.add(singular)
      })
      return res.json(Array.from(normalized))
    }
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
  if (!roleId) return res.json([])
  const list = expandPermissionSynonyms(db.rolePermissions.filter(rp => rp.role_id === roleId).map(rp => rp.permission_code))
  const normalized = new Set<string>(list)
  ;['view','write','delete','archive'].forEach(act => {
    const plural = `orders.${act}`
    const singular = `order.${act}`
    if (normalized.has(plural) && !normalized.has(singular)) normalized.add(singular)
  })
  return res.json(Array.from(normalized))
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
    if (hasPg) {
      try {
        const { pgPool } = require('../dbAdapter')
        if (pgPool) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS users (
            id text PRIMARY KEY,
            username text UNIQUE,
            email text UNIQUE,
            password_hash text NOT NULL,
            role text NOT NULL,
            created_at timestamptz DEFAULT now()
          );`)
          await pgPool.query('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);')
          await pgPool.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);')
          await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_password_hash text;')
        }
      } catch (e: any) {
        try { console.error(`[RBAC] ensure users table error message=${String(e?.message || '')}`) } catch {}
      }
      try {
        const created = await pgInsert('users', row as any)
        return res.status(201).json(created || row)
      } catch (e: any) {
        const code = String((e && (e as any).code) || '')
        const msg = String((e && (e as any).message) || '')
        if (code === '23505' || /duplicate key value|unique constraint/i.test(msg)) {
          return res.status(409).json({ message: '用户名或邮箱已存在' })
        }
        if (code === '42P01' || /relation .* does not exist/i.test(msg)) {
          return res.status(500).json({ message: '数据库未初始化，请重试或联系管理员' })
        }
        return res.status(500).json({ message: msg || '创建失败' })
      }
    }
    // Supabase branch removed
    return res.status(201).json(row)
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
})

router.patch('/users/:id', requirePerm('rbac.manage'), async (req, res) => {
  const parsed = userUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const didResetPassword = !!parsed.data.password
  const payload: any = { ...parsed.data }
  if (payload.password) { payload.password_hash = await bcrypt.hash(payload.password, 10); delete payload.password }
  const { id } = req.params
  try {
    if (hasPg) {
      const updated = await pgUpdate('users', id, payload as any)
      if (didResetPassword) {
        try {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            await pgPool.query(`CREATE TABLE IF NOT EXISTS sessions (
              id text PRIMARY KEY,
              user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              created_at timestamptz DEFAULT now(),
              last_seen_at timestamptz DEFAULT now(),
              expires_at timestamptz NOT NULL,
              revoked boolean NOT NULL DEFAULT false,
              ip text,
              user_agent text,
              device text
            );`)
            await pgPool.query('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);')
            await pgPool.query('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);')
            await pgPool.query('CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(user_id) WHERE revoked = false;')
            await pgPool.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND revoked=false', [id])
          }
        } catch {}
      }
      return res.json(updated || { id, ...payload })
    }
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
