import { deriveThumbUrl } from './pdfThumbUrl'

type Kind = 'deep_cleaning' | 'maintenance'

export type WorkRecordPdfTemplateInput = {
  kind: Kind
  showChinese?: boolean
  jobNumber: string
  completionText: string
  areaText: string
  beforeUrls: any
  afterUrls: any
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
    .map(s => String(s || '').trim())
    .filter(Boolean)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function areaToEnglish(s: string): string {
  const raw = String(s || '').trim()
  if (!raw) return ''
  const dict: Record<string, string> = {
    '入户走廊': 'Entry Corridor',
    '走廊': 'Corridor',
    '客厅': 'Living Room',
    '厨房': 'Kitchen',
    '卧室': 'Bedroom',
    '浴室': 'Bathroom',
    '阳台': 'Balcony',
    '全屋': 'Whole House',
    '其他': 'Other',
  }
  const parts = raw.replace(/[，、;；]/g, ',').split(/[,/|]+/g).map(x => x.trim()).filter(Boolean)
  if (parts.length <= 1) return dict[raw] || raw
  return parts.map(p => dict[p] || p).join(', ')
}

function areaDisplay(raw: string, showChinese: boolean): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  const en = areaToEnglish(s)
  if (!showChinese) return en || s
  if (/[A-Za-z]/.test(s)) return s
  if (!en || en === s) return s
  return `${s} ${en}`
}

function pickItems(urlsAny: any) {
  const urls = asUrlStrings(urlsAny).filter(u => /^https?:\/\//i.test(u))
  return urls.map((u) => {
    const fallback = u
    const src = deriveThumbUrl(u)
    return { src, fallback }
  })
}

export function workRecordPdfCssText(): string {
  return `
    @page { size: A4; margin: 12mm; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; font-family: "Times New Roman", Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .keep-pack { break-inside: avoid; page-break-inside: avoid; }
    .titlebar { background: #eef3fb; padding: 6px 8px; margin-bottom: 10px; }
    .title { font-size: 16px; font-weight: 700; }
    .top-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 22px; padding: 2px 0 10px; }
    .top-item { min-width: 0; }
    .top-k { font-size: 12px; font-weight: 700; color: #6b778c; letter-spacing: 0.2px; text-transform: uppercase; }
    .top-v { margin-top: 8px; font-size: 16px; font-weight: 700; color: #111; overflow-wrap: anywhere; line-height: 1.25; }
    .top-v-blue { color: #1f5cff; }
    .section-head { margin-top: 16px; display: flex; align-items: center; gap: 10px; }
    .section-bar { width: 4px; height: 16px; background: #1f5cff; border-radius: 2px; }
    .section-title { font-size: 16px; font-weight: 700; color: #2b3a55; letter-spacing: 0.2px; line-height: 1.2; }
    .phase-pack { width: 100%; margin-top: 18px; break-inside: avoid; page-break-inside: avoid; }
    .phase-head { width: 100%; break-after: avoid; page-break-after: avoid; }
    .phase-text { font-size: 16px; font-weight: 700; color: #111; }
    .phase-line { height: 2px; background: #c4cddd; margin-top: 10px; margin-bottom: 12px; }
    .phase-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; }
    .img-cell { min-width: 0; padding: 0; margin: 0; border: none; border-radius: 0; background: transparent; box-shadow: none; break-inside: avoid; page-break-inside: avoid; }
    .img-cell img { width: 100%; height: 76mm; object-fit: contain; display: block; background: #fff; border: none; border-radius: 0; box-shadow: none; outline: none; }
  `
}

export function workRecordPdfCssTextScoped(scope: string): string {
  const s = String(scope || '').trim()
  if (!s) return ''
  return `
    ${s} .keep-pack { break-inside: avoid; page-break-inside: avoid; }
    ${s} .titlebar { background: #eef3fb; padding: 6px 8px; margin-bottom: 10px; }
    ${s} .title { font-size: 16px; font-weight: 700; }
    ${s} .top-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 22px; padding: 2px 0 10px; }
    ${s} .top-item { min-width: 0; }
    ${s} .top-k { font-size: 12px; font-weight: 700; color: #6b778c; letter-spacing: 0.2px; text-transform: uppercase; }
    ${s} .top-v { margin-top: 8px; font-size: 16px; font-weight: 700; color: #111; overflow-wrap: anywhere; line-height: 1.25; }
    ${s} .top-v-blue { color: #1f5cff; }
    ${s} .section-head { margin-top: 16px; display: flex; align-items: center; gap: 10px; }
    ${s} .section-bar { width: 4px; height: 16px; background: #1f5cff; border-radius: 2px; }
    ${s} .section-title { font-size: 16px; font-weight: 700; color: #2b3a55; letter-spacing: 0.2px; line-height: 1.2; }
    ${s} .phase-pack { width: 100%; margin-top: 18px; break-inside: avoid; page-break-inside: avoid; }
    ${s} .phase-head { width: 100%; break-after: avoid; page-break-after: avoid; }
    ${s} .phase-text { font-size: 16px; font-weight: 700; color: #111; }
    ${s} .phase-line { height: 2px; background: #c4cddd; margin-top: 10px; margin-bottom: 12px; }
    ${s} .phase-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; }
    ${s} .img-cell { min-width: 0; padding: 0; margin: 0; border: none; border-radius: 0; background: transparent; box-shadow: none; break-inside: avoid; page-break-inside: avoid; }
    ${s} .img-cell img { width: 100%; height: 76mm; object-fit: contain; display: block; background: #fff; border: none; border-radius: 0; box-shadow: none; outline: none; }
  `
}

function buildWorkRecordParts(input: WorkRecordPdfTemplateInput): { title: string; body: string; imageCount: number } {
  const showChinese = input.showChinese === true
  const title = (() => {
    if (input.kind === 'maintenance') return showChinese ? 'Maintenance Repairs 维修记录' : 'Maintenance Repairs'
    return showChinese ? 'Deep Cleaning Maintenance 深度清洁维护' : 'Deep Cleaning Maintenance'
  })()
  const jobNumber = String(input.jobNumber || '').trim()
  const completionText = String(input.completionText || '').trim()
  const areaTextRaw = String(input.areaText || '').trim()
  const areaText = areaDisplay(areaTextRaw, showChinese)
  const beforeItems = pickItems(input.beforeUrls)
  const afterItems = pickItems(input.afterUrls)
  const imageCount = beforeItems.length + afterItems.length

  const labelJob = showChinese ? '工单编号  JOB NUMBER' : 'JOB NUMBER'
  const labelCompletion = showChinese ? '完成时间  COMPLETION DATE' : 'COMPLETION DATE'
  const labelArea = showChinese ? '维护区域  SERVICE AREA' : 'SERVICE AREA'
  const labelBefore = showChinese ? 'Before（前）' : 'Before'
  const labelAfter = showChinese ? 'After（后）' : 'After'
  const labelDetails = showChinese ? '维护详情对比  Service Details' : 'Service Details'

  const renderHeader = () => {
    return `
      <div class="titlebar">
        <div class="title">${escapeHtml(title)}</div>
      </div>
      <div class="top-grid">
        <div class="top-item">
          <div class="top-k">${escapeHtml(labelJob)}</div>
          <div class="top-v top-v-blue">${escapeHtml(jobNumber || '-')}</div>
        </div>
        <div class="top-item">
          <div class="top-k">${escapeHtml(labelCompletion)}</div>
          <div class="top-v">${escapeHtml(completionText || '-')}</div>
        </div>
        <div class="top-item">
          <div class="top-k">${escapeHtml(labelArea)}</div>
          <div class="top-v">${escapeHtml(areaText || '-')}</div>
        </div>
      </div>
      <div class="section-head">
        <div class="section-bar"></div>
        <div class="section-title">${escapeHtml(labelDetails)}</div>
      </div>
    `
  }

  const renderGrid = (items: Array<{ src: string; fallback: string }>) => {
    if (!items.length) return ''
    return `
      <div class="phase-grid">
        ${items.map((it) => {
          const onerr = `try{var fb=this.getAttribute('data-fallback')||'';if(fb&&this.src!==fb){this.onerror=null;this.src=fb}}catch(e){}`
          return `
            <div class="img-cell">
              <img crossorigin="anonymous" referrerpolicy="no-referrer" src="${escapeHtml(it.src)}" data-fallback="${escapeHtml(it.fallback)}" alt="" onerror="${escapeHtml(onerr)}" />
            </div>
          `
        }).join('')}
      </div>
    `
  }

  const renderPhase = (phase: string, items: Array<{ src: string; fallback: string }>) => {
    if (!items.length) return ''
    return `
      <div class="phase-pack">
        <div class="phase-head">
          <div class="phase-text">${escapeHtml(phase)}</div>
          <div class="phase-line"></div>
        </div>
        ${renderGrid(items)}
      </div>
    `
  }

  const first = beforeItems.length ? { label: labelBefore, items: beforeItems } : (afterItems.length ? { label: labelAfter, items: afterItems } : null)
  const second = (beforeItems.length && afterItems.length) ? { label: labelAfter, items: afterItems } : null

  const body = `
    <div class="keep-pack">
      ${renderHeader()}
      ${first ? renderPhase(first.label, first.items) : ''}
    </div>
    ${second ? renderPhase(second.label, second.items) : ''}
  `
  return { title, body, imageCount }
}

export function renderWorkRecordBodyFragment(input: WorkRecordPdfTemplateInput): { title: string; body: string; imageCount: number } {
  return buildWorkRecordParts(input)
}

export function renderWorkRecordPdfHtml(input: WorkRecordPdfTemplateInput): { html: string; imageCount: number } {
  const { title, body, imageCount } = buildWorkRecordParts(input)

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(title || (input.kind === 'deep_cleaning' ? 'Deep Cleaning' : 'Maintenance'))}</title>
        <style>
          ${workRecordPdfCssText()}
        </style>
      </head>
      <body>
        ${body}
      </body>
    </html>
  `
  return { html, imageCount }
}
