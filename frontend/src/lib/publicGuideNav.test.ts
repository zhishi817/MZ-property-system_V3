import { describe, expect, it } from 'vitest'
import {
  TOC_BG_ALPHA_ACTIVE,
  TOC_BG_ALPHA_BASE,
  TOC_BG_ALPHA_HOVER,
  TOC_BLUR_ACTIVE_PX,
  TOC_BLUR_BASE_PX,
  TOC_BLUR_HOVER_PX,
  TOC_TRANSITION_MS,
  computeAnchorScrollTop,
  isCatalogPage,
} from './publicGuideNav'

describe('publicGuideNav', () => {
  it('keeps TOC alpha within requested range', () => {
    expect(TOC_BG_ALPHA_BASE).toBeGreaterThanOrEqual(0.85)
    expect(TOC_BG_ALPHA_BASE).toBeLessThanOrEqual(0.9)
    expect(TOC_BG_ALPHA_HOVER).toBeGreaterThanOrEqual(0.85)
    expect(TOC_BG_ALPHA_HOVER).toBeLessThanOrEqual(0.9)
    expect(TOC_BG_ALPHA_ACTIVE).toBeGreaterThanOrEqual(0.85)
    expect(TOC_BG_ALPHA_ACTIVE).toBeLessThanOrEqual(0.9)
  })

  it('keeps blur radius within requested range', () => {
    expect(TOC_BLUR_BASE_PX).toBeGreaterThanOrEqual(4)
    expect(TOC_BLUR_BASE_PX).toBeLessThanOrEqual(6)
    expect(TOC_BLUR_HOVER_PX).toBeGreaterThanOrEqual(4)
    expect(TOC_BLUR_HOVER_PX).toBeLessThanOrEqual(6)
    expect(TOC_BLUR_ACTIVE_PX).toBeGreaterThanOrEqual(4)
    expect(TOC_BLUR_ACTIVE_PX).toBeLessThanOrEqual(6)
  })

  it('keeps transition duration within requested range', () => {
    expect(TOC_TRANSITION_MS).toBeGreaterThanOrEqual(150)
    expect(TOC_TRANSITION_MS).toBeLessThanOrEqual(200)
  })

  it('computes smooth scroll top with offset', () => {
    expect(computeAnchorScrollTop(200, 1000, 96)).toBe(1104)
  })

  it('detects catalog page based on first chapter top', () => {
    const firstChapterTopAbsY = 1000
    const threshold = 24
    expect(isCatalogPage(0, firstChapterTopAbsY, threshold)).toBe(true)
    expect(isCatalogPage(950, firstChapterTopAbsY, threshold)).toBe(true)
    expect(isCatalogPage(980, firstChapterTopAbsY, threshold)).toBe(false)
    expect(isCatalogPage(1500, firstChapterTopAbsY, threshold)).toBe(false)
  })
})

