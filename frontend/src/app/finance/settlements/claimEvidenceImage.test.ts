import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadPersonnelClaimEvidenceObjectUrl,
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
})
