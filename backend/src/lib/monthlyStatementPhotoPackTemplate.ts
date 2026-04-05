type Kind = 'maintenance' | 'deep_cleaning'

export type PhotoPackEmbeddedImage = {
  dataUrl: string
  mimeType: string
  width?: number
  height?: number
}

export type PhotoPackTemplateRecord = {
  kind: Kind
  jobNumber: string
  completionText: string
  areaText: string
  beforeImages: PhotoPackEmbeddedImage[]
  afterImages: PhotoPackEmbeddedImage[]
  beforeRawCount?: number
  afterRawCount?: number
  missingNotice?: string
}

export type MonthlyStatementPhotoPackTemplateInput = {
  month: string
  property: { id: string; code?: string; address?: string } | null
  landlordName?: string
  showChinese?: boolean
  records: PhotoPackTemplateRecord[]
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function titleOf(kind: Kind, showChinese: boolean) {
  if (kind === 'maintenance') return showChinese ? 'Maintenance Repairs 维修记录' : 'Maintenance Repairs'
  return showChinese ? 'Deep Cleaning Maintenance 深度清洁维护' : 'Deep Cleaning Maintenance'
}

function areaToEnglish(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
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
  const parts = s.replace(/[，、;；]/g, ',').split(/[,/|]+/g).map((x) => x.trim()).filter(Boolean)
  if (parts.length <= 1) return dict[s] || s
  return parts.map((p) => dict[p] || p).join(', ')
}

function areaDisplay(raw: string, showChinese: boolean) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const en = areaToEnglish(s)
  if (!showChinese) return en || s
  if (/[A-Za-z]/.test(s)) return s
  if (!en || en === s) return s
  return `${s} ${en}`
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

type PageSection = {
  label: string
  images?: PhotoPackEmbeddedImage[]
  missingText?: string
}

function renderRecordHeader(record: PhotoPackTemplateRecord, showChinese: boolean) {
  const labelJob = showChinese ? '工单编号  JOB NUMBER' : 'JOB NUMBER'
  const labelCompletion = showChinese ? '完成时间  COMPLETION DATE' : 'COMPLETION DATE'
  const labelArea = showChinese ? '维护区域  SERVICE AREA' : 'SERVICE AREA'
  const labelDetails = showChinese ? '维护详情对比  Service Details' : 'Service Details'
  const title = titleOf(record.kind, showChinese)
  const areaText = areaDisplay(record.areaText, showChinese)
  return `
    <div class="record-head">
      <div class="titlebar">
        <div class="title">${escapeHtml(title)}</div>
      </div>
      <div class="top-grid">
        <div class="top-item">
          <div class="top-k">${escapeHtml(labelJob)}</div>
          <div class="top-v top-v-blue">${escapeHtml(record.jobNumber || '-')}</div>
        </div>
        <div class="top-item">
          <div class="top-k">${escapeHtml(labelCompletion)}</div>
          <div class="top-v">${escapeHtml(record.completionText || '-')}</div>
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
    </div>
  `
}

function renderRecordPage(record: PhotoPackTemplateRecord, showChinese: boolean, sections: PageSection[]) {
  return `
    <section class="page photo-page">
      ${renderRecordHeader(record, showChinese)}
      ${sections.map((section) => `
        <div class="phase-pack">
          <div class="phase-head">
            <div class="phase-text">${escapeHtml(section.label)}</div>
            <div class="phase-line"></div>
          </div>
          ${section.missingText
            ? `<div class="missing-box">${escapeHtml(section.missingText)}</div>`
            : `<div class="phase-grid">
                ${(section.images || []).map((img) => `
                  <div class="img-cell">
                    <img src="${escapeHtml(img.dataUrl)}" alt="" />
                  </div>
                `).join('')}
              </div>`}
        </div>
      `).join('')}
    </section>
  `
}

export function renderMonthlyStatementPhotoPackHtml(input: MonthlyStatementPhotoPackTemplateInput): { html: string; imageCount: number; pageCount: number } {
  const showChinese = input.showChinese !== false
  const propCode = String(input.property?.code || '').trim()
  const propAddr = String(input.property?.address || '').trim()
  const month = String(input.month || '').trim()
  const landlord = String(input.landlordName || '').trim()
  const pages: string[] = []
  let imageCount = 0

  for (const record of input.records || []) {
    const beforeLabel = showChinese ? 'Before（前）' : 'Before'
    const afterLabel = showChinese ? 'After（后）' : 'After'
    const pageCapacity = 6
    const phases = [
      { label: beforeLabel, images: Array.isArray(record.beforeImages) ? record.beforeImages : [], rawCount: Number(record.beforeRawCount || 0) || 0 },
      { label: afterLabel, images: Array.isArray(record.afterImages) ? record.afterImages : [], rawCount: Number(record.afterRawCount || 0) || 0 },
    ]
    let renderedAny = false
    let currentSections: PageSection[] = []
    let usedSlots = 0
    const flushPage = () => {
      if (!currentSections.length) return
      pages.push(renderRecordPage(record, showChinese, currentSections))
      currentSections = []
      usedSlots = 0
    }
    for (const phase of phases) {
      if (phase.images.length > 0) {
        imageCount += phase.images.length
        let idx = 0
        while (idx < phase.images.length) {
          const remaining = pageCapacity - usedSlots
          if (remaining <= 0) {
            flushPage()
            continue
          }
          const take = Math.min(remaining, phase.images.length - idx)
          currentSections.push({ label: phase.label, images: phase.images.slice(idx, idx + take) })
          usedSlots += take
          idx += take
          if (usedSlots >= pageCapacity) flushPage()
        }
        renderedAny = true
      } else if (phase.rawCount > 0) {
        const msg = showChinese
          ? `${phase.label} 的图片均无法加载，请检查原始链接`
          : `All ${phase.label} images failed to load. Please verify the source links.`
        flushPage()
        currentSections.push({ label: phase.label, missingText: msg })
        flushPage()
        renderedAny = true
      }
    }
    if (!renderedAny) {
      const msg = record.missingNotice || (showChinese
        ? '该记录没有可用图片，请检查原始链接'
        : 'No usable images were available for this record.')
      currentSections.push({ label: showChinese ? '照片缺失说明' : 'Missing Photos', missingText: msg })
    }
    flushPage()
  }

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(`Photo Pack ${month}`)}</title>
        <style>
          @page { size: A4; margin: 12mm; }
          html, body { margin: 0; padding: 0; background: #fff; color: #000; font-family: "Times New Roman", Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .cover { break-after: page; page-break-after: always; }
          .header { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 2px solid #000; padding-bottom: 8px; }
          .title-main { font-size: 28px; font-weight: 700; letter-spacing: 0.6px; }
          .meta { text-align: right; font-size: 13px; line-height: 1.4; }
          .page { break-after: page; page-break-after: always; }
          .page:last-child { break-after: auto; page-break-after: auto; }
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
          .phase-pack { margin-top: 18px; }
          .phase-head { width: 100%; }
          .phase-text { font-size: 16px; font-weight: 700; color: #111; }
          .phase-line { height: 2px; background: #c4cddd; margin-top: 10px; margin-bottom: 12px; }
          .phase-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; }
          .img-cell { min-width: 0; }
          .img-cell img { width: 100%; height: 76mm; object-fit: contain; display: block; background: #fff; border: 1px solid #e5e7eb; }
          .missing-box { margin-top: 12px; padding: 18px; border: 1px dashed #c4cddd; color: #4b5563; font-size: 14px; line-height: 1.6; background: #fafbff; }
        </style>
      </head>
      <body>
        ${pages.join('')}
      </body>
    </html>
  `
  return { html, imageCount, pageCount: pages.length }
}
