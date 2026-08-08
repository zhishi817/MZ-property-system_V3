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
type ReceiptQueryable = {
  query: (sql: string, values?: any[]) => Promise<any>
}

let idempotentStepReceiptsReady = false
let idempotentStepReceiptsEnsuring: Promise<void> | null = null

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

export async function ensureIdempotentStepReceiptsTable(pgPool: ReceiptQueryable) {
  if (idempotentStepReceiptsReady) return
  if (idempotentStepReceiptsEnsuring) return idempotentStepReceiptsEnsuring
  idempotentStepReceiptsEnsuring = (async () => {
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
    idempotentStepReceiptsReady = true
  })().catch((error) => {
    idempotentStepReceiptsEnsuring = null
    throw error
  }).finally(() => {
    if (idempotentStepReceiptsReady) idempotentStepReceiptsEnsuring = null
  })
  return idempotentStepReceiptsEnsuring
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
