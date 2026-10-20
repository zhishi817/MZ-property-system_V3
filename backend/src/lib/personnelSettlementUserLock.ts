type Queryable = { query: (sql: string, params?: any[]) => Promise<any> }

const TRANSACTION_POOLER_HOST_SEGMENT = /(^|[.-])(pooler|pgbouncer|proxy)([.-]|$)/i
const TRANSACTION_POOLER_QUERY_KEYS = ['pgbouncer', 'pool_mode', 'pooler', 'proxy']

function requiredId(value: unknown, code: string) {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new Error(code)
  return normalized
}

/**
 * A session advisory lock is valid only when every statement uses the same
 * physical PostgreSQL backend. Require the explicitly configured direct URL,
 * an operator acknowledgement of that property, and reject common transaction
 * pooler/proxy URL markers. Do not derive or rewrite a pooled DATABASE_URL.
 */
export function requirePersonnelSettlementSessionAffineDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
) {
  if (String(env.PERSONNEL_SETTLEMENT_DIRECT_SESSION_AFFINITY_CONFIRMED || '').trim() !== '1') {
    throw new Error('personnel_settlement_direct_session_affinity_not_confirmed')
  }
  const raw = String(env.DATABASE_DIRECT_URL || '').trim()
  if (!raw) throw new Error('personnel_settlement_direct_database_required')
  const primaryRaw = String(env.DATABASE_URL || '').trim()
  if (!primaryRaw) throw new Error('personnel_settlement_primary_database_required')
  let url: URL
  let primaryUrl: URL
  try {
    url = new URL(raw)
    primaryUrl = new URL(primaryRaw)
  } catch {
    throw new Error('personnel_settlement_direct_database_invalid')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol.toLowerCase())) {
    throw new Error('personnel_settlement_direct_database_invalid')
  }
  const database = url.pathname.replace(/^\/+/, '').trim()
  if (!url.hostname || !database) throw new Error('personnel_settlement_direct_database_invalid')
  const hasPoolerQueryMarker = TRANSACTION_POOLER_QUERY_KEYS.some((key) => {
    const value = String(url.searchParams.get(key) || '').trim().toLowerCase()
    return value === '1' || value === 'true' || value === 'transaction' || value === 'statement'
  })
  if (
    TRANSACTION_POOLER_HOST_SEGMENT.test(url.hostname)
    || url.port === '6543'
    || hasPoolerQueryMarker
  ) {
    throw new Error('personnel_settlement_direct_database_not_session_affine')
  }
  const primaryDirectHost = primaryUrl.hostname.toLowerCase().replace(/-pooler(?=\.)/i, '')
  const directPort = url.port || '5432'
  const primaryPort = primaryUrl.port || '5432'
  const primaryIsRecognizedPooler = TRANSACTION_POOLER_HOST_SEGMENT.test(primaryUrl.hostname)
    || primaryUrl.port === '6543'
  if (
    !['postgres:', 'postgresql:'].includes(primaryUrl.protocol.toLowerCase())
    || primaryDirectHost !== url.hostname.toLowerCase()
    || primaryUrl.pathname !== url.pathname
    || primaryUrl.username !== url.username
    || (!primaryIsRecognizedPooler && primaryPort !== directPort)
  ) {
    throw new Error('personnel_settlement_direct_database_source_mismatch')
  }
  return raw
}

/**
 * Serialize profile/rule mutations with settlement transitions that enter or
 * leave finance-approved/paid states. Every participating transaction must
 * acquire this user-scoped advisory lock before any business-row FOR UPDATE.
 */
export async function lockPersonnelSettlementUserScope(client: Queryable, userId: unknown) {
  const normalizedUserId = requiredId(userId, 'user_id_required')
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('personnel-settlement-user'), hashtext($1))",
    [normalizedUserId],
  )
  return normalizedUserId
}

/**
 * Bridge a SERIALIZABLE transaction across its pre-BEGIN boundary. The caller
 * must acquire this session lock, begin the transaction, acquire the matching
 * transaction lock above, and then immediately release the session lock.
 */
export async function lockPersonnelSettlementUserSessionScope(client: Queryable, userId: unknown) {
  const normalizedUserId = requiredId(userId, 'user_id_required')
  await client.query(
    "SELECT pg_advisory_lock(hashtext('personnel-settlement-user'), hashtext($1))",
    [normalizedUserId],
  )
  return normalizedUserId
}

export async function unlockPersonnelSettlementUserSessionScope(client: Queryable, userId: unknown) {
  const normalizedUserId = requiredId(userId, 'user_id_required')
  const result = await client.query(
    "SELECT pg_advisory_unlock(hashtext('personnel-settlement-user'), hashtext($1)) AS unlocked",
    [normalizedUserId],
  )
  if (result.rows?.[0]?.unlocked !== true) throw new Error('personnel_settlement_user_session_unlock_failed')
}

export async function getPersonnelSettlementUserScopeId(client: Queryable, settlementId: unknown) {
  const normalizedSettlementId = requiredId(settlementId, 'settlement_not_found')
  const result = await client.query(
    'SELECT user_id FROM personnel_weekly_settlements WHERE id=$1',
    [normalizedSettlementId],
  )
  const userId = String(result.rows?.[0]?.user_id ?? '').trim()
  if (!userId) throw new Error('settlement_not_found')
  return userId
}

/**
 * Settlement transitions know only the settlement id at entry. Resolve its
 * immutable user id without a row lock, acquire the shared advisory lock, and
 * let the caller take settlement/user/profile row locks afterwards.
 */
export async function lockPersonnelSettlementUserScopeForSettlement(
  client: Queryable,
  settlementId: unknown,
) {
  const userId = await getPersonnelSettlementUserScopeId(client, settlementId)
  await lockPersonnelSettlementUserScope(client, userId)
  return userId
}
