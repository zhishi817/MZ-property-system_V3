/** Server-private inbox text must never cross the push delivery boundary. */
function publicNotificationData(data: any): Record<string, any> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  const { _inbox_body, ...publicData } = data
  return publicData
}

export function notificationInboxContent(body: any, data: any) {
  const inboxBody = typeof data?._inbox_body === 'string' ? data._inbox_body.trim() : ''
  return { body: inboxBody || String(body || ''), data: publicNotificationData(data) }
}

export function notificationPushContent(body: any, data: any) {
  return { body: String(body || ''), data: publicNotificationData(data) }
}
