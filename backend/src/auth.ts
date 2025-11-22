import jwt from 'jsonwebtoken'
import { Request, Response, NextFunction } from 'express'
import { roleHasPermission } from './store'
import { hasPg, pgSelect } from './dbAdapter'
import { hasSupabase, supaSelect } from './supabase'
import bcrypt from 'bcryptjs'

const SECRET = process.env.JWT_SECRET || 'dev-secret'

type User = { id: string; username: string; role: 'admin'|'ops'|'field' }

export const users: Record<string, User & { password: string }> = {
  admin: { id: 'u-admin', username: 'admin', role: 'admin', password: process.env.ADMIN_PASSWORD || 'admin' },
  ops: { id: 'u-ops', username: 'ops', role: 'ops', password: process.env.OPS_PASSWORD || 'ops' },
  field: { id: 'u-field', username: 'field', role: 'field', password: process.env.FIELD_PASSWORD || 'field' },
}

export async function login(req: Request, res: Response) {
  const { username, password } = req.body || {}
  if (!username || !password) return res.status(400).json({ message: 'missing credentials' })
  // DB first
  try {
    let row: any = null
    if (hasPg) {
      const byUser = await pgSelect('users', '*', { username })
      row = byUser && byUser[0]
      if (!row) {
        const byEmail = await pgSelect('users', '*', { email: username })
        row = byEmail && byEmail[0]
      }
    }
    if (!row && hasSupabase) {
      const byUser: any = await supaSelect('users', '*', { username })
      row = byUser && byUser[0]
      if (!row) {
        const byEmail: any = await supaSelect('users', '*', { email: username })
        row = byEmail && byEmail[0]
      }
    }
    if (row) {
      const ok = await bcrypt.compare(password, row.password_hash)
      if (!ok) return res.status(401).json({ message: 'invalid credentials' })
      const token = jwt.sign({ sub: row.id, role: row.role, username: row.username }, SECRET, { expiresIn: '7d' })
      return res.json({ token, role: row.role })
    }
  } catch (e: any) {
    // fall through to static
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