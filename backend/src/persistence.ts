import fs from 'fs'
import path from 'path'

type RP = { role_id: string; permission_code: string }
type Role = { id: string; name: string; description?: string }

const dataDir = path.resolve(process.cwd(), 'data')
const rpFile = path.join(dataDir, 'role-permissions.json')
const rolesFile = path.join(dataDir, 'roles.json')

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

export function loadRoles(): Role[] {
  try {
    if (!fs.existsSync(rolesFile)) return []
    const raw = fs.readFileSync(rolesFile, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string')
      .map((x) => ({ id: String(x.id), name: String(x.name), description: typeof x.description === 'string' ? x.description : undefined }))
  } catch {
    return []
  }
}

export function saveRoles(list: Role[]) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir)
    const clean = Array.isArray(list)
      ? list
        .filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string')
        .map(({ id, name, description }) => ({ id, name, description: typeof description === 'string' ? description : undefined }))
      : []
    fs.writeFileSync(rolesFile, JSON.stringify(clean, null, 2), 'utf-8')
  } catch {}
}
