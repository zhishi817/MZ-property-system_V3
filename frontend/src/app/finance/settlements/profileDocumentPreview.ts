import { getBlob } from '../../../lib/api'

export type ProfileDocumentType = 'photo_id' | 'visa_document'

export type ProfileDocumentPreview = {
  url: string
  contentType: string
}

export function profileDocumentFailureMessage(error: unknown) {
  const status = Number((error as any)?.status || 0)
  const code = String((error as any)?.code || '').trim()
  if (status === 401) return '登录已失效，请重新登录'
  if (status === 403) return '无权限查看该资料'
  if (status === 404 || code === 'profile_document_not_found') return '资料文件不存在'
  if (status === 503 || code === 'profile_document_storage_unavailable') return '资料存储暂时不可用'
  return '资料读取失败，请稍后重试'
}

export async function loadProfileDocumentPreview(userId: string, type: ProfileDocumentType) {
  const id = String(userId || '').trim()
  if (!id) throw new Error('user_id_required')
  const blob = await getBlob(
    `/finance/settlements/profiles/${encodeURIComponent(id)}/profile-documents/${type}`,
    { authSensitive: true },
  )
  if (!blob.size) throw new Error('profile_document_empty')
  return {
    url: URL.createObjectURL(blob),
    contentType: blob.type || 'application/octet-stream',
  } satisfies ProfileDocumentPreview
}

export function releaseProfileDocumentPreview(preview: ProfileDocumentPreview | null) {
  if (preview?.url?.startsWith('blob:')) URL.revokeObjectURL(preview.url)
}
