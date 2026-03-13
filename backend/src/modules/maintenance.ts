import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import { requireAnyPerm } from '../auth'
import { hasPg, pgPool } from '../dbAdapter'
import crypto from 'crypto'
import { pdfTaskLimiter } from '../lib/pdfTaskLimiter'
import { getChromiumBrowser, resetChromiumBrowser } from '../lib/playwright'
import { waitForImages } from '../lib/waitForImages'
import { renderWorkRecordPdfHtml } from '../lib/workRecordPdfTemplate'
import { resizeUploadImage } from '../lib/uploadImageResize'

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

function isPlaywrightClosedError(e: any) {
  const msg = String(e?.message || '')
  return /(Target page, context or browser has been closed|browser has been closed|browser disconnected|Target closed)/i.test(msg)
}

async function ensurePropertyMaintenanceTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_maintenance (
    id text PRIMARY KEY,
    property_id text REFERENCES properties(id) ON DELETE SET NULL,
    occurred_at date,
    worker_name text,
    details text,
    notes text,
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
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category_detail text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS started_at timestamptz;')
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
    await ensurePropertyMaintenanceTable()
    const r0 = await pgPool.query(
      `SELECT m.*, COALESCE(m.property_code, p.code) AS property_code
       FROM property_maintenance m
       LEFT JOIN properties p ON p.id = m.property_id
       WHERE m.id=$1
       LIMIT 1`,
      [rid]
    )
    const row = r0.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })

    const tz = 'Australia/Melbourne'
    function dayStrAtTZ(d: Date): string {
      const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
      const get = (t: string) => parts.find(p => p.type === t)?.value || ''
      const yyyy = get('year'); const mm = get('month'); const dd = get('day')
      return `${yyyy}-${mm}-${dd}`
    }
    function timeStrAtTZ(d: Date): string {
      const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
      const get = (t: string) => parts.find(p => p.type === t)?.value || ''
      const hh = get('hour'); const mi = get('minute')
      return `${hh}:${mi}`
    }
    function pickDateOnly(): string {
      const occurred = String(row?.occurred_at || '').slice(0, 10)
      if (/^\d{4}-\d{2}-\d{2}$/.test(occurred)) return occurred
      const raw = row?.completed_at || row?.started_at || row?.created_at
      if (!raw) return ''
      const d = new Date(String(raw))
      return isNaN(d.getTime()) ? '' : dayStrAtTZ(d)
    }
    function completionText(): string {
      const dateOnly = pickDateOnly()
      const stRaw = String(row?.started_at || '').trim()
      const ctRaw = String(row?.completed_at || '').trim()
      const st = stRaw ? new Date(stRaw) : null
      const ct = ctRaw ? new Date(ctRaw) : null
      const stOk = st && !isNaN(st.getTime())
      const ctOk = ct && !isNaN(ct.getTime())
      const base = dateOnly || (ctOk ? dayStrAtTZ(ct as any) : (stOk ? dayStrAtTZ(st as any) : ''))
      if (stOk && ctOk) return `${base} ${timeStrAtTZ(st as any)}~${timeStrAtTZ(ct as any)}`
      if (ctOk) return `${base} ${timeStrAtTZ(ct as any)}`
      if (stOk) return `${base} ${timeStrAtTZ(st as any)}`
      return base || '-'
    }

    const apiBase = (() => {
      const host = String((req.headers['x-forwarded-host'] as any) || req.headers.host || '').split(',')[0].trim()
      const proto = String((req.headers['x-forwarded-proto'] as any) || req.protocol || 'https').split(',')[0].trim()
      return host ? `${proto}://${host}` : ''
    })()
    const isR2 = (u: string) => u.includes('.r2.dev/') || u.includes('r2.cloudflarestorage.com/')
    const proxyR2 = (u: string) => apiBase ? `${apiBase}/public/r2-image?url=${encodeURIComponent(u)}` : u
    const normalizePhotoUrl = (u: string) => {
      const s = String(u || '').trim()
      if (!s) return ''
      if (/^https?:\/\//i.test(s)) return isR2(s) ? proxyR2(s) : s
      if (s.startsWith('//')) {
        const abs = `https:${s}`
        return isR2(abs) ? proxyR2(abs) : abs
      }
      if (s.startsWith('/')) return apiBase ? `${apiBase}${s}` : ''
      return ''
    }
    const normUrlList = (raw: any): string[] => {
      if (!raw) return []
      let arr: any[] = []
      if (Array.isArray(raw)) arr = raw
      else if (typeof raw === 'string') { try { const j = JSON.parse(raw); arr = Array.isArray(j) ? j : [] } catch { arr = [] } }
      return arr
        .map((x) => {
          if (!x) return ''
          if (typeof x === 'string') return x
          if (typeof x === 'object') return String((x as any).url || (x as any).src || (x as any).path || '')
          return String(x || '')
        })
        .map((s) => String(s || '').trim())
        .filter(Boolean)
    }
    const beforeUrls = normUrlList(row?.photo_urls).map(normalizePhotoUrl).filter(u => /^https?:\/\//i.test(u))
    const afterUrls = normUrlList(row?.repair_photo_urls).map(normalizePhotoUrl).filter(u => /^https?:\/\//i.test(u))

    const tpl = renderWorkRecordPdfHtml({
      kind: 'maintenance',
      showChinese,
      jobNumber: String(row?.work_no || row?.id || ''),
      completionText: completionText(),
      areaText: String(row?.category_detail || row?.category || ''),
      beforeUrls,
      afterUrls,
    })
    if (Number(tpl?.imageCount || 0) <= 0) return res.status(422).json({ message: 'no photos to render' })

    const filename = `maintenance-${String(row?.work_no || row?.id || rid).replace(/[^a-zA-Z0-9._-]+/g, '-')}.pdf`
    const navTimeoutMs = Math.max(5000, Math.min(120000, Number(process.env.PDF_NAV_TIMEOUT_MS || 45000)))
    const waitTimeoutMs = Math.max(5000, Math.min(120000, Number(process.env.PDF_WAIT_TIMEOUT_MS || 45000)))

    const runOnce = async () => {
      let browser = await getChromiumBrowser()
      let context: any = null
      try { context = await browser.newContext() } catch (e: any) {
        if (!isPlaywrightClosedError(e)) throw e
        await resetChromiumBrowser()
        browser = await getChromiumBrowser()
        context = await browser.newContext()
      }
      try {
        const page = await context.newPage()
        page.setDefaultTimeout(waitTimeoutMs)
        page.setDefaultNavigationTimeout(navTimeoutMs)
        await page.setContent(tpl.html, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs } as any)
        await page.evaluate(() => (document as any).fonts?.ready).catch(() => {})
        await waitForImages(page, { timeoutMs: 20000, scroll: true, tryFallbackAttr: 'data-fallback', maxFailedUrls: 8 }).catch(() => null)
        await page.waitForTimeout(200)
        await page.emulateMedia({ media: 'print' } as any)
        const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
        try { await page.close() } catch {}
        return pdf
      } finally {
        try { await context?.close?.() } catch {}
      }
    }

    let pdf: any = null
    try {
      pdf = await runOnce()
    } catch (e: any) {
      if (!isPlaywrightClosedError(e)) throw e
      await resetChromiumBrowser()
      pdf = await runOnce()
    }

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('X-WorkRecordPdfTemplate', 'workRecordPdfTemplate.v4.headerOnce.noFrame')
    res.setHeader('X-WorkRecordPdfChinese', showChinese ? '1' : '0')
    return res.status(200).send(Buffer.from(pdf))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'generate pdf failed' })
  }
})

export default router
