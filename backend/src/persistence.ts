import fs from 'fs'
import path from 'path'

type RP = { role_id: string; permission_code: string }

const dataDir = path.resolve(process.cwd(), 'data')
const rpFile = path.join(dataDir, 'role-permissions.json')

export function loadRolePermissions(): RP[] {
  try {
    if (!fs.existsSync(rpFile)) return []
    const raw = fs.readFileSync(rpFile, 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((x) => x && typeof x.role_id === 'string' && typeof x.permission_code === 'string')
    }
    return []
  } catch {
    return []
  }
}

export function saveRolePermissions(list: RP[]) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir)
    const clean = Array.isArray(list) ? list.map(({ role_id, permission_code }) => ({ role_id, permission_code })) : []
    fs.writeFileSync(rpFile, JSON.stringify(clean, null, 2), 'utf-8')
  } catch {}
}