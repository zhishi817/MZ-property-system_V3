import { r2KeyFromUrl, type R2ObjectSummary } from '../r2'

export const R2_MEDIA_PREFIXES = [
  'cleaning/',
  'deep-cleaning/',
  'deep-cleaning-upload/',
  'deep-cleaning-share/',
  'expenses/',
  'guest-site/',
  'inventory/',
  'invoice-files/',
  'key-items/',
  'landlord-documents/',
  'maintenance/',
  'mzapp/',
  'onboarding/',
  'pdf-jobs/',
  'property-guides/',
] as const

// This list is intentionally empty for durable business media. A prefix can
// be added only after its retention and re-creatability have been confirmed.
export const R2_DEFAULT_TEMPORARY_PREFIXES: readonly string[] = []

const R2_REFERENCE_COLUMN_PATTERN = /(?:url|uri|key|photo|media|file|image|video|attachment|proof|document)/i

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cleanCandidate(value: string) {
  return value
    .trim()
    .replace(/^['"`\s([{]+/, '')
    .replace(/[\s'"`\])},;]+$/, '')
    .split(/[?#]/, 1)[0]
    .replace(/^\/+/, '')
}

export function isKnownR2MediaKey(value: string) {
  return R2_MEDIA_PREFIXES.some((prefix) => value.startsWith(prefix))
}

export function normalizeR2Reference(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const fromUrl = r2KeyFromUrl(raw)
  if (fromUrl && isKnownR2MediaKey(fromUrl)) return fromUrl
  const candidate = cleanCandidate(raw)
  return isKnownR2MediaKey(candidate) ? candidate : null
}

export function extractR2KeysFromValue(value: unknown): string[] {
  const found = new Set<string>()
  const visit = (current: unknown) => {
    if (typeof current === 'string') {
      const direct = normalizeR2Reference(current)
      if (direct) found.add(direct)
      const pattern = new RegExp(`(?:${R2_MEDIA_PREFIXES.map(escapeRegExp).join('|')})[A-Za-z0-9._/-]+`, 'g')
      for (const match of current.match(pattern) || []) {
        const candidate = normalizeR2Reference(match)
        if (candidate) found.add(candidate)
      }
      return
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item)
      return
    }
    if (current && typeof current === 'object') {
      for (const item of Object.values(current as Record<string, unknown>)) visit(item)
    }
  }
  visit(value)
  return Array.from(found)
}

export function isReferenceColumn(columnName: string) {
  return R2_REFERENCE_COLUMN_PATTERN.test(String(columnName || ''))
}

export function parsePrefixList(value: unknown) {
  return Array.from(new Set(String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)))
}

export function isApprovedCleanupPrefix(prefix: string, allowedPrefixes: readonly string[]) {
  const cleanPrefix = String(prefix || '').trim()
  return !!cleanPrefix && allowedPrefixes.some((allowed) => cleanPrefix === allowed)
}

export function isEligibleOrphanObject(
  object: R2ObjectSummary,
  referencedKeys: ReadonlySet<string>,
  options: { nowMs: number; minAgeMs: number },
) {
  if (!isKnownR2MediaKey(object.key)) return false
  if (referencedKeys.has(object.key)) return false
  if (!object.lastModified) return false
  const modifiedMs = new Date(object.lastModified).getTime()
  return Number.isFinite(modifiedMs) && options.nowMs - modifiedMs >= options.minAgeMs
}

export function summarizeR2Objects(objects: readonly R2ObjectSummary[], referencedKeys: ReadonlySet<string>, nowMs: number, minAgeMs: number) {
  const referenced = objects.filter((object) => referencedKeys.has(object.key))
  const orphan = objects.filter((object) => !referencedKeys.has(object.key))
  const eligible = orphan.filter((object) => isEligibleOrphanObject(object, referencedKeys, { nowMs, minAgeMs }))
  const totalBytes = (items: readonly R2ObjectSummary[]) => items.reduce((sum, item) => sum + Math.max(0, Number(item.size || 0)), 0)
  return {
    object_count: objects.length,
    referenced_object_count: referenced.length,
    orphan_object_count: orphan.length,
    orphan_bytes: totalBytes(orphan),
    eligible_orphan_count: eligible.length,
    eligible_orphan_bytes: totalBytes(eligible),
    eligible_orphan_keys: eligible.map((item) => item.key),
  }
}
