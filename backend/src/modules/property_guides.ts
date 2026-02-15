import { Router } from 'express'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import multer from 'multer'
import path from 'path'
import crypto from 'crypto'
import { requireAnyPerm } from '../auth'
import { hasPg, pgPool, pgSelect, pgInsert, pgUpdate, pgRunInTransaction } from '../dbAdapter'
import { hasR2, r2Upload } from '../r2'
import { syncPropertyAccessGuideLink } from './property_guide_link_sync'

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
  try { await pgPool.query('ALTER TABLE property_guides ALTER COLUMN property_id DROP NOT NULL') } catch {}
  await pgPool.query('ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1')
  await pgPool.query('ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS base_version text')
  await pgPool.query('ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS building_key text')
  await pgPool.query('ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS copied_from_id text')
  await pgPool.query('ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS copied_at timestamptz')
  await pgPool.query('ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS copied_by text')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guides_property_id ON property_guides(property_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guides_lang ON property_guides(property_id, language);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guides_status ON property_guides(status);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guides_building_key ON property_guides(building_key);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_guides_building_lang_base ON property_guides(building_key, language, base_version);')
  try {
    await pgPool.query(`
      UPDATE property_guides g
      SET 
        base_version = COALESCE(NULLIF(g.base_version,''), regexp_replace(COALESCE(g.version,''), '-copy-.*$', '')),
        building_key = COALESCE(
          NULLIF(g.building_key,''),
          NULLIF(trim(p.building_name),''),
          upper(regexp_replace(COALESCE(p.code,''), '^([A-Za-z]+-?\\d+).*$','\\1')),
          p.code
        )
      FROM properties p
      WHERE g.property_id = p.id
        AND (
          g.base_version IS NULL OR g.base_version = '' OR g.building_key IS NULL OR g.building_key = ''
        )
    `)
  } catch {}
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
  property_id: z.string().min(1).optional(),
  property_code: z.string().min(1).max(64).optional(),
  language: z.string().min(1).max(24).optional(),
  version: z.string().min(1).max(64).optional(),
  status: guideStatusSchema.optional(),
  content_json: guideContentSchema.optional(),
  change_note: z.string().max(200).optional(),
})

function normalizeBaseVersion(v: any): string {
  const s = String(v || '').trim()
  if (!s) return ''
  const i = s.indexOf('-copy-')
  if (i > 0) return s.slice(0, i)
  return s
}

function deriveBuildingKey(buildingName: any, code: any, address: any, fallback: any): string {
  const bn = String(buildingName || '').trim()
  if (bn) return bn
  const c = String(code || '').trim()
  if (c) {
    const m = c.match(/^([a-z]+-?\d+)/i)
    if (m) return String(m[1]).toUpperCase()
    return c.toUpperCase()
  }
  const a = String(address || '').trim()
  if (a) return a.split(',')[0].trim()
  return String(fallback || '').trim()
}

async function resolvePropertyByIdOrCode(client: any, input: string) {
  const key = String(input || '').trim()
  if (!key) return null
  const r = await client.query('SELECT id, code, building_name, address FROM properties WHERE id=$1 OR upper(code)=upper($1) LIMIT 1', [key])
  return r?.rows?.[0] || null
}

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

router.get('/building-usage', requireAnyPerm(['property_guides.view', 'rbac.manage']), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidesTable()
    const q: any = req.query || {}
    const building_key = String(q.building_key || '').trim()
    const language = String(q.language || '').trim()
    const base_version = String(q.base_version || '').trim()
    if (!building_key || !language || !base_version) return res.status(400).json({ message: 'missing building_key/language/base_version' })
    const rows = await pgPool.query(
      `SELECT g.id, g.property_id, p.code AS property_code
       FROM property_guides g
       JOIN properties p ON p.id = g.property_id
       WHERE g.building_key = $1 AND g.language = $2 AND g.base_version = $3 AND g.property_id IS NOT NULL
       ORDER BY p.code ASC`,
      [building_key, language, base_version]
    )
    return res.json(rows?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'usage failed' })
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
    const prop = await resolvePropertyByIdOrCode(pgPool, parsed.data.property_id)
    if (!prop) return res.status(400).json({ message: 'property not found' })
    const buildingKey = deriveBuildingKey(prop.building_name, prop.code, prop.address, parsed.data.property_id)
    const payload: any = {
      id,
      property_id: String(prop.id),
      language: parsed.data.language,
      version: parsed.data.version,
      base_version: normalizeBaseVersion(parsed.data.version),
      building_key: buildingKey,
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
      const baseVersion = String(old.base_version || '') || normalizeBaseVersion(old.version)
      const buildingKey = String(old.building_key || '')
      const wantVersion = parsed.data.version !== undefined
      if (wantVersion && String(old.copied_from_id || '')) throw new Error('复制记录不允许修改基础版本号')
      let resolvedProp: any = null
      const nextLang = String((parsed.data.language !== undefined ? parsed.data.language : old.language) || '')
      if (parsed.data.property_id || parsed.data.property_code) {
        const propInput = String(parsed.data.property_id || parsed.data.property_code || '').trim()
        resolvedProp = await resolvePropertyByIdOrCode(client, propInput)
        if (!resolvedProp) {
          const e: any = new Error('property_not_found')
          e.statusCode = 400
          throw e
        }
        const propBuildingKey = deriveBuildingKey(resolvedProp.building_name, resolvedProp.code, resolvedProp.address, resolvedProp.id)
        if (buildingKey && propBuildingKey && propBuildingKey !== buildingKey) {
          const e: any = new Error('not_same_building')
          e.statusCode = 400
          throw e
        }
        const lockKey = `${String(resolvedProp.id)}|${nextLang}|${baseVersion}`
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey])
        const dup = await client.query(
          'SELECT id FROM property_guides WHERE id <> $1 AND property_id = $2 AND language = $3 AND base_version = $4 LIMIT 1',
          [id, String(resolvedProp.id), nextLang, baseVersion]
        )
        if (dup?.rows?.[0]) {
          const e: any = new Error('duplicate_property_guide')
          e.statusCode = 409
          throw e
        }
      }
      const oldRev = Number(old.revision || 1)
      const nextRev = oldRev + 1
      const nextRow = {
        ...old,
        ...parsed.data,
        property_id: resolvedProp ? String(resolvedProp.id) : old.property_id,
        base_version: baseVersion || normalizeBaseVersion(parsed.data.version ?? old.version),
        building_key: (old.building_key || (resolvedProp ? deriveBuildingKey(resolvedProp.building_name, resolvedProp.code, resolvedProp.address, resolvedProp.id) : null)) || null,
        revision: nextRev,
        updated_by: user?.sub || null,
        updated_at: new Date().toISOString(),
      }
      delete (nextRow as any).change_note
      delete (nextRow as any).property_code
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
    const msg = String(e?.message || 'update failed')
    const statusCode = Number(e?.statusCode || 0)
    if (msg === 'property_not_found') return res.status(400).json({ message: '房号不存在' })
    if (msg === 'not_same_building') return res.status(400).json({ message: '房号不属于同一楼栋' })
    if (msg === 'duplicate_property_guide') return res.status(409).json({ message: '该房号已存在入住指南，请重新输入' })
    return res.status(statusCode || 500).json({ message: msg })
  }
})

router.delete('/:id', requireAnyPerm(['property_guides.write', 'rbac.manage']), async (req, res) => {
  const { id } = req.params as any
  if (!id) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidesTable()
    await ensurePropertyGuideRevisionsTable()
    await ensurePropertyGuidePublicLinksTable()
    const deleted = await pgRunInTransaction(async (client) => {
      const r = await client.query('SELECT id, status FROM property_guides WHERE id=$1 FOR UPDATE', [id])
      const row = r?.rows?.[0]
      if (!row) return null
      const status = String(row.status || '')
      if (status === 'published') {
        const e: any = new Error('cannot_delete_published')
        e.statusCode = 400
        throw e
      }
      await client.query('DELETE FROM property_guides WHERE id=$1', [id])
      return { id }
    })
    if (!deleted) return res.status(404).json({ message: 'not found' })
    return res.json({ ok: true, id })
  } catch (e: any) {
    const msg = String(e?.message || 'delete failed')
    if (msg === 'cannot_delete_published') return res.status(400).json({ message: '已发布的入住指南不允许删除，请先归档后再删除' })
    return res.status(Number(e?.statusCode || 0) || 500).json({ message: msg })
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
      if (!propertyId) {
        const e: any = new Error('missing_property')
        e.statusCode = 400
        throw e
      }
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
    const msg = String(e?.message || 'publish failed')
    if (msg === 'missing_property') return res.status(400).json({ message: '请先填写房号后再发布' })
    return res.status(Number(e?.statusCode || 0) || 500).json({ message: msg })
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
      base_version: normalizeBaseVersion(newVer),
      building_key: String(row.building_key || null),
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

router.post('/:id/copy', requireAnyPerm(['property_guides.write', 'rbac.manage']), async (req, res) => {
  const { id } = req.params as any
  if (!id) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePropertyGuidesTable()
    await ensurePropertyGuideRevisionsTable()
    const user = (req as any).user || {}
    const now = new Date().toISOString()
    const created = await pgRunInTransaction(async (client) => {
      const r = await client.query('SELECT * FROM property_guides WHERE id=$1 FOR UPDATE', [id])
      const src = r?.rows?.[0]
      if (!src) return null
      const srcPropId = String(src.property_id || '')
      if (!srcPropId) {
        const e: any = new Error('source_missing_property')
        e.statusCode = 400
        throw e
      }
      const prop = await resolvePropertyByIdOrCode(client, srcPropId)
      if (!prop) {
        const e: any = new Error('property_not_found')
        e.statusCode = 400
        throw e
      }
      const buildingKey = deriveBuildingKey(prop.building_name, prop.code, prop.address, prop.id)
      const baseVersion = String(src.base_version || '') || normalizeBaseVersion(src.version)
      const newId = uuidv4()
      const payload: any = {
        id: newId,
        property_id: null,
        language: src.language,
        version: baseVersion,
        base_version: baseVersion,
        building_key: buildingKey,
        copied_from_id: String(id),
        copied_at: now,
        copied_by: user?.sub || null,
        revision: 1,
        status: 'draft',
        content_json: src.content_json || { sections: [] },
        created_by: user?.sub || null,
        updated_by: user?.sub || null,
        created_at: now,
        updated_at: now,
        published_at: null,
      }
      const inserted = await pgInsert('property_guides', payload, client)
      await pgInsert('property_guide_revisions', {
        guide_id: newId,
        revision: 1,
        action: 'copy',
        content_json: (inserted as any)?.content_json ?? payload.content_json,
        change_note: null,
        changed_by: user?.sub || null,
        changed_at: now,
      }, client)
      return inserted || payload
    })
    if (!created) return res.status(404).json({ message: 'not found' })
    return res.status(201).json(created)
  } catch (e: any) {
    const msg = String(e?.message || 'copy failed')
    if (msg === 'source_missing_property') return res.status(400).json({ message: '源指南缺少房号，无法复制' })
    if (msg === 'property_not_found') return res.status(400).json({ message: '房号不存在' })
    return res.status(Number(e?.statusCode || 0) || 500).json({ message: msg })
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
    if (!String(row.property_id || '')) return res.status(400).json({ message: 'missing property_id' })
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
    try {
      const origin = String(req.headers.origin || '')
      await syncPropertyAccessGuideLink({
        propertyId: String(row.property_id || ''),
        mode: 'realtime',
        reqOrigin: origin,
        token,
        tokenHash,
        guideId: id,
        actorId: (req as any)?.user?.sub || undefined,
      })
    } catch {}
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
