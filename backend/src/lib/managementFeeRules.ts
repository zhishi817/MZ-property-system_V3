import { hasPg, pgPool } from '../dbAdapter'

export type LandlordManagementFeeRule = {
  id: string
  landlord_id: string
  effective_from_month: string
  management_fee_rate: number
  note?: string | null
  created_at?: string
  created_by?: string | null
}

let ensurePromise: Promise<void> | null = null

export function isValidMonthKey(monthKey: any): boolean {
  return /^\d{4}-\d{2}$/.test(String(monthKey || '').trim())
}

export async function ensureManagementFeeRulesTable() {
  if (!hasPg || !pgPool) return
  if (ensurePromise) return ensurePromise
  ensurePromise = (async () => {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS landlord_management_fee_rules (
        id text PRIMARY KEY,
        landlord_id text NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
        effective_from_month text NOT NULL,
        management_fee_rate numeric NOT NULL,
        note text,
        created_at timestamptz DEFAULT now(),
        created_by text
      );
    `)
    await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_landlord_management_fee_rules_landlord_month ON landlord_management_fee_rules(landlord_id, effective_from_month);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_landlord_management_fee_rules_lookup ON landlord_management_fee_rules(landlord_id, effective_from_month DESC);`)
  })().catch((err) => {
    ensurePromise = null
    throw err
  })
  return ensurePromise
}

export async function listManagementFeeRulesByLandlordIds(landlordIds: string[]): Promise<Record<string, LandlordManagementFeeRule[]>> {
  const ids = Array.from(new Set((landlordIds || []).map((x) => String(x || '').trim()).filter(Boolean)))
  const out: Record<string, LandlordManagementFeeRule[]> = {}
  ids.forEach((id) => { out[id] = [] })
  if (!ids.length || !hasPg || !pgPool) return out
  await ensureManagementFeeRulesTable()
  const rs = await pgPool.query(
    `SELECT *
       FROM landlord_management_fee_rules
      WHERE landlord_id = ANY($1::text[])
      ORDER BY landlord_id ASC, effective_from_month DESC, created_at DESC`,
    [ids]
  )
  for (const row of (rs.rows || [])) {
    const landlordId = String((row as any).landlord_id || '').trim()
    if (!landlordId) continue
    if (!out[landlordId]) out[landlordId] = []
    out[landlordId].push({
      ...row,
      landlord_id: landlordId,
      effective_from_month: String((row as any).effective_from_month || ''),
      management_fee_rate: Number((row as any).management_fee_rate || 0),
    } as LandlordManagementFeeRule)
  }
  return out
}

export function resolveManagementFeeRateForMonthFromRules(
  rules: Array<Pick<LandlordManagementFeeRule, 'effective_from_month' | 'management_fee_rate'>> | undefined,
  monthKey: string
) {
  const month = String(monthKey || '').trim()
  if (!isValidMonthKey(month)) return { rate: null as number | null, rule: null as any }
  const sorted = (Array.isArray(rules) ? rules : [])
    .filter((r) => isValidMonthKey((r as any)?.effective_from_month))
    .slice()
    .sort((a, b) => String((b as any).effective_from_month || '').localeCompare(String((a as any).effective_from_month || '')))
  const match = sorted.find((r) => String((r as any).effective_from_month || '') <= month) || null
  return {
    rate: match ? Number((match as any).management_fee_rate || 0) : null,
    rule: match,
  }
}

export async function resolveManagementFeeRateForMonth(landlordId: string, monthKey: string) {
  const landlord = String(landlordId || '').trim()
  const month = String(monthKey || '').trim()
  if (!landlord || !isValidMonthKey(month)) return { rate: null as number | null, rule: null as LandlordManagementFeeRule | null }
  if (!hasPg || !pgPool) return { rate: null as number | null, rule: null as LandlordManagementFeeRule | null }
  await ensureManagementFeeRulesTable()
  const rs = await pgPool.query(
    `SELECT *
       FROM landlord_management_fee_rules
      WHERE landlord_id=$1
        AND effective_from_month <= $2
      ORDER BY effective_from_month DESC, created_at DESC
      LIMIT 1`,
    [landlord, month]
  )
  const row = rs.rows?.[0]
  if (!row) return { rate: null as number | null, rule: null as LandlordManagementFeeRule | null }
  return {
    rate: Number((row as any).management_fee_rate || 0),
    rule: {
      ...row,
      landlord_id: String((row as any).landlord_id || ''),
      effective_from_month: String((row as any).effective_from_month || ''),
      management_fee_rate: Number((row as any).management_fee_rate || 0),
    } as LandlordManagementFeeRule,
  }
}

export async function syncLandlordCachedManagementFeeRate(landlordId: string) {
  const landlord = String(landlordId || '').trim()
  if (!landlord || !hasPg || !pgPool) return
  await ensureManagementFeeRulesTable()
  const latest = await pgPool.query(
    `SELECT management_fee_rate
       FROM landlord_management_fee_rules
      WHERE landlord_id=$1
      ORDER BY effective_from_month DESC, created_at DESC
      LIMIT 1`,
    [landlord]
  )
  if (latest.rows?.[0]) {
    await pgPool.query('UPDATE landlords SET management_fee_rate=$2 WHERE id=$1', [landlord, Number(latest.rows[0].management_fee_rate || 0)])
    return
  }
  await pgPool.query('UPDATE landlords SET management_fee_rate=NULL WHERE id=$1', [landlord])
}

export async function listLandlordPropertyIds(landlordId: string): Promise<string[]> {
  const landlord = String(landlordId || '').trim()
  if (!landlord || !hasPg || !pgPool) return []
  const out = new Set<string>()
  try {
    const lrs = await pgPool.query('SELECT property_ids FROM landlords WHERE id=$1 LIMIT 1', [landlord])
    const raw = lrs.rows?.[0]?.property_ids
    if (Array.isArray(raw)) {
      for (const id of raw) {
        const v = String(id || '').trim()
        if (v) out.add(v)
      }
    }
  } catch {}
  try {
    const prs = await pgPool.query('SELECT id FROM properties WHERE landlord_id=$1', [landlord])
    for (const row of (prs.rows || [])) {
      const v = String((row as any).id || '').trim()
      if (v) out.add(v)
    }
  } catch {}
  return Array.from(out)
}

export async function ruleHasRecordedManagementFeeUsage(landlordId: string, effectiveFromMonth: string): Promise<boolean> {
  const landlord = String(landlordId || '').trim()
  const month = String(effectiveFromMonth || '').trim()
  if (!landlord || !isValidMonthKey(month) || !hasPg || !pgPool) return false
  const propertyIds = await listLandlordPropertyIds(landlord)
  if (!propertyIds.length) return false
  const rs = await pgPool.query(
    `SELECT 1
       FROM property_expenses
      WHERE category='management_fee'
        AND property_id = ANY($1::text[])
        AND month_key IS NOT NULL
        AND month_key >= $2
      LIMIT 1`,
    [propertyIds, month]
  )
  return !!rs.rowCount
}
