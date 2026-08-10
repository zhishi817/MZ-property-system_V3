import crypto from 'crypto'

const MZAPP_TASK_PHOTO_KEY_PREFIX = 'mzapp/'
const STORAGE_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

export function normalizeMzappTaskPhotoKey(value: unknown) {
  const key = cleanText(value).replace(/^\/+/, '')
  if (!key.startsWith(MZAPP_TASK_PHOTO_KEY_PREFIX)) return null
  if (key.length > 1000 || key.includes('..') || key.includes('\\') || /[?#]/.test(key)) return null
  return key
}

function currentStorageNamespace() {
  const configured = cleanText(process.env.R2_STORAGE_NAMESPACE).toLowerCase()
  if (configured) return STORAGE_NAMESPACE_PATTERN.test(configured) ? configured : null
  const bucket = cleanText(process.env.R2_BUCKET)
  if (!bucket) return null
  return `bucket-${crypto.createHash('sha256').update(bucket).digest('hex')}`
}

function currentR2UploadBases() {
  const endpoint = cleanText(process.env.R2_ENDPOINT).replace(/\/+$/, '')
  const bucket = cleanText(process.env.R2_BUCKET)
  const publicBase = cleanText(process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_BASE).replace(/\/+$/, '')
  const normalizedPublicBase = publicBase && /\.r2\.dev($|\/)/i.test(publicBase)
    ? publicBase.replace(new RegExp(`/${bucket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '')
    : publicBase
  return [normalizedPublicBase, endpoint && bucket ? `${endpoint}/${bucket}` : ''].filter(Boolean)
}

function currentMzappKeyFromUrl(value: unknown) {
  const raw = cleanText(value).replace(/[?#].*$/, '')
  if (!/^https?:\/\//i.test(raw)) return null
  for (const base of currentR2UploadBases()) {
    if (!raw.startsWith(`${base}/`)) continue
    return normalizeMzappTaskPhotoKey(raw.slice(base.length + 1))
  }
  return null
}

export function createMzappTaskPhotoRemoteReference(key: unknown) {
  const normalizedKey = normalizeMzappTaskPhotoKey(key)
  const namespace = currentStorageNamespace()
  if (!normalizedKey || !namespace) return null
  return `r2://${namespace}/${normalizedKey}`
}

function isCurrentMzappTaskPhotoRemoteReference(value: unknown) {
  const raw = cleanText(value)
  const match = /^r2:\/\/([a-z0-9][a-z0-9._-]{0,119})\/(mzapp\/.*)$/i.exec(raw)
  if (!match) return null
  const namespace = currentStorageNamespace()
  const key = normalizeMzappTaskPhotoKey(match[2])
  if (!namespace || !key || match[1].toLowerCase() !== namespace) return null
  return `r2://${namespace}/${key}`
}

export function currentMzappTaskPhotoKeyFromReference(value: unknown) {
  const canonical = isCurrentMzappTaskPhotoRemoteReference(value)
  if (canonical) {
    const match = /^r2:\/\/[a-z0-9][a-z0-9._-]{0,119}\/(mzapp\/.*)$/i.exec(canonical)
    return match ? normalizeMzappTaskPhotoKey(match[1]) : null
  }
  return currentMzappKeyFromUrl(value)
}

export function isLegacyMzappTaskPhotoPublicUrl(value: unknown) {
  const raw = cleanText(value)
  if (!/^https:\/\//i.test(raw)) return false
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return false
    if (!url.hostname.toLowerCase().endsWith('.r2.dev')) return false
    return Boolean(normalizeMzappTaskPhotoKey(url.pathname))
  } catch {
    return false
  }
}

export function mzappTaskPhotoReferenceVariants(value: unknown) {
  const raw = cleanText(value)
  if (!raw) return []
  const currentKey = currentMzappTaskPhotoKeyFromReference(raw)
  const rawKey = normalizeMzappTaskPhotoKey(raw)
  const legacy = isLegacyMzappTaskPhotoPublicUrl(raw)
  let key = currentKey || rawKey
  if (!key && legacy) {
    try {
      key = normalizeMzappTaskPhotoKey(new URL(raw).pathname)
    } catch {}
  }
  if (!currentKey && !rawKey && !legacy) return []
  return Array.from(new Set([raw, key, key ? createMzappTaskPhotoRemoteReference(key) : null].filter((reference): reference is string => Boolean(reference))))
}

function isLegacyLocalUploadPath(value: unknown) {
  return /^\/uploads\/[A-Za-z0-9._-]{1,240}$/.test(cleanText(value))
}

export function canonicalizeMzappTaskPhotoReference(value: unknown, existingReferences: readonly string[] = []) {
  const raw = cleanText(value)
  if (!raw) return null
  if (existingReferences.includes(raw)) return raw
  return isCurrentMzappTaskPhotoRemoteReference(raw)
    || createMzappTaskPhotoRemoteReference(currentMzappKeyFromUrl(raw))
    || (isLegacyLocalUploadPath(raw) ? raw : null)
}
