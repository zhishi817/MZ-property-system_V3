import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadPersonnelClaimEvidenceObjectUrl,
  personnelClaimEvidenceFailureMessage,
  personnelClaimEvidenceImagePath,
  releasePersonnelClaimEvidenceObjectUrls,
} from './claimEvidenceImage'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('personnel claim evidence image', () => {
  it('uses the authenticated claim-and-evidence route without a storage key', () => {
    const path = personnelClaimEvidenceImagePath('claim/1', 'evidence 1')
    expect(path).toContain('/finance/settlements/claims/claim%2F1/evidence/evidence%201/image')
    expect(path).not.toContain('mzapp/personnel-claims')
  })

  it('creates and releases a private temporary object URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:claim-proof')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const fetcher = vi.fn(async () => new Response(new Blob(['proof'], { type: 'image/jpeg' }), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    })) as any
    const objectUrl = await loadPersonnelClaimEvidenceObjectUrl('claim-1', 'evidence-1', fetcher)
    expect(objectUrl).toBe('blob:claim-proof')
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/claims/claim-1/evidence/evidence-1/image'), expect.objectContaining({ cache: 'no-store' }))
    expect(create).toHaveBeenCalledOnce()
    releasePersonnelClaimEvidenceObjectUrls({ proof: objectUrl, public: 'https://example.test/image.jpg' })
    expect(revoke).toHaveBeenCalledWith('blob:claim-proof')
  })

  it.each([
    [401, 'unauthorized', '登录已失效，请重新登录'],
    [403, 'forbidden_media', '无权限查看照片'],
    [404, 'claim_evidence_file_not_found', '照片文件不存在'],
    [503, 'claim_evidence_storage_unavailable', '照片存储暂时不可用'],
    [503, 'personnel_settlement_profile_failed', '照片读取失败，请稍后重试'],
    [500, 'personnel_settlement_profile_failed', '照片读取失败，请稍后重试'],
  ])('keeps HTTP %s failures distinct', async (status, code, expectedMessage) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as any
    let failure: unknown
    try {
      await loadPersonnelClaimEvidenceObjectUrl('claim-1', 'evidence-1', fetcher)
    } catch (error) {
      failure = error
    }
    expect(personnelClaimEvidenceFailureMessage(failure)).toBe(expectedMessage)
  })

  it('reports an empty successful response separately', async () => {
    const fetcher = vi.fn(async () => new Response(new Blob([]), { status: 200 })) as any
    let failure: unknown
    try {
      await loadPersonnelClaimEvidenceObjectUrl('claim-1', 'evidence-1', fetcher)
    } catch (error) {
      failure = error
    }
    expect(personnelClaimEvidenceFailureMessage(failure)).toBe('照片内容为空')
  })
})
