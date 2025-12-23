import { Router } from 'express'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { hasPg, pgPool, pgSelect, pgInsert, pgUpdate } from '../dbAdapter'

const SECRET = process.env.JWT_SECRET || 'dev-secret'
const DEFAULT_PUBLIC_CLEANING_PASSWORD = process.env.PUBLIC_CLEANING_PASSWORD || 'mz-cleaning'

export const router = Router()

async function ensurePublicAccessTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS public_access (
    area text PRIMARY KEY,
    password_hash text NOT NULL,
    password_updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz DEFAULT now()
  );`)
}

async function ensureCmsPagesTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS cms_pages (
    id text PRIMARY KEY,
    slug text UNIQUE,
    title text,
    content text,
    status text,
    published_at date,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz
  );`)
}

async function getOrInitCleaningAccess(): Promise<{ area: string; password_hash: string; password_updated_at: string } | null> {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'cleaning' }) as any[]
      const existing = rows && rows[0]
      if (existing) return existing
      const hash = await bcrypt.hash(DEFAULT_PUBLIC_CLEANING_PASSWORD, 10)
      const row = await pgInsert('public_access', { area: 'cleaning', password_hash: hash })
      return row as any
    }
  } catch {}
  return null
}

function verifyPublicToken(token: string): { ok: boolean; iat?: number } {
  try {
    const decoded: any = jwt.verify(token, SECRET)
    if (decoded && decoded.scope === 'public_cleaning') {
      return { ok: true, iat: Number(decoded.iat || 0) }
    }
  } catch {}
  return { ok: false }
}

router.post('/cleaning-guide/login', async (req, res) => {
  const { password } = req.body || {}
  if (!password) return res.status(400).json({ message: 'missing password' })
  try {
    const access = await getOrInitCleaningAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const ok = await bcrypt.compare(password, access.password_hash)
    if (!ok) return res.status(401).json({ message: 'invalid password' })
    const token = jwt.sign({ scope: 'public_cleaning' }, SECRET, { expiresIn: '12h' })
    return res.json({ token })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'login failed' })
  }
})

router.get('/cleaning-guide', async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyPublicToken(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  try {
    const access = await getOrInitCleaningAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    const property_code = String((req.query || {}).property_code || '').trim()
    if (hasPg) {
      await ensureCmsPagesTable()
      const { pgPool } = require('../dbAdapter')
      if (pgPool) {
        const like = 'cleaning:%'
        const r = await pgPool.query(`SELECT id, slug, title, content, status, published_at FROM cms_pages WHERE status='published' AND slug LIKE $1`, [like])
        const rows: any[] = r.rows || []
        const general = rows.filter(x => String(x.slug || '').toLowerCase() === 'cleaning:general')
        const filteredProp = property_code ? rows.filter(x => String(x.slug || '').toLowerCase() === `cleaning:${property_code.toLowerCase()}`) : []
        return res.json([...general, ...filteredProp])
      }
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list failed' })
  }
})

router.get('/cleaning-guide/:id', async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyPublicToken(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  try {
    const access = await getOrInitCleaningAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    const { id } = req.params
    if (hasPg) {
      await ensureCmsPagesTable()
      const rows = await pgSelect('cms_pages', 'id,slug,title,content,status,published_at', { id }) as any[]
      const row = rows && rows[0]
      if (!row || String(row.status || '') !== 'published') return res.status(404).json({ message: 'not found' })
      return res.json(row)
    }
    return res.status(404).json({ message: 'not found' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'get failed' })
  }
})

export default router