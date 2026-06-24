import crypto from 'crypto'
import type { Pool } from 'pg'

type ReceiptScope = {
  scopeType: string
  scopeId: string
  submitId: string
  stepKey: string
}

function cleanText(value: any) {
  return String(value || '').trim()
}

export function buildIdempotencyPayloadHash(payload: any) {
  return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex')
}

export async function ensureIdempotentStepReceiptsTable(pgPool: Pool) {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_submit_receipts (
      id text PRIMARY KEY,
      scope_type text NOT NULL,
      scope_id text NOT NULL,
      submit_id text NOT NULL,
      step_key text NOT NULL,
      payload_hash text NOT NULL,
      response_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `)
  await pgPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_submit_receipts_scope
      ON app_submit_receipts(scope_type, scope_id, submit_id, step_key);
  `)
}

export async function loadIdempotentStepReceipt(pgPool: Pool, scope: ReceiptScope) {
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

export async function saveIdempotentStepReceipt(pgPool: Pool, scope: ReceiptScope, payloadHash: string, responseJson: any) {
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
