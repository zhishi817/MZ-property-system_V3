import { Router } from 'express'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { hasPg } from '../dbAdapter'
import crypto from 'crypto'

export const router = Router()

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

function slugifyName(v: string) {
  const raw = String(v || '').trim().toLowerCase()
  const s = raw
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s
}

async function ensureCmsPagesCompanyColumns() {
  if (!hasPg) return
  try {
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return
    await pgPool.query(`CREATE TABLE IF NOT EXISTS cms_pages (
      id text PRIMARY KEY,
      slug text UNIQUE,
      title text,
      content text,
      status text,
      published_at date,
      page_type text NOT NULL DEFAULT 'generic',
      category text,
      pinned boolean NOT NULL DEFAULT false,
      urgent boolean NOT NULL DEFAULT false,
      audience_scope text,
      expires_at date,
      updated_at timestamptz DEFAULT now(),
      updated_by text,
      created_at timestamptz DEFAULT now()
    );`)
    await pgPool.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS page_type text NOT NULL DEFAULT 'generic';`)
    await pgPool.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS category text;`)
    await pgPool.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;`)
    await pgPool.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS urgent boolean NOT NULL DEFAULT false;`)
    await pgPool.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS audience_scope text;`)
    await pgPool.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS expires_at date;`)
    await pgPool.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();`)
    await pgPool.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS updated_by text;`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cms_pages_status ON cms_pages(status);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cms_pages_type ON cms_pages(page_type);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cms_pages_pinned ON cms_pages(pinned, published_at);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cms_pages_expires ON cms_pages(expires_at);`)
  } catch {}
}

async function ensureCmsCompanyPublicLinksTable() {
  if (!hasPg) return
  try {
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return
    await ensureCmsPagesCompanyColumns()
    await pgPool.query(`CREATE TABLE IF NOT EXISTS cms_company_public_links (
      token_hash text PRIMARY KEY,
      token_enc text,
      page_id text NOT NULL REFERENCES cms_pages(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz
    );`)
    await pgPool.query(`ALTER TABLE cms_company_public_links ADD COLUMN IF NOT EXISTS token_enc text;`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cms_company_public_links_page_id ON cms_company_public_links(page_id, created_at DESC);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cms_company_public_links_active ON cms_company_public_links(page_id, revoked_at, expires_at);`)
  } catch {}
}

const pageTypeSchema = z.enum(['announce', 'doc', 'warehouse'])
const audienceScopeSchema = z.enum(['all_staff', 'cleaners', 'warehouse_staff', 'maintenance_staff', 'managers']).optional()
const categorySchema = z.enum(['company_rule', 'work_guide']).optional()

const createSchema = z.object({
  type: pageTypeSchema,
  slug: z.string().optional(),
  title: z.string().min(1),
  content: z.string().optional(),
  status: z.enum(['draft', 'published']).optional(),
  published_at: z.string().optional(),
  pinned: z.boolean().optional(),
  urgent: z.boolean().optional(),
  category: categorySchema,
  audience_scope: audienceScopeSchema,
  expires_at: z.string().optional(),
}).strict()

const patchSchema = z.object({
  slug: z.string().optional(),
  title: z.string().min(1).optional(),
  content: z.string().optional(),
  status: z.enum(['draft', 'published']).optional(),
  published_at: z.string().optional(),
  pinned: z.boolean().optional(),
  urgent: z.boolean().optional(),
  category: categorySchema.optional(),
  audience_scope: audienceScopeSchema.optional(),
  expires_at: z.string().optional(),
}).strict()

const appListSchema = z.object({
  type: pageTypeSchema,
  category: categorySchema.optional(),
}).strict()

function normalizeDate(v: any) {
  const s = String(v || '').trim()
  if (!s) return null
  const m = s.match(/^\d{4}-\d{2}-\d{2}$/)
  return m ? s : null
}

function normalizeSlug(type: string, slug?: string, title?: string, id?: string) {
  const raw = String(slug || '').trim()
  if (raw) return raw
  if (type === 'warehouse') {
    const t = slugifyName(String(title || ''))
    if (t) return `warehouse:${t}`
  }
  if (id) return `${type}:${id.slice(0, 12)}`
  return `${type}:${Math.random().toString(36).slice(2, 10)}`
}

function roleNamesOf(user: any) {
  const roles: string[] = Array.isArray(user?.roles) ? user.roles.map((v: any) => String(v || '').trim()).filter(Boolean) : []
  const primary = String(user?.role || '').trim()
  if (primary) roles.unshift(primary)
  return Array.from(new Set(roles.filter(Boolean)))
}

function appAudienceAllowed(user: any, audienceScope: string | null | undefined) {
  const scope = String(audienceScope || '').trim()
  if (!scope || scope === 'all_staff') return true
  const roles = roleNamesOf(user)
  if (!roles.length) return false
  const hasManagerOverride = roles.some((role) =>
    ['admin', 'offline_manager', 'customer_service', 'cleaning_manager', 'inventory_manager', 'finance_staff'].includes(role),
  )
  if (hasManagerOverride) return true
  if (scope === 'cleaners') {
    return roles.some((role) => ['cleaner', 'cleaning_inspector', 'cleaner_inspector'].includes(role))
  }
  if (scope === 'warehouse_staff') {
    return roles.some((role) => ['inventory_manager', 'warehouse_staff'].includes(role))
  }
  if (scope === 'maintenance_staff') {
    return roles.includes('maintenance_staff')
  }
  if (scope === 'managers') {
    return roles.some((role) => ['admin', 'offline_manager', 'customer_service', 'cleaning_manager', 'inventory_manager', 'finance_staff'].includes(role))
  }
  return false
}

router.get('/company/pages', requirePerm('cms_pages.view'), async (req, res) => {
  const type = String((req.query as any)?.type || '').trim()
  const parsed = pageTypeSchema.safeParse(type)
  if (!parsed.success) return res.status(400).json({ message: 'invalid type' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureCmsPagesCompanyColumns()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })
  try {
    if (type === 'announce') {
      const r = await pgPool.query(
        `SELECT * FROM cms_pages
         WHERE page_type=$1
         ORDER BY pinned DESC, published_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC`,
        [type]
      )
      return res.json(r.rows || [])
    }
    const r = await pgPool.query(
      `SELECT * FROM cms_pages
       WHERE page_type=$1
       ORDER BY updated_at DESC NULLS LAST, created_at DESC`,
      [type]
    )
    return res.json(r.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'list_failed') })
  }
})

router.post('/company/pages', requirePerm('cms_pages.write'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureCmsPagesCompanyColumns()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })

  const actor = (req as any).user
  const userId = actor?.sub ? String(actor.sub) : null
  const { v4: uuid } = require('uuid')
  const id = uuid()
  const type = parsed.data.type

  if (type === 'doc') {
    const cat = String(parsed.data.category || '').trim()
    if (!cat) return res.status(400).json({ message: 'missing category' })
  }

  const title = String(parsed.data.title || '').trim()
  const slug = normalizeSlug(type, parsed.data.slug, title, id)
  const row: any = {
    id,
    slug,
    title,
    content: parsed.data.content ?? '',
    status: parsed.data.status || 'draft',
    published_at: normalizeDate(parsed.data.published_at),
    page_type: type,
    category: type === 'doc' ? (parsed.data.category || null) : null,
    pinned: type === 'announce' ? !!parsed.data.pinned : false,
    urgent: type === 'announce' ? !!parsed.data.urgent : false,
    audience_scope: parsed.data.audience_scope || null,
    expires_at: normalizeDate(parsed.data.expires_at),
    updated_at: new Date().toISOString(),
    updated_by: userId,
  }

  try {
    const keys = Object.keys(row)
    const cols = keys.map(k => `"${k}"`).join(',')
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',')
    const values = keys.map((k) => row[k] === undefined ? null : row[k])
    const sql = `INSERT INTO cms_pages (${cols}) VALUES (${placeholders}) RETURNING *`
    const r = await pgPool.query(sql, values)
    return res.status(201).json(r.rows[0] || row)
  } catch (e: any) {
    const msg = String(e?.message || 'create_failed')
    const code = String(e?.code || '')
    if (code === '23505' || /duplicate key value|unique constraint/i.test(msg)) {
      return res.status(409).json({ message: 'slug 已存在，请更换' })
    }
    return res.status(500).json({ message: msg })
  }
})

router.patch('/company/pages/:id', requirePerm('cms_pages.write'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  const parsed = patchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureCmsPagesCompanyColumns()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })

  const actor = (req as any).user
  const userId = actor?.sub ? String(actor.sub) : null

  try {
    const r0 = await pgPool.query('SELECT * FROM cms_pages WHERE id=$1 LIMIT 1', [id])
    const before = r0?.rows?.[0]
    if (!before) return res.status(404).json({ message: 'not found' })
    const type = String(before.page_type || '')
    if (!pageTypeSchema.safeParse(type).success) return res.status(400).json({ message: 'not a company page' })
    if (type === 'doc') {
      const cat = parsed.data.category === undefined ? String(before.category || '') : String(parsed.data.category || '')
      if (!cat) return res.status(400).json({ message: 'missing category' })
    }

    const patch: any = { ...parsed.data }
    if (patch.published_at !== undefined) patch.published_at = normalizeDate(patch.published_at)
    if (patch.expires_at !== undefined) patch.expires_at = normalizeDate(patch.expires_at)
    if (type !== 'announce') { delete patch.pinned; delete patch.urgent }
    if (type !== 'doc') { delete patch.category }

    patch.updated_at = new Date().toISOString()
    patch.updated_by = userId

    const keys = Object.keys(patch).filter(k => patch[k] !== undefined)
    if (!keys.length) return res.json(before)
    const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(', ')
    const values = keys.map((k) => patch[k] === undefined ? null : patch[k])
    const sql = `UPDATE cms_pages SET ${set} WHERE id=$${keys.length + 1} RETURNING *`
    const r1 = await pgPool.query(sql, [...values, id])
    return res.json(r1.rows[0] || { ...before, ...patch })
  } catch (e: any) {
    const msg = String(e?.message || 'update_failed')
    const code = String(e?.code || '')
    if (code === '23505' || /duplicate key value|unique constraint/i.test(msg)) {
      return res.status(409).json({ message: 'slug 已存在，请更换' })
    }
    return res.status(500).json({ message: msg })
  }
})

router.delete('/company/pages/:id', requirePerm('cms_pages.delete'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureCmsPagesCompanyColumns()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })
  try {
    const r0 = await pgPool.query('SELECT id, page_type FROM cms_pages WHERE id=$1 LIMIT 1', [id])
    const before = r0?.rows?.[0]
    if (!before) return res.status(404).json({ message: 'not found' })
    const type = String(before.page_type || '')
    if (!pageTypeSchema.safeParse(type).success) return res.status(400).json({ message: 'not a company page' })
    await pgPool.query('DELETE FROM cms_pages WHERE id=$1', [id])
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'delete_failed') })
  }
})

router.post('/company/pages/:id/public-link', requirePerm('cms_pages.write'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureCmsCompanyPublicLinksTable()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })
  try {
    const r0 = await pgPool.query('SELECT id, page_type, status FROM cms_pages WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0]
    if (!row) return res.status(404).json({ message: 'not found' })
    if (String(row.page_type || '') !== 'warehouse') return res.status(400).json({ message: 'only warehouse page supports public link' })
    if (String(row.status || '') !== 'published') return res.status(400).json({ message: 'page must be published' })
    const expiresAtRaw = req.body?.expires_at ? String(req.body.expires_at) : ''
    const expiresAt = (() => {
      if (expiresAtRaw) {
        const d = new Date(expiresAtRaw)
        if (!Number.isNaN(d.getTime())) return d.toISOString()
      }
      return new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString()
    })()
    const token = randomToken(24)
    const tokenHash = sha256Hex(token)
    const tokenEnc = encryptLinkToken(token)
    await pgPool.query(
      'INSERT INTO cms_company_public_links(token_hash, token_enc, page_id, expires_at) VALUES($1,$2,$3,$4)',
      [tokenHash, tokenEnc, id, expiresAt],
    )
    return res.json({ token, expires_at: expiresAt })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create_public_link_failed' })
  }
})

router.get('/company/pages/:id/public-links', requirePerm('cms_pages.view'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureCmsCompanyPublicLinksTable()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })
  try {
    const rows = await pgPool.query(
      'SELECT token_hash, token_enc, page_id, created_at, expires_at, revoked_at FROM cms_company_public_links WHERE page_id=$1 ORDER BY created_at DESC',
      [id],
    )
    const out = (rows?.rows || []).map((r: any) => {
      let token = ''
      try { token = r?.token_enc ? decryptLinkToken(String(r.token_enc)) : '' } catch {}
      return {
        token_hash: String(r.token_hash || ''),
        page_id: String(r.page_id || ''),
        created_at: r.created_at || null,
        expires_at: r.expires_at || null,
        revoked_at: r.revoked_at || null,
        token: token || null,
      }
    })
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list_public_links_failed' })
  }
})

router.post('/company/pages/public-links/:tokenHash/revoke', requirePerm('cms_pages.write'), async (req, res) => {
  const tokenHash = String(req.params.tokenHash || '').trim()
  if (!tokenHash) return res.status(400).json({ message: 'missing token_hash' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureCmsCompanyPublicLinksTable()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })
  try {
    const now = new Date().toISOString()
    const r = await pgPool.query('UPDATE cms_company_public_links SET revoked_at=$1 WHERE token_hash=$2 AND revoked_at IS NULL', [now, tokenHash])
    if (!r?.rowCount) return res.status(404).json({ message: 'not found' })
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'revoke_public_link_failed' })
  }
})

router.get('/company/pages/app-list', async (req, res) => {
  const actor = (req as any).user
  if (!actor) return res.status(401).json({ message: 'unauthorized' })
  const parsed = appListSchema.safeParse({
    type: String((req.query as any)?.type || '').trim(),
    category: String((req.query as any)?.category || '').trim() || undefined,
  })
  if (!parsed.success) return res.status(400).json({ message: 'invalid params' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureCmsPagesCompanyColumns()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })
  try {
    const { type, category } = parsed.data
    const where: string[] = [
      `page_type = $1`,
      `status = 'published'`,
      `(expires_at IS NULL OR expires_at >= CURRENT_DATE)`,
    ]
    const values: any[] = [type]
    if (type === 'doc' && category) {
      values.push(category)
      where.push(`category = $${values.length}`)
    }
    const orderBy =
      type === 'announce'
        ? 'pinned DESC, published_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC'
        : 'updated_at DESC NULLS LAST, published_at DESC NULLS LAST, created_at DESC'
    const sql = `SELECT id, title, content, published_at, updated_at, pinned, urgent, audience_scope, page_type, category, expires_at, created_at
                 FROM cms_pages
                 WHERE ${where.join(' AND ')}
                 ORDER BY ${orderBy}`
    const r = await pgPool.query(sql, values)
    const rows = (r.rows || []).filter((row: any) => appAudienceAllowed(actor, row?.audience_scope))
    return res.json(rows)
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'list_failed') })
  }
})
