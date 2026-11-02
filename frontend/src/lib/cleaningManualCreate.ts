export type ManualCreateMode = 'checkout' | 'checkin' | 'turnover' | 'stayover'

function trimmedOrNull(value: string) {
  const trimmed = String(value || '').trim()
  return trimmed || null
}

export function manualCreatePasswordPayload(
  mode: ManualCreateMode,
  checkoutPassword: string,
  checkinPassword: string,
): { old_code?: string | null; new_code?: string | null } {
  const payload: { old_code?: string | null; new_code?: string | null } = {}
  if (mode === 'checkout' || mode === 'turnover') payload.old_code = trimmedOrNull(checkoutPassword)
  if (mode === 'checkin' || mode === 'turnover') payload.new_code = trimmedOrNull(checkinPassword)
  return payload
}
