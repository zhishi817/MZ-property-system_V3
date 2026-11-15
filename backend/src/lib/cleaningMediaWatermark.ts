// Identity comes from authentication, never from a task's assignee or free-form watermark.
const text = (value: unknown) => String(value ?? '').trim()
const dayEndLabels: Record<string, string> = {
  backup_key_return: '日终交接-备用钥匙',
  return_wash_linen: '日终交接-脏床品',
  warehouse_key_return: '日终交接-仓库钥匙',
  remaining_consumables: '日终交接-剩余消耗品',
  reject_linen_return: '日终交接-Reject床品',
}

export function cleaningMediaCaptureOwnerMatches(owner: unknown, authenticatedId: unknown): boolean {
  // Absent metadata is accepted for legacy clients, not asserted to identify a photographer.
  return owner === undefined || (!!text(owner) && !!text(authenticatedId) && text(owner) === text(authenticatedId))
}

export function recordedCaptureTime(value: unknown): string | null {
  const raw = text(value)
  // Do not guess a timezone for legacy timestamps without an explicit offset.
  if (!raw || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return null
  const date = new Date(raw)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function melbourneCaptureTime(value: unknown): string {
  const recorded = recordedCaptureTime(value)
  if (!recorded) return '未记录'
  const date = new Date(recorded)
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} Melbourne`
}

export function cleaningPhotoWatermarkLines(input: {
  propertyCode?: unknown; purpose?: unknown; capturedAt?: unknown;
  authenticatedName?: unknown; capturedByUserId?: unknown;
}): string[] {
  const actor = text(input.authenticatedName) || '未记录'
  const subject = dayEndLabels[text(input.purpose)] || text(input.propertyCode) || '未记录'
  // Legacy clients provide no capture ownership: only certify the authenticated submitting account.
  const identityLabel = text(input.capturedByUserId) ? '操作账号' : '提交账号'
  return [`${subject}  ${identityLabel}: ${actor}`, melbourneCaptureTime(input.capturedAt)]
}
