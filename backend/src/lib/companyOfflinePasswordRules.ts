type OfflinePasswordStructure = {
  secret_kind?: string | null
  property_ids?: unknown
  box_number?: unknown
  location?: unknown
  rotation_interval_days?: unknown
}

const propertyLinkedKinds = new Set([
  'mailbox',
  'backup_key',
  'door_lock',
  'mailbox_lockbox',
  'garage_lockbox',
  'mailbox_key_lockbox',
  'locker',
])

const numberedBoxKinds = new Set([
  'backup_key',
  'mailbox_lockbox',
  'garage_lockbox',
  'mailbox_key_lockbox',
])

export function offlinePasswordStructureIssue(input: OfflinePasswordStructure): { path: string; message: string } | null {
  const kind = String(input.secret_kind || '').trim()
  const propertyIds = input.property_ids

  if (propertyLinkedKinds.has(kind) && (!Array.isArray(propertyIds) || !propertyIds.some((id) => String(id || '').trim()))) {
    return { path: 'property_ids', message: 'at least one linked property is required' }
  }
  if (numberedBoxKinds.has(kind) && !String(input.box_number || '').trim()) {
    return { path: 'box_number', message: 'password box number is required' }
  }
  if (numberedBoxKinds.has(kind) && !String(input.location || '').trim()) {
    return { path: 'location', message: 'password box location is required' }
  }
  if (kind === 'company_rotating' && !Number(input.rotation_interval_days || 0)) {
    return { path: 'rotation_interval_days', message: 'rotation interval is required' }
  }
  return null
}
