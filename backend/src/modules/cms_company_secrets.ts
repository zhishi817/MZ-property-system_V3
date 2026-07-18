import { Router } from 'express'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { hasPg } from '../dbAdapter'
import { decryptCompanySecret, encryptCompanySecret, hasCompanySecretKey } from '../lib/companySecretCrypto'

export const router = Router()

async function ensureTables() {
  if (!hasPg) return
  try {
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return
    await pgPool.query(`CREATE TABLE IF NOT EXISTS company_secret_items (
      id text PRIMARY KEY,
      title text NOT NULL,
      username text,
      secret_enc text NOT NULL,
      note text,
      item_type text NOT NULL DEFAULT 'legacy',
      property_code text,
      property_codes text[],
      property_ids text[],
      secret_kind text,
      box_number text,
      location text,
      rotation_interval_days integer,
      next_rotation_at date,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      updated_by text
    );`)
    await pgPool.query(`ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'legacy';`)
    await pgPool.query(`ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS property_code text;`)
    await pgPool.query(`ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS property_codes text[];`)
    await pgPool.query(`ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS property_ids text[];`)
    await pgPool.query(`ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS secret_kind text;`)
    await pgPool.query(`ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS box_number text;`)
    await pgPool.query(`ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS location text;`)
    await pgPool.query(`ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS rotation_interval_days integer;`)
    await pgPool.query(`ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS next_rotation_at date;`)
    await pgPool.query(`ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_company_secret_items_updated ON company_secret_items(updated_at DESC);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_company_secret_items_type_updated ON company_secret_items(item_type, updated_at DESC);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_company_secret_items_property ON company_secret_items(property_code);`)
    await pgPool.query(`CREATE TABLE IF NOT EXISTS company_secret_access_logs (
      id text PRIMARY KEY,
      secret_item_id text NOT NULL REFERENCES company_secret_items(id) ON DELETE CASCADE,
      user_id text,
      action text NOT NULL,
      created_at timestamptz DEFAULT now()
    );`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_company_secret_logs_item ON company_secret_access_logs(secret_item_id, created_at DESC);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_company_secret_logs_user ON company_secret_access_logs(user_id, created_at DESC);`)
  } catch {}
}

const secretKindSchema = z.enum([
  'password_box',
  'mailbox',
  'office',
  'backup_key',
  'door_lock',
  'mailbox_lockbox',
  'garage_lockbox',
  'mailbox_key_lockbox',
  'locker',
  'company_rotating',
  'other',
])

const propertyLinkedKinds = new Set(['mailbox', 'backup_key', 'door_lock', 'mailbox_lockbox', 'garage_lockbox', 'mailbox_key_lockbox', 'locker'])
const numberedBoxKinds = new Set(['backup_key', 'mailbox_lockbox', 'garage_lockbox', 'mailbox_key_lockbox'])

const createSchema = z.object({
  title: z.string().min(1),
  property_code: z.string().optional(),
  property_codes: z.array(z.string().min(1)).optional(),
  property_ids: z.array(z.string().min(1)).optional(),
  secret_kind: secretKindSchema,
  box_number: z.string().optional(),
  location: z.string().optional(),
  rotation_interval_days: z.number().int().positive().max(3650).nullable().optional(),
  next_rotation_at: z.string().nullable().optional(),
  secret: z.string().min(1),
  note: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).strict().superRefine((data, ctx) => {
  if (propertyLinkedKinds.has(data.secret_kind) && !data.property_ids?.some((id) => String(id || '').trim())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['property_ids'], message: 'at least one linked property is required' })
  }
  if (numberedBoxKinds.has(data.secret_kind) && !String(data.box_number || '').trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['box_number'], message: 'password box number is required' })
  }
  if (data.secret_kind === 'company_rotating' && !data.rotation_interval_days) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rotation_interval_days'], message: 'rotation interval is required' })
  }
})

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  property_code: z.string().optional(),
  property_codes: z.array(z.string().min(1)).optional(),
  property_ids: z.array(z.string().min(1)).optional(),
  secret_kind: secretKindSchema.optional(),
  box_number: z.string().optional(),
  location: z.string().optional(),
  rotation_interval_days: z.number().int().positive().max(3650).nullable().optional(),
  next_rotation_at: z.string().nullable().optional(),
  secret: z.string().optional(),
  note: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).strict()

const offlinePasswordSelect = 'id, title, property_code, property_codes, property_ids, secret_kind, box_number, location, rotation_interval_days, next_rotation_at, note, status, secret_enc, created_at, updated_at, updated_by'

async function resolveLinkedProperties(pgPool: any, rawIds: string[] | undefined) {
  const ids = Array.from(new Set((rawIds || []).map((id) => String(id).trim()).filter(Boolean)))
  if (!ids.length) return { ids: [] as string[], codes: [] as string[] }
  const result = await pgPool.query('SELECT id, code FROM properties WHERE id = ANY($1::text[])', [ids])
  const rows = Array.isArray(result.rows) ? result.rows : []
  const byId = new Map(rows.map((row: any) => [String(row.id), String(row.code || '').trim()]))
  if (ids.some((id) => !byId.has(id))) return null
  return { ids, codes: ids.map((id) => byId.get(id) || id) }
}

function offlinePasswordFilter(req: any) {
  const q = String(req?.query?.q || '').trim()
  const status = String(req?.query?.status || '').trim()
  const clauses = ["item_type='offline_password'"]
  const values: any[] = []
  if (q) {
    values.push(`%${q}%`)
    const p = `$${values.length}`
    clauses.push(`(title ILIKE ${p} OR property_code ILIKE ${p} OR array_to_string(property_codes, ',') ILIKE ${p} OR EXISTS (SELECT 1 FROM properties linked_property WHERE linked_property.id = ANY(COALESCE(property_ids, ARRAY[]::text[])) AND (linked_property.code ILIKE ${p} OR linked_property.address ILIKE ${p})) OR secret_kind ILIKE ${p} OR box_number ILIKE ${p} OR location ILIKE ${p} OR note ILIKE ${p})`)
  }
  if (status === 'active' || status === 'inactive') {
    values.push(status)
    clauses.push(`status=$${values.length}`)
  }
  return { where: clauses.join(' AND '), values }
}

async function insertLog(secretItemId: string, userId: string | null, action: string) {
  try {
    const { pgInsert } = require('../dbAdapter')
    const { v4: uuid } = require('uuid')
    await pgInsert('company_secret_access_logs', { id: uuid(), secret_item_id: secretItemId, user_id: userId, action })
  } catch {}
}

router.get('/company/secrets', requirePerm('company_secret_items.view'), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })
  try {
    const includeSecret = String((req.query as any)?.include_secret || '').trim() === '1'
    if (includeSecret) res.setHeader('Cache-Control', 'no-store')
    const actor = (req as any).user
    const userId = actor?.sub ? String(actor.sub) : null
    const filter = offlinePasswordFilter(req)
    const r = await pgPool.query(`SELECT ${offlinePasswordSelect} FROM company_secret_items WHERE ${filter.where} ORDER BY updated_at DESC NULLS LAST, created_at DESC`, filter.values)
    const rows = (r.rows || []) as any[]
    if (!includeSecret) {
      return res.json(rows.map(({ secret_enc: _secretEnc, ...x }) => x))
    }
    const hasKey = hasCompanySecretKey()
    const out = rows.map((x) => {
      const enc = String(x.secret_enc || '')
      const plain = enc && hasKey ? decryptCompanySecret(enc) : null
      return { id: x.id, title: x.title, property_code: x.property_code, property_codes: x.property_codes, property_ids: x.property_ids, secret_kind: x.secret_kind, box_number: x.box_number, location: x.location, rotation_interval_days: x.rotation_interval_days, next_rotation_at: x.next_rotation_at, note: x.note, status: x.status, secret: plain, has_key: hasKey, created_at: x.created_at, updated_at: x.updated_at, updated_by: x.updated_by }
    })
    try {
      for (const x of rows) { await insertLog(String(x.id), userId, 'view_list') }
    } catch {}
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'list_failed') })
  }
})

router.get('/company/secrets/app-list', requirePerm('company_secret_items.view'), async (req, res) => {
  const actor = (req as any).user
  if (!actor) return res.status(401).json({ message: 'unauthorized' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })
  try {
    const userId = actor?.sub ? String(actor.sub) : null
    res.setHeader('Cache-Control', 'no-store')
    const filter = offlinePasswordFilter(req)
    const r = await pgPool.query(`SELECT ${offlinePasswordSelect} FROM company_secret_items WHERE ${filter.where} ORDER BY updated_at DESC NULLS LAST, created_at DESC`, filter.values)
    const rows = (r.rows || []) as any[]
    const hasKey = hasCompanySecretKey()
    const out = rows.map((x) => {
      const enc = String(x.secret_enc || '')
      const plain = enc && hasKey ? decryptCompanySecret(enc) : null
      return { id: x.id, title: x.title, property_code: x.property_code, property_codes: x.property_codes, property_ids: x.property_ids, secret_kind: x.secret_kind, box_number: x.box_number, location: x.location, rotation_interval_days: x.rotation_interval_days, next_rotation_at: x.next_rotation_at, note: x.note, status: x.status, secret: plain, has_key: hasKey, updated_at: x.updated_at }
    })
    try {
      for (const x of rows) { await insertLog(String(x.id), userId, 'view_list_app') }
    } catch {}
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'list_failed') })
  }
})

router.post('/company/secrets/:id/log-copy-app', requirePerm('company_secret_items.view'), async (req, res) => {
  const actor = (req as any).user
  if (!actor) return res.status(401).json({ message: 'unauthorized' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })
  const userId = actor?.sub ? String(actor.sub) : null
  try {
    const r0 = await pgPool.query("SELECT id FROM company_secret_items WHERE id=$1 AND item_type='offline_password' LIMIT 1", [id])
    if (!r0?.rows?.[0]) return res.status(404).json({ message: 'not found' })
    await insertLog(id, userId, 'copy_app')
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'log_failed') })
  }
})

router.post('/company/secrets', requirePerm('company_secret_items.write'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasCompanySecretKey()) return res.status(500).json({ message: 'missing CMS_SECRET_KEY' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })

  const { v4: uuid } = require('uuid')
  const id = uuid()
  const enc = encryptCompanySecret(parsed.data.secret)
  if (!enc) return res.status(500).json({ message: 'encrypt_failed' })

  const actor = (req as any).user
  const userId = actor?.sub ? String(actor.sub) : null
  const now = new Date().toISOString()

  try {
    const linkedProperties = await resolveLinkedProperties(pgPool, parsed.data.property_ids)
    if (!linkedProperties) return res.status(400).json({ message: 'linked property not found' })
    const row = {
      id,
      title: String(parsed.data.title).trim(),
      username: null,
      secret_enc: enc,
      note: parsed.data.note ? String(parsed.data.note) : null,
      item_type: 'offline_password',
      property_code: parsed.data.property_code ? String(parsed.data.property_code).trim() : null,
      property_codes: linkedProperties.codes,
      property_ids: linkedProperties.ids,
      secret_kind: parsed.data.secret_kind,
      box_number: parsed.data.box_number ? String(parsed.data.box_number).trim() : null,
      location: parsed.data.location ? String(parsed.data.location).trim() : null,
      rotation_interval_days: parsed.data.rotation_interval_days ?? null,
      next_rotation_at: parsed.data.next_rotation_at ? String(parsed.data.next_rotation_at).trim() : null,
      status: parsed.data.status || 'active',
      updated_at: now,
      updated_by: userId,
    }
    const keys = Object.keys(row)
    const cols = keys.map((k) => `"${k}"`).join(',')
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',')
    const values = keys.map((k) => (row as any)[k] === undefined ? null : (row as any)[k])
    const sql = `INSERT INTO company_secret_items (${cols}) VALUES (${placeholders}) RETURNING id, title, property_code, property_codes, property_ids, secret_kind, box_number, location, rotation_interval_days, next_rotation_at, note, status, created_at, updated_at, updated_by`
    const r = await pgPool.query(sql, values)
    await insertLog(id, userId, 'create')
    return res.status(201).json(r.rows?.[0] || { ...row, created_at: now })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'create_failed') })
  }
})

router.patch('/company/secrets/:id', requirePerm('company_secret_items.write'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  const parsed = patchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })

  const actor = (req as any).user
  const userId = actor?.sub ? String(actor.sub) : null
  const now = new Date().toISOString()

  try {
    const r0 = await pgPool.query("SELECT id, secret_kind, box_number, property_codes, property_ids, rotation_interval_days FROM company_secret_items WHERE id=$1 AND item_type='offline_password' LIMIT 1", [id])
    const existing = r0?.rows?.[0]
    if (!existing) return res.status(404).json({ message: 'not found' })

    const patch: any = {}
    if (parsed.data.title !== undefined) patch.title = String(parsed.data.title).trim()
    if (parsed.data.property_code !== undefined) patch.property_code = parsed.data.property_code ? String(parsed.data.property_code).trim() : null
    if (parsed.data.property_ids !== undefined) {
      const linkedProperties = await resolveLinkedProperties(pgPool, parsed.data.property_ids)
      if (!linkedProperties) return res.status(400).json({ message: 'linked property not found' })
      patch.property_ids = linkedProperties.ids
      patch.property_codes = linkedProperties.codes
    }
    if (parsed.data.secret_kind !== undefined) patch.secret_kind = parsed.data.secret_kind
    if (parsed.data.box_number !== undefined) patch.box_number = parsed.data.box_number ? String(parsed.data.box_number).trim() : null
    if (parsed.data.location !== undefined) patch.location = parsed.data.location ? String(parsed.data.location).trim() : null
    if (parsed.data.rotation_interval_days !== undefined) patch.rotation_interval_days = parsed.data.rotation_interval_days
    if (parsed.data.next_rotation_at !== undefined) patch.next_rotation_at = parsed.data.next_rotation_at ? String(parsed.data.next_rotation_at).trim() : null
    if (parsed.data.note !== undefined) patch.note = parsed.data.note ? String(parsed.data.note) : null
    if (parsed.data.status !== undefined) patch.status = parsed.data.status
    if (parsed.data.secret !== undefined) {
      if (!hasCompanySecretKey()) return res.status(500).json({ message: 'missing CMS_SECRET_KEY' })
      const enc = encryptCompanySecret(String(parsed.data.secret))
      if (!enc) return res.status(500).json({ message: 'encrypt_failed' })
      patch.secret_enc = enc
    }
    const nextKind = patch.secret_kind ?? existing.secret_kind
    const nextBoxNumber = patch.box_number ?? existing.box_number
    const nextPropertyIds = patch.property_ids ?? existing.property_ids
    const nextRotationInterval = patch.rotation_interval_days ?? existing.rotation_interval_days
    if (numberedBoxKinds.has(nextKind) && !String(nextBoxNumber || '').trim()) {
      return res.status(400).json({ message: 'password box number is required' })
    }
    if (propertyLinkedKinds.has(nextKind) && (!Array.isArray(nextPropertyIds) || !nextPropertyIds.some((propertyId: any) => String(propertyId || '').trim()))) {
      return res.status(400).json({ message: 'at least one linked property is required' })
    }
    if (nextKind === 'company_rotating' && !Number(nextRotationInterval || 0)) {
      return res.status(400).json({ message: 'rotation interval is required' })
    }
    patch.updated_at = now
    patch.updated_by = userId

    const keys = Object.keys(patch)
    if (!keys.length) return res.json({ ok: true })
    const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(', ')
    const values = keys.map((k) => patch[k] === undefined ? null : patch[k])
    const sql = `UPDATE company_secret_items SET ${set} WHERE id=$${keys.length + 1} AND item_type='offline_password' RETURNING id, title, property_code, property_codes, property_ids, secret_kind, box_number, location, rotation_interval_days, next_rotation_at, note, status, created_at, updated_at, updated_by`
    const r1 = await pgPool.query(sql, [...values, id])
    await insertLog(id, userId, 'update')
    return res.json(r1.rows?.[0] || { ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'update_failed') })
  }
})

router.delete('/company/secrets/:id', requirePerm('company_secret_items.delete'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })

  const actor = (req as any).user
  const userId = actor?.sub ? String(actor.sub) : null

  try {
    const r0 = await pgPool.query("SELECT id FROM company_secret_items WHERE id=$1 AND item_type='offline_password' LIMIT 1", [id])
    if (!r0?.rows?.[0]) return res.status(404).json({ message: 'not found' })
    await insertLog(id, userId, 'delete')
    await pgPool.query('DELETE FROM company_secret_items WHERE id=$1', [id])
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'delete_failed') })
  }
})

router.get('/company/secrets/:id/reveal', requirePerm('company_secret_items.view'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  res.setHeader('Cache-Control', 'no-store')
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })

  const actor = (req as any).user
  const userId = actor?.sub ? String(actor.sub) : null

  try {
    const r0 = await pgPool.query(`SELECT ${offlinePasswordSelect} FROM company_secret_items WHERE id=$1 AND item_type='offline_password' LIMIT 1`, [id])
    const row = r0?.rows?.[0]
    if (!row) return res.status(404).json({ message: 'not found' })
    const enc = String(row.secret_enc || '')
    const plain = enc ? decryptCompanySecret(enc) : null
    await insertLog(id, userId, 'view')
    return res.json({ id, title: row.title, property_code: row.property_code, property_codes: row.property_codes, property_ids: row.property_ids, secret_kind: row.secret_kind, box_number: row.box_number, location: row.location, rotation_interval_days: row.rotation_interval_days, next_rotation_at: row.next_rotation_at, note: row.note, status: row.status, secret: plain, has_key: hasCompanySecretKey(), updated_at: row.updated_at, updated_by: row.updated_by, created_at: row.created_at })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'reveal_failed') })
  }
})

router.post('/company/secrets/:id/log-copy', requirePerm('company_secret_items.view'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg) return res.status(500).json({ message: 'no database configured' })
  await ensureTables()
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return res.status(500).json({ message: 'no database configured' })

  const actor = (req as any).user
  const userId = actor?.sub ? String(actor.sub) : null

  try {
    const r0 = await pgPool.query("SELECT id FROM company_secret_items WHERE id=$1 AND item_type='offline_password' LIMIT 1", [id])
    if (!r0?.rows?.[0]) return res.status(404).json({ message: 'not found' })
    await insertLog(id, userId, 'copy')
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'log_failed') })
  }
})
