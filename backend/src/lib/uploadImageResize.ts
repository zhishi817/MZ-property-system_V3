import path from 'path'
import sharp from 'sharp'

export type UploadImageResult = {
  buffer: Buffer
  contentType: string
  ext: string
}

function extFromContentType(ct: string): string {
  const s = String(ct || '').toLowerCase()
  if (s.includes('jpeg') || s.includes('jpg')) return '.jpg'
  if (s.includes('png')) return '.png'
  if (s.includes('webp')) return '.webp'
  if (s.includes('gif')) return '.gif'
  if (s.includes('svg')) return '.svg'
  return ''
}

export async function resizeUploadImage(input: {
  buffer: Buffer
  contentType?: string
  originalName?: string
}): Promise<UploadImageResult> {
  const buf = input.buffer
  const ct0 = String(input.contentType || '').trim() || 'application/octet-stream'
  const name = String(input.originalName || '').trim()
  const origExt = (path.extname(name) || extFromContentType(ct0) || '').toLowerCase()

  const isImage = ct0.toLowerCase().startsWith('image/')
  if (!isImage) return { buffer: buf, contentType: ct0, ext: origExt }
  if (ct0.toLowerCase().includes('gif') || ct0.toLowerCase().includes('svg')) return { buffer: buf, contentType: ct0, ext: origExt }

  const maxInputBytes = Math.max(1 * 1024 * 1024, Math.min(40 * 1024 * 1024, Number(process.env.UPLOAD_IMAGE_MAX_BYTES || 15 * 1024 * 1024)))
  if (buf.length > maxInputBytes) return { buffer: buf, contentType: ct0, ext: origExt }

  const maxEdge = Math.max(1200, Math.min(5000, Number(process.env.UPLOAD_IMAGE_MAX_EDGE || 2400)))
  const jpegQ = Math.max(80, Math.min(95, Number(process.env.UPLOAD_JPEG_QUALITY || 92)))

  let meta: sharp.Metadata | null = null
  try {
    meta = await sharp(buf, { failOnError: false }).metadata()
  } catch {
    return { buffer: buf, contentType: ct0, ext: origExt }
  }
  const w0 = Number(meta?.width || 0)
  const h0 = Number(meta?.height || 0)
  if (!w0 || !h0) return { buffer: buf, contentType: ct0, ext: origExt }
  if (Math.max(w0, h0) <= maxEdge) return { buffer: buf, contentType: ct0, ext: origExt }

  const fmt = String(meta?.format || '').toLowerCase()
  const outFmt = (fmt === 'png' || fmt === 'webp' || fmt === 'jpeg' || fmt === 'jpg') ? (fmt === 'jpg' ? 'jpeg' : fmt) : 'jpeg'
  const pipeline = sharp(buf, { failOnError: false }).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })

  try {
    if (outFmt === 'png') {
      const out = await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
      return { buffer: out, contentType: 'image/png', ext: origExt || '.png' }
    }
    if (outFmt === 'webp') {
      const out = await pipeline.webp({ quality: jpegQ }).toBuffer()
      return { buffer: out, contentType: 'image/webp', ext: origExt || '.webp' }
    }
    const out = await pipeline.jpeg({ quality: jpegQ, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer()
    return { buffer: out, contentType: 'image/jpeg', ext: (origExt === '.jpeg' || origExt === '.jpg') ? origExt : '.jpg' }
  } catch {
    return { buffer: buf, contentType: ct0, ext: origExt }
  }
}

