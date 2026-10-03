import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'
import { CLEANING_IMAGE_FORMAT_ERROR, normalizeCleaningImageUpload } from './cleaningMediaImage'
import {
  createMzappTaskPhotoRemoteReference,
  currentMzappTaskPhotoKeyFromReference,
  hasCurrentMzappTaskPhotoStorageNamespace,
  normalizeMzappTaskPhotoKey,
  parseMzappTaskPhotoRemoteReference,
} from './mzappTaskPhotoReference'
import { assertPersonnelSettlementSchemaReady } from './personnelSettlementSchema'
import { hasR2, r2GetObjectByKeyDetailed, r2Upload } from '../r2'

type Queryable = { query: (sql: string, params?: any[]) => Promise<any> }

export const PERSONNEL_CLAIM_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024

const SAFE_MEDIA_ID = /^[a-zA-Z0-9_-]{8,120}$/
const SAFE_LOCAL_NAME = /^personnel-claim-[a-zA-Z0-9_-]+\.jpg$/
const LOCAL_PRIVATE_PREFIX = 'local-private:personnel-claims/'
const R2_EVIDENCE_PREFIX = 'mzapp/personnel-claims/'

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

function safeSegment(value: unknown, field: string) {
  const normalized = cleanText(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)
  if (!normalized) throw new Error(`${field}_required`)
  return normalized
}

export function validatePersonnelClaimEvidenceMediaId(value: unknown) {
  const mediaId = cleanText(value)
  if (!SAFE_MEDIA_ID.test(mediaId)) throw new Error('invalid_claim_evidence_media_id')
  return mediaId
}

export function personnelClaimEvidenceStorageKey(input: { userId: string; claimId: string; mediaId: string }) {
  return `${R2_EVIDENCE_PREFIX}${safeSegment(input.userId, 'user_id')}/${safeSegment(input.claimId, 'claim_id')}/${validatePersonnelClaimEvidenceMediaId(input.mediaId)}.jpg`
}

export function personnelClaimEvidenceR2KeyFromReference(value: unknown) {
  const reference = cleanText(value)
  const key = currentMzappTaskPhotoKeyFromReference(reference) || normalizeMzappTaskPhotoKey(reference)
  return key?.startsWith(R2_EVIDENCE_PREFIX) ? key : null
}

export function serializePersonnelClaimEvidence(row: any) {
  return {
    id: cleanText(row?.id),
    claim_id: cleanText(row?.claim_id),
    media_id: cleanText(row?.media_id),
    mime_type: cleanText(row?.mime_type) || 'image/jpeg',
    byte_size: row?.byte_size == null ? null : Number(row.byte_size),
    original_file_name: cleanText(row?.original_file_name) || null,
    created_at: row?.created_at ? String(row.created_at) : null,
  }
}

async function findEvidenceByMediaId(mediaId: string, executor: Queryable) {
  const result = await executor.query(
    `SELECT evidence.*, claim.submitter_user_id, claim.status AS claim_status
       FROM personnel_workload_claim_evidence evidence
       JOIN personnel_workload_claims claim ON claim.id=evidence.claim_id
      WHERE evidence.media_id=$1
      LIMIT 1`,
    [mediaId],
  )
  return result.rows?.[0] || null
}

function localEvidenceName(input: { userId: string; claimId: string; mediaId: string }) {
  const digest = crypto
    .createHash('sha256')
    .update(`${input.userId}:${input.claimId}:${input.mediaId}`)
    .digest('hex')
    .slice(0, 40)
  return `personnel-claim-${digest}.jpg`
}

async function persistEvidenceBytes(input: {
  userId: string
  claimId: string
  mediaId: string
  body: Buffer
  contentType: string
}) {
  if (hasR2) {
    const key = personnelClaimEvidenceStorageKey(input)
    const reference = createMzappTaskPhotoRemoteReference(key)
    if (!reference) throw new Error('claim_evidence_storage_unavailable')
    try {
      await r2Upload(key, input.contentType, input.body)
    } catch {
      throw new Error('claim_evidence_storage_unavailable')
    }
    return reference
  }
  const fileName = localEvidenceName(input)
  const uploadDir = path.resolve(process.cwd(), 'private-uploads', 'personnel-claims')
  await fs.promises.mkdir(uploadDir, { recursive: true })
  await fs.promises.writeFile(path.join(uploadDir, fileName), input.body)
  return `${LOCAL_PRIVATE_PREFIX}${fileName}`
}

export async function savePersonnelClaimEvidence(input: {
  userId: string
  claimId: string
  mediaId: string
  originalFileName?: string | null
  contentType: string
  body: Buffer
}) {
  assertPersonnelSettlementSchemaReady()
  if (!hasPg || !pgPool) throw new Error('pg_required')
  const mediaId = validatePersonnelClaimEvidenceMediaId(input.mediaId)
  if (!Buffer.isBuffer(input.body) || input.body.length <= 0) throw new Error('claim_evidence_file_required')
  if (input.body.length > PERSONNEL_CLAIM_EVIDENCE_MAX_BYTES) throw new Error('claim_evidence_file_too_large')

  const existing = await findEvidenceByMediaId(mediaId, pgPool)
  if (existing) {
    if (cleanText(existing.claim_id) !== cleanText(input.claimId) || cleanText(existing.submitter_user_id) !== cleanText(input.userId)) {
      throw new Error('claim_evidence_media_conflict')
    }
    return serializePersonnelClaimEvidence(existing)
  }

  const claim = await pgPool.query(
    `SELECT id, status
       FROM personnel_workload_claims
      WHERE id=$1 AND submitter_user_id=$2
      LIMIT 1`,
    [input.claimId, input.userId],
  )
  const claimRow = claim.rows?.[0]
  if (!claimRow) throw new Error('claim_not_found')
  if (!['draft', 'returned'].includes(cleanText(claimRow.status))) throw new Error('claim_not_editable')

  const normalized = await normalizeCleaningImageUpload({
    buffer: input.body,
    contentType: input.contentType,
    originalName: input.originalFileName || `${mediaId}.jpg`,
  })
  if (!normalized.isImage || !normalized.normalized) {
    const error: any = new Error('image_format_unsupported')
    error.code = CLEANING_IMAGE_FORMAT_ERROR
    throw error
  }
  if (normalized.buffer.length > PERSONNEL_CLAIM_EVIDENCE_MAX_BYTES) throw new Error('claim_evidence_file_too_large')

  const storageKey = await persistEvidenceBytes({
    userId: input.userId,
    claimId: input.claimId,
    mediaId,
    body: normalized.buffer,
    contentType: 'image/jpeg',
  })
  const evidenceId = crypto.randomUUID()
  const originalFileName = cleanText(input.originalFileName).slice(0, 180) || null
  const saved = await pgRunInTransaction(async (client) => {
    const lockedClaim = await client.query(
      `SELECT id, status
         FROM personnel_workload_claims
        WHERE id=$1 AND submitter_user_id=$2
        FOR UPDATE`,
      [input.claimId, input.userId],
    )
    const lockedRow = lockedClaim.rows?.[0]
    if (!lockedRow) throw new Error('claim_not_found')
    if (!['draft', 'returned'].includes(cleanText(lockedRow.status))) throw new Error('claim_not_editable')
    await client.query(
      `INSERT INTO personnel_workload_claim_evidence (
         id, claim_id, media_id, storage_key, mime_type, byte_size,
         original_file_name, uploaded_by, created_at
       ) VALUES ($1,$2,$3,$4,'image/jpeg',$5,$6,$7,now())
       ON CONFLICT (media_id) DO NOTHING`,
      [evidenceId, input.claimId, mediaId, storageKey, normalized.buffer.length, originalFileName, input.userId],
    )
    const row = await findEvidenceByMediaId(mediaId, client)
    if (!row || cleanText(row.claim_id) !== cleanText(input.claimId) || cleanText(row.submitter_user_id) !== cleanText(input.userId)) {
      throw new Error('claim_evidence_media_conflict')
    }
    return row
  })
  if (!saved) throw new Error('claim_evidence_save_failed')
  return serializePersonnelClaimEvidence(saved)
}

export async function getPersonnelClaimEvidence(input: {
  claimId: string
  evidenceId: string
  requestingUserId?: string
}, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  assertPersonnelSettlementSchemaReady()
  const params: any[] = [input.claimId, input.evidenceId]
  const ownerFilter = input.requestingUserId ? 'AND claim.submitter_user_id=$3' : ''
  if (input.requestingUserId) params.push(input.requestingUserId)
  const result = await executor.query(
    `SELECT evidence.*, claim.submitter_user_id
       FROM personnel_workload_claim_evidence evidence
       JOIN personnel_workload_claims claim ON claim.id=evidence.claim_id
      WHERE evidence.claim_id=$1 AND evidence.id=$2 ${ownerFilter}
      LIMIT 1`,
    params,
  )
  return result.rows?.[0] || null
}

export async function readPersonnelClaimEvidenceBytes(row: any) {
  const reference = cleanText(row?.storage_key)
  const remoteReference = parseMzappTaskPhotoRemoteReference(reference)
  if (remoteReference && !hasCurrentMzappTaskPhotoStorageNamespace()) {
    throw new Error('claim_evidence_storage_unavailable')
  }
  const r2Key = personnelClaimEvidenceR2KeyFromReference(reference)
  if (r2Key) {
    if (!hasR2) throw new Error('claim_evidence_storage_unavailable')
    const result = await r2GetObjectByKeyDetailed(r2Key)
    if (result.status === 'not_found') return null
    if (result.status === 'unavailable') throw new Error('claim_evidence_storage_unavailable')
    return result.object
  }
  if (reference.startsWith(LOCAL_PRIVATE_PREFIX)) {
    const fileName = reference.slice(LOCAL_PRIVATE_PREFIX.length)
    if (!SAFE_LOCAL_NAME.test(fileName) || reference !== `${LOCAL_PRIVATE_PREFIX}${fileName}`) throw new Error('invalid_claim_evidence_reference')
    const filePath = path.resolve(process.cwd(), 'private-uploads', 'personnel-claims', fileName)
    try {
      const body = await fs.promises.readFile(filePath)
      return body.length ? { body, contentType: 'image/jpeg' } : null
    } catch (error: any) {
      if (String(error?.code || '') === 'ENOENT') return null
      throw new Error('claim_evidence_storage_unavailable')
    }
  }
  throw new Error('invalid_claim_evidence_reference')
}
