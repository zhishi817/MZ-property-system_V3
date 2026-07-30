import path from 'path'
import sharp from 'sharp'

export const CLEANING_IMAGE_FORMAT_ERROR = 'IMAGE_FORMAT_UNSUPPORTED'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.avif', '.tif', '.tiff'])

function normalizedContentType(value: string) {
  return String(value || '').trim().toLowerCase().split(';', 1)[0] || 'application/octet-stream'
}

export function isImageUploadCandidate(contentType: string, originalName: string) {
  const mime = normalizedContentType(contentType)
  const ext = path.extname(String(originalName || '')).toLowerCase()
  return mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)
}

function imageFormatError() {
  const error: any = new Error('image_format_unsupported')
  error.code = CLEANING_IMAGE_FORMAT_ERROR
  return error
}

export async function encodeCleaningImageToJpeg(buffer: Buffer, options?: { maxEdge?: number; quality?: number }) {
  try {
    const maxEdge = Math.max(480, Math.trunc(Number(options?.maxEdge || 2400) || 2400))
    const quality = Math.min(95, Math.max(60, Math.trunc(Number(options?.quality || 88) || 88)))
    const output = await sharp(buffer, { failOnError: true })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer()
    if (!output.length) throw imageFormatError()
    return output
  } catch (error: any) {
    if (error?.code === CLEANING_IMAGE_FORMAT_ERROR) throw error
    throw imageFormatError()
  }
}

export async function normalizeCleaningImageUpload(params: {
  buffer: Buffer
  contentType: string
  originalName: string
}) {
  const contentType = normalizedContentType(params.contentType)
  const isImage = isImageUploadCandidate(contentType, params.originalName)
  if (!isImage || contentType === 'image/svg+xml' || contentType === 'image/gif') {
    return {
      buffer: params.buffer,
      contentType,
      extension: path.extname(String(params.originalName || '')).toLowerCase(),
      isImage,
      normalized: false,
    }
  }
  const buffer = await encodeCleaningImageToJpeg(params.buffer)
  return {
    buffer,
    contentType: 'image/jpeg',
    extension: '.jpg',
    isImage: true,
    normalized: true,
  }
}
