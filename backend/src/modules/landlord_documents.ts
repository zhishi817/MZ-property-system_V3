import { Router } from 'express'
import crypto from 'crypto'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { hasR2, r2GetObjectByKey, r2Upload } from '../r2'
import { requireAnyPerm } from '../auth'
import { addAudit } from '../store'
import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'
import { generateLandlordDocumentPdf, type LandlordDocumentType } from '../lib/landlordDocumentPdf'

export const router = Router()
export const publicRouter = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
})

const VIEW_PERMS = ['landlord.manage', 'landlords.view', 'landlords.write']
const WRITE_PERMS = ['landlord.manage']
const TYPES = ['agency_authority', 'property_service_agreement'] as const
const STATUSES = ['draft', 'sent_for_signature', 'signed', 'archived'] as const
const AGENCY_AUTHORITY_TEMPLATE_VERSION = 'authorisation-detail-v3-onepage-2026-05-18'

const createSchema = z.object({
  type: z.enum(TYPES),
  landlord_id: z.string().trim().optional().nullable(),
  property_id: z.string().trim().optional().nullable(),
  status: z.enum(STATUSES).optional(),
  fields: z.record(z.any()).optional(),
  notes: z.string().optional().nullable(),
})

const patchSchema = z.object({
  landlord_id: z.string().trim().optional().nullable(),
  property_id: z.string().trim().optional().nullable(),
  status: z.enum(STATUSES).optional(),
  fields: z.record(z.any()).optional(),
  notes: z.string().optional().nullable(),
})

const mzSignSchema = z.object({
  signed_name: z.string().trim().min(1),
  signature_data_url: z.string().trim().min(1),
})

const landlordSignSchema = z.object({
  signed_name: z.string().trim().min(1),
  signature_data_url: z.string().trim().min(1),
})

async function ensureLandlordDocumentsTables() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS landlord_documents (
    id text PRIMARY KEY,
    type text NOT NULL,
    document_no text,
    landlord_id text REFERENCES landlords(id) ON DELETE SET NULL,
    property_id text REFERENCES properties(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'draft',
    fields jsonb NOT NULL DEFAULT '{}'::jsonb,
    notes text,
    current_draft_version_id text,
    current_signed_version_id text,
    created_by text,
    updated_by text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );`)
  await pgPool.query(`CREATE TABLE IF NOT EXISTS landlord_document_versions (
    id text PRIMARY KEY,
    document_id text NOT NULL REFERENCES landlord_documents(id) ON DELETE CASCADE,
    kind text NOT NULL,
    version_no integer NOT NULL,
    file_url text NOT NULL,
    file_key text,
    file_name text,
    file_size integer,
    content_type text,
    is_current boolean DEFAULT false,
    notes text,
    created_by text,
    created_at timestamptz DEFAULT now()
  );`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_landlord_documents_type_status ON landlord_documents(type, status);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_landlord_documents_landlord ON landlord_documents(landlord_id);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_landlord_documents_property ON landlord_documents(property_id);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_landlord_document_versions_doc ON landlord_document_versions(document_id, kind, version_no DESC);`)
}

function actorOf(req: any) {
  const u = req?.user || {}
  return String(u.sub || u.username || '').trim() || null
}

function cleanId(v: any) {
  const s = String(v || '').trim()
  return s || null
}

function documentPrefix(type: string) {
  return type === 'agency_authority' ? 'AA' : 'SA'
}

function nextDocumentNo(type: string) {
  return `${documentPrefix(type)}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function sha256Hex(input: string) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex')
}

function isImageDataUrl(value: string) {
  return /^data:image\/(png|jpeg|jpg);base64,/i.test(String(value || '').trim())
}

async function loadDefaults(landlordId?: string | null, propertyId?: string | null) {
  if (!pgPool) return {}
  let landlord: any = null
  let property: any = null
  if (propertyId) {
    const pr = await pgPool.query('SELECT * FROM properties WHERE id=$1 LIMIT 1', [propertyId])
    property = pr.rows?.[0] || null
    if (!landlordId && property?.landlord_id) landlordId = String(property.landlord_id)
  }
  if (landlordId) {
    const lr = await pgPool.query('SELECT * FROM landlords WHERE id=$1 LIMIT 1', [landlordId])
    landlord = lr.rows?.[0] || null
  }
  const emails = Array.isArray(landlord?.emails) ? landlord.emails : []
  const ownerEmail = String(emails[0] || landlord?.email || '').trim()
  const capacity = property?.capacity == null ? '' : String(property.capacity)
  const propertyType = [property?.type, capacity ? `${capacity} guests` : '', property?.parking_space ? `${property.parking_space} parking space` : ''].filter(Boolean).join(', ')
  return {
    landlord_name: landlord?.name || '',
    landlord_email: ownerEmail,
    landlord_phone: landlord?.phone || '',
    landlord_abn: landlord?.abn || '',
    owner_name: landlord?.name || '',
    owner_email: ownerEmail,
    owner_phone: landlord?.phone || '',
    bsb: landlord?.payout_bsb || '',
    account_number: landlord?.payout_account || '',
    account_name: landlord?.name || '',
    property_address: property?.address || '',
    property_code: property?.code || '',
    property_type_description: propertyType,
    parking_details: property?.parking_space || property?.parking_type || '',
    maximum_guests: capacity,
    mz_agent_name: 'Ming Xue',
    mz_contact_phone: '+61 430 907 988',
    mz_contact_email: 'info@mzproperty.com.au',
    termination_notice_days: '60',
    repair_approval_limit: '300',
    utilities_paid_by: 'paid by Owner',
    investment_or_holiday: 'Investment',
    term: 'Ongoing with 3-months termination notice',
    initial_property_visit: 'Included',
    setup_fee: '$0.00',
    management_fee: '50%/Month',
    consumable_fee: '$0.00 /Month',
    linen_fee: 'Included',
    initial_housekeeping_fee: 'TBC',
    installation_fee: '$0.00',
    purchase_fee: '$0.00',
    photography_fee: '$0.00',
  }
}

async function buildFields(landlordId: string | null, propertyId: string | null, fields: Record<string, any>) {
  const defaults = await loadDefaults(landlordId, propertyId)
  return { ...defaults, ...(fields || {}) }
}

function parseFields(raw: any): Record<string, any> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw)
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
    } catch {
      return {}
    }
  }
  return {}
}

function withDocumentTemplateVersion(type: any, fields: Record<string, any>) {
  if (type === 'agency_authority') {
    return { ...fields, agency_authority_template_version: AGENCY_AUTHORITY_TEMPLATE_VERSION }
  }
  return fields
}

function safeFilenamePart(value: any) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function documentDownloadFilename(row: any, suffix = '') {
  const fields = parseFields(row?.fields)
  const propertyCode = safeFilenamePart(row?.property_code || fields.property_code)
  const documentNo = safeFilenamePart(row?.document_no || row?.id)
  return [propertyCode, documentNo].filter(Boolean).join('-') + `${suffix}.pdf`
}

async function loadDocument(id: string) {
  await ensureLandlordDocumentsTables()
  const r = await pgPool!.query(
    `SELECT d.*,
            l.name AS landlord_name,
            p.code AS property_code,
            p.address AS property_address,
            dv.file_url AS current_draft_url,
            dv.file_key AS current_draft_file_key,
            dv.file_name AS current_draft_file_name,
            sv.file_url AS current_signed_url,
            sv.file_key AS current_signed_file_key,
            sv.file_name AS current_signed_file_name
     FROM landlord_documents d
     LEFT JOIN landlords l ON l.id = d.landlord_id
     LEFT JOIN properties p ON p.id = d.property_id
     LEFT JOIN landlord_document_versions dv ON dv.id = d.current_draft_version_id
     LEFT JOIN landlord_document_versions sv ON sv.id = d.current_signed_version_id
     WHERE d.id=$1
     LIMIT 1`,
    [id]
  )
  const row = r.rows?.[0] || null
  if (!row) return null
  const vr = await pgPool!.query('SELECT * FROM landlord_document_versions WHERE document_id=$1 ORDER BY kind, version_no DESC, created_at DESC', [id])
  return { ...row, versions: vr.rows || [] }
}

async function updateDocumentFields(id: string, fields: Record<string, any>, actor: string | null, status?: string) {
  const keys: string[] = []
  const values: any[] = []
  const add = (k: string, v: any) => { keys.push(k); values.push(v) }
  add('fields', JSON.stringify(fields))
  if (status !== undefined) add('status', status)
  add('updated_by', actor)
  add('updated_at', new Date().toISOString())
  const set = keys.map((k, i) => `"${k}" = $${i + 1}${k === 'fields' ? '::jsonb' : ''}`).join(', ')
  const r = await pgPool!.query(`UPDATE landlord_documents SET ${set} WHERE id=$${keys.length + 1} RETURNING *`, [...values, id])
  return r.rows?.[0] || null
}

async function createDraftVersion(documentId: string, actor: string | null, notes: string, nextStatus?: string) {
  if (!hasR2) throw new Error('R2 not configured')
  const doc = await loadDocument(documentId)
  if (!doc) throw new Error('not found')
  const versionNo = await nextVersionNo(documentId, 'draft')
  const fields = withDocumentTemplateVersion(doc.type, parseFields(doc.fields))
  const built = await generateLandlordDocumentPdf({
    type: doc.type as LandlordDocumentType,
    documentNo: doc.document_no,
    fields,
  })
  const key = `landlord-documents/drafts/${documentId}/v${versionNo}.pdf`
  const url = await r2Upload(key, 'application/pdf', built.pdf)
  const out = await pgRunInTransaction(async (client) => {
    await client.query('UPDATE landlord_document_versions SET is_current=false WHERE document_id=$1 AND kind=$2', [documentId, 'draft'])
    const vr = await client.query(
      `INSERT INTO landlord_document_versions(id, document_id, kind, version_no, file_url, file_key, file_name, file_size, content_type, is_current, notes, created_by, created_at)
       VALUES($1,$2,'draft',$3,$4,$5,$6,$7,'application/pdf',true,$8,$9,now())
       RETURNING *`,
      [uuidv4(), documentId, versionNo, url, key, built.filename, built.pdf.byteLength, notes, actor]
    )
    const version = vr.rows[0]
    if (nextStatus !== undefined) {
      await client.query('UPDATE landlord_documents SET fields=$1::jsonb, current_draft_version_id=$2, status=$3, updated_by=$4, updated_at=now() WHERE id=$5', [JSON.stringify(fields), version.id, nextStatus, actor, documentId])
    } else {
      await client.query('UPDATE landlord_documents SET fields=$1::jsonb, current_draft_version_id=$2, updated_by=$3, updated_at=now() WHERE id=$4', [JSON.stringify(fields), version.id, actor, documentId])
    }
    return version
  })
  return { version: out, document: await loadDocument(documentId) }
}

async function createSignedVersion(documentId: string, fields: Record<string, any>, actor: string | null, notes: string) {
  if (!hasR2) throw new Error('R2 not configured')
  const doc = await loadDocument(documentId)
  if (!doc) throw new Error('not found')
  const versionNo = await nextVersionNo(documentId, 'signed')
  const signedFields = withDocumentTemplateVersion(doc.type, fields)
  const built = await generateLandlordDocumentPdf({
    type: doc.type as LandlordDocumentType,
    documentNo: doc.document_no,
    fields: signedFields,
  })
  const key = `landlord-documents/signed/${documentId}/v${versionNo}.pdf`
  const url = await r2Upload(key, 'application/pdf', built.pdf)
  const out = await pgRunInTransaction(async (client) => {
    await client.query('UPDATE landlord_document_versions SET is_current=false WHERE document_id=$1 AND kind=$2', [documentId, 'signed'])
    const vr = await client.query(
      `INSERT INTO landlord_document_versions(id, document_id, kind, version_no, file_url, file_key, file_name, file_size, content_type, is_current, notes, created_by, created_at)
       VALUES($1,$2,'signed',$3,$4,$5,$6,$7,'application/pdf',true,$8,$9,now())
       RETURNING *`,
      [uuidv4(), documentId, versionNo, url, key, built.filename, built.pdf.byteLength, notes, actor]
    )
    const version = vr.rows[0]
    await client.query(
      'UPDATE landlord_documents SET fields=$1::jsonb, current_signed_version_id=$2, status=$3, updated_by=$4, updated_at=now() WHERE id=$5',
      [JSON.stringify(signedFields), version.id, 'signed', actor, documentId]
    )
    return version
  })
  return { version: out, document: await loadDocument(documentId) }
}

async function loadPublicSigningDocumentByToken(token: string) {
  await ensureLandlordDocumentsTables()
  const tokenHash = sha256Hex(token)
  const r = await pgPool!.query(
    `SELECT d.*,
            l.name AS landlord_name,
            p.code AS property_code,
            p.address AS property_address,
            dv.file_url AS current_draft_url,
            dv.file_key AS current_draft_file_key,
            dv.file_name AS current_draft_file_name
     FROM landlord_documents d
     LEFT JOIN landlords l ON l.id = d.landlord_id
     LEFT JOIN properties p ON p.id = d.property_id
     LEFT JOIN landlord_document_versions dv ON dv.id = d.current_draft_version_id
     WHERE d.status <> 'archived'
       AND d.fields->>'landlord_sign_token_hash' = $1
       AND COALESCE(NULLIF(d.fields->>'landlord_sign_expires_at', '')::timestamptz, now() - interval '1 day') > now()
     LIMIT 1`,
    [tokenHash]
  )
  return r.rows?.[0] || null
}

router.get('/', requireAnyPerm(VIEW_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureLandlordDocumentsTables()
    const q: any = req.query || {}
    const values: any[] = []
    const where: string[] = []
    const type = String(q.type || '').trim()
    const status = String(q.status || '').trim()
    if (type) {
      if (!TYPES.includes(type as any)) return res.status(400).json({ message: 'invalid type' })
      values.push(type); where.push(`d.type=$${values.length}`)
    }
    if (status) {
      if (!STATUSES.includes(status as any)) return res.status(400).json({ message: 'invalid status' })
      values.push(status); where.push(`d.status=$${values.length}`)
    } else if (String(q.include_archived || '').toLowerCase() !== 'true') {
      where.push(`d.status <> 'archived'`)
    }
    const landlordId = cleanId(q.landlord_id)
    if (landlordId) { values.push(landlordId); where.push(`d.landlord_id=$${values.length}`) }
    const propertyId = cleanId(q.property_id)
    if (propertyId) { values.push(propertyId); where.push(`d.property_id=$${values.length}`) }
    const sql = `SELECT d.*,
                        l.name AS landlord_name,
                        p.code AS property_code,
                        p.address AS property_address,
                        dv.file_url AS current_draft_url,
                        sv.file_url AS current_signed_url
                 FROM landlord_documents d
                 LEFT JOIN landlords l ON l.id = d.landlord_id
                 LEFT JOIN properties p ON p.id = d.property_id
                 LEFT JOIN landlord_document_versions dv ON dv.id = d.current_draft_version_id
                 LEFT JOIN landlord_document_versions sv ON sv.id = d.current_signed_version_id
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC`
    const r = await pgPool.query(sql, values)
    return res.json(r.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list failed' })
  }
})

router.get('/:id', requireAnyPerm(VIEW_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const row = await loadDocument(String(req.params.id || ''))
    if (!row) return res.status(404).json({ message: 'not found' })
    return res.json(row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'get failed' })
  }
})

router.post('/', requireAnyPerm(WRITE_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureLandlordDocumentsTables()
    const parsed = createSchema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json(parsed.error.format())
    const v = parsed.data
    const landlordId = cleanId(v.landlord_id)
    const propertyId = cleanId(v.property_id)
    const fields = await buildFields(landlordId, propertyId, parseFields(v.fields))
    if (!String(fields.property_address || '').trim()) return res.status(400).json({ message: 'missing property_address' })
    const ownerName = String(fields.landlord_name || fields.owner_name || '').trim()
    if (!ownerName) return res.status(400).json({ message: 'missing landlord_name' })
    const actor = actorOf(req)
    const row = await pgPool.query(
      `INSERT INTO landlord_documents(id, type, document_no, landlord_id, property_id, status, fields, notes, created_by, updated_by, created_at, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9,now(),now())
       RETURNING *`,
      [uuidv4(), v.type, nextDocumentNo(v.type), landlordId, propertyId, v.status || 'draft', JSON.stringify(fields), v.notes || null, actor]
    )
    const out = row.rows?.[0]
    const createdId = String(out?.id || '')
    let responseDoc: any = out
    if (createdId && hasR2) {
      const generated = await createDraftVersion(createdId, actor, 'Auto draft on create', 'draft')
      responseDoc = generated.document
    }
    addAudit('LandlordDocument', createdId, 'create', null, responseDoc, actor || undefined)
    return res.status(201).json(responseDoc)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create failed' })
  }
})

router.patch('/:id', requireAnyPerm(WRITE_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureLandlordDocumentsTables()
    const id = String(req.params.id || '').trim()
    const parsed = patchSchema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json(parsed.error.format())
    const before = await loadDocument(id)
    if (!before) return res.status(404).json({ message: 'not found' })
    const patch = parsed.data
    const landlordId = patch.landlord_id !== undefined ? cleanId(patch.landlord_id) : before.landlord_id
    const propertyId = patch.property_id !== undefined ? cleanId(patch.property_id) : before.property_id
    const existingFields = parseFields(before.fields)
    const fields = patch.fields !== undefined ? await buildFields(landlordId, propertyId, { ...existingFields, ...parseFields(patch.fields) }) : existingFields
    const actor = actorOf(req)
    const keys: string[] = []
    const values: any[] = []
    const add = (k: string, v: any) => { keys.push(k); values.push(v) }
    if (patch.landlord_id !== undefined) add('landlord_id', landlordId)
    if (patch.property_id !== undefined) add('property_id', propertyId)
    if (patch.status !== undefined) add('status', patch.status)
    if (patch.fields !== undefined) add('fields', JSON.stringify(fields))
    if (patch.notes !== undefined) add('notes', patch.notes || null)
    add('updated_by', actor)
    add('updated_at', new Date().toISOString())
    const set = keys.map((k, i) => `"${k}" = $${i + 1}${k === 'fields' ? '::jsonb' : ''}`).join(', ')
    const r = await pgPool.query(`UPDATE landlord_documents SET ${set} WHERE id=$${keys.length + 1} RETURNING *`, [...values, id])
    const out = r.rows?.[0] || null
    const contentChanged = patch.landlord_id !== undefined || patch.property_id !== undefined || patch.fields !== undefined
    let responseDoc: any = out
    if (contentChanged && hasR2) {
      const generated = await createDraftVersion(id, actor, 'Auto draft on update', patch.status || 'draft')
      responseDoc = generated.document
    } else {
      responseDoc = await loadDocument(id)
    }
    addAudit('LandlordDocument', id, 'update', before, responseDoc, actor || undefined)
    return res.json(responseDoc)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update failed' })
  }
})

router.post('/:id/mz-sign', requireAnyPerm(WRITE_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    const id = String(req.params.id || '').trim()
    const parsed = mzSignSchema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json(parsed.error.format())
    const signature = String(parsed.data.signature_data_url || '').trim()
    if (!isImageDataUrl(signature)) return res.status(400).json({ message: 'invalid signature image' })
    const before = await loadDocument(id)
    if (!before) return res.status(404).json({ message: 'not found' })
    if (String(before.status || '') === 'signed') return res.status(409).json({ message: 'already_signed' })
    const fields = {
      ...parseFields(before.fields),
      mz_signed_name: parsed.data.signed_name,
      mz_signature_data_url: signature,
      mz_signed_at: new Date().toISOString(),
      landlord_sign_token_hash: '',
      landlord_sign_expires_at: '',
    }
    const actor = actorOf(req)
    await updateDocumentFields(id, fields, actor, 'draft')
    const out = await createDraftVersion(id, actor, 'MZ e-sign draft refresh', 'draft')
    addAudit('LandlordDocument', id, 'mz_sign', before, out.document, actor || undefined)
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'mz sign failed' })
  }
})

router.post('/:id/request-landlord-sign', requireAnyPerm(WRITE_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    const id = String(req.params.id || '').trim()
    const before = await loadDocument(id)
    if (!before) return res.status(404).json({ message: 'not found' })
    if (String(before.status || '') === 'signed') return res.status(409).json({ message: 'already_signed' })
    const fields = parseFields(before.fields)
    if (!String(fields.mz_signature_data_url || '').trim()) return res.status(400).json({ message: 'missing_mz_signature' })
    const actor = actorOf(req)
    const token = randomToken()
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
    const merged = {
      ...fields,
      landlord_sign_token_hash: sha256Hex(token),
      landlord_sign_expires_at: expiresAt,
      landlord_sign_requested_at: new Date().toISOString(),
    }
    await updateDocumentFields(id, merged, actor, 'sent_for_signature')
    const out = await createDraftVersion(id, actor, 'Request landlord e-sign', 'sent_for_signature')
    addAudit('LandlordDocument', id, 'request_landlord_sign', before, out.document, actor || undefined)
    return res.json({ token, expires_at: expiresAt, document: out.document })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'request landlord sign failed' })
  }
})

router.post('/:id/generate-pdf', requireAnyPerm(WRITE_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    await ensureLandlordDocumentsTables()
    const id = String(req.params.id || '').trim()
    const doc = await loadDocument(id)
    if (!doc) return res.status(404).json({ message: 'not found' })
    const actor = actorOf(req)
    const nextStatus = String(doc.status || '').trim() || 'draft'
    const out = await createDraftVersion(id, actor, String(req.body?.notes || ''), nextStatus)
    addAudit('LandlordDocument', id, 'generate_pdf', doc, out.document, actor || undefined)
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'generate pdf failed' })
  }
})

async function nextVersionNo(documentId: string, kind: 'draft' | 'signed') {
  const r = await pgPool!.query('SELECT COALESCE(MAX(version_no),0)::int + 1 AS n FROM landlord_document_versions WHERE document_id=$1 AND kind=$2', [documentId, kind])
  return Number(r.rows?.[0]?.n || 1)
}

router.get('/:id/download-current-draft', requireAnyPerm(VIEW_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    const id = String(req.params.id || '').trim()
    await ensureLandlordDocumentsTables()
    const r = await pgPool.query(
      `SELECT v.* FROM landlord_documents d
       JOIN landlord_document_versions v ON v.id = d.current_draft_version_id
       WHERE d.id=$1 LIMIT 1`,
      [id]
    )
    const v = r.rows?.[0] || null
    if (!v?.file_key) return res.status(404).json({ message: 'draft not found' })
    const obj = await r2GetObjectByKey(String(v.file_key))
    if (!obj?.body?.length) return res.status(404).json({ message: 'file not found' })
    const doc = await loadDocument(id)
    const filename = documentDownloadFilename(doc || { id }, '')
    res.setHeader('Content-Type', obj.contentType || 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.status(200).send(obj.body)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'download failed' })
  }
})

router.get('/:id/download-current-signed', requireAnyPerm(VIEW_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    const id = String(req.params.id || '').trim()
    await ensureLandlordDocumentsTables()
    const r = await pgPool.query(
      `SELECT v.* FROM landlord_documents d
       JOIN landlord_document_versions v ON v.id = d.current_signed_version_id
       WHERE d.id=$1 LIMIT 1`,
      [id]
    )
    const v = r.rows?.[0] || null
    if (!v?.file_key) return res.status(404).json({ message: 'signed version not found' })
    const obj = await r2GetObjectByKey(String(v.file_key))
    if (!obj?.body?.length) return res.status(404).json({ message: 'file not found' })
    const doc = await loadDocument(id)
    const filename = documentDownloadFilename(doc || { id }, '-signed')
    res.setHeader('Content-Type', obj.contentType || 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.status(200).send(obj.body)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'download signed failed' })
  }
})

router.post('/:id/signed-versions/upload', requireAnyPerm(WRITE_PERMS), upload.single('file'), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    if (!req.file) return res.status(400).json({ message: 'missing file' })
    const file = req.file
    const mime = String(file.mimetype || '').toLowerCase()
    if (mime && mime !== 'application/pdf') return res.status(400).json({ message: 'only pdf allowed' })
    const id = String(req.params.id || '').trim()
    const doc = await loadDocument(id)
    if (!doc) return res.status(404).json({ message: 'not found' })
    const versionNo = await nextVersionNo(id, 'signed')
    const key = `landlord-documents/signed/${id}/v${versionNo}.pdf`
    const url = await r2Upload(key, 'application/pdf', (file as any).buffer)
    const actor = actorOf(req)
    const notes = String((req.body as any)?.notes || '').trim()
    const out = await pgRunInTransaction(async (client) => {
      await client.query('UPDATE landlord_document_versions SET is_current=false WHERE document_id=$1 AND kind=$2', [id, 'signed'])
      const vr = await client.query(
        `INSERT INTO landlord_document_versions(id, document_id, kind, version_no, file_url, file_key, file_name, file_size, content_type, is_current, notes, created_by, created_at)
         VALUES($1,$2,'signed',$3,$4,$5,$6,$7,'application/pdf',true,$8,$9,now())
         RETURNING *`,
        [uuidv4(), id, versionNo, url, key, file.originalname || `signed-v${versionNo}.pdf`, file.size || (file as any).buffer?.byteLength || 0, notes, actor]
      )
      const version = vr.rows[0]
      await client.query('UPDATE landlord_documents SET current_signed_version_id=$1, status=$2, updated_by=$3, updated_at=now() WHERE id=$4', [version.id, 'signed', actor, id])
      return version
    })
    addAudit('LandlordDocument', id, 'upload_signed', doc, out, actor || undefined)
    return res.status(201).json({ version: out, document: await loadDocument(id) })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload signed failed' })
  }
})

router.patch('/:id/signed-versions/:versionId/set-current', requireAnyPerm(WRITE_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureLandlordDocumentsTables()
    const id = String(req.params.id || '').trim()
    const versionId = String(req.params.versionId || '').trim()
    const actor = actorOf(req)
    const r0 = await pgPool.query('SELECT * FROM landlord_document_versions WHERE id=$1 AND document_id=$2 AND kind=$3 LIMIT 1', [versionId, id, 'signed'])
    const version = r0.rows?.[0] || null
    if (!version) return res.status(404).json({ message: 'not found' })
    await pgRunInTransaction(async (client) => {
      await client.query('UPDATE landlord_document_versions SET is_current=false WHERE document_id=$1 AND kind=$2', [id, 'signed'])
      await client.query('UPDATE landlord_document_versions SET is_current=true WHERE id=$1', [versionId])
      await client.query('UPDATE landlord_documents SET current_signed_version_id=$1, status=$2, updated_by=$3, updated_at=now() WHERE id=$4', [versionId, 'signed', actor, id])
    })
    addAudit('LandlordDocument', id, 'set_current_signed', null, version, actor || undefined)
    return res.json({ document: await loadDocument(id) })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'set current failed' })
  }
})

publicRouter.get('/landlord-documents/sign/:token', async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const token = String(req.params.token || '').trim()
    if (!token) return res.status(400).json({ message: 'missing token' })
    const row = await loadPublicSigningDocumentByToken(token)
    if (!row) return res.status(404).json({ message: 'not found' })
    const fields = parseFields(row.fields)
    return res.json({
      id: row.id,
      type: row.type,
      document_no: row.document_no,
      property_code: row.property_code,
      property_address: row.property_address || fields.property_address || '',
      landlord_name: row.landlord_name || fields.landlord_name || fields.owner_name || '',
      mz_signed_name: fields.mz_signed_name || fields.mz_agent_name || '',
      mz_signed_at: fields.mz_signed_at || '',
      landlord_signed_at: fields.landlord_signed_at || '',
      current_draft_url: row.current_draft_url || '',
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'get public sign document failed' })
  }
})

publicRouter.get('/landlord-documents/sign/:token/draft.pdf', async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    const token = String(req.params.token || '').trim()
    if (!token) return res.status(400).json({ message: 'missing token' })
    const row = await loadPublicSigningDocumentByToken(token)
    if (!row?.current_draft_file_key) return res.status(404).json({ message: 'draft not found' })
    const obj = await r2GetObjectByKey(String(row.current_draft_file_key))
    if (!obj?.body?.length) return res.status(404).json({ message: 'file not found' })
    const filename = String(row.current_draft_file_name || `${row.id}.pdf`).replace(/[^a-zA-Z0-9._-]/g, '_')
    res.setHeader('Content-Type', obj.contentType || 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
    return res.status(200).send(obj.body)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'public draft download failed' })
  }
})

publicRouter.post('/landlord-documents/sign/:token/submit', async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    const token = String(req.params.token || '').trim()
    if (!token) return res.status(400).json({ message: 'missing token' })
    const parsed = landlordSignSchema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json(parsed.error.format())
    const signature = String(parsed.data.signature_data_url || '').trim()
    if (!isImageDataUrl(signature)) return res.status(400).json({ message: 'invalid signature image' })
    const row = await loadPublicSigningDocumentByToken(token)
    if (!row) return res.status(404).json({ message: 'not found' })
    const fields = parseFields(row.fields)
    if (!String(fields.mz_signature_data_url || '').trim()) return res.status(409).json({ message: 'missing_mz_signature' })
    if (String(fields.landlord_signed_at || '').trim()) return res.status(409).json({ message: 'already_signed' })
    const merged = {
      ...fields,
      landlord_signed_name: parsed.data.signed_name,
      landlord_signature_data_url: signature,
      landlord_signed_at: new Date().toISOString(),
    }
    delete (merged as any).landlord_sign_token_hash
    delete (merged as any).landlord_sign_expires_at
    delete (merged as any).landlord_sign_requested_at
    const out = await createSignedVersion(String(row.id), merged, 'public_landlord_sign', 'Landlord e-sign completed')
    addAudit('LandlordDocument', String(row.id), 'landlord_sign_complete', row, out.document, 'public_landlord_sign')
    return res.json({ ok: true, document: out.document, signed_url: out.document?.current_signed_url || '' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'public sign failed' })
  }
})

router.delete('/:id', requireAnyPerm(WRITE_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureLandlordDocumentsTables()
    const id = String(req.params.id || '').trim()
    const before = await loadDocument(id)
    if (!before) return res.status(404).json({ message: 'not found' })
    const actor = actorOf(req)
    const r = await pgPool.query('UPDATE landlord_documents SET status=$1, updated_by=$2, updated_at=now() WHERE id=$3 RETURNING *', ['archived', actor, id])
    const out = r.rows?.[0] || null
    addAudit('LandlordDocument', id, 'archive', before, out, actor || undefined)
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'archive failed' })
  }
})

export default router
