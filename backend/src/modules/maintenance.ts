import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { hasR2, r2GetObjectByKey, r2Upload } from '../r2'
import { requireAnyPerm } from '../auth'
import { hasPg, pgPool } from '../dbAdapter'
import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { pdfTaskLimiter } from '../lib/pdfTaskLimiter'
import { resizeUploadImage } from '../lib/uploadImageResize'
import { ensurePdfJobsSchema } from '../services/pdfJobsSchema'
import { generateWorkRecordPdf } from '../lib/workRecordPdf'
import { WORK_RECORD_PDF_TEMPLATE_VERSION } from '../lib/workRecordPdfTemplate'
import { ensureMaintenanceWorkflowFoundation } from '../lib/maintenanceWorkflowSchema'
import {
  availableMaintenanceActions,
  normalizeMaintenanceWorkflowStatus,
  validateMaintenanceWorkflowAction,
  type MaintenanceWorkflowAction,
} from '../lib/maintenanceWorkflow'
import {
  ensureMaintenanceWorkTasksTable,
  insertMaintenanceWorkflowEvent,
  maintenanceWorkflowSourceType,
  upsertMaintenanceWorkTask,
  type MaintenanceWorkflowDomain,
} from '../lib/maintenanceWorkflowStore'
import {
  buildIdempotencyPayloadHash,
  ensureIdempotentStepReceiptsTable,
  IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH,
  loadIdempotentStepReceipt,
  saveIdempotentStepReceipt,
} from '../lib/idempotentStepReceipts'

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

async function ensurePropertyMaintenanceTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_maintenance (
    id text PRIMARY KEY,
    property_id text REFERENCES properties(id) ON DELETE SET NULL,
    occurred_at date,
    worker_name text,
    details text,
    created_by text,
    created_at timestamptz DEFAULT now()
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_maintenance_pid ON property_maintenance(property_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_maintenance_date ON property_maintenance(occurred_at);')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls jsonb;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_notes text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS property_code text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS work_no text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category_detail text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS invoice_description_en text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS area text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS completed_at timestamptz;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS updated_at timestamptz;')
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

type MaintenanceDomain = MaintenanceWorkflowDomain

class MaintenanceWorkflowError extends Error {
  constructor(public statusCode: number, public code: string) {
    super(code)
  }
}

function workflowDomain(value: any): MaintenanceDomain | null {
  const domain = String(value || '').trim().toLowerCase()
  return domain === 'internal' || domain === 'external' ? domain : null
}

function workflowTable(domain: MaintenanceDomain): string {
  return domain === 'internal' ? 'property_maintenance' : 'external_maintenance_orders'
}

function workflowSourceType(domain: MaintenanceDomain): string {
  return maintenanceWorkflowSourceType(domain)
}

function userRoleNames(user: any): string[] {
  return Array.from(new Set([
    String(user?.role || '').trim(),
    ...(Array.isArray(user?.roles) ? user.roles.map((role: any) => String(role || '').trim()) : []),
  ].filter(Boolean)))
}

function isMaintenanceManager(user: any): boolean {
  return userRoleNames(user).some((role) => ['admin', 'offline_manager', 'customer_service'].includes(role))
}

function userId(user: any): string {
  return String(user?.sub || user?.id || '').trim()
}

function userName(user: any): string | null {
  const name = String(user?.username || user?.name || '').trim()
  return name || null
}

function dateOnly(value: any): string | null {
  const raw = String(value || '').trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

function nonEmptyStrings(value: any): string[] {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value]
  return Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)))
}

function internalAssignmentRecordPatch(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const patch: Record<string, any> = {}
  const has = (key: string) => Object.prototype.hasOwnProperty.call(value, key)
  if (has('property_id')) patch.property_id = String(value.property_id || '').trim() || null
  if (has('submitter_name')) patch.submitter_name = String(value.submitter_name || '').trim() || null
  if (has('urgency')) patch.urgency = String(value.urgency || '').trim() || null
  if (has('details')) patch.details = value.details == null ? null : String(value.details)
  if (has('invoice_description_en')) patch.invoice_description_en = value.invoice_description_en == null ? null : String(value.invoice_description_en)
  if (has('photo_urls')) patch.photo_urls = nonEmptyStrings(value.photo_urls)
  return patch
}

function workflowAction(value: any, decision: any): MaintenanceWorkflowAction | null {
  const action = String(value || '').trim().toLowerCase()
  if (action === 'review') {
    const reviewDecision = String(decision || '').trim().toLowerCase()
    if (reviewDecision === 'approved') return 'review_approved'
    if (reviewDecision === 'rejected') return 'review_rejected'
    return null
  }
  return ['assign', 'start', 'submit', 'executor_complete', 'executor_unfinished', 'reopen', 'cancel', 'hold'].includes(action)
    ? action as MaintenanceWorkflowAction
    : null
}

async function updateMaintenanceWorkflowRecord(client: any, domain: MaintenanceDomain, id: string, patch: Record<string, any>) {
  const values: any[] = []
  const sets = Object.entries(patch).map(([field, value]) => {
    values.push(value)
    const cast = field === 'completion_photo_urls' || field === 'photo_urls' ? '::jsonb' : ''
    return `"${field}" = $${values.length}${cast}`
  })
  sets.push('updated_at = now()')
  values.push(id)
  const result = await client.query(
    `UPDATE ${workflowTable(domain)}
        SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING *`,
    values,
  )
  const row = result?.rows?.[0] || null
  if (!row) throw new MaintenanceWorkflowError(404, 'maintenance_not_found')
  return row
}

function workflowResponse(domain: MaintenanceDomain, row: any, user: any) {
  const status = normalizeMaintenanceWorkflowStatus(row?.status, row?.review_status)
  const assignedExecutor = !!userId(user) && String(row?.assignee_id || '').trim() === userId(user)
  return {
    ok: true,
    domain,
    id: String(row?.id || ''),
    status,
    source_type: workflowSourceType(domain),
    source_id: String(row?.id || ''),
    work_task_id: `${workflowSourceType(domain)}:${String(row?.id || '')}`,
    available_actions: availableMaintenanceActions({ status, isManager: isMaintenanceManager(user), isAssignedExecutor: assignedExecutor }),
  }
}

async function reconcileLegacyInternalMaintenanceAssignee(client: any, row: any, user: any, action: MaintenanceWorkflowAction) {
  if (!['executor_complete', 'executor_unfinished'].includes(action)) return row
  const actorId = userId(user)
  if (!actorId || String(row?.assignee_id || '').trim()) return row

  const status = normalizeMaintenanceWorkflowStatus(row?.status, row?.review_status)
  if (!['pending_assignment', 'assigned', 'in_progress'].includes(status)) return row

  // Historical Task Center assignment changed only the work_tasks projection.
  // Reconcile only an unassigned source record and only for the authenticated
  // projected assignee; never use a name match or override an existing assignee.
  const projectionResult = await client.query(
    `SELECT assignee_id, scheduled_date
       FROM work_tasks
      WHERE source_type=$1 AND source_id=$2
      LIMIT 1`,
    [workflowSourceType('internal'), String(row.id)],
  )
  const projection = projectionResult?.rows?.[0] || null
  if (String(projection?.assignee_id || '').trim() !== actorId) return row

  const fallbackEta = dateOnly(projection?.scheduled_date)
  const updated = await updateMaintenanceWorkflowRecord(client, 'internal', String(row.id), {
    status: 'assigned',
    assignee_id: actorId,
    assigned_at: new Date().toISOString(),
    assigned_by: actorId,
    ...(row?.eta ? {} : fallbackEta ? { eta: fallbackEta } : {}),
  })
  await upsertMaintenanceWorkTask(client, 'internal', updated)
  await insertMaintenanceWorkflowEvent(client, {
    domain: 'internal',
    recordId: String(row.id),
    eventType: 'assignment_reconciled',
    fromStatus: status,
    toStatus: 'assigned',
    actorUserId: actorId,
    actorName: userName(user),
    reason: null,
    payload: { source: 'legacy_work_task_projection' },
  })
  return updated
}

router.post('/upload', requireAnyPerm(['property_maintenance.write','property.write','rbac.manage']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (!hasR2 || !(req.file as any).buffer) {
      return res.status(500).json({ message: 'R2 not configured' })
    }
    const img = await resizeUploadImage({ buffer: (req.file as any).buffer, contentType: req.file.mimetype, originalName: req.file.originalname })
    const ext = img.ext || path.extname(req.file.originalname) || ''
    const key = `maintenance/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, img.contentType || req.file.mimetype || 'application/octet-stream', img.buffer)
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

router.post('/pdf/:id', requireAnyPerm(['property_maintenance.view','property_maintenance.write','rbac.manage']), pdfLimiter, async (req, res) => {
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
    const built = await generateWorkRecordPdf({ recordId: rid, kind: 'maintenance', showChinese, apiBase, photosMode: 'full' })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`)
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('X-WorkRecordPdfTemplate', WORK_RECORD_PDF_TEMPLATE_VERSION)
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

router.post('/pdf-jobs/:id', requireAnyPerm(['property_maintenance.view','property_maintenance.write','rbac.manage']), async (req, res) => {
  try {
    const rid = String(req.params?.id || '').trim()
    const body = req.body || {}
    const showChinese = !(body.showChinese === false || body.showChinese === '0' || body.showChinese === 0)
    const qualityMode = String(body.quality_mode || '').trim()
    const templateVersion = String(body.template_version || '').trim() || WORK_RECORD_PDF_TEMPLATE_VERSION
    const forceNew = body.forceNew === true || body.forceNew === 1 || body.forceNew === '1'
    if (!rid) return res.status(400).json({ message: 'missing id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!String(process.env.FRONTEND_BASE_URL || '').trim()) return res.status(500).json({ message: 'missing FRONTEND_BASE_URL' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    await ensurePdfJobsSchema()
    await ensurePropertyMaintenanceTable()
    const rowCheck = await pgPool.query('SELECT id FROM property_maintenance WHERE id=$1 LIMIT 1', [rid])
    if (!rowCheck.rowCount) return res.status(404).json({ message: 'not found' })
    if (!forceNew) {
      const r0 = await pgPool.query(
        `SELECT id, status
         FROM pdf_jobs
         WHERE kind='maintenance_record_pdf'
           AND status IN ('queued', 'running', 'success')
           AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at > now())
           AND COALESCE(params->>'record_id', params->>'id') = $1
           AND COALESCE(params->>'showChinese', 'false') = $2
           AND COALESCE(params->>'template_version', '') = $3
         ORDER BY created_at DESC
         LIMIT 1`,
        [rid, showChinese ? 'true' : 'false', templateVersion]
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
      template_version: templateVersion,
    }
    await pgPool.query(
      `INSERT INTO pdf_jobs(id, kind, status, progress, stage, detail, params, result_files, attempts, max_attempts, next_retry_at, created_at, updated_at)
       VALUES($1,'maintenance_record_pdf','queued',0,'queued',NULL,$2::jsonb,'[]'::jsonb,0,3,now(),now(),now())`,
      [id, JSON.stringify(params)]
    )
    return res.json({ job_id: id, status: 'queued', reused: false })
  } catch (e: any) {
    const code = String(e?.code || '')
    if (code === 'PDF_JOBS_SCHEMA_MISSING') return res.status(500).json({ message: 'pdf_jobs table missing (apply migration)' })
    return res.status(500).json({ message: e?.message || 'create job failed' })
  }
})

router.get('/pdf-jobs/:id', requireAnyPerm(['property_maintenance.view','property_maintenance.write','rbac.manage']), async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim()
    if (!id) return res.status(400).json({ message: 'missing id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePdfJobsSchema()
    const r = await pgPool.query(`SELECT * FROM pdf_jobs WHERE id=$1 AND kind='maintenance_record_pdf' LIMIT 1`, [id])
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

router.get('/pdf-jobs/:id/download', requireAnyPerm(['property_maintenance.view','property_maintenance.write','rbac.manage']), async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim()
    if (!id) return res.status(400).json({ message: 'missing id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    await ensurePdfJobsSchema()
    const r = await pgPool.query(`SELECT id, status, stage, result_files FROM pdf_jobs WHERE id=$1 AND kind='maintenance_record_pdf' LIMIT 1`, [id])
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

router.post('/workflow/external-orders', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!isMaintenanceManager(user)) return res.status(403).json({ code: 'maintenance_manager_required' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })

  const body = req.body || {}
  const clientName = String(body.client_name || '').trim()
  const siteName = String(body.site_name || '').trim()
  const details = String(body.details || '').trim()
  if (!clientName || !siteName || !details) return res.status(400).json({ code: 'external_maintenance_required_fields' })
  const requestedAt = body.requested_at == null || body.requested_at === '' ? null : dateOnly(body.requested_at)
  const scheduledDate = body.scheduled_date == null || body.scheduled_date === '' ? null : dateOnly(body.scheduled_date)
  if ((body.requested_at != null && body.requested_at !== '' && !requestedAt) || (body.scheduled_date != null && body.scheduled_date !== '' && !scheduledDate)) {
    return res.status(400).json({ code: 'maintenance_invalid_date' })
  }

  try {
    await ensureMaintenanceWorkflowFoundation(pgPool)
    await ensureMaintenanceWorkTasksTable(pgPool)
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      const id = uuidv4()
      const suppliedOrderNo = String(body.order_no || '').trim()
      const orderNo = suppliedOrderNo || `EXT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${id.slice(0, 8).toUpperCase()}`
      const created = await client.query(
        `INSERT INTO external_maintenance_orders(
           id, order_no, client_name, client_contact_name, client_contact_phone, client_contact_email,
           site_name, site_address, access_notes, external_reference, source_channel,
           requested_at, scheduled_date, area, details, urgency, status, created_by, created_at, updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'external_manual',$11::date,$12::date,$13,$14,$15,'pending_assignment',$16,now(),now())
         RETURNING *`,
        [
          id,
          orderNo,
          clientName,
          String(body.client_contact_name || '').trim() || null,
          String(body.client_contact_phone || '').trim() || null,
          String(body.client_contact_email || '').trim() || null,
          siteName,
          String(body.site_address || '').trim() || null,
          String(body.access_notes || '').trim() || null,
          String(body.external_reference || '').trim() || null,
          requestedAt,
          scheduledDate,
          String(body.area || '').trim() || null,
          details,
          String(body.urgency || '').trim() || 'medium',
          userId(user) || null,
        ],
      )
      const row = created?.rows?.[0]
      await upsertMaintenanceWorkTask(client, 'external', row)
      await insertMaintenanceWorkflowEvent(client, {
        domain: 'external',
        recordId: id,
        eventType: 'created',
        fromStatus: '',
        toStatus: 'pending_assignment',
        actorUserId: userId(user),
        actorName: userName(user),
        reason: null,
        payload: { order_no: orderNo },
      })
      await client.query('COMMIT')
      return res.status(201).json(workflowResponse('external', row, user))
    } catch (error) {
      try { await client.query('ROLLBACK') } catch {}
      throw error
    } finally {
      client.release()
    }
  } catch (e: any) {
    if (e instanceof MaintenanceWorkflowError) return res.status(e.statusCode).json({ code: e.code })
    if (String(e?.code || '') === '23505') return res.status(409).json({ code: 'external_maintenance_order_no_conflict' })
    return res.status(500).json({ message: e?.message || 'external_maintenance_create_failed' })
  }
})

router.post('/workflow/:domain/:id/:action', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const domain = workflowDomain(req.params.domain)
  const id = String(req.params.id || '').trim()
  const action = workflowAction(req.params.action, req.body?.decision)
  if (!domain || !id || !action) return res.status(400).json({ code: 'maintenance_workflow_request_invalid' })

  const body = req.body || {}
  const reason = String(body.reason || body.review_note || body.note || '').trim() || null
  const completionPhotoUrls = nonEmptyStrings(body.completion_photo_urls)
  const actorId = userId(user)
  const operationId = String(body.operation_id || '').trim()
  if (operationId.length > IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH) {
    return res.status(400).json({ code: 'maintenance_operation_id_invalid' })
  }
  const recordPatch = domain === 'internal' && action === 'assign'
    ? internalAssignmentRecordPatch(body.record_patch)
    : {}
  const receiptScope = operationId
    ? {
        scopeType: 'maintenance_workflow_action',
        scopeId: `${domain}:${id}:${actorId}`,
        submitId: operationId,
        stepKey: action,
      }
    : null
  const receiptPayloadHash = receiptScope
      ? buildIdempotencyPayloadHash({
        action,
        assignee_id: String(body.assignee_id || '').trim() || null,
        scheduled_date: body.scheduled_date == null ? null : String(body.scheduled_date || '').trim(),
        record_patch: recordPatch,
        completion_photo_urls: completionPhotoUrls,
        completion_note: String(body.completion_note || body.note || '').trim() || null,
        reason,
      })
    : ''
  try {
    await ensureMaintenanceWorkflowFoundation(pgPool)
    await ensureMaintenanceWorkTasksTable(pgPool)
    if (receiptScope) await ensureIdempotentStepReceiptsTable(pgPool)
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query(`SELECT * FROM ${workflowTable(domain)} WHERE id=$1 FOR UPDATE`, [id])
      let row = locked?.rows?.[0] || null
      if (!row) throw new MaintenanceWorkflowError(404, 'maintenance_not_found')
      if (receiptScope) {
        const receipt = await loadIdempotentStepReceipt(client, receiptScope)
        if (receipt) {
          if (String(receipt.payload_hash || '') !== receiptPayloadHash) {
            throw new MaintenanceWorkflowError(409, 'maintenance_idempotency_conflict')
          }
          await client.query('COMMIT')
          return res.json(receipt.response_json || { ok: true })
        }
      }
      if (domain === 'internal') {
        row = await reconcileLegacyInternalMaintenanceAssignee(client, row, user, action)
      }
      const status = normalizeMaintenanceWorkflowStatus(row.status, row.review_status)
      const assignedExecutor = !!userId(user) && String(row.assignee_id || '').trim() === userId(user)
      const existingCompletionPhotoUrls = nonEmptyStrings(row.completion_photo_urls)
      const legacyCompletionPhotoUrls = existingCompletionPhotoUrls.length ? [] : nonEmptyStrings(row.repair_photo_urls)
      const validation = validateMaintenanceWorkflowAction({
        action,
        status,
        isManager: isMaintenanceManager(user),
        isAssignedExecutor: assignedExecutor,
        completionPhotoCount: action === 'submit' || action === 'executor_complete'
          ? completionPhotoUrls.length
          : existingCompletionPhotoUrls.length || legacyCompletionPhotoUrls.length,
        reason,
      })
      if (!validation.ok) {
        const statusCode = validation.code === 'maintenance_completion_photo_required'
          ? 422
          : validation.code.includes('reason_required')
            ? 400
            : validation.code === 'maintenance_transition_invalid'
              ? 409
              : 403
        throw new MaintenanceWorkflowError(statusCode, validation.code)
      }

      const actorName = userName(user)
      let patch: Record<string, any> = {}
      let nextStatus = status
      let eventFromStatus = status
      let eventType: string = action
      if (action === 'assign') {
        const assigneeId = String(body.assignee_id || '').trim()
        if (!assigneeId) throw new MaintenanceWorkflowError(400, 'maintenance_assignee_required')
        const assigneeResult = await client.query('SELECT id FROM users WHERE id::text = $1 LIMIT 1', [assigneeId])
        if (!assigneeResult?.rows?.[0]) throw new MaintenanceWorkflowError(400, 'maintenance_assignee_not_found')
        const scheduledDate = body.scheduled_date === undefined
          ? (domain === 'internal' ? dateOnly(row.eta) : dateOnly(row.scheduled_date))
          : dateOnly(body.scheduled_date)
        if (body.scheduled_date !== undefined && body.scheduled_date !== null && body.scheduled_date !== '' && !scheduledDate) {
          throw new MaintenanceWorkflowError(400, 'maintenance_invalid_date')
        }
        nextStatus = 'assigned'
        patch = {
          status: nextStatus,
          assignee_id: assigneeId,
          assigned_at: new Date().toISOString(),
          assigned_by: actorId || null,
          ...(domain === 'internal' ? { eta: scheduledDate } : { scheduled_date: scheduledDate }),
        }
        eventType = String(row.assignee_id || '').trim() && String(row.assignee_id || '').trim() !== assigneeId ? 'reassigned' : 'assigned'
      } else if (action === 'start') {
        nextStatus = 'in_progress'
        patch = { status: nextStatus, started_at: row.started_at || new Date().toISOString() }
      } else if (action === 'submit') {
        nextStatus = 'pending_review'
        patch = {
          status: nextStatus,
          submitted_at: new Date().toISOString(),
          completion_photo_urls: JSON.stringify(completionPhotoUrls),
          ...(domain === 'internal'
            ? { repair_notes: String(body.completion_note || body.note || '').trim() || null }
            : { completion_notes: String(body.completion_note || body.note || '').trim() || null }),
        }
      } else if (action === 'executor_complete') {
        const startedAt = row.started_at || new Date().toISOString()
        if (status === 'assigned') {
          await insertMaintenanceWorkflowEvent(client, {
            domain,
            recordId: id,
            eventType: 'started',
            fromStatus: status,
            toStatus: 'in_progress',
            actorUserId: actorId,
            actorName,
            reason: null,
            payload: { implicit: true },
          })
          eventFromStatus = 'in_progress'
        }
        nextStatus = 'pending_review'
        patch = {
          status: nextStatus,
          started_at: startedAt,
          submitted_at: new Date().toISOString(),
          completion_photo_urls: JSON.stringify(completionPhotoUrls),
          ...(domain === 'internal'
            ? { repair_notes: String(body.completion_note || body.note || '').trim() || null }
            : { completion_notes: String(body.completion_note || body.note || '').trim() || null }),
        }
        eventType = 'executor_completed'
      } else if (action === 'executor_unfinished') {
        const startedAt = row.started_at || new Date().toISOString()
        if (status === 'assigned') {
          await insertMaintenanceWorkflowEvent(client, {
            domain,
            recordId: id,
            eventType: 'started',
            fromStatus: status,
            toStatus: 'in_progress',
            actorUserId: actorId,
            actorName,
            reason: null,
            payload: { implicit: true },
          })
          eventFromStatus = 'in_progress'
        }
        nextStatus = 'in_progress'
        patch = {
          status: nextStatus,
          started_at: startedAt,
          ...(completionPhotoUrls.length ? { completion_photo_urls: JSON.stringify(completionPhotoUrls) } : {}),
          ...(domain === 'internal'
            ? { repair_notes: String(body.completion_note || body.note || '').trim() || null }
            : { completion_notes: String(body.completion_note || body.note || '').trim() || null }),
          completion_reason: reason,
        }
        eventType = 'executor_unfinished'
      } else if (action === 'review_approved') {
        nextStatus = 'closed'
        patch = {
          status: nextStatus,
          review_status: 'approved',
          reviewed_at: new Date().toISOString(),
          reviewed_by: actorId || null,
          review_note: reason,
          closed_at: new Date().toISOString(),
          closed_by: actorId || null,
        }
      } else if (action === 'review_rejected') {
        nextStatus = 'in_progress'
        patch = {
          status: nextStatus,
          review_status: 'rejected',
          reviewed_at: new Date().toISOString(),
          reviewed_by: actorId || null,
          review_note: reason,
        }
      } else if (action === 'reopen') {
        nextStatus = 'in_progress'
        patch = {
          status: nextStatus,
          review_status: 'reopened',
          reopened_at: new Date().toISOString(),
          reopened_by: actorId || null,
          reopen_reason: reason,
          closed_at: null,
          closed_by: null,
        }
      } else if (action === 'cancel') {
        nextStatus = 'cancelled'
        patch = {
          status: nextStatus,
          cancelled_at: new Date().toISOString(),
          cancelled_by: actorId || null,
          cancel_reason: reason,
        }
      }

      const updated = await updateMaintenanceWorkflowRecord(client, domain, id, { ...recordPatch, ...patch })
      await upsertMaintenanceWorkTask(client, domain, updated)
      await insertMaintenanceWorkflowEvent(client, {
        domain,
        recordId: id,
        eventType,
        fromStatus: eventFromStatus,
        toStatus: nextStatus,
        actorUserId: actorId,
        actorName,
        reason,
        payload: action === 'assign'
          ? { assignee_id: updated.assignee_id || null, updated_fields: Object.keys(recordPatch) }
          : { completion_photo_count: completionPhotoUrls.length },
      })
      const response = workflowResponse(domain, updated, user)
      if (receiptScope) await saveIdempotentStepReceipt(client, receiptScope, receiptPayloadHash, response)
      await client.query('COMMIT')
      return res.json(response)
    } catch (error) {
      try { await client.query('ROLLBACK') } catch {}
      throw error
    } finally {
      client.release()
    }
  } catch (e: any) {
    if (e instanceof MaintenanceWorkflowError) return res.status(e.statusCode).json({ code: e.code })
    return res.status(500).json({ message: e?.message || 'maintenance_workflow_action_failed' })
  }
})

export default router
