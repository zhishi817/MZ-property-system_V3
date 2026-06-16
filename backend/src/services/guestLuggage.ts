export type GuestLuggageContent = {
  note: string | null
  photoUrls: string[]
}

export function canEditGuestLuggageForRoles(roles: string[]) {
  const allowed = new Set(['customer_service', 'admin', 'offline_manager'])
  return (roles || []).some((role) => allowed.has(String(role || '').trim()))
}

export function planGuestLuggageMutation(
  existing: { note?: unknown; photo_urls?: unknown; version?: unknown } | null,
  next: GuestLuggageContent,
  normalizePhotoUrls: (value: unknown) => string[],
) {
  const changed =
    !existing
    || String(existing.note || '').trim() !== String(next.note || '').trim()
    || JSON.stringify(normalizePhotoUrls(existing.photo_urls)) !== JSON.stringify(next.photoUrls)

  return {
    changed,
    version: existing ? Math.max(1, Number(existing.version || 1)) + (changed ? 1 : 0) : 1,
    resetAcknowledgements: !!existing && changed,
  }
}

export function resolveGuestLuggageRecipientIds(
  taskRows: Array<{ cleaner_id?: unknown; inspector_id?: unknown; assignee_id?: unknown }>,
  managerUserIds: unknown[],
) {
  const ids = [
    ...(taskRows || []).flatMap((row) => [row.cleaner_id, row.inspector_id, row.assignee_id]),
    ...(managerUserIds || []),
  ]
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)))
}
