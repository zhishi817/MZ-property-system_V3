/** Completion-photo limits are independent of required-area minimums. */
const COMPLETION_PHOTO_LIMITS: Readonly<Record<string, number>> = {
  toilet: 9,
  living: 3,
  sofa: 2,
  bedroom: 8,
  kitchen: 2,
  vacuum_used: 1,
  shower_drain: 1,
  remote_tv: 1,
  remote_ac: 1,
  remote_controls: 3,
}

export function completionPhotoLimitViolation(items: ReadonlyArray<{ area: string }>, taskType: unknown) {
  const stayover = String(taskType || '').trim().toLowerCase() === 'stayover_clean'
  const counts = new Map<string, number>()
  for (const item of items) {
    const area = String(item.area)
    // Each bathroom may need its own drain photo. The final completion route
    // still requires at least one; do not replace that minimum with a maximum.
    if (stayover && area === 'shower_drain') continue
    const count = (counts.get(area) || 0) + 1
    counts.set(area, count)
    const limit = COMPLETION_PHOTO_LIMITS[area] ?? 1
    if (count > limit) return { area, limit }
  }
  return null
}
