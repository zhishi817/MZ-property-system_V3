import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { hasR2, r2GetObjectByKey, r2KeyFromUrl, r2Upload } from '../r2'
import { v4 as uuidv4 } from 'uuid'
import { hasPg, pgPool, pgSelect, pgInsert, pgUpdate } from '../dbAdapter'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { addAudit } from '../store'
import crypto from 'crypto'

const SECRET = process.env.JWT_SECRET || 'dev-secret'
const DEFAULT_PUBLIC_CLEANING_PASSWORD = process.env.PUBLIC_CLEANING_PASSWORD || 'mz-cleaning'
const DEFAULT_PUBLIC_MAINTENANCE_SHARE_PASSWORD = process.env.MAINTENANCE_SHARE_PASSWORD || 'mz-maintenance'
const DEFAULT_PUBLIC_DEEP_CLEANING_SHARE_PASSWORD = process.env.DEEP_CLEANING_SHARE_PASSWORD || 'mz-deep-cleaning'
const DEFAULT_PUBLIC_DEEP_CLEANING_UPLOAD_PASSWORD = process.env.DEEP_CLEANING_UPLOAD_PASSWORD || 'mz-deep-cleaning-upload'
const DEFAULT_PUBLIC_COMPANY_EXPENSE_PASSWORD = process.env.COMPANY_EXPENSE_PUBLIC_PASSWORD || '1234'
const DEFAULT_PUBLIC_PROPERTY_EXPENSE_PASSWORD = process.env.PROPERTY_EXPENSE_PUBLIC_PASSWORD || '1234'
const DEFAULT_PUBLIC_PROPERTY_GUIDE_PASSWORD = process.env.PROPERTY_GUIDE_PUBLIC_PASSWORD || '1234'

export const router = Router()
const upload = multer({ storage: multer.memoryStorage() })

router.get('/r2-image', async (req, res) => {
  try {
    const u = String((req.query as any)?.url || (req.query as any)?.u || '').trim()
    if (!u) return res.status(400).json({ message: 'missing_url' })
    if (!hasR2) return res.status(404).json({ message: 'r2_not_configured' })
    const key = r2KeyFromUrl(u)
    if (!key) return res.status(400).json({ message: 'invalid_r2_url' })
    if (!key.startsWith('invoice-company-logos/')) return res.status(403).json({ message: 'forbidden_key' })
    const obj = await r2GetObjectByKey(key)
    if (!obj || !obj.body?.length) return res.status(404).json({ message: 'not_found' })
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.setHeader('Content-Type', obj.contentType || 'application/octet-stream')
    res.setHeader('Cache-Control', obj.cacheControl || 'public, max-age=86400, stale-while-revalidate=604800')
    if (obj.etag) res.setHeader('ETag', obj.etag)
    return res.status(200).send(obj.body)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'proxy_failed' })
  }
})

function randomSuffix(len: number): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let s = ''
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

function randomToken(bytes = 24) {
  const b64 = crypto.randomBytes(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function generateWorkNo(): Promise<string> {
  const date = new Date().toISOString().slice(0,10).replace(/-/g,'')
  const prefix = `R-${date}-`
  const pool = pgPool
  let len = 4
  for (;;) {
    const candidate = prefix + randomSuffix(len)
    try {
      if (hasPg && pool) {
        const r = await pool.query('SELECT 1 FROM property_maintenance WHERE work_no = $1 LIMIT 1', [candidate])
        if (!r.rowCount) return candidate
      } else {
        return candidate
      }
    } catch {
      return candidate
    }
    len += 1
    if (len > 10) return candidate
  }
}

async function generateDeepCleaningWorkNo(): Promise<string> {
  const date = new Date().toISOString().slice(0,10).replace(/-/g,'')
  const prefix = `DC-${date}-`
  const pool = pgPool
  let len = 4
  for (;;) {
    const candidate = prefix + randomSuffix(len)
    try {
      if (hasPg && pool) {
        const r = await pool.query('SELECT 1 FROM property_deep_cleaning WHERE work_no = $1 LIMIT 1', [candidate])
        if (!r.rowCount) return candidate
      } else {
        return candidate
      }
    } catch {
      return candidate
    }
    len += 1
    if (len > 10) return candidate
  }
}
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

async function getOrInitMaintenanceShareAccess(): Promise<{ area: string; password_hash: string; password_updated_at: string } | null> {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'maintenance_share' }) as any[]
      const existing = rows && rows[0]
      if (existing) return existing
      const hash = await bcrypt.hash(DEFAULT_PUBLIC_MAINTENANCE_SHARE_PASSWORD, 10)
      const row = await pgInsert('public_access', { area: 'maintenance_share', password_hash: hash })
      return row as any
    }
  } catch {}
  return null
}

async function getOrInitDeepCleaningShareAccess(): Promise<{ area: string; password_hash: string; password_updated_at: string } | null> {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'deep_cleaning_share' }) as any[]
      const existing = rows && rows[0]
      if (existing) return existing
      const hash = await bcrypt.hash(DEFAULT_PUBLIC_DEEP_CLEANING_SHARE_PASSWORD, 10)
      const row = await pgInsert('public_access', { area: 'deep_cleaning_share', password_hash: hash })
      return row as any
    }
  } catch {}
  return null
}

async function getOrInitDeepCleaningUploadAccess(): Promise<{ area: string; password_hash: string; password_updated_at: string } | null> {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'deep_cleaning_upload' }) as any[]
      const existing = rows && rows[0]
      if (existing) return existing
      const hash = await bcrypt.hash(DEFAULT_PUBLIC_DEEP_CLEANING_UPLOAD_PASSWORD, 10)
      const row = await pgInsert('public_access', { area: 'deep_cleaning_upload', password_hash: hash })
      return row as any
    }
  } catch {}
  return null
}

async function getOrInitCompanyExpenseAccess(): Promise<{ area: string; password_hash: string; password_updated_at: string } | null> {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'company_expense' }) as any[]
      const existing = rows && rows[0]
      if (existing) return existing
      const hash = await bcrypt.hash(DEFAULT_PUBLIC_COMPANY_EXPENSE_PASSWORD, 10)
      const row = await pgInsert('public_access', { area: 'company_expense', password_hash: hash })
      return row as any
    }
  } catch {}
  return null
}

async function getOrInitPropertyExpenseAccess(): Promise<{ area: string; password_hash: string; password_updated_at: string } | null> {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'property_expense' }) as any[]
      const existing = rows && rows[0]
      if (existing) return existing
      const hash = await bcrypt.hash(DEFAULT_PUBLIC_PROPERTY_EXPENSE_PASSWORD, 10)
      const row = await pgInsert('public_access', { area: 'property_expense', password_hash: hash })
      return row as any
    }
  } catch {}
  return null
}

async function getOrInitPropertyGuideAccess(): Promise<{ area: string; password_hash: string; password_updated_at: string } | null> {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'property_guide' }) as any[]
      const existing = rows && rows[0]
      if (existing) return existing
      const hash = await bcrypt.hash(DEFAULT_PUBLIC_PROPERTY_GUIDE_PASSWORD, 10)
      const row = await pgInsert('public_access', { area: 'property_guide', password_hash: hash })
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

function sha256Hex(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function readCookie(req: any, name: string): string | null {
  try {
    const h = String(req.headers?.cookie || '')
    if (!h) return null
    const parts = h.split(';').map((s) => s.trim())
    for (const p of parts) {
      if (!p) continue
      const idx = p.indexOf('=')
      if (idx < 0) continue
      const k = p.slice(0, idx).trim()
      if (k !== name) continue
      return decodeURIComponent(p.slice(idx + 1))
    }
    return null
  } catch {
    return null
  }
}

function verifyMaintenanceShareJwt(token: string): { ok: boolean; iat?: number; maintenance_id?: string; token_hash?: string } {
  try {
    const decoded: any = jwt.verify(token, SECRET)
    if (decoded && decoded.scope === 'maintenance_share' && decoded.maintenance_id && decoded.token_hash) {
      return { ok: true, iat: Number(decoded.iat || 0), maintenance_id: String(decoded.maintenance_id), token_hash: String(decoded.token_hash) }
    }
  } catch {}
  return { ok: false }
}

function verifyDeepCleaningShareJwt(token: string): { ok: boolean; iat?: number; deep_cleaning_id?: string; token_hash?: string } {
  try {
    const decoded: any = jwt.verify(token, SECRET)
    if (decoded && decoded.scope === 'deep_cleaning_share' && decoded.deep_cleaning_id && decoded.token_hash) {
      return { ok: true, iat: Number(decoded.iat || 0), deep_cleaning_id: String(decoded.deep_cleaning_id), token_hash: String(decoded.token_hash) }
    }
  } catch {}
  return { ok: false }
}

function verifyDeepCleaningUploadJwt(token: string): { ok: boolean; iat?: number } {
  try {
    const decoded: any = jwt.verify(token, SECRET)
    if (decoded && decoded.scope === 'deep_cleaning_upload') {
      return { ok: true, iat: Number(decoded.iat || 0) }
    }
  } catch {}
  return { ok: false }
}

function verifyMaintenanceProgressJwt(token: string): { ok: boolean; iat?: number } {
  try {
    const decoded: any = jwt.verify(token, SECRET)
    if (decoded && decoded.scope === 'maintenance_progress') {
      return { ok: true, iat: Number(decoded.iat || 0) }
    }
  } catch {}
  return { ok: false }
}

function verifyCompanyExpenseJwt(token: string): { ok: boolean; iat?: number } {
  try {
    const decoded: any = jwt.verify(token, SECRET)
    if (decoded && decoded.scope === 'company_expense') {
      return { ok: true, iat: Number(decoded.iat || 0) }
    }
  } catch {}
  return { ok: false }
}

function verifyPropertyExpenseJwt(token: string): { ok: boolean; iat?: number } {
  try {
    const decoded: any = jwt.verify(token, SECRET)
    if (decoded && decoded.scope === 'property_expense') {
      return { ok: true, iat: Number(decoded.iat || 0) }
    }
  } catch {}
  return { ok: false }
}

async function ensureExpenseInvoicesTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_invoices (
    id text PRIMARY KEY,
    expense_id text REFERENCES property_expenses(id) ON DELETE CASCADE,
    url text NOT NULL,
    file_name text,
    mime_type text,
    file_size integer,
    created_at timestamptz DEFAULT now(),
    created_by text
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_invoices_expense ON expense_invoices(expense_id);')
}

function safeDateToIso(v: any): string | null {
  try {
    if (!v) return null
    const d = new Date(String(v))
    if (Number.isNaN(d.getTime())) return null
    return d.toISOString()
  } catch { return null }
}

async function ensureMaintenanceShareLinksTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS maintenance_share_links (
    token_hash text PRIMARY KEY,
    maintenance_id text NOT NULL REFERENCES property_maintenance(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_maintenance_share_mid ON maintenance_share_links(maintenance_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_maintenance_share_expires ON maintenance_share_links(expires_at);')
}

async function ensureDeepCleaningShareLinksTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS deep_cleaning_share_links (
    token_hash text PRIMARY KEY,
    deep_cleaning_id text NOT NULL REFERENCES property_deep_cleaning(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_deep_cleaning_share_mid ON deep_cleaning_share_links(deep_cleaning_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_deep_cleaning_share_expires ON deep_cleaning_share_links(expires_at);')
}

async function ensurePropertyGuidePublicLinksTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_guides (
    id text PRIMARY KEY,
    property_id text NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    language text NOT NULL,
    version text NOT NULL,
    status text NOT NULL,
    content_json jsonb,
    created_by text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz,
    published_at timestamptz
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guides_property_id ON property_guides(property_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guides_lang ON property_guides(property_id, language);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guides_status ON property_guides(status);')
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_guide_public_links (
    token_hash text PRIMARY KEY,
    guide_id text NOT NULL REFERENCES property_guides(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guide_links_guide_id ON property_guide_public_links(guide_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guide_links_expires_at ON property_guide_public_links(expires_at);')
}

async function ensurePropertyGuidePublicSessionsTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_guide_public_sessions (
    session_id_hash text PRIMARY KEY,
    token_hash text NOT NULL REFERENCES property_guide_public_links(token_hash) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guide_sessions_token_hash ON property_guide_public_sessions(token_hash);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guide_sessions_expires_at ON property_guide_public_sessions(expires_at);')
}

async function ensurePropertyMaintenanceShareColumns() {
  if (!pgPool) return
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS work_no text;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category text;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS status text;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS urgency text;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS assignee_id text;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS eta date;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS completed_at timestamptz;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitted_at timestamptz;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_notes text;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS maintenance_amount numeric;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS has_parts boolean;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS parts_amount numeric;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS pay_method text;`)
  await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS pay_other_note text;`)
}

async function ensurePropertyDeepCleaningShareColumns() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_deep_cleaning (
    id text PRIMARY KEY,
    property_id text REFERENCES properties(id) ON DELETE SET NULL,
    occurred_at date NOT NULL,
    worker_name text,
    project_desc text,
    started_at timestamptz,
    ended_at timestamptz,
    duration_minutes integer,
    details text,
    notes text,
    created_by text,
    photo_urls jsonb,
    property_code text,
    work_no text,
    category text,
    status text,
    urgency text,
    submitted_at timestamptz,
    submitter_name text,
    assignee_id text,
    eta date,
    completed_at timestamptz,
    repair_notes text,
    repair_photo_urls jsonb,
    attachment_urls jsonb,
    checklist jsonb,
    consumables jsonb,
    labor_minutes integer,
    labor_cost numeric,
    review_status text,
    reviewed_by text,
    reviewed_at timestamptz,
    review_notes text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz
  );`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS project_desc text;`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS started_at timestamptz;`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS ended_at timestamptz;`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS duration_minutes integer;`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS photo_urls jsonb;`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS attachment_urls jsonb;`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS checklist jsonb;`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS consumables jsonb;`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS review_status text;`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS reviewed_by text;`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;`)
  await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS review_notes text;`)
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
  const item_type = String(body.item_type || '').trim() || 'other'
  const labelPhotos = Array.isArray(body.label_photo_urls) ? body.label_photo_urls : (body.label_photo_urls ? [body.label_photo_urls] : [])
  const submitter_name = String(body.submitter_name || '').trim()
  const submitter_id = String(body.submitter_id || '').trim()
  const urgency = body.urgency ? String(body.urgency) : ''
  if (!property_id) return res.status(400).json({ message: 'missing property_id' })
  if (!category) return res.status(400).json({ message: 'missing category' })
  if (!detail) return res.status(400).json({ message: 'missing detail' })
  if (!submitter_name) return res.status(400).json({ message: 'missing submitter_name' })
  if (item_type === 'appliance' && (!labelPhotos || labelPhotos.length === 0)) return res.status(400).json({ message: 'appliance requires label photos' })
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
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitter_name text;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_notes text;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS item_type text;`)
      await pgPool!.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS label_photo_urls jsonb;`)
      const id = uuidv4()
      const workNo = await generateWorkNo()
      const sql = `INSERT INTO property_maintenance (id, property_id, occurred_at, worker_name, details, notes, created_by, photo_urls, label_photo_urls, item_type, property_code, work_no, category, status, urgency, assignee_id, eta, submitted_at, submitter_name)
        VALUES ($1,$2,$3,$4,$5::text,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`
      const values = [
        id,
        property_id || null,
        new Date().toISOString().slice(0,10),
        '',
        detail ? JSON.stringify([{ content: detail }]) : JSON.stringify([]),
        '',
        submitter_id || null,
        JSON.stringify(attachments || []),
        JSON.stringify(labelPhotos || []),
        item_type || null,
        null,
        workNo,
        category || null,
        'pending',
        (urgency || null),
        null,
        null,
        new Date().toISOString(),
        submitter_name || null
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
      label_photo_urls: labelPhotos,
      item_type,
      created_by: submitter_id || null,
      submitted_at: new Date().toISOString(),
      submitter_name: submitter_name || null,
      work_no: `R-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${randomSuffix(4)}`
    }
    ;(require('../store').db as any).propertyMaintenance = ((require('../store').db as any).propertyMaintenance || [])
    ;(require('../store').db as any).propertyMaintenance.push(row)
    addAudit('property_maintenance', id, 'create', null, row)
    return res.status(201).json(row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'report failed' })
  }
})

router.get('/maintenance-share/:token', async (req, res) => {
  const token = String((req.params as any)?.token || '').trim()
  if (!token) return res.status(400).json({ message: 'missing token' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureMaintenanceShareLinksTable()
    const tokenHash = sha256Hex(token)
    const r = await pgPool.query(
      'SELECT maintenance_id FROM maintenance_share_links WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1',
      [tokenHash]
    )
    const maintenanceId = String(r.rows?.[0]?.maintenance_id || '')
    if (!maintenanceId) return res.status(404).json({ message: 'not found' })
    await ensurePropertyMaintenanceShareColumns()
    const rows = await pgSelect('property_maintenance', '*', { id: maintenanceId }) as any[]
    const row = rows && rows[0]
    if (!row) return res.status(404).json({ message: 'not found' })
    let propCode = ''
    try {
      const pid = String(row?.property_id || '').trim()
      if (pid) {
        const pr = await pgPool.query('SELECT code FROM properties WHERE id=$1 LIMIT 1', [pid])
        propCode = String(pr.rows?.[0]?.code || '').trim()
      }
    } catch {}
    const code = propCode || String(row?.property_code || '').trim()
    return res.json({ ...row, property_code: code || row?.property_code, code: code || row?.code })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'get failed' })
  }
})

router.post('/maintenance-share/login', async (req, res) => {
  const body = req.body || {}
  const tk = String(body.token || '').trim()
  const pwd = String(body.password || '').trim()
  if (!tk) return res.status(400).json({ message: 'missing token' })
  if (!pwd) return res.status(400).json({ message: 'missing password' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitMaintenanceShareAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const ok = await bcrypt.compare(pwd, access.password_hash)
    if (!ok) return res.status(401).json({ message: 'invalid password' })
    await ensureMaintenanceShareLinksTable()
    const tokenHash = sha256Hex(tk)
    const r = await pgPool.query(
      'SELECT maintenance_id FROM maintenance_share_links WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1',
      [tokenHash]
    )
    const maintenanceId = String(r.rows?.[0]?.maintenance_id || '')
    if (!maintenanceId) return res.status(404).json({ message: 'not found' })
    await ensurePropertyMaintenanceShareColumns()
    const rows = await pgSelect('property_maintenance', '*', { id: maintenanceId }) as any[]
    const row = rows && rows[0]
    if (!row) return res.status(404).json({ message: 'not found' })
    let propCode = ''
    try {
      const pid = String(row?.property_id || '').trim()
      if (pid) {
        const pr = await pgPool.query('SELECT code FROM properties WHERE id=$1 LIMIT 1', [pid])
        propCode = String(pr.rows?.[0]?.code || '').trim()
      }
    } catch {}
    const code = propCode || String(row?.property_code || '').trim()
    const shareToken = jwt.sign({ scope: 'maintenance_share', maintenance_id: maintenanceId, token_hash: tokenHash }, SECRET, { expiresIn: '6h' })
    const maintenance = { ...row, property_code: code || row?.property_code, code: code || row?.code }
    return res.json({ token: shareToken, maintenance })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'login failed' })
  }
})

router.post('/maintenance-progress/login', async (req, res) => {
  const { password } = req.body || {}
  const pwd = String(password || '').trim()
  if (!pwd) return res.status(400).json({ message: 'missing password' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitMaintenanceShareAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const ok = await bcrypt.compare(pwd, access.password_hash)
    if (!ok) return res.status(401).json({ message: 'invalid password' })
    const token = jwt.sign({ scope: 'maintenance_progress' }, SECRET, { expiresIn: '12h' })
    return res.json({ token })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'login failed' })
  }
})

router.post('/maintenance-progress/upload', upload.single('file'), async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyMaintenanceProgressJwt(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    const access = await getOrInitMaintenanceShareAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    if (!hasR2 || !(req.file as any).buffer) {
      return res.status(500).json({ message: 'R2 not configured' })
    }
    const ext = path.extname(req.file.originalname) || ''
    const key = `maintenance-progress/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.post('/maintenance-progress/submit', async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyMaintenanceProgressJwt(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  const body = req.body || {}
  const property_id = String(body.property_id || '').trim()
  const occurred_at = String(body.occurred_at || '').trim() || new Date().toISOString().slice(0, 10)
  const worker_name = String(body.worker_name || '').trim()
  const notes = String(body.notes || '').trim()
  const detailsArr = Array.isArray(body.details) ? body.details : []
  if (!property_id) return res.status(400).json({ message: 'missing property_id' })
  if (!worker_name) return res.status(400).json({ message: 'missing worker_name' })
  if (!detailsArr.length) return res.status(400).json({ message: 'missing details' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitMaintenanceShareAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    await ensurePropertyMaintenanceShareColumns()
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls jsonb;`)
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS notes text;`)
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS worker_name text;`)
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS occurred_at date;`)
    const nowIso = new Date().toISOString()
    const sql = `INSERT INTO property_maintenance (
      id, property_id, occurred_at, worker_name, details, notes, created_by,
      photo_urls, repair_photo_urls, property_code, work_no, category, status, urgency,
      submitted_at, submitter_name, completed_at, maintenance_amount, has_parts, parts_amount, pay_method, pay_other_note
    )
    VALUES (
      $1,$2,$3,$4,$5::text,$6,$7,
      $8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,
      $15,$16,$17,$18,$19,$20,$21,$22
    ) RETURNING id`
    let created = 0
    for (const d of detailsArr) {
      const category = String(d?.category || d?.content || '').trim()
      const item = String(d?.item || '').trim()
      if (!category) continue
      const id = uuidv4()
      const workNo = await generateWorkNo()
      const detailText = item ? JSON.stringify([{ content: item }]) : JSON.stringify([])
      const prePhotos = Array.isArray(d?.pre_photo_urls) ? d.pre_photo_urls : (d?.pre_photo_urls ? [d.pre_photo_urls] : [])
      const postPhotos = Array.isArray(d?.post_photo_urls) ? d.post_photo_urls : (d?.post_photo_urls ? [d.post_photo_urls] : [])
      const maintenance_amount = d?.maintenance_amount !== undefined ? Number(d.maintenance_amount || 0) : null
      const has_parts = d?.has_parts !== undefined ? (d.has_parts === true) : null
      const parts_amount = d?.parts_amount !== undefined ? Number(d.parts_amount || 0) : null
      const pay_method = d?.pay_method ? String(d.pay_method) : null
      const pay_other_note = d?.pay_other_note ? String(d.pay_other_note) : null
      const values = [
        id,
        property_id || null,
        occurred_at || new Date().toISOString().slice(0, 10),
        worker_name || '',
        detailText,
        notes || '',
        null,
        JSON.stringify(prePhotos || []),
        JSON.stringify(postPhotos || []),
        null,
        workNo,
        category || null,
        'completed',
        null,
        nowIso,
        worker_name,
        nowIso,
        maintenance_amount,
        has_parts,
        parts_amount,
        pay_method,
        pay_other_note
      ]
      const r = await pgPool.query(sql, values)
      if (r.rowCount) created += 1
      addAudit('property_maintenance', id, 'create', null, { id })
    }
    return res.status(201).json({ ok: true, created })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'submit failed' })
  }
})

router.post('/company-expense/login', async (req, res) => {
  const { password } = req.body || {}
  const pwd = String(password || '').trim()
  if (!pwd) return res.status(400).json({ message: 'missing password' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitCompanyExpenseAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const ok = await bcrypt.compare(pwd, access.password_hash)
    if (!ok) return res.status(401).json({ message: 'invalid password' })
    const token = jwt.sign({ scope: 'company_expense' }, SECRET, { expiresIn: '12h' })
    return res.json({ token })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'login failed' })
  }
})

router.post('/company-expense/upload', upload.single('file'), async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyCompanyExpenseJwt(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    const access = await getOrInitCompanyExpenseAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    if (!hasR2 || !(req.file as any).buffer) {
      return res.status(500).json({ message: 'R2 not configured' })
    }
    const ext = path.extname(req.file.originalname) || ''
    const key = `company-expenses/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.post('/company-expense/submit', async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyCompanyExpenseJwt(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  const body = req.body || {}
  const occurred_at = String(body.occurred_at || '').trim() || new Date().toISOString().slice(0, 10)
  const category = String(body.category || '').trim()
  const category_detail = String(body.category_detail || '').trim()
  const note = String(body.note || '').trim()
  const invoice_url = body.invoice_url ? String(body.invoice_url).trim() : ''
  const amount = Number(body.amount || 0)
  const currency = String(body.currency || 'AUD').trim() || 'AUD'
  if (!category) return res.status(400).json({ message: 'missing category' })
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'invalid amount' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurred_at)) return res.status(400).json({ message: 'invalid occurred_at' })
  const allowedCats = new Set([
    'office',
    'bedding_fee',
    'office_rent',
    'car_loan',
    'electricity',
    'internet',
    'water',
    'fuel',
    'parking_fee',
    'maintenance_materials',
    'tax',
    'service',
    'other'
  ])
  if (!allowedCats.has(category)) return res.status(400).json({ message: 'invalid category' })
  if (category === 'other' && !category_detail) return res.status(400).json({ message: 'missing category_detail' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitCompanyExpenseAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    try {
      await pgPool.query(`ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS invoice_url text;`)
      await pgPool.query(`ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS created_by text;`)
      await pgPool.query(`ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS category_detail text;`)
    } catch {}
    const id = uuidv4()
    const row = await pgInsert('company_expenses', {
      id,
      occurred_at,
      amount: Number(amount.toFixed(2)),
      currency,
      category,
      category_detail: category === 'other' ? category_detail : (category_detail || null),
      note: note || null,
      invoice_url: invoice_url || null,
      created_by: 'public_company_expense',
    } as any)
    try { addAudit('company_expenses', id, 'create', null, row || { id }) } catch {}
    return res.status(201).json({ ok: true, id, row: row || { id } })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'submit failed' })
  }
})

router.post('/property-expense/login', async (req, res) => {
  const { password } = req.body || {}
  const pwd = String(password || '').trim()
  if (!pwd) return res.status(400).json({ message: 'missing password' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitPropertyExpenseAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const ok = await bcrypt.compare(pwd, access.password_hash)
    if (!ok) return res.status(401).json({ message: 'invalid password' })
    const token = jwt.sign({ scope: 'property_expense' }, SECRET, { expiresIn: '12h' })
    return res.json({ token })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'login failed' })
  }
})

router.get('/property-expense/properties', async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyPropertyExpenseJwt(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitPropertyExpenseAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    const r = await pgPool.query('SELECT id, code, address FROM properties ORDER BY COALESCE(code, address, id)')
    return res.json(Array.isArray(r.rows) ? r.rows : [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list failed' })
  }
})

router.post('/property-expense/submit', async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyPropertyExpenseJwt(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  const body = req.body || {}
  const property_id = String(body.property_id || '').trim()
  const occurred_at = String(body.occurred_at || '').trim() || new Date().toISOString().slice(0, 10)
  const category = String(body.category || '').trim()
  const category_detail = String(body.category_detail || '').trim()
  const note = String(body.note || '').trim()
  const amount = Number(body.amount || 0)
  const currency = String(body.currency || 'AUD').trim() || 'AUD'
  if (!property_id) return res.status(400).json({ message: 'missing property_id' })
  if (!category) return res.status(400).json({ message: 'missing category' })
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'invalid amount' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurred_at)) return res.status(400).json({ message: 'invalid occurred_at' })
  const allowedCats = new Set(['electricity', 'water', 'gas_hot_water', 'internet', 'consumables', 'carpark', 'owners_corp', 'council_rate', 'parking_fee', 'other'])
  if (!allowedCats.has(category)) return res.status(400).json({ message: 'invalid category' })
  if (category === 'other' && !category_detail) return res.status(400).json({ message: 'missing category_detail' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitPropertyExpenseAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    try {
      await pgPool.query(`ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS created_by text;`)
      await pgPool.query(`ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;`)
      await pgPool.query(`ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS month_key text;`)
      await pgPool.query(`ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS due_date date;`)
      await pgPool.query(`ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS paid_date date;`)
      await pgPool.query(`ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS status text;`)
    } catch {}
    const id = uuidv4()
    const month_key = occurred_at.slice(0, 7)
    const row = await pgInsert('property_expenses', {
      id,
      property_id,
      occurred_at,
      paid_date: occurred_at,
      due_date: occurred_at,
      month_key,
      amount: Number(amount.toFixed(2)),
      currency,
      category,
      category_detail: category === 'other' ? category_detail : (category_detail || null),
      note: note || null,
      created_by: 'public_property_expense',
    } as any)
    try { addAudit('property_expenses', id, 'create', null, row || { id }) } catch {}
    return res.status(201).json({ ok: true, id, row: row || { id } })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'submit failed' })
  }
})

router.post('/property-expense/:expenseId/upload', upload.single('file'), async (req, res) => {
  const { expenseId } = req.params
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyPropertyExpenseJwt(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitPropertyExpenseAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    const ex = await pgPool.query('SELECT 1 FROM property_expenses WHERE id = $1 LIMIT 1', [expenseId])
    if (!ex.rowCount) return res.status(404).json({ message: 'expense not found' })
    if (!hasR2 || !(req.file as any).buffer) {
      return res.status(500).json({ message: 'R2 not configured' })
    }
    const ext = path.extname(req.file.originalname) || ''
    const key = `expenses/${expenseId}/${uuidv4()}${ext}`
    const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    try {
      const row = await pgInsert('expense_invoices', {
        id: uuidv4(),
        expense_id: expenseId,
        url,
        file_name: req.file.originalname,
        mime_type: req.file.mimetype,
        file_size: req.file.size,
        created_by: 'public_property_expense'
      } as any)
      return res.status(201).json(row || { url })
    } catch (e: any) {
      const msg = String(e?.message || '')
      if (/relation\s+"?expense_invoices"?\s+does\s+not\s+exist/i.test(msg)) {
        await ensureExpenseInvoicesTable()
        const row2 = await pgInsert('expense_invoices', {
          id: uuidv4(),
          expense_id: expenseId,
          url,
          file_name: req.file.originalname,
          mime_type: req.file.mimetype,
          file_size: req.file.size,
          created_by: 'public_property_expense'
        } as any)
        return res.status(201).json(row2 || { url })
      }
      throw e
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.post('/deep-cleaning-upload/login', async (req, res) => {
  const { password } = req.body || {}
  const pwd = String(password || '').trim()
  if (!pwd) return res.status(400).json({ message: 'missing password' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitDeepCleaningUploadAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const ok = await bcrypt.compare(pwd, access.password_hash)
    if (!ok) return res.status(401).json({ message: 'invalid password' })
    const token = jwt.sign({ scope: 'deep_cleaning_upload' }, SECRET, { expiresIn: '12h' })
    return res.json({ token })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'login failed' })
  }
})

router.post('/deep-cleaning-upload/upload', upload.single('file'), async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyDeepCleaningUploadJwt(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    const access = await getOrInitDeepCleaningUploadAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    if (!hasR2 || !(req.file as any).buffer) {
      return res.status(500).json({ message: 'R2 not configured' })
    }
    const ext = path.extname(req.file.originalname) || ''
    const key = `deep-cleaning-upload/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.post('/deep-cleaning-upload/submit', async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyDeepCleaningUploadJwt(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  const body = req.body || {}
  const property_id = String(body.property_id || '').trim()
  const occurred_at = String(body.occurred_at || '').trim() || new Date().toISOString().slice(0, 10)
  const worker_name = String(body.worker_name || '').trim()
  const notes = String(body.notes || '').trim()
  const detailsArr = Array.isArray(body.details) ? body.details : []
  if (!property_id) return res.status(400).json({ message: 'missing property_id' })
  if (!worker_name) return res.status(400).json({ message: 'missing worker_name' })
  if (!detailsArr.length) return res.status(400).json({ message: 'missing details' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitDeepCleaningUploadAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    await ensurePropertyDeepCleaningShareColumns()
    const sql = `INSERT INTO property_deep_cleaning (
      id, property_id, occurred_at, worker_name, project_desc, started_at, ended_at, duration_minutes,
      details, notes, created_by, photo_urls, repair_photo_urls, property_code, work_no, category, status, urgency,
      submitted_at, submitter_name, completed_at, review_status, checklist, consumables
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9::text,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,
      $19,$20,$21,$22,$23::jsonb,$24::jsonb
    )`
    const nowIso = new Date().toISOString()
    let created = 0
    const ids: string[] = []
    for (const d of detailsArr) {
      const project_desc = String(d?.project_desc || d?.desc || d?.item || '').trim()
      const started_at = safeDateToIso(d?.started_at)
      const ended_at = safeDateToIso(d?.ended_at)
      const itemNote = String(d?.notes || d?.note || '').trim()
      if (!project_desc) continue
      if (!started_at || !ended_at) continue
      const before = Array.isArray(d?.pre_photo_urls) ? d.pre_photo_urls : (d?.pre_photo_urls ? [d.pre_photo_urls] : [])
      const after = Array.isArray(d?.post_photo_urls) ? d.post_photo_urls : (d?.post_photo_urls ? [d.post_photo_urls] : [])
      let durationMinutes: number | null = null
      try {
        const ms = new Date(ended_at).getTime() - new Date(started_at).getTime()
        const m = Math.round(ms / 60000)
        if (Number.isFinite(m) && m >= 0) durationMinutes = m
      } catch {}
      const mergedNotes = (() => {
        if (notes && itemNote) return `${notes}\n${itemNote}`
        return notes || itemNote || ''
      })()
      const detailsText = JSON.stringify([{ content: project_desc }])
      const id = uuidv4()
      const workNo = await generateDeepCleaningWorkNo()
      await pgPool.query(sql, [
        id,
        property_id || null,
        occurred_at || new Date().toISOString().slice(0, 10),
        worker_name || '',
        project_desc || '',
        started_at,
        ended_at,
        durationMinutes,
        detailsText,
        mergedNotes,
        null,
        JSON.stringify(before || []),
        JSON.stringify(after || []),
        null,
        workNo,
        null,
        'completed',
        null,
        nowIso,
        worker_name,
        ended_at || nowIso,
        'pending',
        JSON.stringify([]),
        JSON.stringify([]),
      ])
      addAudit('property_deep_cleaning', id, 'create', null, { id })
      created += 1
      ids.push(id)
    }
    if (!created) return res.status(400).json({ message: 'missing project fields' })
    return res.status(201).json({ ok: true, created, ids })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'submit failed' })
  }
})

router.post('/maintenance-share/upload', upload.single('file'), async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyMaintenanceShareJwt(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    const access = await getOrInitMaintenanceShareAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    if (!hasR2 || !(req.file as any).buffer) {
      return res.status(500).json({ message: 'R2 not configured' })
    }
    const ext = path.extname(req.file.originalname) || ''
    const key = `maintenance-share/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.patch('/maintenance-share/:token', async (req, res) => {
  const tk = String((req.params as any)?.token || '').trim()
  if (!tk) return res.status(400).json({ message: 'missing token' })
  const h = String(req.headers.authorization || '')
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyMaintenanceShareJwt(bearer)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitMaintenanceShareAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    const tokenHash = sha256Hex(tk)
    if (String(v.token_hash || '') !== tokenHash) return res.status(401).json({ message: 'unauthorized' })
    await ensureMaintenanceShareLinksTable()
    const r = await pgPool.query(
      'SELECT maintenance_id FROM maintenance_share_links WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1',
      [tokenHash]
    )
    const maintenanceId = String(r.rows?.[0]?.maintenance_id || '')
    if (!maintenanceId) return res.status(404).json({ message: 'not found' })
    if (String(v.maintenance_id || '') !== maintenanceId) return res.status(401).json({ message: 'unauthorized' })
    await ensurePropertyMaintenanceShareColumns()
    const body = req.body || {}
    const allowed = [
      'status','urgency','assignee_id','eta','completed_at',
      'details','repair_notes','repair_photo_urls',
      'maintenance_amount','has_parts','parts_amount','pay_method','pay_other_note',
    ]
    const payload: any = {}
    for (const k of allowed) {
      if (body[k] !== undefined) payload[k] = body[k]
    }
    if (payload.repair_photo_urls !== undefined && typeof payload.repair_photo_urls !== 'string') {
      try { payload.repair_photo_urls = JSON.stringify(payload.repair_photo_urls) } catch {}
    }
    const beforeRows = await pgSelect('property_maintenance', '*', { id: maintenanceId }) as any[]
    const before = beforeRows && beforeRows[0]
    const updated = await pgUpdate('property_maintenance', maintenanceId, payload)
    addAudit('property_maintenance', maintenanceId, 'update', before, updated)
    return res.json(updated || { ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update failed' })
  }
})

router.get('/deep-cleaning-share/:token', async (req, res) => {
  const token = String((req.params as any)?.token || '').trim()
  if (!token) return res.status(400).json({ message: 'missing token' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureDeepCleaningShareLinksTable()
    const tokenHash = sha256Hex(token)
    const r = await pgPool.query(
      'SELECT deep_cleaning_id FROM deep_cleaning_share_links WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1',
      [tokenHash]
    )
    const deepCleaningId = String(r.rows?.[0]?.deep_cleaning_id || '')
    if (!deepCleaningId) return res.status(404).json({ message: 'not found' })
    await ensurePropertyDeepCleaningShareColumns()
    const rows = await pgSelect('property_deep_cleaning', '*', { id: deepCleaningId }) as any[]
    const row = rows && rows[0]
    if (!row) return res.status(404).json({ message: 'not found' })
    let propCode = ''
    try {
      const pid = String(row?.property_id || '').trim()
      if (pid) {
        const pr = await pgPool.query('SELECT code FROM properties WHERE id=$1 LIMIT 1', [pid])
        propCode = String(pr.rows?.[0]?.code || '').trim()
      }
    } catch {}
    const code = propCode || String(row?.property_code || '').trim()
    return res.json({ ...row, property_code: code || row?.property_code, code: code || row?.code })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'get failed' })
  }
})

router.post('/deep-cleaning-share/login', async (req, res) => {
  const body = req.body || {}
  const tk = String(body.token || '').trim()
  const pwd = String(body.password || '').trim()
  if (!tk) return res.status(400).json({ message: 'missing token' })
  if (!pwd) return res.status(400).json({ message: 'missing password' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitDeepCleaningShareAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const ok = await bcrypt.compare(pwd, access.password_hash)
    if (!ok) return res.status(401).json({ message: 'invalid password' })
    await ensureDeepCleaningShareLinksTable()
    const tokenHash = sha256Hex(tk)
    const r = await pgPool.query(
      'SELECT deep_cleaning_id FROM deep_cleaning_share_links WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1',
      [tokenHash]
    )
    const deepCleaningId = String(r.rows?.[0]?.deep_cleaning_id || '')
    if (!deepCleaningId) return res.status(404).json({ message: 'not found' })
    await ensurePropertyDeepCleaningShareColumns()
    const rows = await pgSelect('property_deep_cleaning', '*', { id: deepCleaningId }) as any[]
    const row = rows && rows[0]
    if (!row) return res.status(404).json({ message: 'not found' })
    let propCode = ''
    try {
      const pid = String(row?.property_id || '').trim()
      if (pid) {
        const pr = await pgPool.query('SELECT code FROM properties WHERE id=$1 LIMIT 1', [pid])
        propCode = String(pr.rows?.[0]?.code || '').trim()
      }
    } catch {}
    const code = propCode || String(row?.property_code || '').trim()
    const shareToken = jwt.sign({ scope: 'deep_cleaning_share', deep_cleaning_id: deepCleaningId, token_hash: tokenHash }, SECRET, { expiresIn: '12h' })
    const deep_cleaning = { ...row, property_code: code || row?.property_code, code: code || row?.code }
    return res.json({ token: shareToken, deep_cleaning })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'login failed' })
  }
})

router.post('/deep-cleaning-share/upload', upload.single('file'), async (req, res) => {
  const h = String(req.headers.authorization || '')
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyDeepCleaningShareJwt(token)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    const access = await getOrInitDeepCleaningShareAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    if (!hasR2 || !(req.file as any).buffer) {
      return res.status(500).json({ message: 'R2 not configured' })
    }
    const ext = path.extname(req.file.originalname) || ''
    const key = `deep-cleaning-share/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.patch('/deep-cleaning-share/:token', async (req, res) => {
  const tk = String((req.params as any)?.token || '').trim()
  if (!tk) return res.status(400).json({ message: 'missing token' })
  const h = String(req.headers.authorization || '')
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : ''
  const v = verifyDeepCleaningShareJwt(bearer)
  if (!v.ok) return res.status(401).json({ message: 'unauthorized' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitDeepCleaningShareAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const iatSec = Number(v.iat || 0) * 1000
    const pwdAt = new Date(access.password_updated_at).getTime()
    if (iatSec < pwdAt) return res.status(401).json({ message: 'token invalidated' })
    const tokenHash = sha256Hex(tk)
    if (String(v.token_hash || '') !== tokenHash) return res.status(401).json({ message: 'unauthorized' })
    await ensureDeepCleaningShareLinksTable()
    const r = await pgPool.query(
      'SELECT deep_cleaning_id FROM deep_cleaning_share_links WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1',
      [tokenHash]
    )
    const deepCleaningId = String(r.rows?.[0]?.deep_cleaning_id || '')
    if (!deepCleaningId) return res.status(404).json({ message: 'not found' })
    if (String(v.deep_cleaning_id || '') !== deepCleaningId) return res.status(401).json({ message: 'unauthorized' })
    await ensurePropertyDeepCleaningShareColumns()
    const body = req.body || {}
    const allowed = [
      'status','urgency','assignee_id','eta','completed_at',
      'details','notes','repair_notes','photo_urls','repair_photo_urls','attachment_urls',
      'checklist','consumables','labor_minutes','labor_cost',
    ]
    const payload: any = {}
    for (const k of allowed) {
      if (body[k] !== undefined) payload[k] = body[k]
    }
    const beforeRows = await pgSelect('property_deep_cleaning', '*', { id: deepCleaningId }) as any[]
    const before = beforeRows && beforeRows[0]
    const updated = await pgUpdate('property_deep_cleaning', deepCleaningId, payload)
    addAudit('property_deep_cleaning', deepCleaningId, 'update', before, updated)
    return res.json(updated || { ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update failed' })
  }
})

const GUIDE_SESSION_COOKIE = 'mz_guide_sess'
const GUIDE_SESSION_HEADER = 'x-guide-session'

function readGuideSessionId(req: any): string {
  const byHeader = String(req?.headers?.[GUIDE_SESSION_HEADER] || req?.get?.(GUIDE_SESSION_HEADER) || '').trim()
  if (byHeader) return byHeader
  const byCookie = readCookie(req, GUIDE_SESSION_COOKIE)
  if (byCookie) return byCookie
  const byQuery = String((req?.query as any)?.guide_sess || (req?.query as any)?.sess || '').trim()
  return byQuery
}

router.get('/guide/p/:token/status', async (req, res) => {
  const token = String((req.params as any)?.token || '').trim()
  if (!token || token.length < 32) return res.status(404).json({ message: 'not found' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidePublicLinksTable()
    const tokenHash = sha256Hex(token)
    const r = await pgPool.query('SELECT expires_at, revoked_at FROM property_guide_public_links WHERE token_hash=$1 LIMIT 1', [tokenHash])
    if (!r?.rowCount) return res.status(404).json({ message: 'not found' })
    const row = r.rows?.[0] || {}
    const expires_at = row?.expires_at ? new Date(row.expires_at).toISOString() : null
    const revoked = !!row?.revoked_at
    const expired = expires_at ? (new Date(expires_at).getTime() <= Date.now()) : true
    return res.json({ active: !revoked && !expired, expires_at, revoked })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'status failed' })
  }
})

router.post('/guide/p/:token/login', async (req, res) => {
  const token = String((req.params as any)?.token || '').trim()
  if (!token || token.length < 32) return res.status(404).json({ message: 'not found' })
  const password = String((req.body as any)?.password || '').trim()
  if (!/^\d{4,6}$/.test(password)) return res.status(400).json({ message: 'password must be 4-6 digits' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const access = await getOrInitPropertyGuideAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const ok = await bcrypt.compare(password, access.password_hash)
    if (!ok) return res.status(401).json({ message: 'invalid password' })

    await ensurePropertyGuidePublicLinksTable()
    const tokenHash = sha256Hex(token)
    const r = await pgPool.query(
      `SELECT l.expires_at, l.revoked_at, g.id AS guide_id, g.status
       FROM property_guide_public_links l
       JOIN property_guides g ON g.id = l.guide_id
       WHERE l.token_hash=$1
       LIMIT 1`,
      [tokenHash]
    )
    if (!r?.rowCount) return res.status(404).json({ message: 'not found' })
    const row = r.rows?.[0] || {}
    if (row?.revoked_at) return res.status(404).json({ message: 'not found' })
    const linkExpiresAt = row?.expires_at ? new Date(row.expires_at).getTime() : 0
    if (!linkExpiresAt || linkExpiresAt <= Date.now()) return res.status(404).json({ message: 'not found' })
    if (String(row?.status || '') !== 'published') return res.status(404).json({ message: 'not found' })

    await ensurePropertyGuidePublicSessionsTable()
    const now = Date.now()
    const maxMs = 12 * 3600 * 1000
    const sessionExpiresMs = Math.min(now + maxMs, linkExpiresAt)
    const sessionExpiresAt = new Date(sessionExpiresMs).toISOString()
    const sessionId = randomToken(32)
    const sessionHash = sha256Hex(sessionId)
    await pgPool.query(
      'INSERT INTO property_guide_public_sessions(session_id_hash, token_hash, expires_at) VALUES ($1,$2,$3)',
      [sessionHash, tokenHash, sessionExpiresAt]
    )
    const isProd = process.env.NODE_ENV === 'production'
    res.setHeader('Cache-Control', 'no-store')
    res.cookie(GUIDE_SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: isProd ? 'none' : 'lax',
      secure: isProd,
      path: '/public/guide/p',
      maxAge: Math.max(0, sessionExpiresMs - now),
    })
    return res.json({ ok: true, expires_at: sessionExpiresAt, session_id: sessionId })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'login failed' })
  }
})

router.get('/guide/p/:token', async (req, res) => {
  const token = String((req.params as any)?.token || '').trim()
  if (!token || token.length < 32) return res.status(404).json({ message: 'not found' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidePublicLinksTable()
    await ensurePropertyGuidePublicSessionsTable()
    const tokenHash = sha256Hex(token)
    const r = await pgPool.query(
      `SELECT l.expires_at, l.revoked_at, g.id AS guide_id, g.property_id, g.language, g.version, g.content_json, g.status
       FROM property_guide_public_links l
       JOIN property_guides g ON g.id = l.guide_id
       WHERE l.token_hash=$1
       LIMIT 1`,
      [tokenHash]
    )
    if (!r?.rowCount) return res.status(404).json({ message: 'not found' })
    const row = r.rows?.[0] || {}
    if (row?.revoked_at) return res.status(404).json({ message: 'not found' })
    const linkExpiresAt = row?.expires_at ? new Date(row.expires_at).getTime() : 0
    if (!linkExpiresAt || linkExpiresAt <= Date.now()) return res.status(404).json({ message: 'not found' })
    if (String(row?.status || '') !== 'published') return res.status(404).json({ message: 'not found' })

    const sid = readGuideSessionId(req)
    if (!sid) return res.status(401).json({ message: 'password_required' })
    const sessionHash = sha256Hex(sid)
    const s = await pgPool.query(
      `SELECT created_at, expires_at, revoked_at
       FROM property_guide_public_sessions
       WHERE session_id_hash=$1 AND token_hash=$2
       LIMIT 1`,
      [sessionHash, tokenHash]
    )
    if (!s?.rowCount) return res.status(401).json({ message: 'password_required' })
    const sess = s.rows?.[0] || {}
    if (sess?.revoked_at) return res.status(401).json({ message: 'password_required' })
    const sessExpiresAt = sess?.expires_at ? new Date(sess.expires_at).getTime() : 0
    if (!sessExpiresAt || sessExpiresAt <= Date.now()) return res.status(401).json({ message: 'password_required' })

    const access = await getOrInitPropertyGuideAccess()
    if (!access) return res.status(500).json({ message: 'access not configured' })
    const pwdAt = new Date(access.password_updated_at).getTime()
    const createdAt = sess?.created_at ? new Date(sess.created_at).getTime() : 0
    if (!createdAt || createdAt < pwdAt) return res.status(401).json({ message: 'password_required' })

    let property_code: string | null = null
    let property_address: string | null = null
    try {
      const pid = String(row?.property_id || '').trim()
      if (pid) {
        const pr = await pgPool.query('SELECT code, address FROM properties WHERE id=$1 LIMIT 1', [pid])
        property_code = pr?.rows?.[0]?.code ? String(pr.rows[0].code) : null
        property_address = pr?.rows?.[0]?.address ? String(pr.rows[0].address) : null
      }
    } catch {}

    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    return res.json({
      guide_id: String(row.guide_id || ''),
      property_id: row.property_id || null,
      property_code,
      property_address,
      language: row.language || null,
      version: row.version || null,
      content_json: row.content_json || { sections: [] },
      link_expires_at: new Date(linkExpiresAt).toISOString(),
      session_expires_at: new Date(sessExpiresAt).toISOString(),
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'get failed' })
  }
})

export default router
