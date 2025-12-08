import jwt from 'jsonwebtoken'
import { Request, Response, NextFunction } from 'express'
import { v4 as uuid } from 'uuid'
import { roleHasPermission, db } from './store'
import { hasPg, pgSelect, pgRunInTransaction, pgPool } from './dbAdapter'
import { hasSupabase, supaSelect } from './supabase'
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
  // DB first（优先 Supabase，其次 Postgres；分别容错）
  let row: any = null
  if (hasSupabase) {
    try {
      const byUser: any = await supaSelect('users', '*', { username })
      row = byUser && byUser[0]
      if (!row) {
        const byEmail: any = await supaSelect('users', '*', { email: username })
        row = byEmail && byEmail[0]
      }
    } catch {}
  }
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
    const ok = await bcrypt.compare(password, row.password_hash)
    if (!ok) return res.status(401).json({ message: 'invalid credentials' })
    let sid: string | null = null
    if (hasPg) {
      try {
        sid = await pgRunInTransaction<string>(async (client: any) => {
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
          sid = await pgRunInTransaction<string>(async (client: any) => {
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
          try { if (pgPool) await pgPool.query('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [sid]) } catch {}
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
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user
    if (!user) return res.status(401).json({ message: 'unauthorized' })
    const role = user.role as string
    if (!roleHasPermission(role, code)) return res.status(403).json({ message: 'forbidden' })
    next()
  }
}

export function requireAnyPerm(codes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user
    if (!user) return res.status(401).json({ message: 'unauthorized' })
    const role = user.role as string
    const ok = codes.some((c) => roleHasPermission(role, c))
    if (!ok) return res.status(403).json({ message: 'forbidden' })
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
    if (hasSupabase) {
      const { supaUpdate } = require('./supabase')
      await supaUpdate('users', user.sub, { delete_password_hash: hash })
      return res.json({ ok: true })
    }
    return res.status(200).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
}

export function requireResourcePerm(kind: 'view' | 'write' | 'delete') {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user
    if (!user) return res.status(401).json({ message: 'unauthorized' })
    const role = String(user.role || '')
    const resource = String((req.params as any)?.resource || '')
    if (!resource) return res.status(400).json({ message: 'missing resource' })
    const code = `${resource}.${kind}`
    const ok = roleHasPermission(role, code)
    if (!ok) return res.status(403).json({ message: 'forbidden' })
    next()
  }
}