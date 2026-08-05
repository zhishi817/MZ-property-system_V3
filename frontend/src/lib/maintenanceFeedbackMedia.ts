import { API_BASE, authHeaders } from './api'

function cleanReference(value: unknown) {
  return String(value || '').trim()
}

function privateFeedbackObjectKey(reference: string) {
  const direct = reference.replace(/^\/+/, '')
  if (/^(cleaning|mzapp)\//.test(direct)) return direct
  if (!/^https?:\/\//i.test(reference)) return ''
  try {
    const match = new URL(reference).pathname.match(/\/(cleaning|mzapp)\/.+$/)
    return match ? match[0].replace(/^\/+/, '') : ''
  } catch {
    return ''
  }
}

export function maintenanceFeedbackMediaProxyUrl(referenceValue: unknown) {
  const reference = cleanReference(referenceValue)
  const key = privateFeedbackObjectKey(reference)
  if (!reference || !key || !API_BASE) return ''
  const params = new URLSearchParams({ key })
  return `${API_BASE}/cleaning-app/media/image?${params.toString()}`
}

export async function loadMaintenanceFeedbackMedia(referenceValue: unknown, signal?: AbortSignal) {
  const reference = cleanReference(referenceValue)
  const proxyUrl = maintenanceFeedbackMediaProxyUrl(reference)
  if (!proxyUrl) return { src: reference, revoke: false }
  const response = await fetch(proxyUrl, { headers: authHeaders(), signal })
  if (!response.ok) throw new Error(`maintenance_feedback_media_${response.status}`)
  return { src: URL.createObjectURL(await response.blob()), revoke: true }
}
