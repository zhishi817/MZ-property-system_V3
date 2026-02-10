import { Router } from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import { requireAnyPerm } from '../auth'
import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'
import { addAudit } from '../store'
import { buildPublicGuideUrl, pickPublicBaseUrl } from '../lib/guideLinkSyncUtils'

export const router = Router()

type SyncMode = 'realtime' | 'batch' | 'manual'
type SyncStatus = 'success' | 'failed' | 'skipped'

function linkTokenKey() {
  const secret = String(process.env.JWT_SECRET || 'dev-secret')
  return crypto.createHash('sha256').update(secret).digest()
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

async function ensureSyncLogsTable() {
  if (!hasPg || !pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_guide_link_sync_logs (
    id bigserial PRIMARY KEY,
    synced_at timestamptz NOT NULL DEFAULT now(),
    mode text NOT NULL,
    status text NOT NULL,
    source_property_id text,
    target_property_id text,
    guide_id text,
    token_hash text,
    old_link text,
    new_link text,
    error_message text
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_pgls_target ON property_guide_link_sync_logs(target_property_id, synced_at DESC);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_pgls_status ON property_guide_link_sync_logs(status, synced_at DESC);')
}

async function notifyFailure(payload: any) {
  const url = String(process.env.ALERT_WEBHOOK_URL || '').trim()
  if (!url) return
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2500)
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    clearTimeout(t)
  } catch {}
}

export async function syncPropertyAccessGuideLink({
  propertyId,
  mode,
  reqOrigin,
  token,
  tokenHash,
  guideId,
  actorId,
}: {
  propertyId: string
  mode: SyncMode
  reqOrigin?: string
  token?: string
  tokenHash?: string
  guideId?: string
  actorId?: string
}) {
  if (!hasPg || !pgPool) throw new Error('no database configured')
  await ensureSyncLogsTable()

  const baseUrl = pickPublicBaseUrl(reqOrigin)
  const newLink = token ? buildPublicGuideUrl(token, baseUrl) : ''

  const now = new Date().toISOString()
  const property_id = String(propertyId || '').trim()
  if (!property_id) throw new Error('missing propertyId')

  const run = async () => {
    if (token && !newLink) {
      return { status: 'failed' as SyncStatus, old_link: '', new_link: '', error: 'link_build_failed' }
    }

    const resultRaw = await pgRunInTransaction(async (client) => {
      const r0 = await client.query('SELECT id, access_guide_link FROM properties WHERE id=$1 FOR UPDATE', [property_id])
      const p = r0?.rows?.[0]
      if (!p) return { status: 'failed' as SyncStatus, old_link: '', new_link: '', error: 'property_not_found' }
      const oldLink = String(p.access_guide_link || '')

      if (!token) {
        const q = await client.query(
          `SELECT g.id as guide_id, l.token_hash, l.token_enc
           FROM property_guides g
           JOIN property_guide_public_links l ON l.guide_id = g.id
           WHERE g.property_id=$1
             AND g.status='published'
             AND l.revoked_at IS NULL
             AND l.expires_at > now()
           ORDER BY l.created_at DESC
           LIMIT 1`,
          [property_id]
        )
        const row = q?.rows?.[0]
        if (!row) return { status: 'skipped' as SyncStatus, old_link: oldLink, new_link: '', error: 'no_active_link' }
        const tok = row?.token_enc ? decryptLinkToken(String(row.token_enc)) : ''
        const url = buildPublicGuideUrl(tok, baseUrl)
        if (!url) return { status: 'failed' as SyncStatus, old_link: oldLink, new_link: '', error: 'token_decrypt_failed' }
        guideId = guideId || String(row.guide_id || '')
        tokenHash = tokenHash || String(row.token_hash || '')
        token = tok
        const u = await client.query(
          'UPDATE properties SET access_guide_link=$2, updated_at=$3 WHERE id=$1 RETURNING access_guide_link',
          [property_id, url, now]
        )
        const written = String(u?.rows?.[0]?.access_guide_link || '')
        if (written !== url) return { status: 'failed' as SyncStatus, old_link: oldLink, new_link: url, error: 'write_mismatch' }
        return { status: 'success' as SyncStatus, old_link: oldLink, new_link: url, error: '' }
      }

      const u = await client.query(
        'UPDATE properties SET access_guide_link=$2, updated_at=$3 WHERE id=$1 RETURNING access_guide_link',
        [property_id, newLink, now]
      )
      const written = String(u?.rows?.[0]?.access_guide_link || '')
      if (written !== newLink) return { status: 'failed' as SyncStatus, old_link: oldLink, new_link: newLink, error: 'write_mismatch' }
      return { status: 'success' as SyncStatus, old_link: oldLink, new_link: newLink, error: '' }
    })
    const result = resultRaw || { status: 'failed' as SyncStatus, old_link: '', new_link: newLink || '', error: 'transaction_failed' }

    await pgPool!.query(
      `INSERT INTO property_guide_link_sync_logs(mode, status, source_property_id, target_property_id, guide_id, token_hash, old_link, new_link, error_message)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        mode,
        result.status,
        property_id,
        property_id,
        guideId || null,
        tokenHash || null,
        result.old_link || null,
        result.new_link || null,
        result.error || null,
      ]
    )

    if (result.status === 'failed') {
      addAudit(
        'PropertyGuideLinkSync',
        property_id,
        'failed',
        { access_guide_link: result.old_link },
        { access_guide_link: result.new_link, error: result.error, mode },
        actorId
      )
      await notifyFailure({ kind: 'property_guide_link_sync_failed', when: now, property_id, mode, guide_id: guideId || null, token_hash: tokenHash || null, old_link: result.old_link, new_link: result.new_link, error: result.error })
    }

    return { ok: result.status === 'success', status: result.status, property_id, old_link: result.old_link, new_link: result.new_link, error: result.error }
  }

  return run()
}

const runSchema = z.object({
  property_ids: z.array(z.string().min(1)).optional(),
  include_archived: z.boolean().optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  concurrency: z.number().int().min(1).max(50).optional(),
  dry_run: z.boolean().optional(),
})

router.post('/run', requireAnyPerm(['property.write', 'property_guides.write', 'rbac.manage']), async (req, res) => {
  const parsed = runSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureSyncLogsTable()
    const includeArchived = !!parsed.data.include_archived
    const ids = Array.isArray(parsed.data.property_ids) ? parsed.data.property_ids.map((x) => String(x).trim()).filter(Boolean) : []
    const limit = parsed.data.limit ?? 500
    const concurrency = parsed.data.concurrency ?? 8
    const dryRun = !!parsed.data.dry_run
    const actor = (req as any)?.user?.sub || null
    const origin = String(req.headers.origin || '')

    const candidates = await (async () => {
      if (ids.length) {
        const r = await pgPool!.query('SELECT id, archived FROM properties WHERE id = ANY($1)', [ids])
        return (r?.rows || []).filter((p: any) => includeArchived || !p.archived)
      }
      const r = await pgPool!.query('SELECT id, archived FROM properties WHERE ($1::boolean) OR archived=false ORDER BY created_at DESC NULLS LAST LIMIT $2', [includeArchived, limit])
      return r?.rows || []
    })()

    const out: any[] = []
    let idx = 0
    async function worker() {
      while (idx < candidates.length) {
        const cur = candidates[idx++]
        const pid = String(cur?.id || '').trim()
        if (!pid) continue
        if (dryRun) {
          out.push({ ok: true, status: 'skipped', property_id: pid, old_link: null, new_link: null, error: 'dry_run' })
          continue
        }
        try {
          const r = await syncPropertyAccessGuideLink({ propertyId: pid, mode: 'batch', reqOrigin: origin, actorId: actor || undefined })
          out.push(r)
        } catch (e: any) {
          const msg = String(e?.message || 'sync_failed')
          await pgPool!.query(
            `INSERT INTO property_guide_link_sync_logs(mode, status, source_property_id, target_property_id, old_link, new_link, error_message)
             VALUES($1,$2,$3,$4,$5,$6,$7)`,
            ['batch', 'failed', pid, pid, null, null, msg]
          )
          await notifyFailure({ kind: 'property_guide_link_sync_failed', when: new Date().toISOString(), property_id: pid, mode: 'batch', error: msg })
          out.push({ ok: false, status: 'failed', property_id: pid, old_link: null, new_link: null, error: msg })
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, candidates.length)) }, () => worker())
    await Promise.all(workers)
    const okCount = out.filter((x) => x?.ok).length
    const failCount = out.filter((x) => x?.status === 'failed').length
    const skippedCount = out.filter((x) => x?.status === 'skipped').length
    return res.json({ ok: true, total: out.length, success: okCount, failed: failCount, skipped: skippedCount, items: out })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'run failed' })
  }
})

router.post('/trigger/:propertyId', requireAnyPerm(['property.write', 'property_guides.write', 'rbac.manage']), async (req, res) => {
  const propertyId = String((req.params as any)?.propertyId || '').trim()
  if (!propertyId) return res.status(400).json({ message: 'missing propertyId' })
  try {
    const actor = (req as any)?.user?.sub || null
    const origin = String(req.headers.origin || '')
    const r = await syncPropertyAccessGuideLink({ propertyId, mode: 'manual', reqOrigin: origin, actorId: actor || undefined })
    return res.json(r)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'trigger failed' })
  }
})

router.get('/logs', requireAnyPerm(['property_guides.view', 'property.write', 'rbac.manage']), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureSyncLogsTable()
    const q: any = req.query || {}
    const propertyId = q.property_id ? String(q.property_id).trim() : ''
    const limit = Math.max(1, Math.min(500, Number(q.limit || 50)))
    if (propertyId) {
      const r = await pgPool!.query('SELECT * FROM property_guide_link_sync_logs WHERE target_property_id=$1 ORDER BY synced_at DESC, id DESC LIMIT $2', [propertyId, limit])
      return res.json(r?.rows || [])
    }
    const r = await pgPool!.query('SELECT * FROM property_guide_link_sync_logs ORDER BY synced_at DESC, id DESC LIMIT $1', [limit])
    return res.json(r?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list logs failed' })
  }
})

router.get('/status', requireAnyPerm(['property_guides.view', 'property.write', 'rbac.manage']), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureSyncLogsTable()
    const propertyId = String((req.query as any)?.property_id || '').trim()
    if (!propertyId) return res.status(400).json({ message: 'missing property_id' })
    const origin = String(req.headers.origin || '')
    const baseUrl = pickPublicBaseUrl(origin)

    const pr = await pgPool!.query('SELECT id, access_guide_link, archived FROM properties WHERE id=$1', [propertyId])
    const p = pr?.rows?.[0]
    if (!p) return res.status(404).json({ message: 'property not found' })

    const q = await pgPool!.query(
      `SELECT g.id as guide_id, l.token_hash, l.token_enc
       FROM property_guides g
       JOIN property_guide_public_links l ON l.guide_id = g.id
       WHERE g.property_id=$1
         AND g.status='published'
         AND l.revoked_at IS NULL
         AND l.expires_at > now()
       ORDER BY l.created_at DESC
       LIMIT 1`,
      [propertyId]
    )
    const row = q?.rows?.[0]
    const tok = row?.token_enc ? decryptLinkToken(String(row.token_enc)) : ''
    const expected = tok ? buildPublicGuideUrl(tok, baseUrl) : ''
    const current = String(p.access_guide_link || '')

    const lr = await pgPool!.query('SELECT * FROM property_guide_link_sync_logs WHERE target_property_id=$1 ORDER BY synced_at DESC, id DESC LIMIT 1', [propertyId])
    const last = lr?.rows?.[0] || null

    return res.json({
      property_id: propertyId,
      archived: !!p.archived,
      current_link: current || null,
      expected_link: expected || null,
      consistent: expected ? current === expected : true,
      last_sync: last,
      active_guide_id: row?.guide_id || null,
      active_token_hash: row?.token_hash || null,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'status failed' })
  }
})
