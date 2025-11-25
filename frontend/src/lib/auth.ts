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
  const stored = localStorage.getItem('role') || sessionStorage.getItem('role')
  if (stored) return stored
  try {
    const m = document.cookie.match(/(?:^|;\s*)auth=([^;]*)/)
    const token = m ? decodeURIComponent(m[1]) : null
    const payload = decodeJwtPayload(token)
    const role = payload?.role || null
    if (role) try { localStorage.setItem('role', role) } catch {}
    return role
  } catch { return null }
}

export function hasPerm(code: string): boolean {
  const role = getRole() || ''
  if (role === 'admin') return true
  try {
    const raw = (typeof window !== 'undefined') ? (localStorage.getItem('perms') || '[]') : '[]'
    const list = JSON.parse(raw || '[]') as string[]
    return Array.isArray(list) ? list.includes(code) : false
  } catch { return false }
}

export async function preloadPerms(): Promise<void> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000'}/rbac/my-permissions`, { headers: { Authorization: (() => { try { const t = localStorage.getItem('token') || sessionStorage.getItem('token'); return t ? `Bearer ${t}` : '' } catch { return '' } })() } })
    if (res.ok) {
      const arr = await res.json()
      try { localStorage.setItem('perms', JSON.stringify(arr || [])) } catch {}
    }
  } catch {}
}