export function getRole(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('role') || sessionStorage.getItem('role')
}

const rolePerms: Record<string, string[]> = {
  admin: ['property.write','order.manage','order.sync','keyset.manage','key.flow','cleaning.schedule.manage','cleaning.task.assign','finance.payout','inventory.move','landlord.manage'],
  ops: ['property.write','order.manage','key.flow','cleaning.task.assign','landlord.manage'],
  field: ['cleaning.task.assign'],
}

export function hasPerm(code: string): boolean {
  const role = getRole() || ''
  const list = rolePerms[role] || []
  return list.includes(code)
}