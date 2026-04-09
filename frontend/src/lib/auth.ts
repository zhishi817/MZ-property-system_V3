import { getJSON } from './api'

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
  const arr = await getJSON<any>('/rbac/my-permissions', { authSensitive: true, timeoutMs: 5000 })
  return Array.isArray(arr) ? arr : []
}
export async function preloadRolePerms(): Promise<void> {
  const role = getRole() || ''
  const list = await fetchMyPerms()
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
