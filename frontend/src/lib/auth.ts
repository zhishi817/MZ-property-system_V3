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

const rolePerms: Record<string, string[]> = {
  admin: ['property.write','order.manage','order.sync','keyset.manage','key.flow','cleaning.schedule.manage','cleaning.task.assign','finance.payout','inventory.move','landlord.manage'],
  ops: ['property.write','order.manage','key.flow','cleaning.task.assign','landlord.manage'],
  field: ['cleaning.task.assign'],
}

export function hasPerm(code: string): boolean {
  const role = getRole() || ''
  if (role === 'admin') return true
  const list = rolePerms[role] || []
  return list.includes(code)
}