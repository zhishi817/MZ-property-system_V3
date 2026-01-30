import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import { v4 as uuidv4 } from 'uuid'
import { hasPg, pgPool, pgSelect, pgInsert, pgUpdate } from '../dbAdapter'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { addAudit } from '../store'
import crypto from 'crypto'

const SECRET = process.env.JWT_SECRET || 'dev-secret'
const DEFAULT_PUBLIC_CLEANING_PASSWORD = process.env.PUBLIC_CLEANING_PASSWORD || 'mz-cleaning'
const DEFAULT_PUBLIC_MAINTENANCE_SHARE_PASSWORD = process.env.MAINTENANCE_SHARE_PASSWORD || 'mz-maintenance'

export const router = Router()
const upload = multer({ storage: multer.memoryStorage() })

function randomSuffix(len: number): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let s = ''
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
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

function verifyMaintenanceShareJwt(token: string): { ok: boolean; iat?: number; maintenance_id?: string; token_hash?: string } {
  try {
    const decoded: any = jwt.verify(token, SECRET)
    if (decoded && decoded.scope === 'maintenance_share' && decoded.maintenance_id && decoded.token_hash) {
      return { ok: true, iat: Number(decoded.iat || 0), maintenance_id: String(decoded.maintenance_id), token_hash: String(decoded.token_hash) }
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

export default router
