export type PropertyLite = { id?: string; code?: string; building_name?: string; address?: string }

export function normalizeBaseVersion(version: any): string {
  const s = String(version || '').trim()
  if (!s) return ''
  const i = s.indexOf('-copy-')
  if (i > 0) return s.slice(0, i)
  return s
}

export function deriveBuildingKeyFromProperty(p: PropertyLite | null | undefined): string {
  const bn = String(p?.building_name || '').trim()
  if (bn) return bn
  const c = String(p?.code || '').trim()
  if (c) {
    const m = c.match(/^([a-z]+-?\d+)/i)
    if (m) return String(m[1]).toUpperCase()
    return c.toUpperCase()
  }
  const a = String(p?.address || '').trim()
  if (a) return a.split(',')[0].trim()
  return String(p?.id || '').trim()
}

export function isValidPropertyCode(code: any): boolean {
  const s = String(code || '').trim()
  if (!s) return false
  if (s.length < 3 || s.length > 24) return false
  return /^[a-z0-9-]+$/i.test(s)
}

