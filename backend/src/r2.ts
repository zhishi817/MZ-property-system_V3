import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'

const endpoint = process.env.R2_ENDPOINT || ''
const accessKeyId = process.env.R2_ACCESS_KEY_ID || ''
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || ''
const bucket = process.env.R2_BUCKET || ''
const publicBase = process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_BASE || ''

export const hasR2 = !!(endpoint && accessKeyId && secretAccessKey && bucket)

export const r2 = hasR2
  ? new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })
  : null

function r2UploadTimeoutMs() {
  const raw = Number(process.env.R2_UPLOAD_TIMEOUT_MS || 60000)
  if (!Number.isFinite(raw)) return 60000
  return Math.max(5000, Math.min(300000, Math.floor(raw)))
}

function r2UploadMaxAttempts() {
  const raw = Number(process.env.R2_UPLOAD_MAX_ATTEMPTS || 2)
  if (!Number.isFinite(raw)) return 2
  return Math.max(1, Math.min(5, Math.floor(raw)))
}

function normalizedContentType(value: unknown) {
  return String(value || '').trim().toLowerCase().split(';', 1)[0]
}

async function verifyUploadedR2Object(key: string, contentType: string, expectedSize: number) {
  if (!hasR2 || !r2) throw new Error('R2 not configured')
  const head: any = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  const actualSize = Number(head?.ContentLength)
  const actualType = normalizedContentType(head?.ContentType)
  const expectedType = normalizedContentType(contentType)
  if (!Number.isFinite(actualSize) || actualSize <= 0 || actualSize !== expectedSize || !actualType || actualType !== expectedType) {
    const error: any = new Error('uploaded object verification failed')
    error.code = 'R2_UPLOAD_VERIFY_FAILED'
    throw error
  }
  return {
    etag: head?.ETag ? String(head.ETag).replace(/^"|"$/g, '') : null,
    size: actualSize,
    contentType: actualType,
  }
}

export async function r2Upload(key: string, contentType: string, body: Buffer) {
  if (!hasR2 || !r2) throw new Error('R2 not configured')
  if (!Buffer.isBuffer(body) || body.length <= 0) {
    const error: any = new Error('empty upload body')
    error.code = 'R2_UPLOAD_VERIFY_FAILED'
    throw error
  }
  const timeoutMs = r2UploadTimeoutMs()
  const maxAttempts = r2UploadMaxAttempts()
  let lastErr: any = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController()
    const t = setTimeout(() => {
      try { ac.abort() } catch {}
    }, timeoutMs)
    try {
      await r2.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
        { abortSignal: ac.signal } as any
      )
      clearTimeout(t)
      lastErr = null
      break
    } catch (e: any) {
      clearTimeout(t)
      lastErr = e
      try {
        const name = String(e?.name || '')
        const msg = String(e?.message || '')
        console.log(`[r2][upload] failed attempt=${attempt}/${maxAttempts} key=${key} timeout_ms=${timeoutMs} name=${name} message=${msg}`)
      } catch {}
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(3000, attempt * 1000)))
      }
    }
  }
  if (lastErr) {
    const msg = String(lastErr?.message || '')
    const code = /abort|timeout/i.test(String(lastErr?.name || '') + ' ' + msg) ? 'R2_UPLOAD_TIMEOUT' : 'R2_UPLOAD_FAILED'
    const err: any = new Error(msg || 'r2 upload failed')
    err.code = code
    throw err
  }
  await verifyUploadedR2Object(key, contentType, body.length)
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

export type R2ObjectSummary = {
  key: string
  size: number
  lastModified: string | null
  etag: string | null
}

export async function r2ListObjects(options: { prefix?: string; maxObjects?: number } = {}): Promise<R2ObjectSummary[]> {
  if (!hasR2 || !r2) throw new Error('R2 not configured')
  const maxObjects = Math.max(1, Math.min(100000, Math.floor(Number(options.maxObjects || 10000))))
  const objects: R2ObjectSummary[] = []
  let continuationToken: string | undefined

  do {
    const response: any = await r2.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: String(options.prefix || '').trim() || undefined,
      ContinuationToken: continuationToken,
      MaxKeys: Math.min(1000, maxObjects - objects.length),
    }))
    for (const item of Array.isArray(response?.Contents) ? response.Contents : []) {
      const key = String(item?.Key || '').trim()
      if (!key) continue
      objects.push({
        key,
        size: Number(item?.Size || 0) || 0,
        lastModified: item?.LastModified ? new Date(item.LastModified).toISOString() : null,
        etag: item?.ETag ? String(item.ETag).replace(/"/g, '') : null,
      })
      if (objects.length >= maxObjects) break
    }
    if (objects.length >= maxObjects || !response?.IsTruncated) break
    continuationToken = String(response?.NextContinuationToken || '').trim() || undefined
  } while (continuationToken)

  return objects
}

export async function r2DeleteObjects(keys: string[]): Promise<{ deleted: string[]; errors: Array<{ key: string; code: string; message: string }> }> {
  if (!hasR2 || !r2) throw new Error('R2 not configured')
  const uniqueKeys = Array.from(new Set(keys.map((key) => String(key || '').trim()).filter(Boolean)))
  const deleted: string[] = []
  const errors: Array<{ key: string; code: string; message: string }> = []
  for (let offset = 0; offset < uniqueKeys.length; offset += 1000) {
    const batch = uniqueKeys.slice(offset, offset + 1000)
    const response: any = await r2.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
    }))
    for (const item of Array.isArray(response?.Deleted) ? response.Deleted : []) {
      const key = String(item?.Key || '').trim()
      if (key) deleted.push(key)
    }
    for (const item of Array.isArray(response?.Errors) ? response.Errors : []) {
      const key = String(item?.Key || '').trim()
      if (!key) continue
      errors.push({
        key,
        code: String(item?.Code || 'R2_DELETE_FAILED'),
        message: String(item?.Message || 'R2 object delete failed'),
      })
    }
  }
  return { deleted, errors }
}
