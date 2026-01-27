import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import { v4 as uuidv4 } from 'uuid'
import { hasPg, pgPool, pgSelect, pgInsert, pgUpdate } from '../dbAdapter'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { addAudit } from '../store'

const SECRET = process.env.JWT_SECRET || 'dev-secret'
const DEFAULT_PUBLIC_CLEANING_PASSWORD = process.env.PUBLIC_CLEANING_PASSWORD || 'mz-cleaning'

export const router = Router()
const upload = multer({ storage: multer.memoryStorage() })

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

async function ensureRepairOrdersTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS repair_orders (
    id text PRIMARY KEY,
    property_id text REFERENCES properties(id) ON DELETE SET NULL,
    category text,
    category_detail text,
    detail text,
    attachment_urls jsonb,
    submitter_id text,
    submitter_name text,
    submitted_at timestamptz DEFAULT now(),
    urgency text,
    status text,
    assignee_id text,
    eta date,
    completed_at timestamptz,
    remark text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_repair_orders_property ON repair_orders(property_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_repair_orders_status ON repair_orders(status);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_repair_orders_urgency ON repair_orders(urgency);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_repair_orders_submitted ON repair_orders(submitted_at);')
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

router.post('/repair/upload', upload.single('file'), async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyPublicToken(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (!hasR2 || !(req.file as any).buffer) {
      return res.status(500).json({ message: 'R2 not configured' })
    }
    const ext = path.extname(req.file.originalname) || ''
    const key = `repairs/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.get('/properties', async (_req, res) => {
  try {
    if (hasPg) {
      const rows = await pgSelect('properties', 'id,code,address') as any[]
      return res.json(Array.isArray(rows) ? rows : [])
    }
    const { db } = require('../store')
    return res.json((db.properties || []).map((p: any) => ({ id: p.id, code: p.code, address: p.address })))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list failed' })
  }
})

router.post('/repair/report', async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyPublicToken(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  const body = req.body || {}
  const property_id = String(body.property_id || '').trim()
  const category = String(body.category || '').trim()
  const detail = String(body.detail || '').trim()
  const attachments = Array.isArray(body.attachment_urls) ? body.attachment_urls : (body.attachment_urls ? [body.attachment_urls] : [])
  const submitter_name = String(body.submitter_name || '').trim()
  const submitter_id = String(body.submitter_id || '').trim()
  const urgency = body.urgency ? String(body.urgency) : ''
  if (!property_id) return res.status(400).json({ message: 'missing property_id' })
  if (!category) return res.status(400).json({ message: 'missing category' })
  if (!detail) return res.status(400).json({ message: 'missing detail' })
  if (!submitter_name) return res.status(400).json({ message: 'missing submitter_name' })
  try {
    if (hasPg) {
      // ensure property_maintenance columns exist
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS work_no text;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category text;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS status text;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS urgency text;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS assignee_id text;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS eta date;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS completed_at timestamptz;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitted_at timestamptz;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_notes text;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;`)
      const id = uuidv4()
      const workNo = `R-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.random().toString(36).slice(2,6).toUpperCase()}`
      const sql = `INSERT INTO property_maintenance (id, property_id, occurred_at, worker_name, details, notes, created_by, photo_urls, property_code, work_no, category, status, urgency, assignee_id, eta, submitted_at)
        VALUES ($1,$2,$3,$4,$5::text,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`
      const values = [
        id,
        property_id || null,
        new Date().toISOString().slice(0,10),
        '',
        detail ? JSON.stringify([{ content: detail }]) : JSON.stringify([]),
        '',
        submitter_id || null,
        JSON.stringify(attachments || []),
        null,
        workNo,
        category || null,
        'pending',
        (urgency || null),
        null,
        null,
        new Date().toISOString()
      ]
      const r = await pgPool!.query(sql, values)
      const row = r.rows && r.rows[0]
      addAudit('property_maintenance', id, 'create', null, row)
      try {
        const { broadcastCleaningEvent } = require('./events')
        broadcastCleaningEvent({ type: 'repair-order-created', id, property_id })
      } catch {}
      return res.status(201).json(row)
    }
    const id = uuidv4()
    const row = {
      id, property_id, category, status: 'pending',
      details: JSON.stringify([{ content: detail }]),
      photo_urls: attachments,
      created_by: submitter_id || null,
      submitted_at: new Date().toISOString(),
      work_no: `R-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.random().toString(36).slice(2,6).toUpperCase()}`
    }
    ;(require('../store').db as any).propertyMaintenance = ((require('../store').db as any).propertyMaintenance || [])
    ;(require('../store').db as any).propertyMaintenance.push(row)
    addAudit('property_maintenance', id, 'create', null, row)
    return res.status(201).json(row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'report failed' })
  }
})

export default router
