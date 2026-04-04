import { db } from '../store'
import { hasPg, pgPool } from '../dbAdapter'
import { renderMonthlyStatementPdfHtml } from './monthlyStatementPdfTemplate'
import { waitForImages } from './waitForImages'
import { getChromiumBrowser, resetChromiumBrowser } from './playwright'
import { normalizePhotoUrlForPdf } from './normalizePhotoUrlForPdf'
import { listPhotoUrls, loadMonthlyStatementPhotoRows } from './monthlyStatementPhotoRecords'

export type StatementPhotoPackSection = 'all' | 'maintenance' | 'deep_cleaning'
export type StatementPhotoPackPhotosMode = 'full' | 'compressed' | 'thumbnail' | 'off'

export type GenerateStatementPhotoPackInput = {
  month: string
  propertyId: string
  sections: StatementPhotoPackSection
  showChinese: boolean
  apiBase: string
  photosMode?: StatementPhotoPackPhotosMode
  compress?: { w: number; q: number }
  syncGuard?: boolean
}

export type GenerateStatementPhotoPackResult = {
  pdf: Buffer
  filename: string
  imageCount: number
  rawUrls: number
  cleanedUrls: number
  effectivePhotosMode: Exclude<StatementPhotoPackPhotosMode, 'off'>
  failedUrls: string[]
  notLoaded: number
  detail: string
}

function monthRangeISO(monthKey: string): { start: string; end: string } | null {
  const m = String(monthKey || '').trim()
  const mm = m.match(/^(\d{4})-(\d{2})$/)
  if (!mm) return null
  const y = Number(mm[1])
  const mo = Number(mm[2])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null
  const start = new Date(Date.UTC(y, mo - 1, 1))
  const end = new Date(Date.UTC(y, mo, 1))
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

function isPlaywrightClosedError(e: any) {
  const msg = String(e?.message || '')
  return /(Target page, context or browser has been closed|browser has been closed|browser disconnected|Target closed)/i.test(msg)
}

function countRawUrls(rows: any[]) {
  let n = 0
  for (const r of rows || []) {
    n += listPhotoUrls(r?.photo_urls).length
    n += listPhotoUrls(r?.repair_photo_urls).length
  }
  return n
}

function defaultCompressForMode(mode: Exclude<StatementPhotoPackPhotosMode, 'off'>) {
  if (mode === 'thumbnail') return { w: 900, q: 45 }
  if (mode === 'compressed') return { w: 1200, q: 58 }
  return { w: 1600, q: 72 }
}

function normalizedCode(raw: any) {
  const codeRaw = String(raw || '').trim()
  if (!codeRaw) return ''
  const s = codeRaw.split('(')[0].trim()
  const t = s.split(/\s+/)[0].trim()
  return t || s || codeRaw
}

function buildFilename(monthKey: string, property: any, sections: StatementPhotoPackSection) {
  const code = String(property?.code || property?.address || property?.id || '').trim() || 'property'
  const safe = code.replace(/[^a-zA-Z0-9._-]+/g, '-')
  const suffix = sections === 'maintenance' ? 'maintenance-photos' : sections === 'deep_cleaning' ? 'deep-cleaning-photos' : 'all-photos'
  return `monthly-statement-${monthKey}-${safe}-${suffix}.pdf`
}

async function landlordNameByProperty(landlordId: string): Promise<string> {
  const lid = String(landlordId || '').trim()
  if (!lid || !hasPg || !pgPool) return ''
  try {
    const r = await pgPool.query('SELECT name FROM landlords WHERE id = $1 LIMIT 1', [lid])
    return String(r.rows?.[0]?.name || '').trim()
  } catch {
    return ''
  }
}

export async function generateStatementPhotoPackPdf(input: GenerateStatementPhotoPackInput): Promise<GenerateStatementPhotoPackResult> {
  const monthKey = String(input.month || '').trim()
  const pid = String(input.propertyId || '').trim()
  const sections = (String(input.sections || 'all').trim() || 'all') as StatementPhotoPackSection
  const requestedMode = (() => {
    const raw = String(input.photosMode || 'compressed').trim()
    if (raw === 'full' || raw === 'compressed' || raw === 'thumbnail') return raw as Exclude<StatementPhotoPackPhotosMode, 'off'>
    return 'compressed'
  })()
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    const e: any = new Error('invalid month')
    e.code = 'JOB_INVALID'
    throw e
  }
  if (!pid) {
    const e: any = new Error('missing property_id')
    e.code = 'JOB_INVALID'
    throw e
  }
  if (!hasPg || !pgPool) {
    const e: any = new Error('no database configured')
    e.code = 'JOB_INVALID'
    throw e
  }
  const range = monthRangeISO(monthKey)
  if (!range) {
    const e: any = new Error('invalid month')
    e.code = 'JOB_INVALID'
    throw e
  }
  const propR = await pgPool.query('SELECT id, code, address, landlord_id FROM properties WHERE id = $1 LIMIT 1', [pid])
  const prop = (propR.rows?.[0] || null) as any
  if (!prop) {
    const e: any = new Error('property not found')
    e.code = 'PROPERTY_NOT_FOUND'
    throw e
  }
  const llName = await landlordNameByProperty(String(prop?.landlord_id || ''))
  const codeRaw = String(prop?.code || '').trim()
  const codeNorm = normalizedCode(codeRaw)
  const wantDeep = sections === 'all' || sections === 'deep_cleaning'
  const wantMaint = sections === 'all' || sections === 'maintenance'
  const [deepRows0, maintRows0] = await Promise.all([
    wantDeep
      ? loadMonthlyStatementPhotoRows({ table: 'property_deep_cleaning', pid, monthKey, range, propertyCode: codeNorm, propertyCodeRaw: codeRaw }).catch(() => [] as any[])
      : Promise.resolve([] as any[]),
    wantMaint
      ? loadMonthlyStatementPhotoRows({ table: 'property_maintenance', pid, monthKey, range, propertyCode: codeNorm, propertyCodeRaw: codeRaw }).catch(() => [] as any[])
      : Promise.resolve([] as any[]),
  ])
  const totalRawUrls = countRawUrls(deepRows0) + countRawUrls(maintRows0)
  const effectivePhotosMode = (() => {
    if (requestedMode === 'thumbnail') return 'thumbnail'
    if (requestedMode === 'compressed') return totalRawUrls > 6 ? 'thumbnail' : 'compressed'
    if (totalRawUrls > 6) return 'thumbnail'
    if (totalRawUrls > 0) return 'compressed'
    return 'full'
  })() as Exclude<StatementPhotoPackPhotosMode, 'off'>
  const compress = input.compress || defaultCompressForMode(effectivePhotosMode)
  if (input.syncGuard) {
    const syncMaxPhotos = Math.max(1, Math.min(20, Number(process.env.MONTHLY_STATEMENT_SYNC_MAX_PHOTOS || 6)))
    if (totalRawUrls > syncMaxPhotos) {
      const e: any = new Error('too_many_photos_for_sync_export')
      e.code = 'MEMORY_GUARD_BLOCKED'
      e.rawUrls = totalRawUrls
      e.syncMaxPhotos = syncMaxPhotos
      throw e
    }
  }
  const normalizePhotoUrl = (u: string) => normalizePhotoUrlForPdf(u, {
    apiBase: input.apiBase,
    allowR2KeyPrefixes: ['maintenance/', 'deep-cleaning/', 'deep-cleaning-upload/', 'invoice-company-logos/'],
    photosMode: effectivePhotosMode,
    compress,
  })
  const mapRowUrls = (r: any) => {
    const before = listPhotoUrls(r?.photo_urls).map(normalizePhotoUrl).filter((u) => /^https?:\/\//i.test(u))
    const after = listPhotoUrls(r?.repair_photo_urls).map(normalizePhotoUrl).filter((u) => /^https?:\/\//i.test(u))
    return { ...r, photo_urls: before, repair_photo_urls: after }
  }
  const deepRows = Array.isArray(deepRows0) ? deepRows0.map(mapRowUrls) : []
  const maintRows = Array.isArray(maintRows0) ? maintRows0.map(mapRowUrls) : []
  const cleanedUrls = countRawUrls(deepRows) + countRawUrls(maintRows)
  const tpl = renderMonthlyStatementPdfHtml({
    month: monthKey,
    property: { id: String(prop.id), code: prop.code || '', address: prop.address || '' },
    landlordName: llName || '',
    sections,
    showChinese: !!input.showChinese,
    includePhotosMode: effectivePhotosMode as any,
    deepCleanings: deepRows as any,
    maintenances: maintRows as any,
  } as any)
  const imageCount = Number(tpl?.imageCount || 0)
  if (imageCount <= 0) {
    const e: any = new Error('no photos to render for requested sections')
    e.code = 'NO_PHOTOS_TO_RENDER'
    e.rawUrls = totalRawUrls
    e.cleanedUrls = cleanedUrls
    throw e
  }
  const totalTimeoutMs = Math.max(15000, Math.min(180000, Number(process.env.MONTHLY_STATEMENT_PHOTO_PACK_TIMEOUT_MS || 75000)))
  const startedAt = Date.now()
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
    const navTimeoutMs = Math.max(5000, Math.min(90000, Number(process.env.PDF_NAV_TIMEOUT_MS || 45000)))
    const waitTimeoutMs = Math.max(5000, Math.min(90000, Number(process.env.PDF_WAIT_TIMEOUT_MS || 45000)))
    page.setDefaultTimeout(waitTimeoutMs)
    page.setDefaultNavigationTimeout(navTimeoutMs)
    await page.setContent(tpl.html, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs } as any)
    await page.evaluate(() => (document as any).fonts?.ready).catch(() => {})
    const remainForImages = Math.max(5000, totalTimeoutMs - (Date.now() - startedAt) - 5000)
    const imgStats = await waitForImages(page, { timeoutMs: Math.min(20000, remainForImages), scroll: true, tryFallbackAttr: 'data-fallback', maxFailedUrls: 8 }).catch(() => ({ total: 0, notLoaded: 0, failedUrls: [] as string[] }))
    if (Date.now() - startedAt > totalTimeoutMs) {
      const e: any = new Error('pdf_generation_timeout')
      e.code = 'PDF_GENERATION_TIMEOUT'
      throw e
    }
    await page.waitForTimeout(150)
    await page.emulateMedia({ media: 'print' } as any)
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
    const detail = `图片 ${imageCount} 张（原始 ${totalRawUrls} / 可渲染 ${cleanedUrls}${Number((imgStats as any)?.notLoaded || 0) > 0 ? ` / 未加载 ${Number((imgStats as any)?.notLoaded || 0)}` : ''}）`
    return {
      pdf: Buffer.from(pdf),
      filename: buildFilename(monthKey, prop, sections),
      imageCount,
      rawUrls: totalRawUrls,
      cleanedUrls,
      effectivePhotosMode,
      failedUrls: Array.isArray((imgStats as any)?.failedUrls) ? (imgStats as any).failedUrls : [],
      notLoaded: Number((imgStats as any)?.notLoaded || 0),
      detail,
    }
  } catch (e: any) {
    if (String(e?.code || '') === 'PDF_GENERATION_TIMEOUT') throw e
    if (/timeout/i.test(String(e?.message || ''))) {
      const e2: any = new Error('pdf_image_fetch_timeout')
      e2.code = 'PDF_IMAGE_FETCH_TIMEOUT'
      throw e2
    }
    throw e
  } finally {
    try { await context?.close?.() } catch {}
  }
}
