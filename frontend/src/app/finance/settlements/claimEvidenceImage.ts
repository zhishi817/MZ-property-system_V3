import { API_BASE, authHeaders } from '../../../lib/api'

export type PersonnelClaimEvidenceImageFailure =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'storage_unavailable'
  | 'empty'
  | 'unavailable'

export class PersonnelClaimEvidenceImageError extends Error {
  failure: PersonnelClaimEvidenceImageFailure
  status: number | null

  constructor(failure: PersonnelClaimEvidenceImageFailure, status: number | null = null) {
    super(`claim_evidence_image_${failure}`)
    this.name = 'PersonnelClaimEvidenceImageError'
    this.failure = failure
    this.status = status
  }
}

function failureFromResponse(status: number, code: string): PersonnelClaimEvidenceImageFailure {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (code === 'claim_evidence_storage_unavailable') return 'storage_unavailable'
  return 'unavailable'
}

async function readResponseCode(response: Response) {
  try {
    const payload = await response.json()
    return String(payload?.code || '').trim()
  } catch {
    return ''
  }
}

export function personnelClaimEvidenceFailureMessage(error: unknown) {
  const failure = error instanceof PersonnelClaimEvidenceImageError ? error.failure : 'unavailable'
  if (failure === 'unauthorized') return '登录已失效，请重新登录'
  if (failure === 'forbidden') return '无权限查看照片'
  if (failure === 'not_found') return '照片文件不存在'
  if (failure === 'storage_unavailable') return '照片存储暂时不可用'
  if (failure === 'empty') return '照片内容为空'
  return '照片读取失败，请稍后重试'
}

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
  if (!response.ok) {
    const code = await readResponseCode(response)
    throw new PersonnelClaimEvidenceImageError(failureFromResponse(response.status, code), response.status)
  }
  const blob = await response.blob()
  if (!blob.size) throw new PersonnelClaimEvidenceImageError('empty', response.status)
  return URL.createObjectURL(blob)
}

export function releasePersonnelClaimEvidenceObjectUrls(urls: Record<string, string>) {
  for (const url of Object.values(urls)) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
}
