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

export function deriveThumbUrl(u: string): string {
  const s = String(u || '').trim()
  if (!s) return ''
  try {
    const uu = new URL(s)
    const p = String(uu.pathname || '')
    if (p.endsWith('/public/r2-image') || p.endsWith('/r2-image')) {
      if (!uu.searchParams.get('fmt')) uu.searchParams.set('fmt', 'jpeg')
      if (!uu.searchParams.get('w')) uu.searchParams.set('w', '720')
      if (!uu.searchParams.get('q')) uu.searchParams.set('q', '72')
      return uu.toString()
    }
  } catch {}
  return s
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
      return []
    }
  }
  if (typeof v === 'object') return []
  return []
}

function asUrlStrings(v: any): string[] {
  return safeArr(v).map(x => String(x || '').trim()).filter(Boolean)
}

function pickDate(x: any): string {
  const raw = String(x?.occurred_at || x?.completed_at || x?.started_at || x?.created_at || '').slice(0, 10)
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

  const deriveDirectUrl = (u: string): string => {
    const s = String(u || '').trim()
    if (!s) return ''
    try {
      const uu = new URL(s)
      const p = String(uu.pathname || '')
      if (p.endsWith('/public/r2-image') || p.endsWith('/r2-image')) {
        const inner = String(uu.searchParams.get('url') || '').trim()
        if (/^https?:\/\//i.test(inner)) return inner
      }
    } catch {}
    return s
  }

  const buildPhotoItems = (rows: any[], kind: 'deep_cleaning' | 'maintenance', phase: 'before' | 'after') => {
    const items: Array<{ src: string; fallback: string; caption: string }> = []
    for (const r of rows) {
      const workNo = String(r?.work_no || r?.workNo || '').trim()
      const dt = pickDate(r)
      const urls = (phase === 'before' ? asUrlStrings(r?.photo_urls) : asUrlStrings(r?.repair_photo_urls))
        .filter(u => /^https?:\/\//i.test(u))
      for (const u of urls) {
        const fallback = deriveDirectUrl(u)
        const src = (photosMode === 'thumbnail') ? deriveThumbUrl(u) : u
        const phaseLabel = phase === 'before'
          ? (showChinese ? 'Before（前）' : 'Before')
          : (showChinese ? 'After（后）' : 'After')
        const caption = `${kind === 'deep_cleaning' ? 'DC' : 'R'}${workNo ? ` ${workNo}` : ''}${dt ? ` • ${dt}` : ''}${` • ${phaseLabel}`}`
        items.push({ src, fallback, caption })
      }
    }
    return items
  }

  const deepBeforeItems = buildPhotoItems(deep, 'deep_cleaning', 'before')
  const deepAfterItems = buildPhotoItems(deep, 'deep_cleaning', 'after')
  const maintBeforeItems = buildPhotoItems(maint, 'maintenance', 'before')
  const maintAfterItems = buildPhotoItems(maint, 'maintenance', 'after')
  const totalPhotos = (photosMode === 'off')
    ? 0
    : (deepBeforeItems.length + deepAfterItems.length + maintBeforeItems.length + maintAfterItems.length)

  const pickSrc = (it: { src: string; fallback: string }) => {
    if (photosMode === 'off') return ''
    return it.src
  }

  const renderPhotoPages = (titleMain: string, titlePhase: string, items: Array<{ src: string; fallback: string; caption: string }>, perPage: number, enforcePaging: boolean, breakFirst: boolean) => {
    if (!items.length) return { html: '', rendered: false }
    const pages = enforcePaging ? chunk(items, perPage) : [items]
    let out = ''
    pages.forEach((page, idx) => {
      const pageNo = idx + 1
      const needBreak = (idx === 0) ? breakFirst : true
      out += `
        <section class="page${needBreak ? ' break-before' : ''}">
          <div class="section-title">
            <span class="section-title-main">${escapeHtml(titleMain)}</span>
            <span class="section-title-right">
              <span class="section-title-phase">${escapeHtml(titlePhase)}</span>
              ${pages.length > 1 ? `<span class="muted">(${pageNo}/${pages.length})</span>` : ''}
            </span>
          </div>
          <div class="grid">
            ${page.map((it) => {
              const src = pickSrc(it)
              const fb = it.fallback
              const cap = it.caption
              const onerr = `try{var fb=this.getAttribute('data-fallback')||'';if(fb&&this.src!==fb){this.onerror=null;this.src=fb}}catch(e){}`
              return `
                <figure class="cell">
                  <img crossorigin="anonymous" referrerpolicy="no-referrer" src="${escapeHtml(src)}" data-fallback="${escapeHtml(fb)}" alt="" onerror="${escapeHtml(onerr)}" />
                  <figcaption>${escapeHtml(cap)}</figcaption>
                </figure>
              `
            }).join('')}
          </div>
        </section>
      `
    })
    return { html: out, rendered: true }
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

  const photosHtml = (photosMode === 'off') ? '' : `
    ${(() => {
      let hasPrev = !!includeBase
      let out = ''
      const titleDeep = showChinese ? 'Deep Cleaning Maintenance 深度清洁维护' : 'Deep Cleaning Maintenance'
      const titleMaint = showChinese ? 'Maintenance Repairs 维修记录' : 'Maintenance Repairs'
      const phaseBefore = showChinese ? 'Before（前）' : 'Before'
      const phaseAfter = showChinese ? 'After（后）' : 'After'
      if (includeDeep) {
        const r1 = renderPhotoPages(
          titleDeep,
          phaseBefore,
          deepBeforeItems,
          12,
          true,
          hasPrev
        )
        out += r1.html
        if (r1.rendered) hasPrev = true
        const r2 = renderPhotoPages(
          titleDeep,
          phaseAfter,
          deepAfterItems,
          12,
          true,
          hasPrev
        )
        out += r2.html
        if (r2.rendered) hasPrev = true
      }
      if (includeMaint) {
        const r3 = renderPhotoPages(
          titleMaint,
          phaseBefore,
          maintBeforeItems,
          12,
          true,
          hasPrev
        )
        out += r3.html
        if (r3.rendered) hasPrev = true
        const r4 = renderPhotoPages(
          titleMaint,
          phaseAfter,
          maintAfterItems,
          12,
          true,
          hasPrev
        )
        out += r4.html
        if (r4.rendered) hasPrev = true
      }
      return out
    })()}
  `

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
          .page { break-after: page; page-break-after: always; }
          .page:last-child { break-after: auto; page-break-after: auto; }
          .break-before { break-before: page; page-break-before: always; }
          .header { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 2px solid #000; padding-bottom: 8px; }
          .title { font-size: 32px; font-weight: 700; letter-spacing: 1px; }
          .meta { text-align: right; font-size: 13px; line-height: 1.4; }
          .note { margin-top: 10mm; font-size: 13px; color: #333; }
          .section-title { margin-top: 16px; font-weight: 700; background: #eef3fb; padding: 6px 8px; font-size: 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; break-after: avoid; page-break-after: avoid; }
          .section-title + .grid { break-before: avoid; page-break-before: avoid; }
          .section-title-right { display: inline-flex; align-items: baseline; gap: 8px; white-space: nowrap; }
          .section-title-phase { font-size: 13px; font-weight: 700; color: #111; }
          .muted { color: #666; font-weight: 400; font-size: 12px; }
          .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
          .cell { margin: 0; border: 1px solid #eee; border-radius: 8px; padding: 6px; }
          .cell img { width: 100%; height: 55mm; object-fit: contain; display: block; background: #fafafa; border-radius: 6px; }
          .cell figcaption { margin-top: 6px; font-size: 11px; color: #333; word-break: break-word; }
        </style>
      </head>
      <body>
        ${baseHtml}
        ${photosHtml}
      </body>
    </html>
  `
  return { html, imageCount: totalPhotos }
}
