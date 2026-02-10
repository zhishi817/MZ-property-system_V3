export function pickPublicBaseUrl(reqOrigin?: string) {
  const o = String(reqOrigin || '').trim()
  if (/^https?:\/\//i.test(o)) return o.replace(/\/+$/g, '')
  const env =
    String(process.env.PUBLIC_WEB_BASE_URL || '').trim() ||
    String(process.env.PUBLIC_GUIDE_BASE_URL || '').trim() ||
    String(process.env.FRONTEND_BASE_URL || '').trim() ||
    String(process.env.WEB_BASE_URL || '').trim()
  if (/^https?:\/\//i.test(env)) return env.replace(/\/+$/g, '')
  return ''
}

export function buildPublicGuideUrl(token: string, baseUrl: string) {
  const t = String(token || '').trim()
  if (!t) return ''
  const path = `/guide/p/${encodeURIComponent(t)}`
  const base = String(baseUrl || '').trim().replace(/\/+$/g, '')
  return base ? `${base}${path}` : path
}

