export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4001'

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
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export async function postJSON<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}
