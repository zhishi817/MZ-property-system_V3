export type ManagementFeeRule = {
  id?: string
  landlord_id?: string
  effective_from_month: string
  management_fee_rate: number
  note?: string | null
}

export type LandlordWithManagementFeeRules = {
  id: string
  name?: string
  management_fee_rate?: number
  property_ids?: string[]
  management_fee_rules?: ManagementFeeRule[]
}

export function isValidMonthKey(monthKey?: string | null) {
  return /^\d{4}-\d{2}$/.test(String(monthKey || '').trim())
}

export function resolveManagementFeeRuleForMonth(landlord: LandlordWithManagementFeeRules | null | undefined, monthKey: string) {
  const month = String(monthKey || '').trim()
  if (!landlord || !isValidMonthKey(month)) return { rule: null as ManagementFeeRule | null, rate: null as number | null, hasBaseline: false }
  const rules = (Array.isArray(landlord.management_fee_rules) ? landlord.management_fee_rules : [])
    .filter((r) => isValidMonthKey(String(r?.effective_from_month || '')))
    .slice()
    .sort((a, b) => String(b.effective_from_month || '').localeCompare(String(a.effective_from_month || '')))
  const rule = rules.find((r) => String(r.effective_from_month || '') <= month) || null
  return {
    rule,
    rate: rule ? Number(rule.management_fee_rate || 0) : null,
    hasBaseline: rules.length > 0,
  }
}

export function findLandlordForProperty(landlords: LandlordWithManagementFeeRules[] | undefined, propertyId: string, landlordId?: string | null) {
  const list = Array.isArray(landlords) ? landlords : []
  const pid = String(propertyId || '').trim()
  const lid = String(landlordId || '').trim()
  return (
    list.find((l) => Array.isArray(l.property_ids) && l.property_ids.includes(pid)) ||
    (lid ? list.find((l) => String(l.id || '') === lid) : undefined) ||
    null
  )
}

