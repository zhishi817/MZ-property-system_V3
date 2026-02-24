import { describe, expect, it } from 'vitest'
import { paginateVertical } from './pdfPagination'

describe('paginateVertical', () => {
  it('handles empty inputs', () => {
    expect(paginateVertical({ totalHeight: 0, pageHeight: 100, minSlice: 10, reserve: 10, tailGap: 5 })).toEqual([])
    expect(paginateVertical({ totalHeight: 100, pageHeight: 0, minSlice: 10, reserve: 10, tailGap: 5 })).toEqual([])
  })

  it('creates stable pages without swallowing content', () => {
    const slices = paginateVertical({
      totalHeight: 1000,
      pageHeight: 300,
      minSlice: 80,
      reserve: 60,
      tailGap: 16,
      anchors: [290, 580, 870],
      breaks: [320, 610, 900],
      avoidRanges: [{ top: 295, bottom: 310 }, { top: 605, bottom: 625 }],
    })
    const covered = slices.reduce((s, x) => s + x.height, 0)
    expect(Math.round(covered)).toBe(1000)
    for (let i = 1; i < slices.length; i++) {
      expect(Math.round(slices[i].top)).toBe(Math.round(slices[i - 1].top + slices[i - 1].height))
    }
  })

  it('ignores too-small break adjustments', () => {
    const slices = paginateVertical({
      totalHeight: 700,
      pageHeight: 300,
      minSlice: 120,
      reserve: 80,
      tailGap: 16,
      breaks: [100, 200, 280],
    })
    expect(slices.length).toBeGreaterThan(0)
    expect(slices[0].height).toBeGreaterThanOrEqual(120)
    expect(Math.round(slices.reduce((s, x) => s + x.height, 0))).toBe(700)
  })

  it('keeps table-row ranges from being cut when possible', () => {
    const rowH = 24
    const headerH = 260
    const rows = 200
    const total = headerH + rows * rowH
    const avoidRanges = Array.from({ length: rows }).map((_, i) => {
      const top = headerH + i * rowH
      return { top, bottom: top + rowH }
    })
    const slices = paginateVertical({
      totalHeight: total,
      pageHeight: 820,
      minSlice: 80,
      reserve: 60,
      tailGap: 16,
      avoidRanges,
    })
    const cuts = slices.slice(0, -1).map((s) => s.top + s.height)
    const cutHits = cuts.filter((c) => avoidRanges.some((r) => c > r.top && c < r.bottom))
    expect(cutHits.length).toBe(0)
    expect(Math.round(slices.reduce((s, x) => s + x.height, 0))).toBe(total)
  })

  it('covers empty/50/200 rows scenarios', () => {
    const rowH = 24
    const headerH = 320
    const pageH = 820
    const mk = (rows: number) => {
      const total = headerH + rows * rowH
      const avoidRanges = Array.from({ length: rows }).map((_, i) => {
        const top = headerH + i * rowH
        return { top, bottom: top + rowH }
      })
      const slices = paginateVertical({
        totalHeight: total,
        pageHeight: pageH,
        minSlice: 80,
        reserve: 60,
        tailGap: 16,
        avoidRanges,
      })
      return { total, slices, avoidRanges }
    }

    const a0 = mk(0)
    expect(a0.slices.length).toBe(1)
    expect(Math.round(a0.slices.reduce((s, x) => s + x.height, 0))).toBe(a0.total)

    const a50 = mk(50)
    expect(a50.slices.length).toBeGreaterThan(1)
    expect(Math.round(a50.slices.reduce((s, x) => s + x.height, 0))).toBe(a50.total)

    const a200 = mk(200)
    expect(a200.slices.length).toBeGreaterThan(1)
    expect(Math.round(a200.slices.reduce((s, x) => s + x.height, 0))).toBe(a200.total)
  })
})
