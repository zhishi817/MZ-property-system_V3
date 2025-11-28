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

const rolePerms: Record<string, string[]> = {
  admin: ['property.write','order.manage','order.sync','keyset.manage','key.flow','cleaning.schedule.manage','cleaning.task.assign','finance.payout','inventory.move','landlord.manage'],
  ops: ['property.write','order.manage','key.flow','cleaning.task.assign','landlord.manage'],
  field: ['cleaning.task.assign'],
  customer_service: ['property.write','order.manage','finance.tx.write'],
  cleaning_manager: ['cleaning.schedule.manage','cleaning.task.assign'],
  cleaner_inspector: [],
  finance_staff: ['finance.payout','finance.tx.write','landlord.manage','property.write'],
  inventory_manager: ['inventory.move','keyset.manage','key.flow'],
  maintenance_staff: [],
}

export function hasPerm(code: string): boolean {
  const role = getRole() || ''
  if (role === 'admin') return true
  const list = rolePerms[role] || []
  return list.includes(code)
}
