import jwt from 'jsonwebtoken'
import { Request, Response, NextFunction } from 'express'
import { v4 as uuid } from 'uuid'
import { roleHasPermission, db } from './store'
import { hasPg, pgSelect } from './dbAdapter'
import bcrypt from 'bcryptjs'

const SECRET = process.env.JWT_SECRET || 'dev-secret'
const SESSION_MAX_AGE_HOURS = Number(process.env.SESSION_MAX_AGE_HOURS || 5)
const SESSION_IDLE_TIMEOUT_MINUTES = Number(process.env.SESSION_IDLE_TIMEOUT_MINUTES || 60)

type User = { id: string; username: string; role: string }

export const users: Record<string, User & { password: string }> = {
  admin: { id: 'u-admin', username: 'admin', role: 'admin', password: process.env.ADMIN_PASSWORD || 'admin' },
  cs: { id: 'u-cs', username: 'cs', role: 'customer_service', password: process.env.CS_PASSWORD || 'cs' },
  cleaning_mgr: { id: 'u-cleaning-mgr', username: 'cleaning_mgr', role: 'cleaning_manager', password: process.env.CLEANING_MGR_PASSWORD || 'cleaning_mgr' },
  cleaner: { id: 'u-cleaner', username: 'cleaner', role: 'cleaner_inspector', password: process.env.CLEANER_PASSWORD || 'cleaner' },
  finance: { id: 'u-finance', username: 'finance', role: 'finance_staff', password: process.env.FINANCE_PASSWORD || 'finance' },
  inventory: { id: 'u-inventory', username: 'inventory', role: 'inventory_manager', password: process.env.INVENTORY_PASSWORD || 'inventory' },
  maintenance: { id: 'u-maintenance', username: 'maintenance', role: 'maintenance_staff', password: process.env.MAINTENANCE_PASSWORD || 'maintenance' },
}

export async function login(req: Request, res: Response) {
  const { username, password } = req.body || {}
  if (!username || !password) return res.status(400).json({ message: 'missing credentials' })
  const isDev = String(process.env.APP_ENV || '').toLowerCase() === 'dev' && String(process.env.NODE_ENV || '').toLowerCase() !== 'production'
  // DB first（Postgres；容错）
  let row: any = null
  // Supabase branch removed
  if (!row && hasPg) {
    try {
      const byUser = await pgSelect('users', '*', { username })
      row = byUser && byUser[0]
      if (!row) {
        const byEmail = await pgSelect('users', '*', { email: username })
        row = byEmail && byEmail[0]
      }
    } catch {}
  }
  if (row) {
    let ok = false
    try {
      const hash = typeof row.password_hash === 'string' ? row.password_hash : ''
      if (hash) ok = await bcrypt.compare(password, hash)
    } catch {}
    if (!ok && isDev) {
      const alias: Record<string, string> = { ops: 'cs', field: 'cleaner' }
      const k = alias[String(username)] || String(username)
      const u = (users as any)[k]
      if (u && u.password === String(password)) {
        ok = true
        try {
          if (hasPg) {
            const { pgPool } = require('./dbAdapter')
            if (pgPool) {
              const newHash = await bcrypt.hash(String(password), 10)
              await pgPool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [newHash, row.id])
              row.password_hash = newHash
            }
          }
        } catch {}
      }
    }
    if (!ok) return res.status(401).json({ message: 'invalid credentials' })
    let sid: string | null = null
    if (hasPg) {
      try {
        const { pgRunInTransaction } = require('./dbAdapter')
        const sidNew = await pgRunInTransaction(async (client: any) => {
          await client.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND revoked=false', [row.id])
          const newSid = uuid()
          const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_HOURS * 3600 * 1000).toISOString()
          const ua = String(req.headers['user-agent'] || '')
          const ip = String((req.ip || req.socket?.remoteAddress || '')).slice(0, 255)
          await client.query(
            'INSERT INTO sessions(id, user_id, created_at, last_seen_at, expires_at, revoked, ip, user_agent) VALUES($1,$2,now(),now(),$3,false,$4,$5)',
            [newSid, row.id, expiresAt, ip, ua]
          )
          return newSid
        })
        sid = String(sidNew)
      } catch {}
    }
    const payload: any = { sub: row.id, role: row.role, username: row.username }
    if (sid) payload.sid = sid
    const token = jwt.sign(payload, SECRET, { expiresIn: `${SESSION_MAX_AGE_HOURS}h` })
    return res.json({ token, role: row.role })
  }
  if (!row && db.users.length) {
    const byUser = db.users.find(u => u.username === username)
    const byEmail = db.users.find(u => u.email === username)
    const found = byUser || byEmail
    if (found) {
      const ok = found.password_hash ? await bcrypt.compare(password, found.password_hash) : false
      if (!ok) return res.status(401).json({ message: 'invalid credentials' })
      let sid: string | null = null
      if (hasPg) {
        try {
          const { pgRunInTransaction } = require('./dbAdapter')
          const sidNew = await pgRunInTransaction(async (client: any) => {
            await client.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND revoked=false', [found.id])
            const newSid = uuid()
            const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_HOURS * 3600 * 1000).toISOString()
            const ua = String(req.headers['user-agent'] || '')
            const ip = String((req.ip || req.socket?.remoteAddress || '')).slice(0, 255)
            await client.query(
              'INSERT INTO sessions(id, user_id, created_at, last_seen_at, expires_at, revoked, ip, user_agent) VALUES($1,$2,now(),now(),$3,false,$4,$5)',
              [newSid, found.id, expiresAt, ip, ua]
            )
            return newSid
          })
          sid = String(sidNew)
        } catch {}
      }
      const payload: any = { sub: found.id, role: found.role, username: found.username || found.email }
      if (sid) payload.sid = sid
      const token = jwt.sign(payload, SECRET, { expiresIn: `${SESSION_MAX_AGE_HOURS}h` })
      return res.json({ token, role: found.role })
    }
  }
  // Fallback static users
  const u = users[username]
  if (!u || u.password !== password) return res.status(401).json({ message: 'invalid credentials' })
  const token = jwt.sign({ sub: u.id, role: u.role, username: u.username }, SECRET, { expiresIn: `${SESSION_MAX_AGE_HOURS}h` })
  res.json({ token, role: u.role })
}

export async function auth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization
  if (h && h.startsWith('Bearer ')) {
    const token = h.slice(7)
    try {
      const decoded: any = jwt.verify(token, SECRET)
      const sid = decoded?.sid
      if (sid && hasPg) {
        try {
          const rows: any = await pgSelect('sessions', '*', { id: sid })
          const s = rows && rows[0]
          if (!s) return res.status(401).json({ message: 'session not found' })
          const now = Date.now()
          const exp = new Date(s.expires_at).getTime()
          const last = new Date(s.last_seen_at || s.created_at).getTime()
          const idleMs = SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000
          if (s.revoked) return res.status(401).json({ message: 'session revoked' })
          if (exp < now) return res.status(401).json({ message: 'session expired' })
          if (now - last > idleMs) return res.status(401).json({ message: 'session idle timeout' })
          ;(req as any).user = decoded
          try { const { pgPool } = require('./dbAdapter'); if (pgPool) await pgPool.query('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [sid]) } catch {}
        } catch (e) {
          return res.status(401).json({ message: 'unauthorized' })
        }
      } else {
        ;(req as any).user = decoded
      }
    } catch {}
  }
  next()
}

export function requirePerm(code: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user
    if (!user) return res.status(401).json({ message: 'unauthorized' })
    const roleName = String(user.role || '')
    let ok = false
    try {
      const { hasPg, pgPool } = require('./dbAdapter')
      if (hasPg && pgPool) {
        let roleId = db.roles.find(r => r.name === roleName)?.id
        try {
          const r0 = await pgPool.query('SELECT id FROM roles WHERE name=$1 LIMIT 1', [roleName])
          if (r0 && r0.rows && r0.rows[0] && r0.rows[0].id) roleId = String(r0.rows[0].id)
        } catch {}
        const roleIds = Array.from(new Set([roleId, roleName, roleName.startsWith('role.') ? roleName.replace(/^role\./, '') : `role.${roleName}`].filter(Boolean)))
        const r = await pgPool.query('SELECT 1 FROM role_permissions WHERE role_id = ANY($1::text[]) AND permission_code = $2 LIMIT 1', [roleIds, code])
        ok = !!r?.rowCount
      }
    } catch {}
    if (!ok) ok = roleHasPermission(roleName, code)
    if (!ok) return res.status(403).json({ message: 'forbidden' })
    next()
  }
}

export function requireAnyPerm(codes: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user
    if (!user) return res.status(401).json({ message: 'unauthorized' })
    const roleName = String(user.role || '')
    let ok = false
    try {
      const { hasPg, pgPool } = require('./dbAdapter')
      if (hasPg && pgPool) {
        let roleId = db.roles.find(r => r.name === roleName)?.id
        try {
          const r0 = await pgPool.query('SELECT id FROM roles WHERE name=$1 LIMIT 1', [roleName])
          if (r0 && r0.rows && r0.rows[0] && r0.rows[0].id) roleId = String(r0.rows[0].id)
        } catch {}
        const roleIds = Array.from(new Set([roleId, roleName, roleName.startsWith('role.') ? roleName.replace(/^role\./, '') : `role.${roleName}`].filter(Boolean)))
        const r = await pgPool.query('SELECT 1 FROM role_permissions WHERE role_id = ANY($1::text[]) AND permission_code = ANY($2::text[]) LIMIT 1', [roleIds, codes])
        ok = !!r?.rowCount
      }
    } catch {}
    if (!ok) ok = codes.some((c) => roleHasPermission(roleName, c))
    if (!ok) return res.status(403).json({ message: 'forbidden' })
    next()
  }
}

export function allowCronTokenOrPerm(code: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const h = String(req.headers.authorization || '')
    const hasBearer = h.startsWith('Bearer ')
    const token = hasBearer ? h.slice(7) : ''
    const cron = String(process.env.JOB_CRON_TOKEN || '')
    if (cron && token && token === cron) { return next() }
    const user = (req as any).user
    if (!user) return res.status(401).json({ message: 'unauthorized' })
    const role = String(user.role || '')
    if (!roleHasPermission(role, code)) return res.status(403).json({ message: 'forbidden' })
    next()
  }
}

export function me(req: Request, res: Response) {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  res.json({ role: user.role, username: user.username })
}

export async function setDeletePassword(req: Request, res: Response) {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (user.role !== 'admin') return res.status(403).json({ message: 'forbidden' })
  const { password } = req.body || {}
  if (!password) return res.status(400).json({ message: 'missing password' })
  const hash = await bcrypt.hash(password, 10)
  try {
    if (hasPg) {
      const { Pool } = require('pg')
      const { pgUpdate } = require('./dbAdapter')
      const row = await pgUpdate('users', user.sub, { delete_password_hash: hash })
      return res.json({ ok: true })
    }
    // Supabase branch removed
    return res.status(200).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
}

export function requireResourcePerm(kind: 'view' | 'write' | 'delete') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user
    if (!user) return res.status(401).json({ message: 'unauthorized' })
    const roleName = String(user.role || '')
    const resource = String((req.params as any)?.resource || '')
    if (!resource) return res.status(400).json({ message: 'missing resource' })
    const code = `${resource}.${kind}`
    let ok = false
    const altWritePerms: Record<string, string[]> = {
      recurring_payments: ['finance.tx.write'],
      fixed_expenses: ['finance.tx.write'],
      property_expenses: ['finance.tx.write'],
      company_expenses: ['finance.tx.write'],
    }
    const pluralSingular: Record<string, string> = { orders: 'order', order: 'orders', properties: 'property', property: 'properties' }
    const legacyByResource: Record<string, Partial<Record<'view' | 'write' | 'delete', string[]>>> = {
      landlords: { view: ['landlord.manage'], write: ['landlord.manage'], delete: ['landlord.manage'] },
      finance_transactions: { view: ['finance.tx.write'], write: ['finance.tx.write'] },
      recurring_payments: { view: ['finance.tx.write'], write: ['finance.tx.write'] },
      fixed_expenses: { view: ['finance.tx.write'], write: ['finance.tx.write'] },
      property_expenses: { view: ['finance.tx.write'], write: ['finance.tx.write'] },
      company_expenses: { view: ['finance.tx.write'], write: ['finance.tx.write'] },
      properties: { view: ['property.view'], write: ['property.write'] },
      orders: { view: ['order.view'], write: ['order.write'] },
    }
    const candidates = (() => {
      const s = new Set<string>()
      s.add(code)
      const alt = pluralSingular[resource]
      if (alt) s.add(`${alt}.${kind}`)
      ;(legacyByResource[resource]?.[kind] || []).forEach((c) => s.add(c))
      return Array.from(s)
    })()
    try {
      const { hasPg, pgPool } = require('./dbAdapter')
      if (hasPg && pgPool) {
        let roleId = db.roles.find(r => r.name === roleName)?.id
        try {
          const r0 = await pgPool.query('SELECT id FROM roles WHERE name=$1 LIMIT 1', [roleName])
          if (r0 && r0.rows && r0.rows[0] && r0.rows[0].id) roleId = String(r0.rows[0].id)
        } catch {}
        const roleIds = Array.from(new Set([roleId, roleName, roleName.startsWith('role.') ? roleName.replace(/^role\./, '') : `role.${roleName}`].filter(Boolean)))
        const r = await pgPool.query(
          'SELECT 1 FROM role_permissions WHERE role_id = ANY($1::text[]) AND permission_code = ANY($2::text[]) LIMIT 1',
          [roleIds, candidates]
        )
        ok = !!r?.rowCount
      }
    } catch {}
    if (!ok) {
      ok = candidates.some((c) => roleHasPermission(roleName, c))
      if (!ok && kind === 'write') {
        const alts = altWritePerms[resource] || []
        for (const c of alts) { if (roleHasPermission(roleName, c)) { ok = true; break } }
      }
    }
    if (!ok) return res.status(403).json({ message: 'forbidden' })
    next()
  }
}
