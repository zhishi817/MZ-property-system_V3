const API_BASE_ENV =
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_DEV ||
  process.env.NEXT_PUBLIC_API_BASE ||
  ''

function isNonLocalAbsoluteUrl(s: string) {
  try {
    const u = new URL(String(s))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return u.hostname !== 'localhost' && u.hostname !== '127.0.0.1'
  } catch {
    return false
  }
}

function isLocalAbsoluteUrl(s: string) {
  try {
    const u = new URL(String(s))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

const IS_DEV = process.env.NODE_ENV !== 'production'
const API_BASE = (() => {
  const raw = String(API_BASE_ENV || '').trim()
  if (!raw) return IS_DEV ? '/api' : ''
  if (raw.startsWith('/')) return raw.replace(/\/+$/g, '')
  if (IS_DEV && isLocalAbsoluteUrl(raw)) return '/api'
  if (isNonLocalAbsoluteUrl(raw)) return raw.replace(/\/+$/g, '')
  return raw.replace(/\/+$/g, '')
})()

export { API_BASE }

function assertApiBase() {
  if (!API_BASE) throw new Error('Missing NEXT_PUBLIC_API_BASE (or NEXT_PUBLIC_API_BASE_DEV / NEXT_PUBLIC_API_BASE_URL)')
}

export type FetchTimeoutOptions = { timeoutMs?: number }
export type ApiFailureKind = 'network_unavailable' | 'auth_401' | 'http_other'
export type RequestJSONOptions = FetchTimeoutOptions & { authSensitive?: boolean }

function buildApiError(msg: string, payload?: any) {
  const err: any = new Error(msg)
  if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'message' || key === 'error') continue
      err[key] = value
    }
  }
  return err
}

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

export function clearAuth() {
  if (typeof window === 'undefined') return
  try { localStorage.removeItem('token'); sessionStorage.removeItem('token') } catch {}
  try { localStorage.removeItem('role'); sessionStorage.removeItem('role') } catch {}
  try { document.cookie = 'auth=; path=/; max-age=0; SameSite=Lax' } catch {}
  try { document.cookie = 'auth=; path=/; max-age=0' } catch {}
}

function isLocalDevApiBase() {
  if (!IS_DEV) return false
  if (API_BASE === '/api') return true
  try {
    const u = new URL(String(API_BASE || ''))
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function classifyApiFailure(input: { error?: any; response?: Response | null }): ApiFailureKind {
  if (input.response?.status === 401) return 'auth_401'
  if (input.response) return 'http_other'
  const name = String(input.error?.name || '')
  if (name === 'TypeError' || name === 'AbortError') return 'network_unavailable'
  return 'http_other'
}

function withApiFailure(err: any, kind: ApiFailureKind, extras?: Record<string, any>) {
  const next = err instanceof Error ? err : buildApiError(String(err?.message || err || 'failed'))
  ;(next as any).apiFailureKind = kind
  if (extras && typeof extras === 'object') {
    for (const [key, value] of Object.entries(extras)) (next as any)[key] = value
  }
  return next
}

export function getApiFailureKind(err: any): ApiFailureKind | null {
  const kind = String(err?.apiFailureKind || '').trim()
  return kind === 'network_unavailable' || kind === 'auth_401' || kind === 'http_other' ? kind : null
}

export function isApiFailureKind(err: any, kind: ApiFailureKind) {
  return getApiFailureKind(err) === kind
}

function redirectToLogin() {
  clearAuth()
  if (typeof window !== 'undefined') window.location.href = '/login'
}

async function probeLocalDevHealth() {
  if (!isLocalDevApiBase()) return false
  try {
    const res = await fetchWithTimeout(`${API_BASE}/health`, { cache: 'no-store' }, { timeoutMs: 1500 })
    return res.ok
  } catch {
    return false
  }
}

async function fetchWithDevAuthRecovery(path: string, init?: any, options?: RequestJSONOptions) {
  assertApiBase()
  const makeRequest = () => fetchWithTimeout(`${API_BASE}${path}`, init, options)
  let res: Response
  try {
    res = await makeRequest()
  } catch (error: any) {
    const kind = classifyApiFailure({ error, response: null })
    throw withApiFailure(error, kind, { status: kind === 'network_unavailable' ? 503 : undefined })
  }

  if (res.status !== 401) return res
  if (!isLocalDevApiBase()) {
    const err = withApiFailure(buildApiError('HTTP 401', { status: 401 }), 'auth_401', { status: 401 })
    redirectToLogin()
    throw err
  }

  await delay(1200)
  const retried = await makeRequest().catch((error: any) => {
    throw withApiFailure(error, classifyApiFailure({ error, response: null }), { status: 503 })
  })
  if (retried.status !== 401) return retried

  if (options?.authSensitive) {
    const healthOk = await probeLocalDevHealth()
    if (!healthOk) {
      throw withApiFailure(buildApiError('开发后端暂未就绪，请稍后重试', { status: 503 }), 'network_unavailable', { status: 503 })
    }
    const recovered = await makeRequest().catch((error: any) => {
      throw withApiFailure(error, classifyApiFailure({ error, response: null }), { status: 503 })
    })
    if (recovered.status !== 401) return recovered
  }

  const err = withApiFailure(buildApiError('HTTP 401', { status: 401 }), 'auth_401', { status: 401 })
  redirectToLogin()
  throw err
}

async function parseErrorResponse(res: Response) {
  const ct = res.headers.get('content-type') || ''
  if (/application\/json/i.test(ct)) {
    const j = await res.json().catch(() => null) as any
    const msg = String(j?.message || j?.error || `HTTP ${res.status}`)
    throw withApiFailure(buildApiError(msg, { ...(j || {}), status: res.status }), classifyApiFailure({ response: res }), { status: res.status })
  }
  const text = await res.text().catch(() => '')
  const msg = text ? text : `HTTP ${res.status}`
  throw withApiFailure(new Error(msg), classifyApiFailure({ response: res }), { status: res.status })
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

export async function getJSON<T>(path: string, options?: RequestJSONOptions): Promise<T> {
  const res = await fetchWithDevAuthRecovery(path, { cache: 'no-store', headers: authHeaders() }, options)
  if (!res.ok) await parseErrorResponse(res)
  return res.json() as Promise<T>
}

export async function postJSON<T>(path: string, body: any, options?: RequestJSONOptions): Promise<T> {
  const res = await fetchWithDevAuthRecovery(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) }, options)
  if (!res.ok) await parseErrorResponse(res)
  return res.json() as Promise<T>
}

export async function patchJSON<T>(path: string, body: any, options?: RequestJSONOptions): Promise<T> {
  const res = await fetchWithDevAuthRecovery(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) }, options)
  if (!res.ok) await parseErrorResponse(res)
  return res.json() as Promise<T>
}

export async function putJSON<T>(path: string, body: any, options?: RequestJSONOptions): Promise<T> {
  const res = await fetchWithDevAuthRecovery(path, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) }, options)
  if (!res.ok) await parseErrorResponse(res)
  return res.json() as Promise<T>
}

export async function deleteJSON<T>(path: string, options?: RequestJSONOptions): Promise<T> {
  const res = await fetchWithDevAuthRecovery(path, { method: 'DELETE', headers: { ...authHeaders() } }, options)
  if (!res.ok) await parseErrorResponse(res)
  return res.json() as Promise<T>
}

export const apiList = <T>(resource: string, params?: Record<string, any>, options?: FetchTimeoutOptions) => getJSON<T>(`/crud/${resource}${params ? `?${new URLSearchParams(params as any).toString()}` : ''}`, options)
export const apiCreate = <T>(resource: string, body: any, options?: FetchTimeoutOptions) => postJSON<T>(`/crud/${resource}`, body, options)
export const apiUpdate = <T>(resource: string, id: string, body: any, options?: FetchTimeoutOptions) => patchJSON<T>(`/crud/${resource}/${id}`, body, options)
export const apiDelete = <T>(resource: string, id: string, options?: FetchTimeoutOptions) => deleteJSON<T>(`/crud/${resource}/${id}`, options)
