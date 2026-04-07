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

async function resolveRolePermissionBinding(rawRoleId: string) {
  const reqId = String(rawRoleId || '').trim()
  const normalizedId = reqId.startsWith('role.') ? reqId : `role.${reqId}`
  const altId = reqId.startsWith('role.') ? reqId.replace(/^role\./, '') : reqId
  const variants = new Set<string>([reqId, normalizedId, altId].filter(Boolean))
  let targetRoleId = normalizedId

  if (hasPg) {
    try {
      await ensureRolesTable()
      const { pgPool } = require('../dbAdapter')
      if (pgPool) {
        const found = await pgPool.query(
          'SELECT id, name FROM roles WHERE id = ANY($1::text[]) OR name = ANY($1::text[]) LIMIT 1',
          [Array.from(variants)],
        )
        const row = found?.rows?.[0]
        if (row) {
          const id = String(row.id || '').trim()
          const name = String(row.name || '').trim()
          if (id) {
            targetRoleId = id
            variants.add(id)
            variants.add(id.replace(/^role\./, ''))
          }
          if (name) {
            variants.add(name)
            variants.add(`role.${name}`)
          }
        }
      }
    } catch {}
  }

  return { normalizedId, altId, targetRoleId, variants: Array.from(variants) }
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

const roleUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional().transform((s) => (typeof s === 'string' ? s.trim() : s)),
  description: z.string().max(200).optional().transform((s) => (typeof s === 'string' ? s.trim() : s)),
})

router.patch('/roles/:id', requirePerm('rbac.manage'), async (req, res) => {
  const parsed = roleUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const reqId = String(req.params.id || '').trim()
  if (!reqId) return res.status(400).json({ message: 'id required' })

  const normalizedId = reqId.startsWith('role.') ? reqId : `role.${reqId}`
  const altId = reqId.startsWith('role.') ? reqId.replace(/^role\./, '') : reqId

  const nextName = parsed.data.name
  if (nextName && !/^[a-z][a-z0-9_]*$/i.test(nextName)) {
    return res.status(400).json({ message: '角色名仅支持字母/数字/下划线，且需以字母开头' })
  }

  try {
    if (hasPg) {
      await ensureRolesTable()
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'database not available' })

      const found = await pgPool.query('SELECT * FROM roles WHERE id = $1 OR id = $2 LIMIT 1', [normalizedId, altId])
      const old = found?.rows?.[0]
      if (!old) return res.status(404).json({ message: '角色不存在' })

      const oldId = String(old.id)
      const oldName = String(old.name)
      const newName = nextName ? String(nextName) : oldName
      const newId = nextName ? `role.${newName}` : oldId

      const payload: any = {}
      if (parsed.data.description !== undefined) payload.description = parsed.data.description
      if (nextName) payload.name = newName
      if (!Object.keys(payload).length && newId === oldId) return res.json(old)

      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        if (newId !== oldId) {
          await client.query('UPDATE roles SET id=$1, name=$2, description=$3 WHERE id=$4', [
            newId,
            newName,
            parsed.data.description !== undefined ? parsed.data.description : old.description,
            oldId,
          ])
          try { await client.query('UPDATE users SET role=$1 WHERE role=$2', [newName, oldName]) } catch {}
          try {
            await client.query(
              `CREATE TABLE IF NOT EXISTS user_roles (
                user_id text NOT NULL,
                role_name text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (user_id, role_name)
              );`,
            )
            await client.query('UPDATE user_roles SET role_name=$1 WHERE role_name=$2', [newName, oldName])
          } catch {}
          try { await client.query('UPDATE role_permissions SET role_id=$1 WHERE role_id=$2 OR role_id=$3 OR role_id=$4', [newId, oldId, oldId.replace(/^role\./, ''), oldName]) } catch {}
        } else {
          const nextDesc = parsed.data.description !== undefined ? parsed.data.description : old.description
          await client.query('UPDATE roles SET name=$1, description=$2 WHERE id=$3', [newName, nextDesc, oldId])
        }
        const after = await client.query('SELECT * FROM roles WHERE id = $1 LIMIT 1', [newId])
        await client.query('COMMIT')
        return res.json(after?.rows?.[0] || { ...old, ...payload, id: newId, name: newName })
      } catch (e: any) {
        try { await client.query('ROLLBACK') } catch {}
        const code = String(e?.code || '')
        const msg = String(e?.message || '')
        if (code === '23505' || /duplicate key value|unique constraint/i.test(msg)) return res.status(409).json({ message: '角色名已存在' })
        return res.status(500).json({ message: msg || '更新失败' })
      } finally {
        client.release()
      }
    }
  } catch (e: any) { return res.status(500).json({ message: e.message }) }

  const idx = db.roles.findIndex((r) => r.id === normalizedId || r.id === altId || r.name === altId)
  if (idx < 0) return res.status(404).json({ message: '角色不存在' })
  const old = db.roles[idx]
  const oldId = old.id
  const oldName = old.name
  const newName = nextName ? String(nextName) : oldName
  const newId = nextName ? `role.${newName}` : oldId
  if (newId !== oldId && db.roles.some((r, i) => i !== idx && (r.id === newId || r.name === newName))) return res.status(409).json({ message: '角色名已存在' })
  db.roles[idx] = { ...old, id: newId, name: newName, description: parsed.data.description !== undefined ? parsed.data.description : old.description }
  if (newId !== oldId) {
    db.rolePermissions = db.rolePermissions.map((rp) => ((rp.role_id === oldId || rp.role_id === oldId.replace(/^role\./, '') || rp.role_id === oldName) ? { ...rp, role_id: newId } : rp))
    try { saveRolePermissions(db.rolePermissions) } catch {}
  }
  try { saveRoles(db.roles) } catch {}
  return res.json(db.roles[idx])
})

router.delete('/roles/:id', requirePerm('rbac.manage'), async (req, res) => {
  const reqId = String(req.params.id || '').trim()
  if (!reqId) return res.status(400).json({ message: 'id required' })

  const normalizedId = reqId.startsWith('role.') ? reqId : `role.${reqId}`
  const altId = reqId.startsWith('role.') ? reqId.replace(/^role\./, '') : reqId

  try {
    if (hasPg) {
      await ensureRolesTable()
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'database not available' })

      const found = await pgPool.query('SELECT * FROM roles WHERE id = $1 OR id = $2 LIMIT 1', [normalizedId, altId])
      const role = found?.rows?.[0]
      if (!role) return res.status(404).json({ message: '角色不存在' })

      const roleId = String(role.id || '')
      const roleName = String(role.name || '')
      if (roleId === 'role.admin' || roleName === 'admin') return res.status(400).json({ message: 'admin 角色不可删除' })

      try {
        const cntRes = await pgPool.query('SELECT COUNT(*)::int AS cnt FROM users WHERE role = $1', [roleName])
        const cnt = Number(cntRes?.rows?.[0]?.cnt || 0)
        if (cnt > 0) return res.status(409).json({ message: `该角色仍被 ${cnt} 个用户使用，无法删除` })
      } catch {}

      const variants = Array.from(new Set([roleId, roleId.replace(/^role\./, ''), roleName, normalizedId, altId].filter(Boolean))) as string[]
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        try { await client.query('DELETE FROM role_permissions WHERE role_id = ANY($1)', [variants]) } catch {}
        await client.query('DELETE FROM roles WHERE id = $1', [roleId])
        await client.query('COMMIT')
        return res.json({ ok: true })
      } catch (e: any) {
        try { await client.query('ROLLBACK') } catch {}
        return res.status(500).json({ message: e?.message || 'delete failed' })
      } finally {
        client.release()
      }
    }
  } catch (e: any) { return res.status(500).json({ message: e.message }) }

  const idx = db.roles.findIndex((r) => r.id === normalizedId || r.id === altId || r.name === altId)
  if (idx < 0) return res.status(404).json({ message: '角色不存在' })
  const role = db.roles[idx]
  const roleId = String(role.id || '')
  const roleName = String(role.name || '')
  if (roleId === 'role.admin' || roleName === 'admin') return res.status(400).json({ message: 'admin 角色不可删除' })

  const cnt = (db.users || []).filter((u: any) => String(u?.role || '') === roleName).length
  if (cnt > 0) return res.status(409).json({ message: `该角色仍被 ${cnt} 个用户使用，无法删除` })

  const variants = new Set([roleId, roleId.replace(/^role\./, ''), roleName, normalizedId, altId].filter(Boolean))
  db.rolePermissions = db.rolePermissions.filter((rp) => !variants.has(String(rp.role_id || '')))
  db.roles.splice(idx, 1)
  try { saveRolePermissions(db.rolePermissions) } catch {}
  try { saveRoles(db.roles) } catch {}
  return res.json({ ok: true })
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
      let rows: any[] = []
      if (role_id) {
        const binding = await resolveRolePermissionBinding(String(role_id))
        const { pgPool } = require('../dbAdapter')
        if (pgPool) {
          const rr = await pgPool.query('SELECT * FROM role_permissions WHERE role_id = ANY($1::text[])', [binding.variants])
          rows = rr?.rows || []
        }
      } else {
        rows = await pgSelect('role_permissions', '*') as any[] || []
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
      const binding = await resolveRolePermissionBinding(role_id)
      const client = await pgPool.connect()
      let inserted = 0
      try {
        console.log(`[RBAC] txn begin role_id=${role_id}`)
        await client.query('BEGIN')
        await client.query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [binding.variants])
        for (const code of finalCodes) {
          const id = uuid()
          const sql = 'INSERT INTO role_permissions (id, role_id, permission_code) VALUES ($1,$2,$3) ON CONFLICT (role_id, permission_code) DO NOTHING RETURNING id'
          const r = await client.query(sql, [id, binding.targetRoleId, code])
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

router.delete('/role-permissions', requirePerm('rbac.manage'), async (req, res) => {
  const role_id = String((req.query as any)?.role_id || '').trim()
  if (!role_id) return res.status(400).json({ message: 'role_id required' })
  const binding = await resolveRolePermissionBinding(role_id)
  try {
    if (hasPg) {
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'database not available' })
      try {
        await pgPool.query(`CREATE TABLE IF NOT EXISTS role_permissions (
          id text PRIMARY KEY,
          role_id text NOT NULL,
          permission_code text NOT NULL,
          created_at timestamptz DEFAULT now()
        );`)
        await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_perm ON role_permissions(role_id, permission_code);')
      } catch {}
      await pgPool.query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [binding.variants])
      return res.json({ ok: true })
    }
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
  const variants = new Set(binding.variants)
  db.rolePermissions = db.rolePermissions.filter((rp) => !variants.has(String(rp.role_id || '')))
  try { if (!hasPg) saveRolePermissions(db.rolePermissions) } catch {}
  return res.json({ ok: true })
})

// current user's permissions
router.get('/my-permissions', auth, async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const roleNames: string[] = Array.from(
    new Set<string>(
      (Array.isArray(user.roles) ? (user.roles as any[]) : [user.role])
        .map((x: any) => String(x || '').trim())
        .filter(Boolean),
    ),
  )
  if (roleNames.includes('admin')) {
    const all = (db.permissions || []).map((p: any) => String(p?.code || '')).filter(Boolean)
    const list = expandPermissionSynonyms(all)
    return res.json(Array.from(new Set(list)))
  }
  const out = new Set<string>()
  try {
    if (hasPg) {
      const rolePerms = async (roleName: string) => {
        let roleId = db.roles.find(r => r.name === roleName)?.id
        try {
          await ensureRolesTable()
          const rr = (await pgSelect('roles', 'id,name', { name: roleName })) as any[] || []
          if (rr && rr[0] && rr[0].id) roleId = String(rr[0].id)
        } catch {}
        const roleIds = Array.from(new Set([roleId, roleName].filter(Boolean))) as string[]
        if (!roleIds.length) return [] as string[]
        let rows: any[] = []
        for (const rid of roleIds) {
          const r0 = (await pgSelect('role_permissions', 'permission_code', { role_id: rid })) as any[] || []
          if (r0 && r0.length) { rows = r0; break }
        }
        if (!rows || rows.length === 0) {
          const altCandidates = roleIds.flatMap((rid) => (String(rid).startsWith('role.') ? [String(rid).replace(/^role\./, '')] : [`role.${rid}`]))
          for (const rid of altCandidates) {
            const r0 = (await pgSelect('role_permissions', 'permission_code', { role_id: rid })) as any[] || []
            if (r0 && r0.length) { rows = r0; break }
          }
        }
        return rows.map((r: any) => String(r.permission_code || '')).filter(Boolean)
      }
      try {
        await pgSelect('roles', 'id', { id: 'role.admin' })
      } catch {}
      for (const rn of roleNames) {
        const codes = await rolePerms(rn)
        const list = expandPermissionSynonyms(codes)
        for (const c of list) out.add(String(c))
      }
      ;['view','write','delete','archive'].forEach(act => {
        const plural = `orders.${act}`
        const singular = `order.${act}`
        if (out.has(plural) && !out.has(singular)) out.add(singular)
      })
      return res.json(Array.from(out))
    }
  } catch {
    return res.json([])
  }
  for (const rn of roleNames) {
    const roleId = db.roles.find(r => r.name === rn)?.id
    if (!roleId) continue
    const list = expandPermissionSynonyms(db.rolePermissions.filter(rp => rp.role_id === roleId).map(rp => rp.permission_code))
    for (const c of list) out.add(String(c))
  }
  ;['view','write','delete','archive'].forEach(act => {
    const plural = `orders.${act}`
    const singular = `order.${act}`
    if (out.has(plural) && !out.has(singular)) out.add(singular)
  })
  return res.json(Array.from(out))
})

// Users management
function normalizeAuPhone(v: unknown) {
  const raw = String(v || '').trim()
  if (!raw) return null
  let s = raw.replace(/[\s()-]/g, '').replace(/-+/g, '')
  if (s.startsWith('00')) s = `+${s.slice(2)}`
  if (s.startsWith('+')) {
    const d = s.slice(1).replace(/\D/g, '')
    if (!d.startsWith('61')) return null
    const rest = d.slice(2)
    if (!/^\d{9}$/.test(rest)) return null
    return `+61${rest}`
  }
  const d = s.replace(/\D/g, '')
  if (d.startsWith('61')) {
    const rest = d.slice(2)
    if (!/^\d{9}$/.test(rest)) return null
    return `+61${rest}`
  }
  if (d.startsWith('0') && d.length === 10) return `+61${d.slice(1)}`
  return null
}

const userCreateSchema = z.object({
  username: z.string().min(1),
  email: z.preprocess((v) => {
    if (v === null || v === undefined) return undefined
    const s = String(v).trim()
    return s ? s : undefined
  }, z.string().email().optional()),
  phone_au: z.string().min(1),
  role: z.string().min(1),
  roles: z.array(z.string().min(1)).optional(),
  password: z.string().min(6),
  color_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).transform((v) => {
  const phone = normalizeAuPhone((v as any).phone_au)
  if (!phone) throw new Error('invalid_phone_au')
  return { ...(v as any), phone_au: phone }
})
const userUpdateSchema = z.object({
  username: z.string().optional(),
  email: z.preprocess((v) => {
    if (v === null || v === undefined) return undefined
    const s = String(v).trim()
    return s ? s : undefined
  }, z.string().email().optional()),
  phone_au: z.string().optional(),
  role: z.string().optional(),
  roles: z.array(z.string().min(1)).optional(),
  password: z.string().min(6).optional(),
  color_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).transform((v) => {
  const out: any = { ...(v as any) }
  if (out.phone_au !== undefined) {
    const phone = normalizeAuPhone(out.phone_au)
    if (!phone) throw new Error('invalid_phone_au')
    out.phone_au = phone
  }
  return out
})

async function ensureUserRolesTable() {
  if (!hasPg) return
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return
  await pgPool.query(
    `CREATE TABLE IF NOT EXISTS user_roles (
      user_id text NOT NULL,
      role_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, role_name)
    );`,
  )
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_user_roles_role_name ON user_roles(role_name);')
}

function normalizeRolesInput(params: { role?: any; roles?: any }) {
  const primary = String(params.role ?? '').trim()
  const rolesArr = Array.isArray(params.roles) ? params.roles : []
  const roles = rolesArr.map((x: any) => String(x || '').trim()).filter(Boolean)
  if (primary) roles.unshift(primary)
  const uniq = Array.from(new Set(roles))
  return { role: primary, roles: uniq }
}

router.get('/users', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (hasPg) {
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.json([])
      await ensureUserRolesTable().catch(() => null)
      const r = await pgPool.query(
        `SELECT
           u.*,
           COALESCE(
             ARRAY_AGG(DISTINCT ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL),
             ARRAY[]::text[]
           ) AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id::text
         GROUP BY u.id
         ORDER BY u.created_at DESC NULLS LAST, u.username ASC`,
      )
      const rows = (r?.rows || []).map((x: any) => ({ ...x, roles: Array.isArray(x.roles) ? x.roles : [] }))
      return res.json(rows)
    }
    // Supabase branch removed
    return res.json([])
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
})

router.get('/users/:id', requirePerm('rbac.manage'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })
  try {
    if (hasPg) {
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'pg not available' })
      await ensureUserRolesTable().catch(() => null)
      const r = await pgPool.query(
        `SELECT
           u.*,
           COALESCE(
             ARRAY_AGG(DISTINCT ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL),
             ARRAY[]::text[]
           ) AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id::text
         WHERE u.id::text = $1
         GROUP BY u.id
         LIMIT 1`,
        [id],
      )
      const row = r?.rows?.[0] || null
      if (!row) return res.status(404).json({ message: 'user not found' })
      return res.json({ ...row, roles: Array.isArray((row as any).roles) ? (row as any).roles : [] })
    }
    const row = db.users.find((u: any) => String(u.id) === id)
    if (!row) return res.status(404).json({ message: 'user not found' })
    return res.json(row)
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
})

router.post('/users', requirePerm('rbac.manage'), async (req, res) => {
  const parsed = userCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const hash = await bcrypt.hash(parsed.data.password, 10)
  const norm = normalizeRolesInput({ role: parsed.data.role, roles: (parsed.data as any).roles })
  const rolePrimary = norm.role || norm.roles[0] || parsed.data.role
  const rolesAll = Array.from(new Set([rolePrimary, ...norm.roles].map((x) => String(x || '').trim()).filter(Boolean)))
  const row = { id: uuid(), username: parsed.data.username, email: parsed.data.email, phone_au: parsed.data.phone_au, role: rolePrimary, password_hash: hash, color_hex: parsed.data.color_hex || '#3B82F6' }
  try {
    if (hasPg) {
      try {
        const { pgPool } = require('../dbAdapter')
        if (pgPool) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS users (
            id text PRIMARY KEY,
            username text UNIQUE,
            email text UNIQUE,
            phone_au text,
            password_hash text NOT NULL,
            role text NOT NULL,
            color_hex text NOT NULL DEFAULT '#3B82F6',
            created_at timestamptz DEFAULT now()
          );`)
          await pgPool.query('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);')
          await pgPool.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);')
          await pgPool.query('CREATE INDEX IF NOT EXISTS idx_users_phone_au ON users(phone_au);')
          await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_password_hash text;')
          await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS color_hex text NOT NULL DEFAULT '#3B82F6';`)
          await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_au text;')
        }
      } catch (e: any) {
        try { console.error(`[RBAC] ensure users table error message=${String(e?.message || '')}`) } catch {}
      }
      try {
        const created = await pgInsert('users', row as any)
        try {
          await ensureUserRolesTable()
          const { pgPool } = require('../dbAdapter')
          if (pgPool && rolesAll.length) {
            for (const rn of rolesAll) {
              await pgPool.query('INSERT INTO user_roles (user_id, role_name) VALUES ($1,$2) ON CONFLICT (user_id, role_name) DO NOTHING', [String(row.id), rn])
            }
          }
        } catch {}
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
      try {
        const { pgPool } = require('../dbAdapter')
        if (pgPool) {
          await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS color_hex text NOT NULL DEFAULT '#3B82F6';`)
          await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_au text;')
          await pgPool.query('CREATE INDEX IF NOT EXISTS idx_users_phone_au ON users(phone_au);')
        }
      } catch {}
      const rolesPayload = payload.roles
      delete payload.roles
      if (rolesPayload !== undefined) {
        try {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            const cur = await pgPool.query('SELECT role FROM users WHERE id::text=$1 LIMIT 1', [String(id)])
            const curRole = String(cur?.rows?.[0]?.role || '').trim()
            const norm = normalizeRolesInput({ role: payload.role != null ? payload.role : curRole, roles: rolesPayload })
            const nextPrimary = String(payload.role || '').trim() || (norm.roles.includes(curRole) ? curRole : (norm.roles[0] || curRole))
            payload.role = nextPrimary
            const rolesAll = Array.from(new Set([nextPrimary, ...norm.roles].map((x) => String(x || '').trim()).filter(Boolean)))
            await ensureUserRolesTable()
            await pgPool.query('DELETE FROM user_roles WHERE user_id::text=$1', [String(id)])
            for (const rn of rolesAll) {
              await pgPool.query('INSERT INTO user_roles (user_id, role_name) VALUES ($1,$2) ON CONFLICT (user_id, role_name) DO NOTHING', [String(id), rn])
            }
          }
        } catch {}
      }
      const updated = await pgUpdate('users', id, payload as any)
      if (payload.role) {
        try {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            await ensureUserRolesTable()
            await pgPool.query('INSERT INTO user_roles (user_id, role_name) VALUES ($1,$2) ON CONFLICT (user_id, role_name) DO NOTHING', [String(id), String(payload.role)])
          }
        } catch {}
      }
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
