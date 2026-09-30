import { randomUUID } from 'crypto'
import { pgPool, pgRunInTransaction } from '../dbAdapter'
import { assertPersonnelSettlementSchemaReady } from './personnelSettlementSchema'

export type PersonnelGstStatus = 'unconfirmed' | 'registered' | 'not_registered'
export type PersonnelType = 'cleaner' | 'inspector' | 'warehouse' | 'trial' | 'external' | 'mixed'

export type PersonnelProfilePatch = {
  settlement_enabled?: boolean
  person_type?: PersonnelType
  legal_name?: string | null
  supplier_business_name?: string | null
  personal_abn?: string | null
  gst_status?: PersonnelGstStatus
  bank_account_name?: string | null
  bank_bsb?: string | null
  bank_account_number?: string | null
}

type Queryable = { query: (sql: string, params?: any[]) => Promise<any> }

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

function nullableText(value: unknown) {
  const normalized = cleanText(value)
  return normalized || null
}

export function normalizeAbn(value: unknown) {
  return cleanText(value).replace(/\D/g, '')
}

export function isValidAustralianAbn(value: unknown) {
  const digits = normalizeAbn(value)
  return /^\d{11}$/.test(digits)
}

export function normalizeBsb(value: unknown) {
  return cleanText(value).replace(/\D/g, '')
}

export function normalizeBankAccountNumber(value: unknown) {
  return cleanText(value).replace(/\s|-/g, '')
}

export function isDateOnly(value: unknown) {
  const text = cleanText(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const date = new Date(`${text}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text
}

function addDateOnlyDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function melbourneDateToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function defaultPersonnelType(role: unknown): PersonnelType {
  const value = cleanText(role).toLowerCase()
  if (value === 'cleaner') return 'cleaner'
  if (value === 'cleaning_inspector') return 'inspector'
  if (value === 'cleaner_inspector') return 'mixed'
  if (value === 'inventory_manager') return 'warehouse'
  return 'external'
}

function maskBsb(value: unknown) {
  const digits = normalizeBsb(value)
  if (!digits) return null
  return digits.length >= 2 ? `***-${digits.slice(-3)}` : '***'
}

function maskAccount(value: unknown) {
  const normalized = normalizeBankAccountNumber(value)
  if (!normalized) return null
  return `•••• ${normalized.slice(-4)}`
}

function safeAuditSnapshot(value: any) {
  return {
    settlement_enabled: !!value?.settlement_enabled,
    person_type: value?.person_type || null,
    legal_name: value?.supplier_legal_name || value?.legal_name || null,
    supplier_business_name: value?.supplier_business_name || null,
    personal_abn: value?.abn || value?.personal_abn || null,
    gst_status: value?.gst_status || 'unconfirmed',
    gst_effective_from: value?.gst_effective_from || null,
    bank_account_name: value?.bank_account_name || null,
    bank_details_complete: !!(
      cleanText(value?.bank_account_name)
      && normalizeBsb(value?.bank_bsb).length === 6
      && normalizeBankAccountNumber(value?.bank_account_number)
    ),
    bank_bsb_masked: maskBsb(value?.bank_bsb),
    bank_account_masked: maskAccount(value?.bank_account_number),
  }
}

export function validatePersonnelProfilePatch(input: {
  effectiveDate: string
  reason?: string | null
  source: 'mobile_self' | 'web_admin'
  patch: PersonnelProfilePatch
}) {
  if (!isDateOnly(input.effectiveDate)) throw new Error('invalid_effective_date')
  if (input.effectiveDate > melbourneDateToday()) throw new Error('effective_date_in_future')
  if (input.source === 'web_admin' && !cleanText(input.reason)) throw new Error('change_reason_required')
  if (input.reason && cleanText(input.reason).length > 500) throw new Error('change_reason_too_long')

  const legalName = input.patch.legal_name === undefined ? undefined : nullableText(input.patch.legal_name)
  const businessName = input.patch.supplier_business_name === undefined
    ? undefined
    : nullableText(input.patch.supplier_business_name)
  const abn = input.patch.personal_abn === undefined ? undefined : normalizeAbn(input.patch.personal_abn) || null
  const bankAccountName = input.patch.bank_account_name === undefined
    ? undefined
    : nullableText(input.patch.bank_account_name)
  const bsb = input.patch.bank_bsb === undefined ? undefined : normalizeBsb(input.patch.bank_bsb) || null
  const accountNumber = input.patch.bank_account_number === undefined
    ? undefined
    : normalizeBankAccountNumber(input.patch.bank_account_number) || null

  if (legalName && legalName.length > 120) throw new Error('legal_name_too_long')
  if (businessName && businessName.length > 160) throw new Error('supplier_business_name_too_long')
  if (abn && !isValidAustralianAbn(abn)) throw new Error('invalid_abn')
  if (bankAccountName && bankAccountName.length > 120) throw new Error('bank_account_name_too_long')
  if (bsb && bsb.length !== 6) throw new Error('invalid_bsb')
  if (accountNumber && !/^\d{4,12}$/.test(accountNumber)) throw new Error('invalid_bank_account_number')

  return {
    ...input.patch,
    legal_name: legalName,
    supplier_business_name: businessName,
    personal_abn: abn,
    bank_account_name: bankAccountName,
    bank_bsb: bsb,
    bank_account_number: accountNumber,
  }
}

function profileResponse(row: any, includeBankDetails: boolean) {
  const bankComplete = !!(
    cleanText(row?.bank_account_name)
    && normalizeBsb(row?.bank_bsb).length === 6
    && normalizeBankAccountNumber(row?.bank_account_number)
  )
  return {
    user_id: row.user_id || row.id,
    username: row.username || null,
    display_name: row.display_name || null,
    role: row.role || null,
    legal_name: row.supplier_legal_name || row.legal_name || null,
    supplier_business_name: row.supplier_business_name || null,
    personal_abn: row.abn || row.personal_abn || null,
    gst_status: row.gst_status || 'unconfirmed',
    gst_effective_from: row.gst_effective_from || null,
    effective_from: row.effective_from || null,
    effective_to: row.effective_to || null,
    settlement_enabled: !!row.settlement_enabled,
    person_type: row.person_type || defaultPersonnelType(row.role),
    photo_id_uploaded: !!String(row.photo_id_url || '').trim(),
    bank_details_complete: bankComplete,
    bank_account_name: includeBankDetails ? row.bank_account_name || null : null,
    bank_bsb: includeBankDetails ? row.bank_bsb || null : null,
    bank_account_number: includeBankDetails ? row.bank_account_number || null : null,
    bank_bsb_masked: maskBsb(row.bank_bsb),
    bank_account_masked: maskAccount(row.bank_account_number),
    fee_rule_name: row.fee_rule_name || null,
    fee_rule_price_basis: row.fee_rule_price_basis || null,
    fee_rule_effective_from: row.fee_rule_effective_from || null,
    updated_at: row.updated_at || null,
  }
}

const PROFILE_SELECT = `
  SELECT u.id AS user_id, u.username, u.display_name, u.role, u.legal_name,
         u.personal_abn, u.bank_account_name, u.bank_bsb, u.bank_account_number,
         u.photo_id_url,
         p.id AS profile_id, p.effective_from::text, p.effective_to::text,
         p.settlement_enabled, p.person_type, p.supplier_legal_name,
         p.supplier_business_name, p.abn, p.gst_status,
         p.gst_effective_from::text, p.updated_at::text,
         r.name AS fee_rule_name, r.price_basis AS fee_rule_price_basis,
         r.effective_from::text AS fee_rule_effective_from
    FROM users u
    LEFT JOIN LATERAL (
      SELECT profile.*
        FROM personnel_settlement_profiles profile
       WHERE profile.user_id = u.id::text
         AND profile.effective_from <= CURRENT_DATE
         AND (profile.effective_to IS NULL OR profile.effective_to >= CURRENT_DATE)
       ORDER BY profile.effective_from DESC, profile.updated_at DESC
       LIMIT 1
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT rule.name, rule.price_basis, rule.effective_from
        FROM personnel_fee_rules rule
       WHERE rule.user_id = u.id::text
         AND rule.status = 'active'
         AND rule.effective_from <= CURRENT_DATE
         AND (rule.effective_to IS NULL OR rule.effective_to >= CURRENT_DATE)
       ORDER BY rule.effective_from DESC, rule.updated_at DESC
       LIMIT 1
    ) r ON true`

export async function listPersonnelSettlementProfiles(input: {
  search?: string
  includeBankDetails: boolean
}, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  assertPersonnelSettlementSchemaReady()
  const search = cleanText(input.search)
  const result = await executor.query(
    `${PROFILE_SELECT}
      WHERE ($1::text = '' OR CONCAT_WS(' ', u.username, u.display_name, u.legal_name, u.personal_abn) ILIKE '%' || $1 || '%')
      ORDER BY COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), ''), u.id::text)`,
    [search],
  )
  return (result.rows || []).map((row: any) => profileResponse(row, input.includeBankDetails))
}

export async function getPersonnelSettlementProfile(input: {
  userId: string
  includeBankDetails: boolean
}, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  assertPersonnelSettlementSchemaReady()
  const result = await executor.query(`${PROFILE_SELECT} WHERE u.id::text = $1 LIMIT 1`, [input.userId])
  const row = result.rows?.[0]
  return row ? profileResponse(row, input.includeBankDetails) : null
}

export async function savePersonnelSettlementProfile(input: {
  userId: string
  actorUserId: string
  source: 'mobile_self' | 'web_admin'
  reason?: string | null
  effectiveDate: string
  patch: PersonnelProfilePatch
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const patch = validatePersonnelProfilePatch(input)
  const saved = await pgRunInTransaction(async (client) => {
    const userResult = await client.query(
      `SELECT id, username, display_name, role, legal_name, personal_abn,
              bank_account_name, bank_bsb, bank_account_number, photo_id_url
         FROM users WHERE id::text=$1 FOR UPDATE`,
      [input.userId],
    )
    const user = userResult.rows?.[0]
    if (!user) throw new Error('user_not_found')

    const lockedResult = await client.query(
      `SELECT 1
         FROM personnel_weekly_settlements settlement
         JOIN personnel_settlement_batches batch ON batch.id = settlement.batch_id
        WHERE settlement.user_id=$1
          AND settlement.status = ANY($2::text[])
          AND batch.week_end >= $3::date
        LIMIT 1`,
      [input.userId, ['finance_approved', 'paid'], input.effectiveDate],
    )
    if (lockedResult.rowCount) throw new Error('profile_effective_date_locked')

    const profilesResult = await client.query(
      `SELECT * FROM personnel_settlement_profiles
        WHERE user_id=$1
        ORDER BY effective_from, created_at
        FOR UPDATE`,
      [input.userId],
    )
    const profiles = profilesResult.rows || []
    const exact = profiles.find((row: any) => String(row.effective_from) === input.effectiveDate) || null
    const current = exact || [...profiles].reverse().find((row: any) => (
      String(row.effective_from) <= input.effectiveDate
      && (!row.effective_to || String(row.effective_to) >= input.effectiveDate)
    )) || null
    const next = profiles.find((row: any) => String(row.effective_from) > input.effectiveDate) || null

    const merged = {
      settlement_enabled: patch.settlement_enabled ?? current?.settlement_enabled ?? false,
      person_type: patch.person_type || current?.person_type || defaultPersonnelType(user.role),
      supplier_legal_name: patch.legal_name === undefined
        ? nullableText(current?.supplier_legal_name ?? user.legal_name)
        : patch.legal_name,
      supplier_business_name: patch.supplier_business_name === undefined
        ? nullableText(current?.supplier_business_name)
        : patch.supplier_business_name,
      abn: patch.personal_abn === undefined
        ? (normalizeAbn(current?.abn ?? user.personal_abn) || null)
        : patch.personal_abn,
      gst_status: patch.gst_status || current?.gst_status || 'unconfirmed',
      gst_effective_from: (patch.gst_status || current?.gst_status || 'unconfirmed') === 'unconfirmed'
        ? null
        : input.effectiveDate,
      bank_account_name: patch.bank_account_name === undefined
        ? nullableText(user.bank_account_name)
        : patch.bank_account_name,
      bank_bsb: patch.bank_bsb === undefined ? normalizeBsb(user.bank_bsb) || null : patch.bank_bsb,
      bank_account_number: patch.bank_account_number === undefined
        ? normalizeBankAccountNumber(user.bank_account_number) || null
        : patch.bank_account_number,
    }

    if (merged.abn && !isValidAustralianAbn(merged.abn)) throw new Error('invalid_abn')
    if (merged.settlement_enabled && !merged.supplier_legal_name) throw new Error('legal_name_required')
    if (merged.settlement_enabled && !merged.abn) throw new Error('abn_required')
    if (merged.gst_status === 'registered' && !merged.abn) throw new Error('abn_required_for_gst')

    const before = safeAuditSnapshot({ ...current, ...user })
    if (!next) {
      await client.query(
        `UPDATE users
            SET legal_name=$1, personal_abn=$2, bank_account_name=$3,
                bank_bsb=$4, bank_account_number=$5
          WHERE id::text=$6`,
        [
          merged.supplier_legal_name,
          merged.abn,
          merged.bank_account_name,
          merged.bank_bsb,
          merged.bank_account_number,
          input.userId,
        ],
      )
    }

    let profileId = exact?.id || randomUUID()
    if (exact) {
      await client.query(
        `UPDATE personnel_settlement_profiles
            SET settlement_enabled=$1, person_type=$2, supplier_legal_name=$3,
                supplier_business_name=$4, abn=$5, gst_status=$6,
                gst_effective_from=$7::date, updated_by=$8, updated_at=now()
          WHERE id=$9`,
        [
          merged.settlement_enabled, merged.person_type, merged.supplier_legal_name,
          merged.supplier_business_name, merged.abn, merged.gst_status,
          merged.gst_effective_from, input.actorUserId, profileId,
        ],
      )
    } else {
      await client.query(
        `UPDATE personnel_settlement_profiles
            SET effective_to=$1::date - 1, updated_by=$2, updated_at=now()
          WHERE user_id=$3
            AND effective_from < $1::date
            AND (effective_to IS NULL OR effective_to >= $1::date)`,
        [input.effectiveDate, input.actorUserId, input.userId],
      )
      await client.query(
        `INSERT INTO personnel_settlement_profiles (
           id, user_id, effective_from, effective_to, settlement_enabled, person_type,
           supplier_legal_name, supplier_business_name, abn, gst_status,
           gst_effective_from, created_by, updated_by
         ) VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11::date,$12,$12)`,
        [
          profileId, input.userId, input.effectiveDate,
          next ? addDateOnlyDays(String(next.effective_from), -1) : null,
          merged.settlement_enabled, merged.person_type, merged.supplier_legal_name,
          merged.supplier_business_name, merged.abn, merged.gst_status,
          merged.gst_effective_from, input.actorUserId,
        ],
      )
    }

    const after = safeAuditSnapshot(merged)
    await client.query(
      `INSERT INTO personnel_settlement_profile_audits (
         id, user_id, profile_id, actor_user_id, actor_source, reason,
         effective_date, before_snapshot, after_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::jsonb,$9::jsonb)`,
      [
        randomUUID(), input.userId, profileId, input.actorUserId, input.source,
        cleanText(input.reason) || (input.source === 'mobile_self' ? 'self_service_profile_update' : null),
        input.effectiveDate, JSON.stringify(before), JSON.stringify(after),
      ],
    )
    return profileId
  })
  if (!saved) throw new Error('save_failed')
  return getPersonnelSettlementProfile({ userId: input.userId, includeBankDetails: true })
}
