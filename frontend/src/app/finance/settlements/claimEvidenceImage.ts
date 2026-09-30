import { API_BASE, authHeaders } from '../../../lib/api'

export function personnelClaimEvidenceImagePath(claimId: string, evidenceId: string) {
  const claim = String(claimId || '').trim()
  const evidence = String(evidenceId || '').trim()
  if (!claim || !evidence) throw new Error('claim_evidence_id_required')
  return `${API_BASE}/finance/settlements/claims/${encodeURIComponent(claim)}/evidence/${encodeURIComponent(evidence)}/image`
}

export async function loadPersonnelClaimEvidenceObjectUrl(
  claimId: string,
  evidenceId: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(personnelClaimEvidenceImagePath(claimId, evidenceId), {
    method: 'GET',
    cache: 'no-store',
    headers: { ...authHeaders(), 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  })
  if (!response.ok) throw new Error(`claim_evidence_image_failed_${response.status}`)
  const blob = await response.blob()
  if (!blob.size) throw new Error('claim_evidence_image_empty')
  return URL.createObjectURL(blob)
}

export function releasePersonnelClaimEvidenceObjectUrls(urls: Record<string, string>) {
  for (const url of Object.values(urls)) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
}
