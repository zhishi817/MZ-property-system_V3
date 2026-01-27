function decodeJwtPayload(token: string | null): any {
  try {
    if (!token || token.indexOf('.') === -1) return null
    const p = token.split('.')[1]
    const norm = p.replace(/-/g, '+').replace(/_/g, '/')
    const pad = norm + '==='.slice((norm.length + 3) % 4)
    const json = atob(pad)
    return JSON.parse(json)
  } catch { return null }
}

export function getRole(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const m = document.cookie.match(/(?:^|;\s*)auth=([^;]*)/)
    const token = m ? decodeURIComponent(m[1]) : null
    const payload = decodeJwtPayload(token)
    const roleFromToken = payload?.role || null
    if (roleFromToken) {
      try { localStorage.setItem('role', roleFromToken) } catch {}
      return roleFromToken
    }
  } catch {}
  const stored = localStorage.getItem('role') || sessionStorage.getItem('role')
  return stored || null
}

let cachedPerms: Record<string, string[]> = {}
async function fetchMyPerms(): Promise<string[]> {
  try {
    const m = typeof document !== 'undefined' ? (document.cookie.match(/(?:^|;\s*)auth=([^;]*)/) || []) : []
    const token = m[1] ? decodeURIComponent(m[1]) : (typeof localStorage !== 'undefined' ? (localStorage.getItem('token') || '') : '')
    const res = await fetch(`${API_BASE}/rbac/my-permissions`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
    if (res.ok) {
      const arr = await res.json().catch(() => [])
      return Array.isArray(arr) ? arr : []
    }
  } catch {}
  return []
}
export async function preloadRolePerms(): Promise<void> {
  const role = getRole() || ''
  const list = await fetchMyPerms().catch(() => [])
  cachedPerms[role] = list
  try { localStorage.setItem(`perms:${role}`, JSON.stringify(list)) } catch {}
}

export function hasPerm(code: string): boolean {
  const role = getRole() || ''
  if (role === 'admin') return true
  const mem = cachedPerms[role]
  let list: string[] = Array.isArray(mem) ? mem : []
  if (typeof localStorage !== 'undefined') {
    try {
      const s = localStorage.getItem(`perms:${role}`) || '[]'
      const latest = JSON.parse(s)
      if (Array.isArray(latest) && latest.length) list = latest
    } catch {}
  }
  return Array.isArray(list) ? list.includes(code) : false
}
import { API_BASE } from './api'
