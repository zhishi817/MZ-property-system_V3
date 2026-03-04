export type PdfRange = { top: number; bottom: number }
export type PdfSlice = { top: number; height: number }

export function paginateVertical(opts: {
  totalHeight: number
  pageHeight: number
  minSlice: number
  reserve: number
  tailGap: number
  anchors?: number[]
  breaks?: number[]
  avoidRanges?: PdfRange[]
  maxPages?: number
}): PdfSlice[] {
  const totalHeight = Number(opts.totalHeight || 0)
  const pageHeight = Number(opts.pageHeight || 0)
  const minSlice = Math.max(0, Number(opts.minSlice || 0))
  const reserve = Math.max(0, Number(opts.reserve || 0))
  const tailGap = Math.max(0, Number(opts.tailGap || 0))
  const maxPages = Math.max(1, Math.floor(Number(opts.maxPages || 2000)))

  if (!Number.isFinite(totalHeight) || !Number.isFinite(pageHeight) || totalHeight <= 0 || pageHeight <= 0) return []

  const anchors = (opts.anchors || []).filter(Number.isFinite).map(Number).sort((a, b) => a - b)
  const breaks = (opts.breaks || []).filter(Number.isFinite).map(Number).sort((a, b) => a - b)
  const avoidRanges = (opts.avoidRanges || [])
    .map((r) => ({ top: Number(r.top), bottom: Number(r.bottom) }))
    .filter((r) => Number.isFinite(r.top) && Number.isFinite(r.bottom) && r.bottom > r.top)
    .sort((a, b) => a.top - b.top)

  const slices: PdfSlice[] = []
  let y = 0

  while (y < totalHeight - 0.5 && slices.length < maxPages) {
    const desiredEnd = Math.min(y + pageHeight, totalHeight)
    if (desiredEnd <= y + 0.5) break
    if (desiredEnd >= totalHeight - 0.5) {
      slices.push({ top: y, height: totalHeight - y })
      break
    }

    let end = desiredEnd

    if (reserve > 0 && anchors.length) {
      for (let i = anchors.length - 1; i >= 0; i--) {
        const pos = anchors[i]
        if (pos <= y + minSlice) continue
        if (pos > desiredEnd) continue
        if ((desiredEnd - pos) < reserve && (pos - y) >= minSlice) {
          end = Math.min(end, pos)
          break
        }
      }
    }

    if (breaks.length) {
      for (let i = breaks.length - 1; i >= 0; i--) {
        const v = breaks[i]
        if (v <= y + minSlice) continue
        if (v >= end - tailGap) continue
        if (v - y >= minSlice) end = Math.min(end, v)
        break
      }
    }

    if (avoidRanges.length) {
      const hit = avoidRanges.find((r) => end > r.top && end < r.bottom)
      if (hit) {
        const adjusted = hit.top
        const hitHeight = hit.bottom - hit.top
        const wouldWaste = end - adjusted
        const isHugeBlock = hitHeight > pageHeight * 0.9
        const wastesTooMuch = wouldWaste > pageHeight * 0.35
        if (!isHugeBlock && !wastesTooMuch && adjusted - y >= minSlice) end = adjusted
      }
    }

    if (end <= y + 0.5) end = desiredEnd

    const height = end - y
    if (height <= 0.5) break
    slices.push({ top: y, height })
    y = end
  }

  if (slices.length >= maxPages) {
    const last = slices[slices.length - 1]
    if (last && last.top + last.height < totalHeight - 0.5) {
      slices[slices.length - 1] = { top: last.top, height: totalHeight - last.top }
    }
  }

  return slices
}
