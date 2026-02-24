import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import { paginateVertical, type PdfRange } from './pdfPagination'

async function waitForFonts() {
  try {
    const fonts: any = (document as any).fonts
    if (fonts?.ready) {
      await Promise.race([fonts.ready, new Promise((r) => setTimeout(r, 1500))])
    }
  } catch {}
}

async function waitForImages(root: HTMLElement) {
  try {
    const imgs = Array.from(root.querySelectorAll('img')) as HTMLImageElement[]
    if (!imgs.length) return
    const loaders = imgs.map((img) => {
      if (img.complete) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const done = () => {
          img.removeEventListener('load', done)
          img.removeEventListener('error', done)
          resolve()
        }
        img.addEventListener('load', done)
        img.addEventListener('error', done)
      })
    })
    await Promise.race([Promise.all(loaders), new Promise((r) => setTimeout(r, 6000))])
  } catch {}
}

function safeRectTop(el: Element, rootTop: number) {
  const r = (el as HTMLElement).getBoundingClientRect()
  const top = r.top - rootTop
  return Number.isFinite(top) ? top : null
}

function safeRange(el: Element, rootTop: number): PdfRange | null {
  const r = (el as HTMLElement).getBoundingClientRect()
  const top = r.top - rootTop
  const bottom = r.bottom - rootTop
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return null
  return { top, bottom }
}

export async function exportElementToPdfBlob(opts: {
  element: HTMLElement
  orientation: 'p' | 'l'
  cssText?: string
  rootWidthMm: number
  marginMm?: number
  scale?: number
  imageQuality?: number
  minSlicePx?: number
  reservePx?: number
  tailGapPx?: number
}): Promise<{ blob: Blob; pageCount: number }> {
  const marginMm = Number.isFinite(opts.marginMm) ? Number(opts.marginMm) : 10
  const scale = Number.isFinite(opts.scale) ? Number(opts.scale) : 2
  const imageQuality = Number.isFinite(opts.imageQuality) ? Number(opts.imageQuality) : 0.82
  const minSlicePx = Number.isFinite(opts.minSlicePx) ? Number(opts.minSlicePx) : 80
  const reservePx = Number.isFinite(opts.reservePx) ? Number(opts.reservePx) : 60
  const tailGapPx = Number.isFinite(opts.tailGapPx) ? Number(opts.tailGapPx) : 16

  const nodeOrig = opts.element
  const node = nodeOrig.cloneNode(true) as HTMLElement
  node.className = `${node.className || ''} __pdf_capture_root__`.trim()
  node.style.width = `${opts.rootWidthMm}mm`
  node.style.boxSizing = 'border-box'
  node.style.margin = '0 auto'

  const sandbox = document.createElement('div')
  sandbox.style.position = 'fixed'
  sandbox.style.left = '-100000px'
  sandbox.style.top = '0'
  sandbox.style.width = '1px'
  sandbox.style.height = '1px'
  sandbox.style.overflow = 'visible'
  sandbox.style.pointerEvents = 'none'

  const styleEl = document.createElement('style')
  styleEl.textContent = String(opts.cssText || '')

  document.body.appendChild(sandbox)
  sandbox.appendChild(styleEl)
  sandbox.appendChild(node)
  try {
    await waitForFonts()
    await waitForImages(node)
    await new Promise((r) => setTimeout(r, 60))

    const rootRect = node.getBoundingClientRect()
    const rootTop = rootRect.top
    const rootWidthPx = rootRect.width || node.scrollWidth || node.clientWidth
    const rootHeightPx = rootRect.height || node.scrollHeight || node.clientHeight

    const pdf = new jsPDF({ orientation: opts.orientation, unit: 'mm', format: 'a4', compress: true })
    const pageWidthMm = pdf.internal.pageSize.getWidth()
    const pageHeightMm = pdf.internal.pageSize.getHeight()
    const contentWidthMm = pageWidthMm - marginMm * 2
    const contentHeightMm = pageHeightMm - marginMm * 2

    const pageHeightPx = contentHeightMm * (rootWidthPx / contentWidthMm)
    const totalHeightPx = rootHeightPx

    const anchors = Array.from(node.querySelectorAll('[data-keep-with-next="true"]'))
      .map((el) => safeRectTop(el, rootTop))
      .filter((v): v is number => typeof v === 'number')

    const breaks = Array.from(node.querySelectorAll('[data-pdf-break-before="true"]'))
      .map((el) => safeRectTop(el, rootTop))
      .filter((v): v is number => typeof v === 'number')

    const avoidRanges = Array.from(node.querySelectorAll('tr, [data-pdf-avoid-cut="true"]'))
      .map((el) => safeRange(el, rootTop))
      .filter((v): v is PdfRange => !!v)

    const slices = paginateVertical({
      totalHeight: totalHeightPx,
      pageHeight: pageHeightPx,
      minSlice: minSlicePx,
      reserve: reservePx,
      tailGap: tailGapPx,
      anchors,
      breaks,
      avoidRanges,
    })

    const windowWidth = Math.ceil(Math.max(rootWidthPx, node.scrollWidth || 0, node.clientWidth || 0))
    const windowHeight = Math.ceil(Math.max(rootHeightPx, node.scrollHeight || 0, node.clientHeight || 0))

    for (let i = 0; i < slices.length; i++) {
      const s = slices[i]
      if (i > 0) pdf.addPage()
      const canvas = await html2canvas(node, {
        scale,
        backgroundColor: '#ffffff',
        useCORS: true,
        allowTaint: true,
        imageTimeout: 15000,
        scrollX: 0,
        scrollY: 0,
        windowWidth,
        windowHeight,
        x: 0,
        y: Math.max(0, s.top),
        width: Math.ceil(rootWidthPx),
        height: Math.ceil(Math.max(1, s.height)),
      } as any)
      const img = canvas.toDataURL('image/jpeg', imageQuality)
      const imgHeightMm = (contentWidthMm * canvas.height) / canvas.width
      pdf.addImage(img, 'JPEG', marginMm, marginMm, contentWidthMm, imgHeightMm)
    }

    const blob = pdf.output('blob') as Blob
    return { blob, pageCount: slices.length || 1 }
  } finally {
    try { document.body.removeChild(sandbox) } catch {}
  }
}
