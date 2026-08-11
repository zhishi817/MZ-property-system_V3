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

function currentR2PublicBase() {
  const bucket = cleanText(process.env.R2_BUCKET)
  const publicBase = cleanText(process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_BASE).replace(/\/+$/, '')
  return publicBase && /\.r2\.dev($|\/)/i.test(publicBase)
    ? publicBase.replace(new RegExp(`/${bucket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '')
    : publicBase
}

function currentR2UploadBases() {
  const endpoint = cleanText(process.env.R2_ENDPOINT).replace(/\/+$/, '')
  const bucket = cleanText(process.env.R2_BUCKET)
  const normalizedPublicBase = currentR2PublicBase()
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

function normalizeHistoricalOfflineTaskPhotoKey(value: unknown) {
  const key = cleanText(value).replace(/^\/+/, '')
  if (!key || key.length > 1000 || key.includes('..') || key.includes('\\') || /[?#]/.test(key)) return null
  return key
}

function currentHistoricalOfflineTaskPhotoKeyFromUrl(value: unknown) {
  const raw = cleanText(value)
  if (!/^https:\/\//i.test(raw)) return null
  // URL() normalizes `..` segments. Reject them before parsing so this narrow
  // historical compatibility path cannot escape its recorded object key.
  if (/(?:\/|%2f)(?:\.|%2e){1,2}(?=\/|%2f|$)/i.test(raw)) return null
  const publicBase = currentR2PublicBase()
  if (!publicBase) return null
  try {
    const url = new URL(raw)
    const base = new URL(publicBase)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null
    if (base.protocol !== 'https:' || base.username || base.password || base.port || base.search || base.hash) return null
    if (url.origin !== base.origin) return null
    const basePath = base.pathname.replace(/\/+$/, '')
    const key = basePath
      ? url.pathname.startsWith(`${basePath}/`) ? url.pathname.slice(basePath.length + 1) : ''
      : url.pathname.slice(1)
    return normalizeHistoricalOfflineTaskPhotoKey(key)
  } catch {
    return null
  }
}

export function currentOfflineTaskPhotoKeyFromReference(value: unknown) {
  return currentMzappTaskPhotoKeyFromReference(value) || currentHistoricalOfflineTaskPhotoKeyFromUrl(value)
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

/**
 * A pre-canonical offline task row may hold a current-public-base object URL
 * whose key is outside `mzapp/`. It is only a candidate for the task-media
 * proxy; callers must still prove exact row association and authorization.
 */
export function offlineTaskPhotoReferenceVariants(value: unknown) {
  const raw = cleanText(value)
  const mzappVariants = mzappTaskPhotoReferenceVariants(raw)
  if (mzappVariants.length) return mzappVariants
  return currentHistoricalOfflineTaskPhotoKeyFromUrl(raw) ? [raw] : []
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
