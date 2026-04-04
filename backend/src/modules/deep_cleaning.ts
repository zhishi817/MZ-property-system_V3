import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { hasR2, r2GetObjectByKey, r2Upload } from '../r2'
import { requireAnyPerm } from '../auth'
import { hasPg, pgPool } from '../dbAdapter'
import { pdfTaskLimiter } from '../lib/pdfTaskLimiter'
import { resizeUploadImage } from '../lib/uploadImageResize'
import { ensurePdfJobsSchema } from '../services/pdfJobsSchema'
import { generateWorkRecordPdf } from '../lib/workRecordPdf'

export const router = Router()
const upload = multer({ storage: multer.memoryStorage() })

function sha256Hex(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function randomToken(bytes = 24) {
  const b64 = crypto.randomBytes(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function pdfLimiter(req: any, res: any, next: any) {
  pdfTaskLimiter.acquire().then((release) => {
    let done = false
    const once = () => {
      if (done) return
      done = true
      try { release() } catch {}
    }
    res.on('finish', once)
    res.on('close', once)
    try { res.on('error', once) } catch {}
    next()
  }).catch(() => {
    return res.status(429).json({ message: 'PDF任务繁忙，请稍后重试' })
  })
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
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS pay_method text;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS gst_type text;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS total_cost numeric;')
}

router.post('/upload', requireAnyPerm(['property_deep_cleaning.write','rbac.manage','property.write']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (!hasR2 || !(req.file as any).buffer) {
      return res.status(500).json({ message: 'R2 not configured' })
    }
    const img = await resizeUploadImage({ buffer: (req.file as any).buffer, contentType: req.file.mimetype, originalName: req.file.originalname })
    const ext = img.ext || path.extname(req.file.originalname) || ''
    const key = `deep-cleaning/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, img.contentType || req.file.mimetype || 'application/octet-stream', img.buffer)
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

router.post('/pdf/:id', requireAnyPerm(['property_deep_cleaning.view','property_deep_cleaning.write','rbac.manage']), pdfLimiter, async (req, res) => {
  const { id } = req.params as any
  const rid = String(id || '').trim()
  if (!rid) return res.status(400).json({ message: 'missing id' })
  try {
    const showChineseRaw = String((req as any)?.query?.showChinese ?? '').trim().toLowerCase()
    const showChinese = showChineseRaw === '1' || showChineseRaw === 'true' || showChineseRaw === 'yes'
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const apiBase = (() => {
      const host = String((req.headers['x-forwarded-host'] as any) || req.headers.host || '').split(',')[0].trim()
      const proto = String((req.headers['x-forwarded-proto'] as any) || req.protocol || 'https').split(',')[0].trim()
      return host ? `${proto}://${host}` : ''
    })()
    const built = await generateWorkRecordPdf({ recordId: rid, kind: 'deep_cleaning', showChinese, apiBase, photosMode: 'full' })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`)
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('X-WorkRecordPdfTemplate', 'workRecordPdfTemplate.v4.headerOnce.noFrame')
    res.setHeader('X-WorkRecordPdfChinese', showChinese ? '1' : '0')
    if (built.notLoaded > 0) res.setHeader('X-WorkRecordPdfWarnings', `images_not_loaded=${built.notLoaded}`)
    return res.status(200).send(built.pdf)
  } catch (e: any) {
    const msg = String(e?.message || 'generate pdf failed')
    if (msg === 'not found') return res.status(404).json({ message: 'not found' })
    if (msg === 'no photos to render') return res.status(422).json({ message: 'no photos to render' })
    if (/timeout/i.test(msg)) return res.status(504).json({ message: 'pdf_generation_timeout' })
    return res.status(500).json({ message: msg || 'generate pdf failed' })
  }
})

router.post('/pdf-jobs/:id', requireAnyPerm(['property_deep_cleaning.view','property_deep_cleaning.write','rbac.manage']), async (req, res) => {
  try {
    const rid = String(req.params?.id || '').trim()
    const body = req.body || {}
    const showChinese = !(body.showChinese === false || body.showChinese === '0' || body.showChinese === 0)
    const qualityMode = String(body.quality_mode || '').trim()
    const forceNew = body.forceNew === true || body.forceNew === 1 || body.forceNew === '1'
    if (!rid) return res.status(400).json({ message: 'missing id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!String(process.env.FRONTEND_BASE_URL || '').trim()) return res.status(500).json({ message: 'missing FRONTEND_BASE_URL' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    await ensurePdfJobsSchema()
    await ensurePropertyDeepCleaningTable()
    const rowCheck = await pgPool.query('SELECT id FROM property_deep_cleaning WHERE id=$1 LIMIT 1', [rid])
    if (!rowCheck.rowCount) return res.status(404).json({ message: 'not found' })
    if (!forceNew) {
      const r0 = await pgPool.query(
        `SELECT id, status
         FROM pdf_jobs
         WHERE kind='deep_cleaning_record_pdf'
           AND status IN ('queued', 'running', 'success')
           AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at > now())
           AND COALESCE(params->>'record_id', params->>'id') = $1
           AND COALESCE(params->>'showChinese', 'false') = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [rid, showChinese ? 'true' : 'false']
      )
      const existing = r0.rows?.[0] || null
      if (existing?.id) {
        return res.json({ job_id: String(existing.id), status: String(existing.status || 'running'), reused: true })
      }
    }
    const id = uuidv4()
    const params = {
      record_id: rid,
      showChinese,
      quality_mode: qualityMode || null,
    }
    await pgPool.query(
      `INSERT INTO pdf_jobs(id, kind, status, progress, stage, detail, params, result_files, attempts, max_attempts, next_retry_at, created_at, updated_at)
       VALUES($1,'deep_cleaning_record_pdf','queued',0,'queued',NULL,$2::jsonb,'[]'::jsonb,0,3,now(),now(),now())`,
      [id, JSON.stringify(params)]
    )
    return res.json({ job_id: id, status: 'queued', reused: false })
  } catch (e: any) {
    const code = String(e?.code || '')
    if (code === 'PDF_JOBS_SCHEMA_MISSING') return res.status(500).json({ message: 'pdf_jobs table missing (apply migration)' })
    return res.status(500).json({ message: e?.message || 'create job failed' })
  }
})

router.get('/pdf-jobs/:id', requireAnyPerm(['property_deep_cleaning.view','property_deep_cleaning.write','rbac.manage']), async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim()
    if (!id) return res.status(400).json({ message: 'missing id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePdfJobsSchema()
    const r = await pgPool.query(`SELECT * FROM pdf_jobs WHERE id=$1 AND kind='deep_cleaning_record_pdf' LIMIT 1`, [id])
    const row = r.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not_found' })
    return res.json({
      id: row.id,
      kind: row.kind,
      status: row.status,
      progress: Number(row.progress || 0),
      stage: row.stage || '',
      detail: row.detail || '',
      attempts: Number(row.attempts || 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_retry_at: row.next_retry_at || null,
      lease_expires_at: row.lease_expires_at || null,
      result_files: row.result_files || [],
      last_error_code: row.last_error_code || null,
      last_error_message: row.last_error_message || null,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'get job failed' })
  }
})

router.get('/pdf-jobs/:id/download', requireAnyPerm(['property_deep_cleaning.view','property_deep_cleaning.write','rbac.manage']), async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim()
    if (!id) return res.status(400).json({ message: 'missing id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    await ensurePdfJobsSchema()
    const r = await pgPool.query(`SELECT id, status, stage, result_files FROM pdf_jobs WHERE id=$1 AND kind='deep_cleaning_record_pdf' LIMIT 1`, [id])
    const row = r.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not_found' })
    if (String(row.status || '') !== 'success' || String(row.stage || '') !== 'done') {
      return res.status(409).json({ message: 'job_not_done', status: row.status || null, stage: row.stage || null })
    }
    const files = Array.isArray(row?.result_files) ? row.result_files : []
    const file = files.find((x: any) => String(x?.kind || '') === 'work_record_pdf') || files[0]
    const key = String(file?.path || '').trim()
    if (!key) return res.status(404).json({ message: 'file_not_found' })
    const obj = await r2GetObjectByKey(key)
    if (!obj || !obj.body?.length) return res.status(404).json({ message: 'file_not_found' })
    const filename = String(file?.name || `${id}.pdf`).replace(/[^a-zA-Z0-9._-]/g, '_')
    res.setHeader('Content-Type', obj.contentType || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'private, max-age=0, no-cache')
    return res.status(200).send(obj.body)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'download failed' })
  }
})

export default router
