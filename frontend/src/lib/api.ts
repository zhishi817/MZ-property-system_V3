const API_BASE_ENV =
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_DEV ||
  process.env.NEXT_PUBLIC_API_BASE ||
  ''

export const API_BASE = API_BASE_ENV

function assertApiBase() {
  if (!API_BASE) throw new Error('Missing NEXT_PUBLIC_API_BASE_URL')
}

export type FetchTimeoutOptions = { timeoutMs?: number }

function getToken() {
  if (typeof window === 'undefined') return null
  const ls = localStorage.getItem('token') || sessionStorage.getItem('token')
  if (ls) return ls
  try {
    const m = document.cookie.match(/(?:^|;\s*)auth=([^;]*)/)
    return m ? decodeURIComponent(m[1]) : null
  } catch { return null }
}

export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {}
  const t = getToken()
  if (t) h.Authorization = `Bearer ${t}`
  return h
}

export async function fetchWithTimeout(input: any, init?: any, options?: FetchTimeoutOptions): Promise<Response> {
  const timeoutMs = Math.max(0, Number(options?.timeoutMs || 0))
  if (!timeoutMs) return fetch(input, init)
  const ac = new AbortController()
  const extSignal = init?.signal as AbortSignal | undefined
  const onAbort = () => { try { ac.abort() } catch {} }
  if (extSignal) {
    if (extSignal.aborted) onAbort()
    else extSignal.addEventListener('abort', onAbort, { once: true } as any)
  }
  const t = setTimeout(() => { try { ac.abort() } catch {} }, timeoutMs)
  try {
    return await fetch(input, { ...(init || {}), signal: ac.signal })
  } finally {
    clearTimeout(t)
    if (extSignal) { try { extSignal.removeEventListener('abort', onAbort as any) } catch {} }
  }
}

export async function getJSON<T>(path: string, options?: FetchTimeoutOptions): Promise<T> {
  assertApiBase()
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { cache: 'no-store', headers: authHeaders() }, options)
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new Error('HTTP 401')
  }
  if (!res.ok) {
    try {
      const ct = res.headers.get('content-type') || ''
      if (/application\/json/i.test(ct)) {
        const j = await res.json() as any
        const msg = String(j?.message || j?.error || `HTTP ${res.status}`)
        throw new Error(msg)
      } else {
        const t = await res.text()
        const msg = t ? t : `HTTP ${res.status}`
        throw new Error(msg)
      }
    } catch {
      throw new Error(`HTTP ${res.status}`)
    }
  }
  return res.json() as Promise<T>
}

export async function postJSON<T>(path: string, body: any, options?: FetchTimeoutOptions): Promise<T> {
  assertApiBase()
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) }, options)
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new Error('HTTP 401')
  }
  if (!res.ok) {
    try {
      const ct = res.headers.get('content-type') || ''
      if (/application\/json/i.test(ct)) {
        const j = await res.json() as any
        const msg = String(j?.message || j?.error || `HTTP ${res.status}`)
        throw new Error(msg)
      } else {
        const t = await res.text()
        const msg = t ? t : `HTTP ${res.status}`
        throw new Error(msg)
      }
    } catch {
      throw new Error(`HTTP ${res.status}`)
    }
  }
  return res.json() as Promise<T>
}

export async function patchJSON<T>(path: string, body: any, options?: FetchTimeoutOptions): Promise<T> {
  assertApiBase()
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) }, options)
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new Error('HTTP 401')
  }
  if (!res.ok) {
    try {
      const ct = res.headers.get('content-type') || ''
      if (/application\/json/i.test(ct)) {
        const j = await res.json() as any
        const msg = String(j?.message || j?.error || `HTTP ${res.status}`)
        throw new Error(msg)
      } else {
        const t = await res.text()
        const msg = t ? t : `HTTP ${res.status}`
        throw new Error(msg)
      }
    } catch {
      throw new Error(`HTTP ${res.status}`)
    }
  }
  return res.json() as Promise<T>
}

export async function deleteJSON<T>(path: string, options?: FetchTimeoutOptions): Promise<T> {
  assertApiBase()
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { method: 'DELETE', headers: { ...authHeaders() } }, options)
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new Error('HTTP 401')
  }
  if (!res.ok) {
    try {
      const ct = res.headers.get('content-type') || ''
      if (/application\/json/i.test(ct)) {
        const j = await res.json() as any
        const msg = String(j?.message || j?.error || `HTTP ${res.status}`)
        throw new Error(msg)
      } else {
        const t = await res.text()
        const msg = t ? t : `HTTP ${res.status}`
        throw new Error(msg)
      }
    } catch {
      throw new Error(`HTTP ${res.status}`)
    }
  }
  return res.json() as Promise<T>
}

export const apiList = <T>(resource: string, params?: Record<string, any>, options?: FetchTimeoutOptions) => getJSON<T>(`/crud/${resource}${params ? `?${new URLSearchParams(params as any).toString()}` : ''}`, options)
export const apiCreate = <T>(resource: string, body: any, options?: FetchTimeoutOptions) => postJSON<T>(`/crud/${resource}`, body, options)
export const apiUpdate = <T>(resource: string, id: string, body: any, options?: FetchTimeoutOptions) => patchJSON<T>(`/crud/${resource}/${id}`, body, options)
export const apiDelete = <T>(resource: string, id: string, options?: FetchTimeoutOptions) => deleteJSON<T>(`/crud/${resource}/${id}`, options)
