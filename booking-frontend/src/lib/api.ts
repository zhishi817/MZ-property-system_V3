const API_BASE_ENV =
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_DEV ||
  process.env.NEXT_PUBLIC_API_BASE ||
  ''

const API_BASE = (() => {
  const raw = String(API_BASE_ENV || '').trim()
  if (!raw) return '/api'
  return raw.replace(/\/+$/g, '')
})()

function apiOrigin() {
  if (/^https?:\/\//i.test(API_BASE)) {
    try {
      return new URL(API_BASE).origin
    } catch {
      return ''
    }
  }
  return ''
}

export function resolveAssetUrl(value: string) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^(https?:)?\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('blob:')) return raw
  if (raw.startsWith('/')) {
    const origin = apiOrigin()
    if (origin) return `${origin}${raw}`
    if (typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname)) {
      return `http://localhost:4002${raw}`
    }
    return raw
  }
  return raw
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    ...(init || {}),
    headers: {
      'Content-Type': 'application/json',
      ...((init && init.headers) || {}),
    },
  })
  if (!res.ok) {
    const ct = res.headers.get('content-type') || ''
    if (/application\/json/i.test(ct)) {
      const j = await res.json().catch(() => null) as any
      throw new Error(String(j?.message || `HTTP ${res.status}`))
    }
    throw new Error(`HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function getJSON<T>(path: string) {
  return request<T>(path, { method: 'GET' })
}

export function postJSON<T>(path: string, body: any) {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body || {}) })
}
