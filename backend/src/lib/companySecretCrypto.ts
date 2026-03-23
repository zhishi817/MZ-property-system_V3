import crypto from 'crypto'

function readKey(): Buffer | null {
  const raw = String(process.env.CMS_SECRET_KEY || '').trim()
  if (!raw) return null
  try {
    const b64 = Buffer.from(raw, 'base64')
    if (b64.length === 32) return b64
  } catch {}
  try {
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      const hex = Buffer.from(raw, 'hex')
      if (hex.length === 32) return hex
    }
  } catch {}
  try {
    const utf8 = Buffer.from(raw, 'utf8')
    if (utf8.length === 32) return utf8
  } catch {}
  return null
}

export function hasCompanySecretKey(): boolean {
  return !!readKey()
}

export function encryptCompanySecret(plain: string): string | null {
  const key = readKey()
  if (!key) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(String(plain), 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`
  return `v1:${payload}`
}

export function decryptCompanySecret(enc: string): string | null {
  const key = readKey()
  if (!key) return null
  const s = String(enc || '').trim()
  if (!s.startsWith('v1:')) return null
  const body = s.slice(3)
  const parts = body.split('.')
  if (parts.length !== 3) return null
  const [ivB64, tagB64, ctB64] = parts
  try {
    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const ct = Buffer.from(ctB64, 'base64')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
  } catch {
    return null
  }
}

