export type MergeSplitInfo = {
  maintenancePhotoCount: number
  deepCleaningPhotoCount: number
  totalPhotoCount: number
  shouldSplit: boolean
  hardSplit: boolean
  threshold: number
  hardThreshold: number
}

export type SplitKind = 'maintenance' | 'deep_cleaning'

export function splitPartPhotoCount(info: MergeSplitInfo | null | undefined, kind: SplitKind): number {
  if (!info) return 0
  return kind === 'maintenance'
    ? Number(info.maintenancePhotoCount || 0)
    : Number(info.deepCleaningPhotoCount || 0)
}

export function canDownloadSplitPart(info: MergeSplitInfo | null | undefined, kind: SplitKind): boolean {
  return splitPartPhotoCount(info, kind) > 0
}
