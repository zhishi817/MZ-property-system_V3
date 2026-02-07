import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

const endpoint = process.env.R2_ENDPOINT || ''
const accessKeyId = process.env.R2_ACCESS_KEY_ID || ''
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || ''
const bucket = process.env.R2_BUCKET || ''
const publicBase = process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_BASE || ''

export const hasR2 = !!(endpoint && accessKeyId && secretAccessKey && bucket)

export const r2 = hasR2 ? new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } }) : null

export async function r2Upload(key: string, contentType: string, body: Buffer) {
  if (!hasR2 || !r2) throw new Error('R2 not configured')
  await r2.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }))
  const pb = (publicBase || '').replace(/\/$/, '')
  // If publicBase already contains the bucket path, strip it; Cloudflare R2 public host is per-bucket
  const cleaned = pb && /\.r2\.dev($|\/)/.test(pb)
    ? pb.replace(new RegExp(`/${bucket}$`), '')
    : pb
  const base = cleaned || `${endpoint.replace(/\/$/, '')}/${bucket}`
  return `${base}/${key}`
}

export function r2Status() {
  const missing: string[] = []
  if (!endpoint) missing.push('R2_ENDPOINT')
  if (!accessKeyId) missing.push('R2_ACCESS_KEY_ID')
  if (!secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY')
  if (!bucket) missing.push('R2_BUCKET')
  return { hasR2, endpoint, bucket, publicBase, missing }
}

function computePublicBase(): string {
  const pb = (publicBase || '').replace(/\/$/, '')
  const cleaned = pb && /\.r2\.dev($|\/)/.test(pb)
    ? pb.replace(new RegExp(`/${bucket}$`), '')
    : pb
  return cleaned || `${endpoint.replace(/\/$/, '')}/${bucket}`
}

export function r2KeyFromUrl(url: string): string | null {
  try {
    if (!hasR2) return null
    const clean = String(url || '').trim().replace(/\?[^#]*$/, '')
    if (!clean) return null
    try {
      const u = new URL(clean)
      const host = String(u.hostname || '').toLowerCase()
      if (host.endsWith('.r2.dev')) {
        const key = String(u.pathname || '').replace(/^\//, '')
        return key || null
      }
    } catch {}
    const base1 = computePublicBase()
    const base2 = `${endpoint.replace(/\/$/, '')}/${bucket}`
    if (clean.startsWith(base1 + '/')) return clean.slice(base1.length + 1) || null
    if (clean.startsWith(base2 + '/')) return clean.slice(base2.length + 1) || null
    return null
  } catch {
    return null
  }
}

async function streamToBuffer(body: any): Promise<Buffer> {
  if (!body) return Buffer.from([])
  if (typeof body.transformToByteArray === 'function') {
    const arr = await body.transformToByteArray()
    return Buffer.from(arr)
  }
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    body.on('data', (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    body.on('end', () => resolve())
    body.on('error', (e: any) => reject(e))
  })
  return Buffer.concat(chunks)
}

export async function r2GetObjectByKey(key: string): Promise<{ body: Buffer; contentType: string; cacheControl?: string; etag?: string } | null> {
  try {
    if (!hasR2 || !r2) return null
    const resp: any = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const body = await streamToBuffer(resp?.Body)
    const contentType = String(resp?.ContentType || 'application/octet-stream')
    const cacheControl = resp?.CacheControl ? String(resp.CacheControl) : undefined
    const etag = resp?.ETag ? String(resp.ETag).replace(/"/g, '') : undefined
    return { body, contentType, cacheControl, etag }
  } catch {
    return null
  }
}

export async function r2DeleteByUrl(url: string): Promise<boolean> {
  try {
    if (!hasR2 || !r2) return false
    const clean = String(url || '').replace(/\?[^#]*$/, '')
    const base1 = computePublicBase()
    const base2 = `${endpoint.replace(/\/$/, '')}/${bucket}`
    let key = ''
    if (clean.startsWith(base1 + '/')) key = clean.slice(base1.length + 1)
    else if (clean.startsWith(base2 + '/')) key = clean.slice(base2.length + 1)
    else return false
    if (!key) return false
    await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch {
    return false
  }
}
