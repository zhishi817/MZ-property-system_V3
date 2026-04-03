export function resolveExcludeOrphanFixedSnapshotsParam(raw: string | null | undefined): boolean {
  if (raw === '0') return false
  if (raw === '1') return true
  return true
}
