import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import { requireAnyPerm } from '../auth'
import { hasPg, pgPool } from '../dbAdapter'
import crypto from 'crypto'

export const router = Router()
const upload = multer({ storage: multer.memoryStorage() })

function sha256Hex(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function randomToken(bytes = 24) {
  const b64 = crypto.randomBytes(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function ensureMaintenanceShareTables() {
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

router.post('/upload', requireAnyPerm(['property.write','rbac.manage']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (!hasR2 || !(req.file as any).buffer) {
      return res.status(500).json({ message: 'R2 not configured' })
    }
    const ext = path.extname(req.file.originalname) || ''
    const key = `maintenance/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.post('/share-link/:id', requireAnyPerm(['property_maintenance.view','property_maintenance.write','rbac.manage']), async (req, res) => {
  const { id } = req.params as any
  if (!id) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureMaintenanceShareTables()
    const r0 = await pgPool.query('SELECT id FROM property_maintenance WHERE id=$1 LIMIT 1', [id])
    if (!r0.rowCount) return res.status(404).json({ message: 'not found' })
    const token = randomToken(24)
    const tokenHash = sha256Hex(token)
    const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString()
    await pgPool.query(
      'INSERT INTO maintenance_share_links(token_hash, maintenance_id, expires_at) VALUES ($1,$2,$3)',
      [tokenHash, id, expiresAt]
    )
    return res.json({ token, expires_at: expiresAt })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create share link failed' })
  }
})

export default router
