export const R2_IMAGE_ALLOWED_PREFIXES = [
  'invoice-company-logos/',
  'deep-cleaning/',
  'deep-cleaning-upload/',
  'maintenance/',
]

export function isAllowedR2ImageKey(key: string): boolean {
  const k = String(key || '')
  return R2_IMAGE_ALLOWED_PREFIXES.some((p) => k.startsWith(p))
}

