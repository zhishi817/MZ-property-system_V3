export const TOC_BG_ALPHA_BASE = 0.88
export const TOC_BG_ALPHA_HOVER = 0.9
export const TOC_BG_ALPHA_ACTIVE = 0.86
export const TOC_BLUR_BASE_PX = 5
export const TOC_BLUR_HOVER_PX = 6
export const TOC_BLUR_ACTIVE_PX = 4
export const TOC_TRANSITION_MS = 180

export function computeAnchorScrollTop(targetTopInViewport: number, scrollY: number, offsetPx: number) {
  return targetTopInViewport + scrollY - offsetPx
}

export function isCatalogPage(scrollY: number, firstChapterTopAbsY: number, thresholdPx: number) {
  return scrollY < Math.max(0, firstChapterTopAbsY - thresholdPx)
}

