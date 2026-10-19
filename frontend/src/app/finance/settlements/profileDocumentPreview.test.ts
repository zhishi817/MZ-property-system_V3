import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBlob } from '../../../lib/api'
import {
  loadProfileDocumentPreview,
  profileDocumentFailureMessage,
  releaseProfileDocumentPreview,
} from './profileDocumentPreview'

vi.mock('../../../lib/api', () => ({ getBlob: vi.fn() }))

describe('profile document preview', () => {
  afterEach(() => vi.restoreAllMocks())

  it('loads through the authenticated relative endpoint and creates an object URL', async () => {
    const blob = new Blob(['identity-document'], { type: 'image/jpeg' })
    vi.mocked(getBlob).mockResolvedValue(blob)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-preview')

    await expect(loadProfileDocumentPreview('user / 1', 'photo_id')).resolves.toEqual({
      url: 'blob:private-preview',
      contentType: 'image/jpeg',
    })
    expect(getBlob).toHaveBeenCalledWith(
      '/finance/settlements/profiles/user%20%2F%201/profile-documents/photo_id',
      { authSensitive: true },
    )
    expect(createObjectURL).toHaveBeenCalledWith(blob)
  })

  it('revokes only generated blob URLs', () => {
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    releaseProfileDocumentPreview({ url: 'blob:private-preview', contentType: 'application/pdf' })
    releaseProfileDocumentPreview({ url: 'https://example.test/file', contentType: 'application/pdf' })
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:private-preview')
  })

  it('maps permission, missing and storage failures without exposing server details', () => {
    expect(profileDocumentFailureMessage({ status: 403 })).toBe('无权限查看该资料')
    expect(profileDocumentFailureMessage({ code: 'profile_document_not_found' })).toBe('资料文件不存在')
    expect(profileDocumentFailureMessage({ code: 'profile_document_storage_unavailable' })).toBe('资料存储暂时不可用')
  })
})
