const API_BASE_ENV = process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_DEV || process.env.NEXT_PUBLIC_API_BASE
if (!API_BASE_ENV) throw new Error('Missing NEXT_PUBLIC_API_BASE_URL')
export const API_BASE = API_BASE_ENV

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

export async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', headers: authHeaders() })
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new Error('HTTP 401')
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export async function postJSON<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export async function patchJSON<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export async function deleteJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: { ...authHeaders() } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export const apiList = <T>(resource: string, params?: Record<string, any>) => getJSON<T>(`/crud/${resource}${params ? `?${new URLSearchParams(params as any).toString()}` : ''}`)
export const apiCreate = <T>(resource: string, body: any) => postJSON<T>(`/crud/${resource}`, body)
export const apiUpdate = <T>(resource: string, id: string, body: any) => patchJSON<T>(`/crud/${resource}/${id}`, body)
export const apiDelete = <T>(resource: string, id: string) => deleteJSON<T>(`/crud/${resource}/${id}`)
