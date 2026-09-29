import { randomUUID } from 'crypto'
import { pgPool, pgRunInTransaction } from '../dbAdapter'
import {
  CLEANING_PROPERTY_TYPES,
  type CleaningPropertyType,
  type SettlementComponentType,
  type SettlementPriceBasis,
} from './personnelSettlement'
import { assertPersonnelSettlementSchemaReady } from './personnelSettlementSchema'

type Queryable = { query: (sql: string, params?: any[]) => Promise<any> }

export type PersonnelFeeRuleItemInput = {
  component_type: SettlementComponentType
  property_id?: string | null
  task_type?: string | null
  conditions?: {
    property_type?: string | null
  } | null
  priority?: number
  rate_cents: number
}

export type PersonnelFeeRuleInput = {
  name: string
  effective_date: string
  price_basis: SettlementPriceBasis
  notes?: string | null
  items: PersonnelFeeRuleItemInput[]
}

const COMPONENT_TYPES = new Set<SettlementComponentType>([
  'cleaning_task', 'inspection_day', 'warehouse_hour',
  'trial_task', 'trial_day', 'trial_hour',
  'external_task', 'external_day', 'external_hour',
  'weekly_fixed', 'subsidy_amount', 'overtime_hour',
  'new_property_task', 'custom_amount',
])
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const CLEANING_PROPERTY_TYPE_SET = new Set<string>(CLEANING_PROPERTY_TYPES)

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

function nullableText(value: unknown) {
  const normalized = cleanText(value)
  return normalized || null
}

function isDateOnly(value: unknown) {
  const text = cleanText(value)
  if (!DATE_ONLY.test(text)) return false
  const date = new Date(`${text}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text
}

function addDateOnlyDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function safeInteger(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`invalid_${field}`)
  return parsed
}

export function validatePersonnelFeeRuleInput(input: PersonnelFeeRuleInput) {
  const name = cleanText(input.name)
  const effectiveDate = cleanText(input.effective_date)
  const notes = nullableText(input.notes)
  if (!name || name.length > 120) throw new Error('invalid_rule_name')
  if (!isDateOnly(effectiveDate)) throw new Error('invalid_rule_effective_date')
  if (input.price_basis !== 'exclusive_gst' && input.price_basis !== 'inclusive_gst') {
    throw new Error('invalid_rule_price_basis')
  }
  if (notes && notes.length > 1000) throw new Error('rule_notes_too_long')
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) {
    throw new Error('invalid_rule_items')
  }

  const scopes = new Set<string>()
  const cleaningPropertyTypes = new Set<CleaningPropertyType>()
  const items = input.items.map((item) => {
    const componentType = cleanText(item?.component_type) as SettlementComponentType
    if (!COMPONENT_TYPES.has(componentType)) throw new Error('invalid_rule_component_type')
    const propertyId = nullableText(item?.property_id)
    const taskType = nullableText(item?.task_type)
    const rawConditions = item?.conditions
    if (rawConditions != null && (typeof rawConditions !== 'object' || Array.isArray(rawConditions))) {
      throw new Error('invalid_rule_conditions')
    }
    const propertyType = nullableText(rawConditions?.property_type)
    if (componentType === 'cleaning_task') {
      if (!propertyType || !CLEANING_PROPERTY_TYPE_SET.has(propertyType)) {
        throw new Error('invalid_rule_cleaning_property_type')
      }
      if (cleaningPropertyTypes.has(propertyType as CleaningPropertyType)) {
        throw new Error('invalid_rule_duplicate_cleaning_property_type')
      }
      cleaningPropertyTypes.add(propertyType as CleaningPropertyType)
    } else if (propertyType) {
      throw new Error('invalid_rule_property_type_scope')
    }
    const requestedPriority = safeInteger(item?.priority ?? 0, 'rule_priority', 0, 100000)
    const priority = componentType === 'cleaning_task'
      ? CLEANING_PROPERTY_TYPES.length - CLEANING_PROPERTY_TYPES.indexOf(propertyType as CleaningPropertyType)
      : requestedPriority
    const rateCents = safeInteger(item?.rate_cents, 'rule_rate_cents', 0, 100_000_000)
    const scope = `${componentType}\u0000${propertyId || ''}\u0000${taskType || ''}\u0000${propertyType || ''}\u0000${priority}`
    if (scopes.has(scope)) throw new Error('duplicate_rule_item_scope')
    scopes.add(scope)
    return {
      component_type: componentType,
      property_id: propertyId,
      task_type: taskType,
      conditions: propertyType ? { property_type: propertyType as CleaningPropertyType } : {},
      priority,
      rate_cents: rateCents,
    }
  })

  if (cleaningPropertyTypes.size > 0 && cleaningPropertyTypes.size !== CLEANING_PROPERTY_TYPES.length) {
    throw new Error('invalid_rule_cleaning_property_type_rates_incomplete')
  }

  return {
    name,
    effective_date: effectiveDate,
    price_basis: input.price_basis,
    notes,
    items,
  }
}

function serializeRuleRows(rows: any[]) {
  const rules = new Map<string, any>()
  for (const row of rows) {
    let rule = rules.get(row.rule_id)
    if (!rule) {
      rule = {
        id: row.rule_id,
        user_id: row.user_id,
        name: row.rule_name,
        status: row.status,
        effective_from: row.effective_from,
        effective_to: row.effective_to,
        price_basis: row.price_basis,
        currency: row.currency,
        notes: row.notes,
        created_by: row.created_by,
        updated_by: row.updated_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        is_current: !!row.is_current,
        items: [],
      }
      rules.set(row.rule_id, rule)
    }
    if (row.item_id) {
      rule.items.push({
        id: row.item_id,
        component_type: row.component_type,
        property_id: row.property_id,
        task_type: row.task_type,
        conditions: row.conditions && typeof row.conditions === 'object' ? row.conditions : {},
        priority: Number(row.priority || 0),
        rate_cents: safeInteger(row.rate_cents, 'rule_rate_cents', 0, 100_000_000),
      })
    }
  }
  return Array.from(rules.values())
}

const RULE_HISTORY_SELECT = `
  SELECT r.id AS rule_id, r.user_id, r.name AS rule_name, r.status,
         r.effective_from::text, r.effective_to::text, r.price_basis, r.currency,
         r.notes, r.created_by, r.updated_by, r.created_at::text, r.updated_at::text,
         (r.status='active' AND r.effective_from <= CURRENT_DATE
          AND (r.effective_to IS NULL OR r.effective_to >= CURRENT_DATE)) AS is_current,
         i.id AS item_id, i.component_type, i.property_id, i.task_type,
         i.conditions, i.priority, i.rate_cents
    FROM personnel_fee_rules r
    LEFT JOIN personnel_fee_rule_items i ON i.rule_id=r.id
   WHERE r.user_id=$1
   ORDER BY r.effective_from DESC, r.created_at DESC, i.priority DESC, i.id`

export async function listPersonnelFeeRuleHistory(userId: string, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  assertPersonnelSettlementSchemaReady()
  const result = await executor.query(RULE_HISTORY_SELECT, [userId])
  return serializeRuleRows(result.rows || [])
}

const RULE_EFFECTIVE_DATE_LOCK_SELECT = `
  SELECT MAX(batch.week_end)::text AS locked_through
    FROM personnel_weekly_settlements settlement
    JOIN personnel_settlement_batches batch ON batch.id=settlement.batch_id
   WHERE settlement.user_id=$1
     AND settlement.status=ANY($2::text[])`

export function buildPersonnelFeeRuleEffectiveDateConstraint(lockedThrough: unknown) {
  const normalized = cleanText(lockedThrough)
  return {
    locked_through: isDateOnly(normalized) ? normalized : null,
    earliest_effective_date: isDateOnly(normalized) ? addDateOnlyDays(normalized, 1) : null,
  }
}

export async function getPersonnelFeeRuleEffectiveDateConstraint(userId: string, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  assertPersonnelSettlementSchemaReady()
  const result = await executor.query(RULE_EFFECTIVE_DATE_LOCK_SELECT, [userId, ['finance_approved', 'paid']])
  return buildPersonnelFeeRuleEffectiveDateConstraint(result.rows?.[0]?.locked_through)
}

export async function savePersonnelFeeRule(input: {
  userId: string
  actorUserId: string
  rule: PersonnelFeeRuleInput
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const rule = validatePersonnelFeeRuleInput(input.rule)
  const ruleId = await pgRunInTransaction(async (client) => {
    const user = await client.query('SELECT id FROM users WHERE id::text=$1 FOR UPDATE', [input.userId])
    if (!user.rowCount) throw new Error('user_not_found')

    const locked = await client.query(RULE_EFFECTIVE_DATE_LOCK_SELECT, [input.userId, ['finance_approved', 'paid']])
    const constraint = buildPersonnelFeeRuleEffectiveDateConstraint(locked.rows?.[0]?.locked_through)
    if (constraint.locked_through && constraint.locked_through >= rule.effective_date) {
      const error: any = new Error('rule_effective_date_locked')
      error.constraints = constraint
      throw error
    }

    const existingResult = await client.query(
      `SELECT * FROM personnel_fee_rules
        WHERE user_id=$1 AND status='active'
        ORDER BY effective_from, created_at
        FOR UPDATE`,
      [input.userId],
    )
    const existing = existingResult.rows || []
    const exact = existing.find((row: any) => String(row.effective_from) === rule.effective_date) || null
    const next = existing.find((row: any) => String(row.effective_from) > rule.effective_date) || null
    const savedRuleId = exact?.id || randomUUID()

    if (exact) {
      await client.query(
        `UPDATE personnel_fee_rules
            SET name=$1, price_basis=$2, notes=$3, updated_by=$4, updated_at=now()
          WHERE id=$5`,
        [rule.name, rule.price_basis, rule.notes, input.actorUserId, savedRuleId],
      )
      await client.query('DELETE FROM personnel_fee_rule_items WHERE rule_id=$1', [savedRuleId])
    } else {
      await client.query(
        `UPDATE personnel_fee_rules
            SET effective_to=$1::date - 1, updated_by=$2, updated_at=now()
          WHERE user_id=$3 AND status='active'
            AND effective_from < $1::date
            AND (effective_to IS NULL OR effective_to >= $1::date)`,
        [rule.effective_date, input.actorUserId, input.userId],
      )
      await client.query(
        `INSERT INTO personnel_fee_rules (
           id, user_id, name, status, effective_from, effective_to,
           price_basis, currency, notes, created_by, updated_by
         ) VALUES ($1,$2,$3,'active',$4::date,$5::date,$6,'AUD',$7,$8,$8)`,
        [
          savedRuleId, input.userId, rule.name, rule.effective_date,
          next ? addDateOnlyDays(String(next.effective_from), -1) : null,
          rule.price_basis, rule.notes, input.actorUserId,
        ],
      )
    }

    for (const item of rule.items) {
      await client.query(
        `INSERT INTO personnel_fee_rule_items (
           id, rule_id, component_type, property_id, task_type, conditions, priority, rate_cents
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          randomUUID(), savedRuleId, item.component_type, item.property_id, item.task_type,
          JSON.stringify(item.conditions), item.priority, item.rate_cents,
        ],
      )
    }
    return savedRuleId
  })
  if (!ruleId) throw new Error('save_rule_failed')
  const history = await listPersonnelFeeRuleHistory(input.userId)
  return history.find((entry) => entry.id === ruleId) || null
}
