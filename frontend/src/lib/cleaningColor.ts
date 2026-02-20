export type CleaningColorKind = 'unassigned' | 'checkin' | 'checkout' | 'combined'

export type CleaningColorItem = {
  source?: string | null
  label?: string | null
  assignee_id?: string | null
  cleaner?: string | null
  cleaner_id?: string | null
  entity_ids?: string[] | null
}

function cleanerValue(it: CleaningColorItem): string {
  const v = it.assignee_id ?? it.cleaner_id ?? it.cleaner
  return String(v || '').trim()
}

export function cleaningColorKind(it: CleaningColorItem): CleaningColorKind {
  if (!cleanerValue(it)) return 'unassigned'

  const source = String(it.source || '')
  const label = String(it.label || '')
  const hasMany = Array.isArray(it.entity_ids) && it.entity_ids.length > 1

  if (source === 'offline_tasks') return 'combined'
  if (hasMany) return 'combined'
  if (label.includes('入住') && label.includes('退房')) return 'combined'
  if (label.includes('入住')) return 'checkin'
  if (label.includes('退房')) return 'checkout'

  const s = `${source}:${label}`.toLowerCase()
  if (s.includes('checkin')) return 'checkin'
  if (s.includes('checkout')) return 'checkout'
  return 'checkout'
}

