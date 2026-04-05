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
  onStage?: (stage: string, detail: string, meta?: Record<string, any>) => Promise<void> | void
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
  metrics: Record<string, any>
}

function jobError(code: string, message: string, extra?: Record<string, any>) {
  const e: any = new Error(message)
  e.code = code
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) e[k] = v
  }
  return e
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

function nowMs() {
  return Date.now()
}

function isLikelyImageUrl(u: string): boolean {
  const s = String(u || '').trim().toLowerCase()
  if (!s) return false
  if (/\/public\/r2-image\b|\/r2-image\b/.test(s)) return true
  if (/\.(jpg|jpeg|png|webp|gif|bmp|svg|heic|heif)(\?|$)/i.test(s)) return true
  if (/\.(mp4|mov|avi|m4v|webm)(\?|$)/i.test(s)) return false
  return /^https?:\/\//i.test(s)
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  const n = Math.max(1, Math.min(20, Number(limit || 1)))
  let idx = 0
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const cur = idx++
      if (cur >= items.length) break
      await worker(items[cur], cur)
    }
  })
  await Promise.all(runners)
}

async function preflightPhotoUrls(urls: string[]): Promise<{ ok: string[]; failed: string[]; checked: number; skipped: number }> {
  const unique = Array.from(new Set(urls.map((u) => String(u || '').trim()).filter(Boolean)))
  if (!unique.length) return { ok: [], failed: [], checked: 0, skipped: 0 }
  const maxChecks = Math.max(1, Math.min(12, Number(process.env.PHOTO_PREFLIGHT_MAX_CHECKS || 6)))
  const candidates = unique.slice(0, maxChecks)
  const timeoutMs = Math.max(1500, Math.min(12000, Number(process.env.PHOTO_PREFLIGHT_TIMEOUT_MS || 4000)))
  const concurrency = Math.max(2, Math.min(8, Number(process.env.PHOTO_PREFLIGHT_CONCURRENCY || 4)))
  const ok: string[] = []
  const failed: string[] = []
  await runLimited(candidates, concurrency, async (u) => {
    const ac = new AbortController()
    const t = setTimeout(() => { try { ac.abort() } catch {} }, timeoutMs)
    try {
      let r: any = null
      try {
        r = await fetch(u, { method: 'HEAD', signal: ac.signal } as any)
      } catch {}
      const shouldFallbackGet = !r || !r.ok || [403, 405, 501].includes(Number(r?.status || 0))
      if (shouldFallbackGet) {
        try { await r?.body?.cancel?.() } catch {}
        r = await fetch(u, { method: 'GET', signal: ac.signal } as any)
      }
      const ct = String(r?.headers?.get?.('content-type') || '').toLowerCase()
      try { await r?.body?.cancel?.() } catch {}
      if (!r?.ok) throw new Error(`http_${String(r?.status || '')}`)
      if (ct && !ct.startsWith('image/')) throw new Error(`invalid_content_type:${ct}`)
      ok.push(u)
    } catch {
      failed.push(u)
    } finally {
      clearTimeout(t)
    }
  })
  return { ok, failed, checked: candidates.length, skipped: Math.max(0, unique.length - candidates.length) }
}

export async function generateStatementPhotoPackPdf(input: GenerateStatementPhotoPackInput): Promise<GenerateStatementPhotoPackResult> {
  const metrics: Record<string, any> = {}
  const stage = async (name: string, detail: string, meta?: Record<string, any>) => {
    if (meta && typeof meta === 'object') Object.assign(metrics, meta)
    await input.onStage?.(name, detail, meta)
  }
  const t0 = nowMs()
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
  metrics.load_rows_ms = nowMs() - t0
  const totalRawUrls = countRawUrls(deepRows0) + countRawUrls(maintRows0)
  await stage('normalize_urls', `正在整理照片链接（原始 ${totalRawUrls}）...`, { rawUrls: totalRawUrls })
  const apiBase = String(input.apiBase || '').trim().replace(/\/+$/g, '')
  if (totalRawUrls > 0 && !/^https?:\/\//i.test(apiBase)) {
    throw jobError('PHOTO_ASSETS_UNREACHABLE', 'photo assets unreachable: missing valid api base', { rawUrls: totalRawUrls })
  }
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
    apiBase,
    allowR2KeyPrefixes: ['maintenance/', 'deep-cleaning/', 'deep-cleaning-upload/', 'invoice-company-logos/'],
    photosMode: effectivePhotosMode,
    compress,
  })
  const mapRowUrls = (r: any) => {
    const before = listPhotoUrls(r?.photo_urls).map(normalizePhotoUrl).filter((u) => /^https?:\/\//i.test(u) && isLikelyImageUrl(u))
    const after = listPhotoUrls(r?.repair_photo_urls).map(normalizePhotoUrl).filter((u) => /^https?:\/\//i.test(u) && isLikelyImageUrl(u))
    return { ...r, photo_urls: before, repair_photo_urls: after }
  }
  const deepRows = Array.isArray(deepRows0) ? deepRows0.map(mapRowUrls) : []
  const maintRows = Array.isArray(maintRows0) ? maintRows0.map(mapRowUrls) : []
  const cleanedUrls = countRawUrls(deepRows) + countRawUrls(maintRows)
  metrics.normalize_urls_ms = nowMs() - t0 - Number(metrics.load_rows_ms || 0)
  if (totalRawUrls > 0 && cleanedUrls <= 0) {
    throw jobError('PHOTO_ASSETS_UNREACHABLE', 'photo assets unreachable: no renderable urls after normalization', {
      rawUrls: totalRawUrls,
      cleanedUrls,
    })
  }
  const allUrls = Array.from(new Set(
    [...deepRows, ...maintRows].flatMap((r: any) => [...listPhotoUrls(r?.photo_urls), ...listPhotoUrls(r?.repair_photo_urls)])
  ))
  await stage('prefetch_validate', `正在校验照片资源（${allUrls.length}）...`, { dedupedUrls: allUrls.length, cleanedUrls })
  const preflightStartedAt = nowMs()
  const preflight = await preflightPhotoUrls(allUrls)
  metrics.prefetch_validate_ms = nowMs() - preflightStartedAt
  metrics.validatedUrls = preflight.ok.length
  metrics.failed_prefetch = preflight.failed.length
  metrics.checked_prefetch = preflight.checked
  metrics.skipped_prefetch = preflight.skipped
  const preflightWarn = preflight.failed.length > 0
    ? `快检异常 ${preflight.failed.length}/${preflight.checked || 0}，将继续尝试渲染`
    : ''
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
    await stage('wait_images', `正在等待全部照片加载（${imageCount}）...`, { imageCount })
    await page.setContent(tpl.html, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs } as any)
    await page.evaluate(() => (document as any).fonts?.ready).catch(() => {})
    const remainForImages = Math.max(5000, totalTimeoutMs - (Date.now() - startedAt) - 5000)
    const waitStartedAt = nowMs()
    const imgStats = await waitForImages(page, { timeoutMs: Math.min(12000, remainForImages), scroll: 'once', tryFallbackAttr: 'data-fallback', maxFailedUrls: 12 }).catch(() => ({ total: 0, notLoaded: 0, failedUrls: [] as string[] }))
    metrics.wait_images_ms = nowMs() - waitStartedAt
    const notLoaded = Number((imgStats as any)?.notLoaded || 0)
    const failedUrls = Array.isArray((imgStats as any)?.failedUrls) ? (imgStats as any).failedUrls : []
    const mergedFailedUrls = Array.from(new Set([...(preflight.failed || []), ...failedUrls])).slice(0, 20)
    if (imageCount > 0 && notLoaded >= imageCount) {
      throw jobError('PHOTO_PACK_RENDER_EMPTY', 'photo pack render empty: all images failed to load', {
        imageCount,
        notLoaded,
        failedUrls: mergedFailedUrls,
      })
    }
    if (Date.now() - startedAt > totalTimeoutMs) {
      const e: any = new Error('pdf_generation_timeout')
      e.code = 'PDF_GENERATION_TIMEOUT'
      throw e
    }
    await stage('render_pdf', '正在生成 PDF...', {})
    await page.waitForTimeout(150)
    await page.emulateMedia({ media: 'print' } as any)
    const pdfStartedAt = nowMs()
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
    metrics.render_pdf_ms = nowMs() - pdfStartedAt
    metrics.pdf_bytes = Buffer.byteLength(pdf)
    const detailParts = [
      `图片 ${imageCount} 张（原始 ${totalRawUrls} / 去重 ${allUrls.length} / 可渲染 ${cleanedUrls} / 已快检 ${preflight.ok.length}/${preflight.checked || 0}）`,
    ]
    if (preflightWarn) detailParts.push(preflightWarn)
    if (notLoaded > 0) detailParts.push(`渲染时有 ${notLoaded} 张未成功加载，已尽量导出其余图片`)
    const detail = detailParts.join('；')
    return {
      pdf: Buffer.from(pdf),
      filename: buildFilename(monthKey, prop, sections),
      imageCount,
      rawUrls: totalRawUrls,
      cleanedUrls,
      effectivePhotosMode,
      failedUrls: mergedFailedUrls,
      notLoaded,
      detail,
      metrics,
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
