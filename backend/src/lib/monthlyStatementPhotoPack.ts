import { db } from '../store'
import { hasPg, pgPool } from '../dbAdapter'
import sharp from 'sharp'
import archiver from 'archiver'
import { PassThrough } from 'stream'
import { getChromiumBrowser, resetChromiumBrowser } from './playwright'
import { isAllowedR2ImageKey } from './r2ImageProxyPolicy'
import { estimatePhotoPackRecordPageCount, renderMonthlyStatementPhotoPackHtml, type PhotoPackEmbeddedImage, type PhotoPackTemplateRecord } from './monthlyStatementPhotoPackTemplate'
import { listPhotoUrls, loadMonthlyStatementPhotoRows, recordCompletedDateRaw } from './monthlyStatementPhotoRecords'
import { hasR2, r2GetObjectByKey, r2KeyFromUrl } from '../r2'

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

export type StatementPhotoPackVolume = {
  partNo: number
  filename: string
  pdf: Buffer
  imageCount: number
  pageCount: number
  recordCount: number
  detail: string
}

export type GenerateStatementPhotoPackBundleResult = {
  files: Array<{
    kind: 'statement_photo_pack_pdf' | 'statement_photo_pack_part_pdf' | 'statement_photo_pack_zip'
    filename: string
    contentType: 'application/pdf' | 'application/zip'
    body: Buffer
    imageCount: number
    pageCount: number
    partNo?: number
  }>
  volumeCount: number
  totalImages: number
  totalPages: number
  rawUrls: number
  cleanedUrls: number
  failedUrls: string[]
  notLoaded: number
  effectivePhotosMode: Exclude<StatementPhotoPackPhotosMode, 'off'>
  detail: string
  metrics: Record<string, any>
}

type LoadedAsset = {
  ok: boolean
  image?: PhotoPackEmbeddedImage
  sourceUrl: string
  reason?: string
}

type PreparedStatementPhotoPackData = {
  monthKey: string
  property: { id: string; code?: string; address?: string }
  landlordName: string
  showChinese: boolean
  sections: StatementPhotoPackSection
  effectivePhotosMode: Exclude<StatementPhotoPackPhotosMode, 'off'>
  records: PhotoPackTemplateRecord[]
  rawUrls: number
  cleanedUrls: number
  failedUrls: string[]
  notLoaded: number
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

function dayLabel(raw: any) {
  const s = String(recordCompletedDateRaw(raw) || raw?.occurred_at || raw?.started_at || raw?.created_at || '').trim()
  return s ? s.slice(0, 10) : ''
}

function photoPackLimits() {
  const totalLimit = Math.max(50, Math.min(5000, Number(process.env.PHOTO_PACK_MAX_IMAGES || 1000)))
  const fetchConcurrency = Math.max(2, Math.min(10, Number(process.env.PHOTO_PACK_FETCH_CONCURRENCY || 6)))
  const fetchTimeoutMs = Math.max(3000, Math.min(20000, Number(process.env.PHOTO_PACK_FETCH_TIMEOUT_MS || 10000)))
  const maxEdge = Math.max(800, Math.min(1800, Number(process.env.PHOTO_PACK_IMAGE_MAX_EDGE || 1200)))
  const jpegQuality = Math.max(50, Math.min(90, Number(process.env.PHOTO_PACK_IMAGE_JPEG_QUALITY || 80)))
  const imagesPerVolume = Math.max(12, Math.min(500, Number(process.env.PHOTO_PACK_MAX_IMAGES_PER_VOLUME || 120)))
  const pagesPerVolume = Math.max(4, Math.min(200, Number(process.env.PHOTO_PACK_MAX_PAGES_PER_VOLUME || 35)))
  return { totalLimit, fetchConcurrency, fetchTimeoutMs, maxEdge, jpegQuality, imagesPerVolume, pagesPerVolume }
}

function dataUrl(mimeType: string, body: Buffer) {
  return `data:${mimeType};base64,${body.toString('base64')}`
}

function normalizeFetchUrl(raw: string, apiBase: string): { sourceUrl: string; kind: 'r2' | 'url'; value: string } | null {
  const s = String(raw || '').trim()
  if (!s) return null
  const abs = (() => {
    if (/^https?:\/\//i.test(s)) return s
    if (s.startsWith('//')) return `https:${s}`
    if (s.startsWith('/')) return apiBase ? `${apiBase}${s}` : s
    return s
  })()
  try {
    const u = new URL(abs)
    if (/\/public\/r2-image\b|\/r2-image\b/.test(String(u.pathname || ''))) {
      const original = String(u.searchParams.get('url') || '').trim()
      if (original) {
        const key = r2KeyFromUrl(original)
        if (key && isAllowedR2ImageKey(key)) return { sourceUrl: original, kind: 'r2', value: key }
        return { sourceUrl: original, kind: 'url', value: original }
      }
    }
    const key = r2KeyFromUrl(abs)
    if (key && isAllowedR2ImageKey(key)) return { sourceUrl: abs, kind: 'r2', value: key }
    return /^https?:\/\//i.test(abs) ? { sourceUrl: abs, kind: 'url', value: abs } : null
  } catch {
    if (isAllowedR2ImageKey(s)) return { sourceUrl: s, kind: 'r2', value: s }
    return null
  }
}

async function fetchExternalBytes(url: string, timeoutMs: number): Promise<{ body: Buffer; contentType: string }> {
  let lastErr: any = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController()
    const t = setTimeout(() => { try { ac.abort() } catch {} }, timeoutMs)
    try {
      const resp: any = await fetch(url, { method: 'GET', signal: ac.signal, headers: { Accept: 'image/*,*/*;q=0.8' } } as any)
      if (!resp?.ok) throw new Error(`http_${String(resp?.status || '')}`)
      const ab = await resp.arrayBuffer()
      return { body: Buffer.from(ab), contentType: String(resp?.headers?.get?.('content-type') || 'application/octet-stream') }
    } catch (e: any) {
      lastErr = e
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      clearTimeout(t)
    }
  }
  throw lastErr || new Error('fetch_failed')
}

async function fetchAssetBytes(target: { sourceUrl: string; kind: 'r2' | 'url'; value: string }, timeoutMs: number): Promise<{ body: Buffer; contentType: string }> {
  if (target.kind === 'r2') {
    if (!hasR2) throw new Error('r2_not_configured')
    const obj = await r2GetObjectByKey(target.value)
    if (!obj?.body?.length) throw new Error('r2_not_found')
    return { body: obj.body, contentType: String(obj.contentType || 'application/octet-stream') }
  }
  return fetchExternalBytes(target.value, timeoutMs)
}

async function compressImage(body: Buffer, contentType: string, maxEdge: number, jpegQuality: number): Promise<PhotoPackEmbeddedImage> {
  const img = sharp(body, { animated: false }).rotate()
  const meta = await img.metadata().catch(() => ({} as any))
  const hasAlpha = !!meta?.hasAlpha
  const pipeline = img.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
  if (hasAlpha) {
    const out = await pipeline.png({ compressionLevel: 9, palette: true }).toBuffer()
    return { dataUrl: dataUrl('image/png', out), mimeType: 'image/png', width: Number(meta?.width || 0), height: Number(meta?.height || 0) }
  }
  const out = await pipeline.jpeg({ quality: jpegQuality, mozjpeg: true }).toBuffer()
  return { dataUrl: dataUrl('image/jpeg', out), mimeType: 'image/jpeg', width: Number(meta?.width || 0), height: Number(meta?.height || 0) }
}

async function loadImageAsset(raw: string, apiBase: string, timeoutMs: number, maxEdge: number, jpegQuality: number): Promise<LoadedAsset> {
  try {
    const target = normalizeFetchUrl(raw, apiBase)
    if (!target) return { ok: false, sourceUrl: raw, reason: 'invalid_source' }
    const { body, contentType } = await fetchAssetBytes(target, timeoutMs)
    const ct = String(contentType || '').toLowerCase()
    if (!ct.startsWith('image/')) return { ok: false, sourceUrl: target.sourceUrl, reason: `invalid_content_type:${ct || 'unknown'}` }
    const image = await compressImage(body, ct, maxEdge, jpegQuality)
    return { ok: true, sourceUrl: target.sourceUrl, image }
  } catch (e: any) {
    return { ok: false, sourceUrl: raw, reason: String(e?.message || 'load_failed') }
  }
}

function sectionSuffix(sections: StatementPhotoPackSection) {
  return sections === 'maintenance' ? 'maintenance' : sections === 'deep_cleaning' ? 'deep-cleaning' : 'all'
}

function volumeFilename(baseFilename: string, partNo: number, volumeCount: number) {
  if (volumeCount <= 1) return baseFilename
  return baseFilename.replace(/\.pdf$/i, `-part-${String(partNo).padStart(2, '0')}.pdf`)
}

function zipFilename(monthKey: string, property: { code?: string; address?: string; id: string }, sections: StatementPhotoPackSection) {
  const code = String(property?.code || property?.address || property?.id || '').trim() || 'property'
  const safe = code.replace(/[^a-zA-Z0-9._-]+/g, '-')
  const suffix = sectionSuffix(sections)
  return `monthly-statement-${monthKey}-${safe}-${suffix}-photos.zip`
}

async function createZipBuffer(entries: Array<{ name: string; body: Buffer }>): Promise<Buffer> {
  const archive = archiver('zip', { zlib: { level: 9 } })
  const stream = new PassThrough()
  const chunks: Buffer[] = []
  stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
  const done = new Promise<Buffer>((resolve, reject) => {
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
    archive.on('error', reject)
  })
  archive.pipe(stream)
  for (const entry of entries) archive.append(entry.body, { name: entry.name })
  await archive.finalize()
  return done
}

async function renderPhotoPackPdfFromRecords(input: {
  monthKey: string
  property: { id: string; code?: string; address?: string }
  landlordName: string
  showChinese: boolean
  sections: StatementPhotoPackSection
  records: PhotoPackTemplateRecord[]
  rawUrls: number
  cleanedUrls: number
  failedUrls: string[]
  notLoaded: number
  effectivePhotosMode: Exclude<StatementPhotoPackPhotosMode, 'off'>
  metrics?: Record<string, any>
  onStage?: (stage: string, detail: string, meta?: Record<string, any>) => Promise<void> | void
  filenameOverride?: string
}): Promise<GenerateStatementPhotoPackResult> {
  const metrics: Record<string, any> = { ...(input.metrics || {}) }
  const stage = async (name: string, detail: string, meta?: Record<string, any>) => {
    if (meta && typeof meta === 'object') Object.assign(metrics, meta)
    await input.onStage?.(name, detail, meta)
  }
  const tpl = renderMonthlyStatementPhotoPackHtml({
    month: input.monthKey,
    property: input.property,
    landlordName: input.landlordName || '',
    showChinese: input.showChinese,
    records: input.records,
  })
  const imageCount = Number(tpl?.imageCount || 0)
  if (imageCount <= 0) {
    const e: any = new Error('no photos to render for requested sections')
    e.code = 'NO_PHOTOS_TO_RENDER'
    e.rawUrls = input.rawUrls
    e.cleanedUrls = input.cleanedUrls
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
    await stage('render_html', `正在写入 PDF 页面内容（${imageCount}）...`, { imageCount, pageCount: tpl.pageCount })
    await page.setContent(tpl.html, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs } as any)
    await page.evaluate(() => (document as any).fonts?.ready).catch(() => {})
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
      `图片 ${imageCount} 张（原始 ${input.rawUrls} / 成功嵌入 ${input.cleanedUrls} / 失败 ${input.failedUrls.length} / 记录 ${input.records.length}）`,
    ]
    const missingOnlyRecords = input.records.filter((record) => (record.beforeImages.length + record.afterImages.length) <= 0).length
    if (missingOnlyRecords > 0) detailParts.push(`有 ${missingOnlyRecords} 条记录仅输出了缺图提示`)
    if (input.failedUrls.length > 0) detailParts.push(`失败样本：${input.failedUrls.slice(0, 3).join(' | ')}`)
    return {
      pdf: Buffer.from(pdf),
      filename: input.filenameOverride || buildFilename(input.monthKey, input.property, input.sections),
      imageCount,
      rawUrls: input.rawUrls,
      cleanedUrls: input.cleanedUrls,
      effectivePhotosMode: input.effectivePhotosMode,
      failedUrls: input.failedUrls.slice(0, 20),
      notLoaded: input.notLoaded,
      detail: detailParts.join('；'),
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

async function prepareStatementPhotoPackData(input: GenerateStatementPhotoPackInput): Promise<PreparedStatementPhotoPackData> {
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
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw Object.assign(new Error('invalid month'), { code: 'JOB_INVALID' })
  if (!pid) throw Object.assign(new Error('missing property_id'), { code: 'JOB_INVALID' })
  if (!hasPg || !pgPool) throw Object.assign(new Error('no database configured'), { code: 'JOB_INVALID' })
  const range = monthRangeISO(monthKey)
  if (!range) throw Object.assign(new Error('invalid month'), { code: 'JOB_INVALID' })
  const propR = await pgPool.query('SELECT id, code, address, landlord_id FROM properties WHERE id = $1 LIMIT 1', [pid])
  const prop = (propR.rows?.[0] || null) as any
  if (!prop) throw Object.assign(new Error('property not found'), { code: 'PROPERTY_NOT_FOUND' })
  const llName = await landlordNameByProperty(String(prop?.landlord_id || ''))
  const codeRaw = String(prop?.code || '').trim()
  const codeNorm = normalizedCode(codeRaw)
  const wantDeep = sections === 'all' || sections === 'deep_cleaning'
  const wantMaint = sections === 'all' || sections === 'maintenance'
  const [deepRows0, maintRows0] = await Promise.all([
    wantDeep ? loadMonthlyStatementPhotoRows({ table: 'property_deep_cleaning', pid, monthKey, range, propertyCode: codeNorm, propertyCodeRaw: codeRaw }).catch(() => [] as any[]) : Promise.resolve([] as any[]),
    wantMaint ? loadMonthlyStatementPhotoRows({ table: 'property_maintenance', pid, monthKey, range, propertyCode: codeNorm, propertyCodeRaw: codeRaw }).catch(() => [] as any[]) : Promise.resolve([] as any[]),
  ])
  metrics.load_rows_ms = nowMs() - t0
  const totalRawUrls = countRawUrls(deepRows0) + countRawUrls(maintRows0)
  await stage('collect_assets', `正在整理照片记录（原始 ${totalRawUrls}）...`, { rawUrls: totalRawUrls })
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
  if (input.syncGuard) {
    const syncMaxPhotos = Math.max(1, Math.min(20, Number(process.env.MONTHLY_STATEMENT_SYNC_MAX_PHOTOS || 6)))
    if (totalRawUrls > syncMaxPhotos) throw Object.assign(new Error('too_many_photos_for_sync_export'), { code: 'MEMORY_GUARD_BLOCKED', rawUrls: totalRawUrls, syncMaxPhotos })
  }
  const { totalLimit, fetchConcurrency, fetchTimeoutMs, maxEdge, jpegQuality } = photoPackLimits()
  const sourceRows = [
    ...((wantDeep ? deepRows0 : []).map((row: any) => ({ kind: 'deep_cleaning' as const, row }))),
    ...((wantMaint ? maintRows0 : []).map((row: any) => ({ kind: 'maintenance' as const, row }))),
  ].sort((a, b) => dayLabel(a.row).localeCompare(dayLabel(b.row)) || String(a.row?.id || '').localeCompare(String(b.row?.id || '')))
  const totalPlanned = sourceRows.reduce((sum, item) => {
    return sum + listPhotoUrls(item.row?.photo_urls).filter(isLikelyImageUrl).length + listPhotoUrls(item.row?.repair_photo_urls).filter(isLikelyImageUrl).length
  }, 0)
  if (totalPlanned > totalLimit) {
    throw jobError('PHOTO_PACK_TOO_LARGE', `photo pack exceeds image hard limit (${totalPlanned}/${totalLimit})`, { rawUrls: totalRawUrls, totalPlanned, totalLimit })
  }
  await stage('fetch_assets', `正在抓取并压缩照片资源（${totalPlanned}）...`, { rawUrls: totalRawUrls, totalPlanned, totalLimit })
  const fetchStartedAt = nowMs()
  const records: PhotoPackTemplateRecord[] = []
  const failedDetails: Array<{ url: string; reason: string }> = []
  let successImages = 0
  let skippedRecords = 0
  for (const item of sourceRows) {
    const row = item.row
    const beforeRaw = listPhotoUrls(row?.photo_urls).filter(isLikelyImageUrl)
    const afterRaw = listPhotoUrls(row?.repair_photo_urls).filter(isLikelyImageUrl)
    const beforeResults: LoadedAsset[] = new Array(beforeRaw.length)
    const afterResults: LoadedAsset[] = new Array(afterRaw.length)
    await runLimited(beforeRaw, fetchConcurrency, async (u, idx) => { beforeResults[idx] = await loadImageAsset(u, apiBase, fetchTimeoutMs, maxEdge, jpegQuality) })
    await runLimited(afterRaw, fetchConcurrency, async (u, idx) => { afterResults[idx] = await loadImageAsset(u, apiBase, fetchTimeoutMs, maxEdge, jpegQuality) })
    const beforeImages = beforeResults.filter((x) => x?.ok && x.image).map((x) => x.image!) as PhotoPackEmbeddedImage[]
    const afterImages = afterResults.filter((x) => x?.ok && x.image).map((x) => x.image!) as PhotoPackEmbeddedImage[]
    const failures = [...beforeResults, ...afterResults].filter((x) => x && !x.ok)
    failures.forEach((f) => failedDetails.push({ url: f.sourceUrl, reason: String(f.reason || 'load_failed') }))
    successImages += beforeImages.length + afterImages.length
    if (beforeRaw.length + afterRaw.length <= 0) continue
    const missingNotice = failures.length && (beforeImages.length + afterImages.length) <= 0 ? '该记录的所有图片均无法加载，请检查原始链接' : undefined
    if ((beforeImages.length + afterImages.length) <= 0) skippedRecords += 1
    records.push({
      kind: item.kind,
      jobNumber: String(row?.work_no || row?.id || '').trim(),
      completionText: dayLabel(row) || '-',
      areaText: item.kind === 'maintenance' ? String(row?.category_detail || row?.category || '').trim() : String(row?.category || '').trim(),
      beforeImages,
      afterImages,
      beforeRawCount: beforeRaw.length,
      afterRawCount: afterRaw.length,
      missingNotice,
    })
  }
  metrics.fetch_assets_ms = nowMs() - fetchStartedAt
  metrics.success_images = successImages
  metrics.failed_images = failedDetails.length
  metrics.skipped_records = skippedRecords
  if (records.length <= 0 || successImages <= 0) {
    throw jobError('PHOTO_PACK_RENDER_EMPTY', 'photo pack render empty: no embeddable images', {
      rawUrls: totalRawUrls,
      failedUrls: failedDetails.slice(0, 8).map((x) => `${x.reason}:${x.url}`),
    })
  }
  await stage('transform_assets', `正在整理页面内容（成功 ${successImages} / 失败 ${failedDetails.length}）...`, {
    success_images: successImages,
    failed_images: failedDetails.length,
    skipped_records: skippedRecords,
  })
  return {
    monthKey,
    property: { id: String(prop.id), code: prop.code || '', address: prop.address || '' },
    landlordName: llName || '',
    showChinese: !!input.showChinese,
    sections,
    effectivePhotosMode,
    records,
    rawUrls: totalRawUrls,
    cleanedUrls: successImages,
    failedUrls: failedDetails.slice(0, 20).map((x) => `${x.reason}:${x.url}`),
    notLoaded: failedDetails.length,
    metrics,
  }
}

export function splitStatementPhotoPackVolumes(records: PhotoPackTemplateRecord[], limits?: { imagesPerVolume?: number; pagesPerVolume?: number }): PhotoPackTemplateRecord[][] {
  const imagesPerVolume = Math.max(12, Number(limits?.imagesPerVolume || 120))
  const pagesPerVolume = Math.max(4, Number(limits?.pagesPerVolume || 35))
  const volumes: PhotoPackTemplateRecord[][] = []
  let current: PhotoPackTemplateRecord[] = []
  let currentImages = 0
  let currentPages = 0
  const flush = () => {
    if (!current.length) return
    volumes.push(current)
    current = []
    currentImages = 0
    currentPages = 0
  }
  for (const record of records || []) {
    const recordImages = (record.beforeImages?.length || 0) + (record.afterImages?.length || 0)
    const recordPages = estimatePhotoPackRecordPageCount(record)
    const overLimit = current.length > 0 && (
      (currentImages + recordImages > imagesPerVolume) ||
      (currentPages + recordPages > pagesPerVolume)
    )
    if (overLimit) flush()
    current.push(record)
    currentImages += recordImages
    currentPages += recordPages
  }
  flush()
  return volumes
}

export async function generateStatementPhotoPackPdf(input: GenerateStatementPhotoPackInput): Promise<GenerateStatementPhotoPackResult> {
  const prepared = await prepareStatementPhotoPackData(input)
  return renderPhotoPackPdfFromRecords({
    ...prepared,
    onStage: input.onStage,
  })
}

export async function generateStatementPhotoPackBundle(input: GenerateStatementPhotoPackInput): Promise<GenerateStatementPhotoPackBundleResult> {
  const prepared = await prepareStatementPhotoPackData(input)
  const { imagesPerVolume, pagesPerVolume } = photoPackLimits()
  const volumes = splitStatementPhotoPackVolumes(prepared.records, { imagesPerVolume, pagesPerVolume })
  const files: GenerateStatementPhotoPackBundleResult['files'] = []
  let totalPages = 0
  for (let i = 0; i < volumes.length; i += 1) {
    const partNo = i + 1
    const volumeRecords = volumes[i]
    const baseFilename = buildFilename(prepared.monthKey, prepared.property, prepared.sections)
    const rendered = await renderPhotoPackPdfFromRecords({
      ...prepared,
      records: volumeRecords,
      filenameOverride: volumeFilename(baseFilename, partNo, volumes.length),
      onStage: async (stage, detail, meta) => {
        if (stage === 'render_html' || stage === 'render_pdf') {
          await input.onStage?.(stage, `${detail}（第 ${partNo}/${volumes.length} 卷）`, { ...(meta || {}), part_no: partNo, volume_count: volumes.length })
        }
      },
      metrics: { ...(prepared.metrics || {}), part_no: partNo, volume_count: volumes.length },
    })
    const pageCount = renderMonthlyStatementPhotoPackHtml({
      month: prepared.monthKey,
      property: prepared.property,
      landlordName: prepared.landlordName,
      showChinese: prepared.showChinese,
      records: volumeRecords,
    }).pageCount
    totalPages += pageCount
    files.push({
      kind: volumes.length <= 1 ? 'statement_photo_pack_pdf' : 'statement_photo_pack_part_pdf',
      filename: rendered.filename,
      contentType: 'application/pdf',
      body: rendered.pdf,
      imageCount: rendered.imageCount,
      pageCount,
      partNo: volumes.length > 1 ? partNo : undefined,
    })
  }
  if (files.length > 1) {
    await input.onStage?.('uploading', `正在打包 ZIP（${files.length} 卷）...`, { volume_count: files.length })
    const zipBody = await createZipBuffer([
      ...files.map((file) => ({ name: file.filename, body: file.body })),
      {
        name: 'manifest.json',
        body: Buffer.from(JSON.stringify({
          month: prepared.monthKey,
          property_id: prepared.property.id,
          property_code: prepared.property.code || '',
          sections: prepared.sections,
          volume_count: files.length,
          total_images: prepared.cleanedUrls,
          total_pages: totalPages,
        }, null, 2), 'utf8'),
      },
    ])
    files.push({
      kind: 'statement_photo_pack_zip',
      filename: zipFilename(prepared.monthKey, prepared.property, prepared.sections),
      contentType: 'application/zip',
      body: zipBody,
      imageCount: prepared.cleanedUrls,
      pageCount: totalPages,
    })
  }
  const detail = files.length > 1
    ? `已生成照片分卷（${volumes.length} 卷，图片 ${prepared.cleanedUrls} 张，页数 ${totalPages}）`
    : `已生成照片 PDF（1 卷，图片 ${prepared.cleanedUrls} 张，页数 ${totalPages}）`
  return {
    files,
    volumeCount: volumes.length,
    totalImages: prepared.cleanedUrls,
    totalPages,
    rawUrls: prepared.rawUrls,
    cleanedUrls: prepared.cleanedUrls,
    failedUrls: prepared.failedUrls,
    notLoaded: prepared.notLoaded,
    effectivePhotosMode: prepared.effectivePhotosMode,
    detail,
    metrics: prepared.metrics,
  }
}
