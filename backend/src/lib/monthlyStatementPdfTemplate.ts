import { recordBusinessDateRaw } from './monthlyStatementPhotoRecords'
import { renderWorkRecordBodyFragment, workRecordPdfCssTextScoped } from './workRecordPdfTemplate'

type SectionMode = 'all' | 'base' | 'deep_cleaning' | 'maintenance'
type PhotosMode = 'full' | 'thumbnail' | 'compressed' | 'off'

export type MonthlyStatementPdfTemplateInput = {
  month: string
  property: { id: string; code?: string; address?: string } | null
  landlordName?: string
  sections?: string[] | string
  showChinese?: boolean
  includePhotosMode?: PhotosMode
  deepCleanings?: Array<{
    id: string
    work_no?: string
    occurred_at?: string
    completed_at?: string
    started_at?: string
    created_at?: string
    photo_urls?: any
    repair_photo_urls?: any
  }>
  maintenances?: Array<{
    id: string
    work_no?: string
    occurred_at?: string
    completed_at?: string
    started_at?: string
    created_at?: string
    photo_urls?: any
    repair_photo_urls?: any
  }>
}

function normSections(sections?: string[] | string): Set<SectionMode> {
  const arr = Array.isArray(sections) ? sections : (sections ? String(sections).split(',') : [])
  const set = new Set(arr.map(s => String(s || '').trim().toLowerCase()).filter(Boolean) as any)
  if (!set.size || set.has('all')) return new Set(['all'])
  const out = new Set<SectionMode>()
  if (set.has('base')) out.add('base')
  if (set.has('maintenance')) out.add('maintenance')
  if (set.has('deep_cleaning') || set.has('deepcleaning')) out.add('deep_cleaning')
  return out.size ? out : new Set(['all'])
}

function safeArr(v: any): any[] {
  if (!v) return []
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return []
    try {
      const j = JSON.parse(s)
      return Array.isArray(j) ? j : []
    } catch {
      if (/^https?:\/\//i.test(s) || s.startsWith('/')) return [s]
      return []
    }
  }
  if (typeof v === 'object') {
    const u = String((v as any)?.url || (v as any)?.src || (v as any)?.path || '').trim()
    if (u) return [u]
    return []
  }
  return []
}

function asUrlStrings(v: any): string[] {
  return safeArr(v)
    .map((x) => {
      if (!x) return ''
      if (typeof x === 'string') return x
      if (typeof x === 'object') return String((x as any).url || (x as any).src || (x as any).path || '')
      return String(x || '')
    })
    .map(x => String(x || '').trim())
    .filter(Boolean)
}

function pickDate(x: any): string {
  const raw = String(recordBusinessDateRaw(x) || '').slice(0, 10)
  return raw
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderMonthlyStatementPdfHtml(input: MonthlyStatementPdfTemplateInput): { html: string; imageCount: number } {
  const month = String(input.month || '').trim()
  const showChinese = input.showChinese !== false
  const sec = normSections(input.sections)
  const photosModeRaw = String(input.includePhotosMode || 'full').toLowerCase()
  const photosMode: PhotosMode =
    photosModeRaw === 'off' ? 'off' :
    photosModeRaw === 'thumbnail' ? 'thumbnail' :
    photosModeRaw === 'compressed' ? 'compressed' : 'full'
  const propCode = String(input.property?.code || '').trim()
  const propAddr = String(input.property?.address || '').trim()
  const landlord = String(input.landlordName || '').trim()

  const deep = Array.isArray(input.deepCleanings) ? input.deepCleanings : []
  const maint = Array.isArray(input.maintenances) ? input.maintenances : []

  const pickRecordUrls = (r: any, phase: 'before' | 'after') => {
    const urls = (phase === 'before' ? asUrlStrings(r?.photo_urls) : asUrlStrings(r?.repair_photo_urls))
      .filter(u => /^https?:\/\//i.test(u))
    return urls
  }
  const completionTextOf = (r: any) => {
    const dt = pickDate(r)
    return dt
  }
  const recordBlocks = (rows: any[], kind: 'deep_cleaning' | 'maintenance') => {
    const sorted = rows.slice().sort((a, b) => pickDate(a).localeCompare(pickDate(b)) || String(a?.id || '').localeCompare(String(b?.id || '')))
    let out = ''
    let images = 0
    sorted.forEach((r, idx) => {
      const beforeUrls = pickRecordUrls(r, 'before')
      const afterUrls = pickRecordUrls(r, 'after')
      if (!beforeUrls.length && !afterUrls.length) return
      const jobNumber = String(r?.work_no || r?.id || '').trim()
      const completionText = completionTextOf(r)
      const areaText = kind === 'maintenance'
        ? String((r as any)?.category_detail || (r as any)?.category || '').trim()
        : String((r as any)?.category || '').trim()
      const frag = renderWorkRecordBodyFragment({
        kind,
        showChinese,
        jobNumber,
        completionText,
        areaText,
        beforeUrls,
        afterUrls,
      })
      images += Number(frag.imageCount || 0)
      const breakCls = idx > 0 ? ' wr-break' : ''
      out += `<div class="wr${breakCls}">${frag.body}</div>`
    })
    return { html: out, imageCount: images }
  }

  const includeAll = sec.has('all')
  const includeBase = includeAll || sec.has('base')
  const includeDeep = includeAll || sec.has('deep_cleaning')
  const includeMaint = includeAll || sec.has('maintenance')

  const baseHtml = includeBase ? `
    <section class="page">
      <div class="header">
        <div class="title">${showChinese ? '月结单' : 'MONTHLY STATEMENT'}</div>
        <div class="meta">
          <div>${escapeHtml(month)}</div>
          <div>${escapeHtml([propCode, propAddr].filter(Boolean).join(' / '))}</div>
          ${landlord ? `<div>${escapeHtml(landlord)}</div>` : ''}
        </div>
      </div>
      <div class="note">
        ${showChinese ? '本 PDF 为稳定下载版本（模板渲染）。如需明细口径请以系统数据为准。' : 'This PDF is generated by a stable template renderer. Please refer to system data for exact figures.'}
      </div>
    </section>
  ` : ''

  const photosParts = (() => {
    if (photosMode === 'off') return { html: '', imageCount: 0 }
    let out = ''
    let n = 0
    let hasPrev = !!includeBase
    if (includeDeep) {
      const r = recordBlocks(deep, 'deep_cleaning')
      if (r.html) {
        out += hasPrev ? `<div class="wr-break"></div>${r.html}` : r.html
        hasPrev = true
        n += r.imageCount
      }
    }
    if (includeMaint) {
      const r = recordBlocks(maint, 'maintenance')
      if (r.html) {
        out += hasPrev ? `<div class="wr-break"></div>${r.html}` : r.html
        hasPrev = true
        n += r.imageCount
      }
    }
    return { html: out, imageCount: n }
  })()

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Monthly Statement ${escapeHtml(month)}</title>
        <style>
          @page { size: A4; margin: 12mm; }
          html, body { margin: 0; padding: 0; background: #fff; color: #000; font-family: "Times New Roman", Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .page { break-inside: avoid; page-break-inside: avoid; }
          .break-before { break-before: page; page-break-before: always; }
          .header { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 2px solid #000; padding-bottom: 8px; }
          .title { font-size: 32px; font-weight: 700; letter-spacing: 1px; }
          .meta { text-align: right; font-size: 13px; line-height: 1.4; }
          .note { margin-top: 10mm; font-size: 13px; color: #333; }
          .wr-break { break-before: page; page-break-before: always; height: 0; }
          ${workRecordPdfCssTextScoped('.wr')}
        </style>
      </head>
      <body>
        ${baseHtml}
        ${photosParts.html}
      </body>
    </html>
  `
  return { html, imageCount: photosParts.imageCount }
}
