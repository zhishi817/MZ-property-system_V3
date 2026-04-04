type PhotosMode = 'full' | 'compressed' | 'thumbnail'

export type NormalizePhotoUrlForPdfOptions = {
  apiBase: string
  allowR2KeyPrefixes: string[]
  photosMode?: PhotosMode
  compress?: { w: number; q: number }
  r2ProxyPath?: string
}

function r2PublicBaseForKeyFromEnv(): string {
  const endpoint = String(process.env.R2_ENDPOINT || '').replace(/\/$/, '')
  const bucket = String(process.env.R2_BUCKET || '').trim()
  const pb = String(process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_BASE || '').replace(/\/$/, '')
  const cleaned = pb && /\.r2\.dev($|\/)/.test(pb) ? pb.replace(new RegExp(`/${bucket}$`), '') : pb
  return cleaned || (endpoint && bucket ? `${endpoint}/${bucket}` : '')
}

function parseUrl(input: string): URL | null {
  try {
    return new URL(String(input || '').trim())
  } catch {
    return null
  }
}

function isR2ProxyUrl(u: string): boolean {
  const parsed = parseUrl(u)
  if (!parsed) return false
  const p = String(parsed.pathname || '')
  return p.endsWith('/public/r2-image') || p.endsWith('/r2-image')
}

export function isR2Url(u: string): boolean {
  const parsed = parseUrl(u)
  if (!parsed) return false
  const host = String(parsed.hostname || '').toLowerCase()
  return host.endsWith('.r2.dev') || host.includes('r2.cloudflarestorage.com')
}

export function proxyR2Url(u: string, opt: NormalizePhotoUrlForPdfOptions): string {
  if (isR2ProxyUrl(u)) return u
  const apiBase = String(opt?.apiBase || '').trim()
  if (!apiBase) return u
  const proxyPath = String(opt?.r2ProxyPath || '/public/r2-image')
  const base = `${apiBase}${proxyPath}?url=${encodeURIComponent(u)}`
  const photosMode = (opt?.photosMode || 'full') as PhotosMode
  if (photosMode !== 'compressed' && photosMode !== 'thumbnail') return base
  const w = Number(opt?.compress?.w || 0)
  const q = Number(opt?.compress?.q || 0)
  if (!Number.isFinite(w) || !Number.isFinite(q) || w <= 0 || q <= 0) return base
  return `${base}&fmt=jpeg&w=${w}&q=${q}`
}

export function normalizeR2KeyForPdf(key: string, opt: NormalizePhotoUrlForPdfOptions): string {
  const k = String(key || '').trim().replace(/^\/+/, '')
  if (!k) return ''
  const allow = Array.isArray(opt?.allowR2KeyPrefixes) ? opt.allowR2KeyPrefixes : []
  if (!allow.some((p) => k.startsWith(p))) return ''
  const base = r2PublicBaseForKeyFromEnv()
  if (!base) return ''
  const u = `${base}/${k}`
  return isR2Url(u) ? proxyR2Url(u, opt) : u
}

export function normalizePhotoUrlForPdf(u: string, opt: NormalizePhotoUrlForPdfOptions): string {
  const s = String(u || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) {
    if (isR2ProxyUrl(s)) return s
    return isR2Url(s) ? proxyR2Url(s, opt) : s
  }
  if (s.startsWith('//')) {
    const abs = `https:${s}`
    if (isR2ProxyUrl(abs)) return abs
    return isR2Url(abs) ? proxyR2Url(abs, opt) : abs
  }
  if (s.startsWith('/')) {
    const apiBase = String(opt?.apiBase || '').trim()
    return apiBase ? `${apiBase}${s}` : ''
  }
  const maybeKey = normalizeR2KeyForPdf(s, opt)
  return maybeKey || ''
}
