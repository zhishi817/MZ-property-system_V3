import crypto from 'crypto'
import type { Pool, PoolClient } from 'pg'

export const IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH = 256

type ReceiptScope = {
  scopeType: string
  scopeId: string
  submitId: string
  stepKey: string
}

type ReceiptClient = Pool | PoolClient

export class IdempotentStepReceiptsNotReady extends Error {
  constructor() {
    super('idempotent_step_receipts_not_ready')
    this.name = 'IdempotentStepReceiptsNotReady'
  }
}

function cleanText(value: any) {
  return String(value || '').trim()
}

export function buildIdempotencyPayloadHash(payload: any) {
  return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex')
}

function canonicalizePayload(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalizePayload)
  if (!value || typeof value !== 'object' || value instanceof Date) return value
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalizePayload(value[key])]),
  )
}

/** Stable recursive hashing for new operation-scoped receipts without changing legacy receipt hashes. */
export function buildCanonicalIdempotencyPayloadHash(payload: any) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalizePayload(payload || {}))).digest('hex')
}

/**
 * Keyed operation receipt fingerprint for payloads that may contain low-entropy
 * credentials. The domain separator prevents reuse as an authentication token,
 * while the server-only JWT secret prevents offline enumeration from a receipt
 * table dump. Legacy receipt hashes remain unchanged.
 */
export function buildCanonicalIdempotencyPayloadHmac(payload: any, secret0?: string) {
  const secret = String(secret0 ?? process.env.JWT_SECRET ?? 'dev-secret')
  return crypto
    .createHmac('sha256', secret)
    .update('app-submit-receipt:v1\0')
    .update(JSON.stringify(canonicalizePayload(payload || {})))
    .digest('hex')
}

/** The receipts migration owns DDL; API requests only verify readiness. */
export async function assertIdempotentStepReceiptsReady(client: ReceiptClient) {
  try {
    await client.query(`SELECT id, scope_type, scope_id, submit_id, step_key, payload_hash, response_json, created_at, updated_at
      FROM app_submit_receipts
      LIMIT 0`)
  } catch {
    throw new IdempotentStepReceiptsNotReady()
  }
}

export async function loadIdempotentStepReceipt(pgPool: ReceiptClient, scope: ReceiptScope) {
  const scopeType = cleanText(scope.scopeType)
  const scopeId = cleanText(scope.scopeId)
  const submitId = cleanText(scope.submitId)
  const stepKey = cleanText(scope.stepKey)
  if (!scopeType || !scopeId || !submitId || !stepKey) return null
  const result = await pgPool.query(
    `SELECT payload_hash, response_json
       FROM app_submit_receipts
      WHERE scope_type = $1
        AND scope_id = $2
        AND submit_id = $3
        AND step_key = $4
      LIMIT 1`,
    [scopeType, scopeId, submitId, stepKey],
  )
  return result?.rows?.[0] || null
}

export async function saveIdempotentStepReceipt(pgPool: ReceiptClient, scope: ReceiptScope, payloadHash: string, responseJson: any) {
  const scopeType = cleanText(scope.scopeType)
  const scopeId = cleanText(scope.scopeId)
  const submitId = cleanText(scope.submitId)
  const stepKey = cleanText(scope.stepKey)
  if (!scopeType || !scopeId || !submitId || !stepKey) return
  await pgPool.query(
    `INSERT INTO app_submit_receipts (
       id, scope_type, scope_id, submit_id, step_key, payload_hash, response_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
     ON CONFLICT (scope_type, scope_id, submit_id, step_key)
     DO UPDATE SET payload_hash = EXCLUDED.payload_hash,
                   response_json = EXCLUDED.response_json,
                   updated_at = now()`,
    [
      `${scopeType}:${scopeId}:${submitId}:${stepKey}`,
      scopeType,
      scopeId,
      submitId,
      stepKey,
      cleanText(payloadHash),
      responseJson == null ? null : JSON.stringify(responseJson),
    ],
  )
}
