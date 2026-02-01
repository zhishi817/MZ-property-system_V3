import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import crypto from 'crypto'
import { hasR2, r2Upload } from '../r2'
import { requireAnyPerm } from '../auth'
import { hasPg, pgPool } from '../dbAdapter'

export const router = Router()
const upload = multer({ storage: multer.memoryStorage() })

function sha256Hex(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function randomToken(bytes = 24) {
  const b64 = crypto.randomBytes(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function ensureDeepCleaningShareTables() {
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

async function ensurePropertyDeepCleaningTable() {
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
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS review_status text;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS reviewed_by text;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS review_notes text;')
}

router.post('/upload', requireAnyPerm(['property_deep_cleaning.write','rbac.manage','property.write']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (!hasR2 || !(req.file as any).buffer) {
      return res.status(500).json({ message: 'R2 not configured' })
    }
    const ext = path.extname(req.file.originalname) || ''
    const key = `deep-cleaning/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.patch('/review/:id', requireAnyPerm(['property_deep_cleaning.audit','rbac.manage']), async (req, res) => {
  const { id } = req.params as any
  if (!id) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyDeepCleaningTable()
    const user = (req as any).user || {}
    const body = req.body || {}
    const review_status = String(body.review_status || '').trim()
    const review_notes = body.review_notes !== undefined ? String(body.review_notes || '') : undefined
    if (!['pending', 'approved', 'rejected'].includes(review_status)) return res.status(400).json({ message: 'invalid review_status' })
    const reviewed_at = review_status === 'pending' ? null : new Date().toISOString()
    const reviewed_by = String(user.username || user.sub || '')
    const patch: Record<string, any> = { review_status, reviewed_at, reviewed_by }
    if (review_notes !== undefined) patch.review_notes = review_notes
    patch.updated_at = new Date().toISOString()
    const keys = Object.keys(patch)
    const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
    const values = keys.map((k) => patch[k])
    const sql = `UPDATE property_deep_cleaning SET ${set} WHERE id = $${keys.length + 1} RETURNING *`
    const r = await pgPool.query(sql, [...values, id])
    const row = r.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    return res.json(row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'review failed' })
  }
})

router.post('/share-link/:id', requireAnyPerm(['property_deep_cleaning.view','property_deep_cleaning.write','rbac.manage']), async (req, res) => {
  const { id } = req.params as any
  if (!id) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyDeepCleaningTable()
    await ensureDeepCleaningShareTables()
    const r0 = await pgPool.query('SELECT id FROM property_deep_cleaning WHERE id=$1 LIMIT 1', [id])
    if (!r0.rowCount) return res.status(404).json({ message: 'not found' })
    const token = randomToken(24)
    const tokenHash = sha256Hex(token)
    const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString()
    await pgPool.query(
      'INSERT INTO deep_cleaning_share_links(token_hash, deep_cleaning_id, expires_at) VALUES ($1,$2,$3)',
      [tokenHash, id, expiresAt]
    )
    return res.json({ token, expires_at: expiresAt })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create share link failed' })
  }
})

export default router
