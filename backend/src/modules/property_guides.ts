import { Router } from 'express'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import multer from 'multer'
import path from 'path'
import crypto from 'crypto'
import { requireAnyPerm } from '../auth'
import { hasPg, pgPool, pgSelect, pgInsert, pgUpdate, pgRunInTransaction } from '../dbAdapter'
import { hasR2, r2Upload } from '../r2'

export const router = Router()

const upload = multer({ storage: multer.memoryStorage() })

function sha256Hex(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function linkTokenKey() {
  const secret = String(process.env.JWT_SECRET || 'dev-secret')
  return crypto.createHash('sha256').update(secret).digest()
}

function encryptLinkToken(token: string) {
  const key = linkTokenKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(token, 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

function decryptLinkToken(tokenEnc: string) {
  const parts = String(tokenEnc || '').split(':')
  if (parts.length !== 3) return ''
  const [ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(ctB64, 'base64')
  const key = linkTokenKey()
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

function randomToken(bytes = 24) {
  const b64 = crypto.randomBytes(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function ensurePropertyGuidesTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_guides (
    id text PRIMARY KEY,
    property_id text NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    language text NOT NULL,
    version text NOT NULL,
    revision integer NOT NULL DEFAULT 1,
    status text NOT NULL,
    content_json jsonb,
    created_by text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz,
    published_at timestamptz
  );`)
  await pgPool.query('ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guides_property_id ON property_guides(property_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guides_lang ON property_guides(property_id, language);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guides_status ON property_guides(status);')
}

async function ensurePropertyGuideRevisionsTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_guide_revisions (
    id bigserial PRIMARY KEY,
    guide_id text NOT NULL REFERENCES property_guides(id) ON DELETE CASCADE,
    revision integer NOT NULL,
    action text NOT NULL,
    content_json jsonb,
    change_note text,
    changed_by text,
    changed_at timestamptz NOT NULL DEFAULT now()
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guide_revisions_guide_id ON property_guide_revisions(guide_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guide_revisions_changed_at ON property_guide_revisions(changed_at);')
}

async function ensurePropertyGuidePublicLinksTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_guide_public_links (
    token_hash text PRIMARY KEY,
    token_enc text,
    guide_id text NOT NULL REFERENCES property_guides(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );`)
  await pgPool.query('ALTER TABLE property_guide_public_links ADD COLUMN IF NOT EXISTS token_enc text')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guide_links_guide_id ON property_guide_public_links(guide_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guide_links_expires_at ON property_guide_public_links(expires_at);')
}

const guideStatusSchema = z.enum(['draft', 'published', 'archived'])

const guideBlockSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().optional(), type: z.literal('text'), text: z.string().optional() }),
  z.object({ id: z.string().optional(), type: z.literal('heading'), text: z.string().optional() }),
  z.object({ id: z.string().optional(), type: z.literal('image'), url: z.string().url().optional(), caption: z.string().optional() }),
  z.object({
    id: z.string().optional(),
    type: z.literal('steps'),
    title: z.string().optional(),
    steps: z.array(z.object({ title: z.string().optional(), text: z.string().optional(), url: z.string().url().optional(), caption: z.string().optional() })).optional(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal('wifi'),
    ssid: z.string().optional(),
    password: z.string().optional(),
    router_location: z.string().optional(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal('notice'),
    title: z.string().optional(),
    items: z.array(z.string()).optional(),
    text: z.string().optional(),
  }),
])

const guideContentSchema = z.object({
  sections: z.array(z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    blocks: z.array(guideBlockSchema).optional(),
  })).optional(),
}).passthrough()

const createSchema = z.object({
  property_id: z.string().min(1),
  language: z.string().min(1).max(24),
  version: z.string().min(1).max(64),
  content_json: guideContentSchema.optional(),
})

const updateSchema = z.object({
  language: z.string().min(1).max(24).optional(),
  version: z.string().min(1).max(64).optional(),
  status: guideStatusSchema.optional(),
  content_json: guideContentSchema.optional(),
  change_note: z.string().max(200).optional(),
})

router.get('/', requireAnyPerm(['property_guides.view', 'rbac.manage']), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidesTable()
    const q: any = req.query || {}
    const property_id = q.property_id ? String(q.property_id) : ''
    const language = q.language ? String(q.language) : ''
    const status = q.status ? String(q.status) : ''
    const filters: any = {}
    if (property_id) filters.property_id = property_id
    if (language) filters.language = language
    if (status) filters.status = status
    const where: string[] = []
    const vals: any[] = []
    Object.keys(filters).forEach((k) => {
      vals.push(filters[k])
      where.push(`"${k}" = $${vals.length}`)
    })
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    const rows = await pgPool.query(`SELECT * FROM property_guides${clause} ORDER BY updated_at DESC NULLS LAST, created_at DESC`, vals)
    return res.json(rows?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list failed' })
  }
})

router.post('/', requireAnyPerm(['property_guides.write', 'rbac.manage']), async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidesTable()
    await ensurePropertyGuideRevisionsTable()
    const user = (req as any).user || {}
    const id = uuidv4()
    const payload: any = {
      id,
      property_id: parsed.data.property_id,
      language: parsed.data.language,
      version: parsed.data.version,
      revision: 1,
      status: 'draft',
      content_json: parsed.data.content_json || { sections: [] },
      created_by: user?.sub || null,
      updated_by: user?.sub || null,
      updated_at: new Date().toISOString(),
    }
    const row = await pgInsert('property_guides', payload)
    await pgInsert('property_guide_revisions', {
      guide_id: id,
      revision: 1,
      action: 'create',
      content_json: (row as any)?.content_json ?? payload.content_json,
      change_note: null,
      changed_by: user?.sub || null,
      changed_at: new Date().toISOString(),
    })
    return res.status(201).json(row || payload)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create failed' })
  }
})

router.patch('/:id', requireAnyPerm(['property_guides.write', 'rbac.manage']), async (req, res) => {
  const { id } = req.params as any
  if (!id) return res.status(400).json({ message: 'missing id' })
  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidesTable()
    await ensurePropertyGuideRevisionsTable()
    const user = (req as any).user || {}
    const updated = await pgRunInTransaction(async (client) => {
      const existing = await client.query('SELECT * FROM property_guides WHERE id=$1 FOR UPDATE', [id])
      const old = existing?.rows?.[0]
      if (!old) return null
      const oldRev = Number(old.revision || 1)
      const nextRev = oldRev + 1
      const nextRow = {
        ...old,
        ...parsed.data,
        revision: nextRev,
        updated_by: user?.sub || null,
        updated_at: new Date().toISOString(),
      }
      delete (nextRow as any).change_note
      const row = await pgUpdate('property_guides', id, nextRow, client)
      await pgInsert('property_guide_revisions', {
        guide_id: id,
        revision: nextRev,
        action: 'update',
        content_json: row?.content_json ?? nextRow.content_json ?? old.content_json ?? { sections: [] },
        change_note: parsed.data.change_note || null,
        changed_by: user?.sub || null,
        changed_at: new Date().toISOString(),
      }, client)
      return row
    })
    if (!updated) return res.status(404).json({ message: 'not found' })
    return res.json(updated)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update failed' })
  }
})

router.post('/:id/publish', requireAnyPerm(['property_guides.write', 'rbac.manage']), async (req, res) => {
  const { id } = req.params as any
  if (!id) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidesTable()
    await ensurePropertyGuideRevisionsTable()
    const updated = await pgRunInTransaction(async (client) => {
      const existing = await client.query('SELECT * FROM property_guides WHERE id=$1 FOR UPDATE', [id])
      const row = existing?.rows?.[0]
      if (!row) return null
      const propertyId = String(row.property_id || '')
      const language = String(row.language || '')
      const now = new Date().toISOString()
      await client.query(
        `UPDATE property_guides SET status='archived', updated_at=$1 WHERE property_id=$2 AND language=$3 AND status='published' AND id <> $4`,
        [now, propertyId, language, id]
      )
      const oldRev = Number(row.revision || 1)
      const nextRev = oldRev + 1
      const next = await pgUpdate('property_guides', id, { status: 'published', published_at: now, updated_at: now, revision: nextRev }, client)
      await pgInsert('property_guide_revisions', {
        guide_id: id,
        revision: nextRev,
        action: 'publish',
        content_json: next?.content_json ?? row.content_json ?? { sections: [] },
        change_note: null,
        changed_by: ((req as any).user || {})?.sub || null,
        changed_at: now,
      }, client)
      return next || { ...row, status: 'published', published_at: now, updated_at: now, revision: nextRev }
    })
    if (!updated) return res.status(404).json({ message: 'not found' })
    return res.json(updated)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'publish failed' })
  }
})

router.post('/:id/archive', requireAnyPerm(['property_guides.write', 'rbac.manage']), async (req, res) => {
  const { id } = req.params as any
  if (!id) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidesTable()
    await ensurePropertyGuideRevisionsTable()
    const updated = await pgRunInTransaction(async (client) => {
      const existing = await client.query('SELECT * FROM property_guides WHERE id=$1 FOR UPDATE', [id])
      const row = existing?.rows?.[0]
      if (!row) return null
      const now = new Date().toISOString()
      const oldRev = Number(row.revision || 1)
      const nextRev = oldRev + 1
      const next = await pgUpdate('property_guides', id, { status: 'archived', updated_at: now, revision: nextRev }, client)
      await pgInsert('property_guide_revisions', {
        guide_id: id,
        revision: nextRev,
        action: 'archive',
        content_json: next?.content_json ?? row.content_json ?? { sections: [] },
        change_note: null,
        changed_by: ((req as any).user || {})?.sub || null,
        changed_at: now,
      }, client)
      return next
    })
    if (!updated) return res.status(404).json({ message: 'not found' })
    return res.json(updated)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'archive failed' })
  }
})

router.post('/:id/duplicate', requireAnyPerm(['property_guides.write', 'rbac.manage']), async (req, res) => {
  const { id } = req.params as any
  if (!id) return res.status(400).json({ message: 'missing id' })
  const version = req.body?.version ? String(req.body.version) : ''
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidesTable()
    await ensurePropertyGuideRevisionsTable()
    const existing = await pgSelect('property_guides', '*', { id }) as any[]
    const row = existing && existing[0]
    if (!row) return res.status(404).json({ message: 'not found' })
    const user = (req as any).user || {}
    const now = new Date().toISOString()
    const newId = uuidv4()
    const newVer = version || `${String(row.version || 'v')}-copy-${now.slice(0, 10)}`
    const payload: any = {
      id: newId,
      property_id: row.property_id,
      language: row.language,
      version: newVer,
      revision: 1,
      status: 'draft',
      content_json: row.content_json || { sections: [] },
      created_by: user?.sub || null,
      updated_by: user?.sub || null,
      created_at: now,
      updated_at: now,
      published_at: null,
    }
    const inserted = await pgInsert('property_guides', payload)
    await pgInsert('property_guide_revisions', {
      guide_id: newId,
      revision: 1,
      action: 'duplicate',
      content_json: (inserted as any)?.content_json ?? payload.content_json,
      change_note: null,
      changed_by: user?.sub || null,
      changed_at: now,
    })
    return res.status(201).json(inserted || payload)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'duplicate failed' })
  }
})

router.get('/:id/revisions', requireAnyPerm(['property_guides.view', 'rbac.manage']), async (req, res) => {
  const { id } = req.params as any
  if (!id) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuideRevisionsTable()
    const rows = await pgPool.query('SELECT * FROM property_guide_revisions WHERE guide_id=$1 ORDER BY revision DESC, changed_at DESC', [id])
    return res.json(rows?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list revisions failed' })
  }
})

router.post('/upload-image', requireAnyPerm(['property_guides.write', 'rbac.manage']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (!hasR2 || !(req.file as any).buffer) return res.status(500).json({ message: 'R2 not configured' })
    const ext = path.extname(req.file.originalname) || ''
    const key = `property-guides/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.post('/:id/public-link', requireAnyPerm(['property_guides.write', 'rbac.manage']), async (req, res) => {
  const { id } = req.params as any
  if (!id) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidesTable()
    await ensurePropertyGuidePublicLinksTable()
    const existing = await pgSelect('property_guides', '*', { id }) as any[]
    const row = existing && existing[0]
    if (!row) return res.status(404).json({ message: 'not found' })
    if (String(row.status || '') !== 'published') return res.status(400).json({ message: 'guide must be published' })
    const expiresAtRaw = req.body?.expires_at ? String(req.body.expires_at) : ''
    const expiresAt = (() => {
      if (expiresAtRaw) {
        const d = new Date(expiresAtRaw)
        if (!Number.isNaN(d.getTime())) return d.toISOString()
      }
      return new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString()
    })()
    const token = randomToken(24)
    const tokenHash = sha256Hex(token)
    const tokenEnc = encryptLinkToken(token)
    await pgPool.query(
      'INSERT INTO property_guide_public_links(token_hash, token_enc, guide_id, expires_at) VALUES($1,$2,$3,$4)',
      [tokenHash, tokenEnc, id, expiresAt]
    )
    return res.json({ token, expires_at: expiresAt })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create link failed' })
  }
})

router.get('/:id/public-links', requireAnyPerm(['property_guides.view', 'rbac.manage']), async (req, res) => {
  const { id } = req.params as any
  if (!id) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidePublicLinksTable()
    const rows = await pgPool.query('SELECT token_hash, token_enc, guide_id, created_at, expires_at, revoked_at FROM property_guide_public_links WHERE guide_id=$1 ORDER BY created_at DESC', [id])
    const out = (rows?.rows || []).map((r: any) => {
      let token = ''
      try {
        token = r?.token_enc ? decryptLinkToken(String(r.token_enc)) : ''
      } catch {}
      return {
        token_hash: r.token_hash,
        guide_id: r.guide_id,
        created_at: r.created_at,
        expires_at: r.expires_at,
        revoked_at: r.revoked_at,
        token: token || null,
      }
    })
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list links failed' })
  }
})

router.post('/public-links/:tokenHash/revoke', requireAnyPerm(['property_guides.write', 'rbac.manage']), async (req, res) => {
  const tokenHash = String((req.params as any)?.tokenHash || '')
  if (!tokenHash) return res.status(400).json({ message: 'missing token_hash' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidePublicLinksTable()
    const now = new Date().toISOString()
    const r = await pgPool.query('UPDATE property_guide_public_links SET revoked_at=$1 WHERE token_hash=$2 AND revoked_at IS NULL', [now, tokenHash])
    if (!r?.rowCount) return res.status(404).json({ message: 'not found' })
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'revoke failed' })
  }
})
