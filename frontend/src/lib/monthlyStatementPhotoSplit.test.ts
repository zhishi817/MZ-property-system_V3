import { describe, expect, it } from 'vitest'
import { canDownloadSplitPart, pickSplitPhotosMode, splitPartPhotoCount, type MergeSplitInfo } from './monthlyStatementPhotoSplit'

describe('monthly statement photo split', () => {
  const info: MergeSplitInfo = {
    maintenancePhotoCount: 2,
    deepCleaningPhotoCount: 0,
    totalPhotoCount: 2,
    shouldSplit: false,
    hardSplit: false,
    threshold: 40,
    hardThreshold: 80,
  }

  it('returns per-part photo counts', () => {
    expect(splitPartPhotoCount(info, 'maintenance')).toBe(2)
    expect(splitPartPhotoCount(info, 'deep_cleaning')).toBe(0)
  })

  it('enables split download only when that part has photos', () => {
    expect(canDownloadSplitPart(info, 'maintenance')).toBe(true)
    expect(canDownloadSplitPart(info, 'deep_cleaning')).toBe(false)
  })

  it('downgrades split photo mode for stability', () => {
    expect(pickSplitPhotosMode(2, 'ultra')).toBe('compressed')
    expect(pickSplitPhotosMode(12, 'ultra')).toBe('compressed')
    expect(pickSplitPhotosMode(24, 'ultra')).toBe('thumbnail')
  })
})
