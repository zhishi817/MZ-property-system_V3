import { hasPg, pgPool } from '../dbAdapter'
import { getChromiumBrowser, resetChromiumBrowser } from './playwright'
import { waitForImages } from './waitForImages'
import { renderWorkRecordPdfHtml } from './workRecordPdfTemplate'
import { normalizePhotoUrlForPdf } from './normalizePhotoUrlForPdf'

export type WorkRecordPdfKind = 'maintenance' | 'deep_cleaning'
export type WorkRecordPdfPhotosMode = 'full' | 'compressed' | 'thumbnail'

type GenerateWorkRecordPdfOptions = {
  recordId: string
  kind: WorkRecordPdfKind
  showChinese?: boolean
  apiBase?: string
  photosMode?: WorkRecordPdfPhotosMode
}

export type GenerateWorkRecordPdfResult = {
  pdf: Buffer
  filename: string
  imageCount: number
  failedUrls: string[]
  notLoaded: number
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
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS invoice_description_en text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS started_at timestamptz;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS completed_at timestamptz;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS updated_at timestamptz;')
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
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS invoice_description_en text;')
}

function dayStrAtTZ(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  const yyyy = get('year')
  const mm = get('month')
  const dd = get('day')
  return `${yyyy}-${mm}-${dd}`
}

function timeStrAtTZ(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  const hh = get('hour')
  const mi = get('minute')
  return `${hh}:${mi}`
}

function parseUrlList(raw: any): string[] {
  if (!raw) return []
  let arr: any[] = []
  if (Array.isArray(raw)) arr = raw
  else if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw)
      arr = Array.isArray(j) ? j : []
    } catch {
      arr = []
    }
  }
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

function photoCompressOptions(photosMode: WorkRecordPdfPhotosMode) {
  if (photosMode === 'thumbnail') return { w: 900, q: 45 }
  if (photosMode === 'compressed') return { w: 1200, q: 58 }
  return undefined
}

async function loadRow(kind: WorkRecordPdfKind, recordId: string) {
  if (!hasPg || !pgPool) throw new Error('no database configured')
  if (kind === 'maintenance') {
    await ensurePropertyMaintenanceTable()
    const r0 = await pgPool.query(
      `SELECT m.*, COALESCE(m.property_code, p.code) AS property_code
       FROM property_maintenance m
       LEFT JOIN properties p ON p.id = m.property_id
       WHERE m.id=$1
       LIMIT 1`,
      [recordId]
    )
    return r0.rows?.[0] || null
  }
  await ensurePropertyDeepCleaningTable()
  const r0 = await pgPool.query(
    `SELECT d.*, COALESCE(d.property_code, p.code) AS property_code
     FROM property_deep_cleaning d
     LEFT JOIN properties p ON p.id = d.property_id
     WHERE d.id=$1
     LIMIT 1`,
    [recordId]
  )
  return r0.rows?.[0] || null
}

function completionTextForRow(kind: WorkRecordPdfKind, row: any, tz: string) {
  const occurred = String(row?.occurred_at || '').slice(0, 10)
  const pickDateOnly = () => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(occurred)) return occurred
    const raw = kind === 'maintenance'
      ? (row?.completed_at || row?.started_at || row?.created_at)
      : (row?.started_at || row?.completed_at || row?.created_at)
    if (!raw) return ''
    const d = new Date(String(raw))
    return isNaN(d.getTime()) ? '' : dayStrAtTZ(d, tz)
  }
  const dateOnly = pickDateOnly()
  if (kind === 'maintenance') {
    const st = row?.started_at ? new Date(String(row.started_at)) : null
    const ct = row?.completed_at ? new Date(String(row.completed_at)) : null
    const stOk = !!(st && !isNaN(st.getTime()))
    const ctOk = !!(ct && !isNaN(ct.getTime()))
    const base = dateOnly || (ctOk ? dayStrAtTZ(ct as Date, tz) : (stOk ? dayStrAtTZ(st as Date, tz) : ''))
    if (stOk && ctOk) return `${base} ${timeStrAtTZ(st as Date, tz)}~${timeStrAtTZ(ct as Date, tz)}`
    if (ctOk) return `${base} ${timeStrAtTZ(ct as Date, tz)}`
    if (stOk) return `${base} ${timeStrAtTZ(st as Date, tz)}`
    return base || '-'
  }
  const st = row?.started_at ? new Date(String(row.started_at)) : null
  const en = row?.ended_at ? new Date(String(row.ended_at)) : null
  const ct = row?.completed_at ? new Date(String(row.completed_at)) : null
  const stOk = !!(st && !isNaN(st.getTime()))
  const enOk = !!(en && !isNaN(en.getTime()))
  const ctOk = !!(ct && !isNaN(ct.getTime()))
  const base = dateOnly || (stOk ? dayStrAtTZ(st as Date, tz) : (ctOk ? dayStrAtTZ(ct as Date, tz) : ''))
  if (stOk && enOk) return `${base} ${timeStrAtTZ(st as Date, tz)}~${timeStrAtTZ(en as Date, tz)}`
  if (stOk) return `${base} ${timeStrAtTZ(st as Date, tz)}`
  if (enOk) return `${base} ${timeStrAtTZ(en as Date, tz)}`
  if (ctOk) return `${base} ${timeStrAtTZ(ct as Date, tz)}`
  return base || '-'
}

export async function generateWorkRecordPdf(opts: GenerateWorkRecordPdfOptions): Promise<GenerateWorkRecordPdfResult> {
  const recordId = String(opts.recordId || '').trim()
  const kind = opts.kind
  const showChinese = !!opts.showChinese
  const photosMode = (opts.photosMode || 'full') as WorkRecordPdfPhotosMode
  if (!recordId) throw new Error('missing id')
  const row = await loadRow(kind, recordId)
  if (!row) throw new Error('not found')

  const tz = 'Australia/Melbourne'
  const apiBase = String(opts.apiBase || '').trim()
  const normalizePhotoUrl = (u: string) => normalizePhotoUrlForPdf(u, {
    apiBase,
    allowR2KeyPrefixes: kind === 'maintenance' ? ['maintenance/'] : ['deep-cleaning/', 'deep-cleaning-upload/'],
    photosMode,
    compress: photoCompressOptions(photosMode),
  })

  const beforeUrls = parseUrlList(row?.photo_urls).map(normalizePhotoUrl).filter(u => /^https?:\/\//i.test(u))
  const afterUrls = parseUrlList(row?.repair_photo_urls).map(normalizePhotoUrl).filter(u => /^https?:\/\//i.test(u))

  const tpl = renderWorkRecordPdfHtml({
    kind,
    showChinese,
    jobNumber: String(row?.work_no || row?.id || ''),
    completionText: completionTextForRow(kind, row, tz),
    areaText: kind === 'maintenance' ? String(row?.area || row?.category_detail || row?.category || '') : String(row?.category || ''),
    beforeUrls,
    afterUrls,
  })
  if (Number(tpl?.imageCount || 0) <= 0) throw new Error('no photos to render')

  const filename = `${kind === 'maintenance' ? 'maintenance' : 'deep-cleaning'}-${String(row?.work_no || row?.id || recordId).replace(/[^a-zA-Z0-9._-]+/g, '-')}.pdf`
  const navTimeoutMs = Math.max(5000, Math.min(120000, Number(process.env.PDF_NAV_TIMEOUT_MS || 45000)))
  const waitTimeoutMs = Math.max(5000, Math.min(120000, Number(process.env.PDF_WAIT_TIMEOUT_MS || 45000)))

  const runOnce = async () => {
    let browser = await getChromiumBrowser()
    let context: any = null
    try {
      try {
        context = await browser.newContext()
      } catch (e: any) {
        if (!isPlaywrightClosedError(e)) throw e
        await resetChromiumBrowser()
        browser = await getChromiumBrowser()
        context = await browser.newContext()
      }
      const page = await context.newPage()
      page.setDefaultTimeout(waitTimeoutMs)
      page.setDefaultNavigationTimeout(navTimeoutMs)
      await page.setContent(tpl.html, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs } as any)
      await page.evaluate(() => (document as any).fonts?.ready).catch(() => {})
      const imgState = await waitForImages(page, { timeoutMs: 20000, scroll: true, tryFallbackAttr: 'data-fallback', maxFailedUrls: 8 }).catch(() => ({ total: 0, notLoaded: 0, failedUrls: [] as string[] }))
      await page.waitForTimeout(200)
      await page.emulateMedia({ media: 'print' } as any)
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
      try { await page.close() } catch {}
      return { pdf: Buffer.from(pdf), imgState }
    } finally {
      try { await context?.close?.() } catch {}
    }
  }

  let result: { pdf: Buffer; imgState: { total: number; notLoaded: number; failedUrls: string[] } } | null = null
  try {
    result = await runOnce()
  } catch (e: any) {
    if (!isPlaywrightClosedError(e)) throw e
    await resetChromiumBrowser()
    result = await runOnce()
  }

  return {
    pdf: result.pdf,
    filename,
    imageCount: Number(tpl?.imageCount || 0),
    failedUrls: Array.isArray(result.imgState?.failedUrls) ? result.imgState.failedUrls : [],
    notLoaded: Number(result.imgState?.notLoaded || 0),
  }
}
