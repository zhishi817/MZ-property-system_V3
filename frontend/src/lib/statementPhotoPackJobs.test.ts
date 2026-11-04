import { describe, expect, it } from 'vitest'
import { normalizePhotoPackError } from './statementPhotoPackJobs'

describe('normalizePhotoPackError', () => {
  it('distinguishes missing API base from media failures', () => {
    expect(normalizePhotoPackError('missing valid api base', { last_error_code: 'PHOTO_ASSETS_UNREACHABLE' }))
      .toContain('照片资源地址配置无效')
  })

  it('reports storage unavailable separately from object missing', () => {
    expect(normalizePhotoPackError(
      'photo pack render empty: no embeddable images (r2_unavailable=4)',
      { last_error_code: 'PHOTO_PACK_RENDER_EMPTY' },
    )).toContain('照片存储服务当前不可用')
    expect(normalizePhotoPackError(
      'photo pack render empty: no embeddable images (r2_not_found=4)',
      { last_error_code: 'PHOTO_PACK_RENDER_EMPTY' },
    )).toContain('照片对象不存在')
    const mixed = normalizePhotoPackError(
      'photo pack render empty: no embeddable images (r2_not_found=2,r2_unavailable=2)',
      { last_error_code: 'PHOTO_PACK_RENDER_EMPTY' },
    )
    expect(mixed).toContain('照片存储服务当前不可用')
    expect(mixed).toContain('照片对象不存在')
  })

  it('reports damaged images and rejected associations without exposing references', () => {
    expect(normalizePhotoPackError(
      'photo pack render empty: no embeddable images (image_decode_failed=2)',
      { last_error_code: 'PHOTO_PACK_RENDER_EMPTY' },
    )).toContain('照片已损坏或格式无法识别')
    expect(normalizePhotoPackError(
      'photo pack render empty: no embeddable images (unassociated_source=1)',
      { last_error_code: 'PHOTO_PACK_RENDER_EMPTY' },
    )).toContain('不属于当前房源记录')
  })
})
