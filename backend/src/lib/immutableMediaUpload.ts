import crypto from 'crypto'
import fs from 'fs'

export const CLEANING_MEDIA_IDEMPOTENCY_CONFLICT = 'CLEANING_MEDIA_IDEMPOTENCY_CONFLICT'

export type ImmutableMediaInspection =
  | { status: 'missing' }
  | { status: 'unavailable' }
  | {
      status: 'exists'
      fingerprint?: string | null
      bodySha256?: string | null
      size: number
      contentType: string
    }

export class ImmutableMediaConflictError extends Error {
  readonly code = CLEANING_MEDIA_IDEMPOTENCY_CONFLICT

  constructor() {
    super('media_id already belongs to different content')
    this.name = 'ImmutableMediaConflictError'
  }
}

export function sha256Hex(value: Buffer | string) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeContentType(value: unknown) {
  return String(value || '').trim().toLowerCase().split(';', 1)[0]
}

/**
 * Fingerprint the original bytes plus every input that can change the stored
 * representation. This keeps retries stable while refusing a reused media_id
 * for a different photo, watermark or business context.
 */
export function buildCleaningMediaUploadFingerprint(input: {
  body: Buffer
  taskId: string
  mediaId: string
  purpose: string
  watermark: boolean
  watermarkText: string
  propertyCode: string
  capturedAt: string
  submitter: string
  contentType: string
  originalName: string
}) {
  const semantic = {
    task_id: String(input.taskId || '').trim(),
    media_id: String(input.mediaId || '').trim(),
    purpose: String(input.purpose || '').trim(),
    watermark: !!input.watermark,
    watermark_text: String(input.watermarkText || ''),
    property_code: String(input.propertyCode || '').trim(),
    captured_at: String(input.capturedAt || '').trim(),
    submitter: String(input.submitter || '').trim(),
    content_type: normalizeContentType(input.contentType),
    original_name: String(input.originalName || '').trim(),
  }
  return crypto.createHash('sha256').update(JSON.stringify(semantic)).update('\0').update(input.body).digest('hex')
}

function inspectionMatches(
  inspection: Extract<ImmutableMediaInspection, { status: 'exists' }>,
  expected: { fingerprint: string; bodySha256: string; size: number; contentType: string },
) {
  const storedFingerprint = String(inspection.fingerprint || '').trim()
  if (storedFingerprint) {
    // The fingerprint covers the original bytes plus every semantic input.
    // Treat it as authoritative so equivalent retries remain reusable even if
    // a Sharp/libjpeg upgrade produces different final JPEG bytes.
    return storedFingerprint === expected.fingerprint
  }
  return String(inspection.bodySha256 || '').trim() === expected.bodySha256
    && Number(inspection.size) === expected.size
    && normalizeContentType(inspection.contentType) === normalizeContentType(expected.contentType)
}

/**
 * Conditional-create orchestration shared by R2 and the isolated contract
 * test. A failed create is always inspected before retrying, covering the
 * common "object stored, response lost" case without another upload.
 */
export async function ensureImmutableMediaStored(input: {
  expected: { fingerprint: string; bodySha256: string; size: number; contentType: string }
  create: () => Promise<void>
  inspect: () => Promise<ImmutableMediaInspection>
  maxAttempts?: number
}) {
  const attempts = Math.max(1, Math.min(5, Math.floor(Number(input.maxAttempts || 2))))
  let lastError: any = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Inspect first so a normal retry never sends the media body again. The
    // conditional create below still closes the race between this HEAD and PUT.
    let preflight: ImmutableMediaInspection = { status: 'unavailable' }
    try {
      preflight = await input.inspect()
      const existing = preflight
      if (existing.status === 'exists') {
        if (!inspectionMatches(existing, input.expected)) throw new ImmutableMediaConflictError()
        return { reused: true, attempt }
      }
    } catch (error: any) {
      if (error?.code === CLEANING_MEDIA_IDEMPOTENCY_CONFLICT) throw error
      lastError = error
      continue
    }
    if (preflight.status === 'unavailable') {
      lastError = Object.assign(new Error('immutable media inspection unavailable'), { code: 'R2_UPLOAD_VERIFY_FAILED' })
      continue
    }

    let created = false
    try {
      await input.create()
      created = true
    } catch (error: any) {
      lastError = error
    }

    let inspection: ImmutableMediaInspection = { status: 'unavailable' }
    try {
      inspection = await input.inspect()
    } catch (error: any) {
      lastError = error
    }
    if (inspection.status === 'exists') {
      if (!inspectionMatches(inspection, input.expected)) throw new ImmutableMediaConflictError()
      return { reused: !created, attempt }
    }
    if (created) {
      lastError = Object.assign(new Error('uploaded object verification failed'), { code: 'R2_UPLOAD_VERIFY_FAILED' })
    }
  }
  throw lastError || Object.assign(new Error('immutable media upload failed'), { code: 'R2_UPLOAD_FAILED' })
}

/** Atomic single-host fallback used when R2 is disabled. */
export async function storeLocalImmutableMedia(sourcePath: string, destinationPath: string) {
  const source = await fs.promises.readFile(sourcePath)
  try {
    await fs.promises.link(sourcePath, destinationPath)
    await fs.promises.unlink(sourcePath)
    return { reused: false }
  } catch (error: any) {
    if (String(error?.code || '') !== 'EEXIST') throw error
    const existing = await fs.promises.readFile(destinationPath)
    await fs.promises.unlink(sourcePath).catch(() => undefined)
    if (existing.length !== source.length || sha256Hex(existing) !== sha256Hex(source)) {
      throw new ImmutableMediaConflictError()
    }
    return { reused: true }
  }
}
