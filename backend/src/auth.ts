import jwt from 'jsonwebtoken'
import { Request, Response, NextFunction } from 'express'
import { roleHasPermission, db } from './store'
import { hasPg, pgSelect } from './dbAdapter'
import { hasSupabase, supaSelect } from './supabase'
import bcrypt from 'bcryptjs'

const SECRET = process.env.JWT_SECRET || 'dev-secret'

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
    const token = jwt.sign({ sub: row.id, role: row.role, username: row.username }, SECRET, { expiresIn: '7d' })
    return res.json({ token, role: row.role })
  }
  if (!row && db.users.length) {
    const byUser = db.users.find(u => u.username === username)
    const byEmail = db.users.find(u => u.email === username)
    const found = byUser || byEmail
    if (found) {
      const ok = found.password_hash ? await bcrypt.compare(password, found.password_hash) : false
      if (!ok) return res.status(401).json({ message: 'invalid credentials' })
      const token = jwt.sign({ sub: found.id, role: found.role, username: found.username || found.email }, SECRET, { expiresIn: '7d' })
      return res.json({ token, role: found.role })
    }
  }
  // Fallback static users
  const u = users[username]
  if (!u || u.password !== password) return res.status(401).json({ message: 'invalid credentials' })
  const token = jwt.sign({ sub: u.id, role: u.role, username: u.username }, SECRET, { expiresIn: '7d' })
  res.json({ token, role: u.role })
}

export function auth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization
  if (h && h.startsWith('Bearer ')) {
    const token = h.slice(7)
    try {
      ;(req as any).user = jwt.verify(token, SECRET)
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