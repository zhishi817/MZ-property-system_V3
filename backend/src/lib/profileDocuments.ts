import { r2KeyFromUrl } from '../r2'

export const PROFILE_DOCUMENT_FIELDS = {
  photo_id: 'photo_id_url',
  visa_document: 'visa_document_url',
} as const

export type ProfileDocumentType = keyof typeof PROFILE_DOCUMENT_FIELDS

export function profileDocumentType(value: unknown): ProfileDocumentType | null {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'photo_id' || normalized === 'visa_document' ? normalized : null
}

export function profileDocumentStorageKey(value: unknown): string | null {
  const reference = String(value || '').trim()
  if (!reference) return null
  if (reference.startsWith('mzapp/')) return reference
  return r2KeyFromUrl(reference)
}

export function ownedProfileDocumentKey(userId: string, type: ProfileDocumentType) {
  return `mzapp/profile-documents/${encodeURIComponent(userId)}/${type}/`
}

export function isOwnedProfileDocumentReference(value: unknown, userId: string, type: ProfileDocumentType) {
  const key = profileDocumentStorageKey(value)
  return !!key && key.startsWith(ownedProfileDocumentKey(userId, type))
}

export function ownedProfileDocumentStorageKey(value: unknown, userId: string, type: ProfileDocumentType) {
  const key = profileDocumentStorageKey(value)
  return key && isOwnedProfileDocumentReference(value, userId, type) ? key : null
}

export function readableProfileDocumentStorageKey(value: unknown, userId: string, type: ProfileDocumentType) {
  const key = profileDocumentStorageKey(value)
  if (!key || !key.startsWith('mzapp/')) return null
  if (key.startsWith('mzapp/profile-documents/') && !isOwnedProfileDocumentReference(value, userId, type)) return null
  return key
}
