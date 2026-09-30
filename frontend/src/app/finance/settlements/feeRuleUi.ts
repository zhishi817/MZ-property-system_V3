export const FEE_COMPONENT_LABELS = {
  cleaning_task: '清洁：每个完成房源/任务',
  inspection_day: '检查：每天固定费用',
  warehouse_hour: '仓管：每小时',
  trial_task: '试工：每个任务',
  trial_day: '试工：每天固定费用',
  trial_hour: '试工：每小时',
  external_task: '编外：每个任务',
  external_day: '编外：每天固定费用',
  external_hour: '编外：每小时',
  weekly_fixed: '每周固定费用',
  subsidy_amount: '补贴：每个核准数量',
  overtime_hour: '加班：每小时',
  new_property_task: '上新房：每小时',
  custom_amount: '其他：每个核准数量',
} as const

export type FeeComponentType = keyof typeof FEE_COMPONENT_LABELS

export const CLEANING_PROPERTY_TYPES = [
  '一房一卫',
  '两房一卫',
  '两房两卫',
  '三房两卫',
  '三房三卫',
  '4房3.5卫',
] as const

export type CleaningPropertyType = typeof CLEANING_PROPERTY_TYPES[number]

export type FeeRuleDraftItem = {
  component_type?: FeeComponentType
  property_type?: string | null
}

export const PRICE_BASIS_LABELS = {
  exclusive_gst: '未含 GST（注册 GST 后另加 10%）',
  inclusive_gst: '已含 GST（系统从总额中拆分 GST）',
} as const

export type FeePriceBasis = keyof typeof PRICE_BASIS_LABELS

export function feeRulePriceBasisForGstStatus(
  gstStatus: unknown,
  priceBasis: FeePriceBasis = 'exclusive_gst',
): FeePriceBasis {
  return gstStatus === 'not_registered' ? 'exclusive_gst' : priceBasis
}

export function feeRulePriceBasisLabel(gstStatus: unknown, priceBasis: FeePriceBasis) {
  return gstStatus === 'not_registered'
    ? '不适用（未注册 GST，GST 为 $0）'
    : PRICE_BASIS_LABELS[priceBasis]
}

export type FeeRuleEffectiveDateConstraint = {
  locked_through: string | null
  earliest_effective_date: string | null
}

export type FeeRuleVersionSummary = {
  effective_from: string
  effective_to?: string | null
  is_current?: boolean
}

function addDateOnlyDays(value: string, days: number) {
  const normalized = String(value || '').trim()
  const date = new Date(`${normalized}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(date.getTime())) return ''
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function isFeeRuleEffectiveDateLocked(value: string, constraints?: FeeRuleEffectiveDateConstraint | null) {
  const normalized = String(value || '').trim()
  return Boolean(normalized && constraints?.locked_through && normalized <= constraints.locked_through)
}

export function feeRuleEffectiveDateLockMessage(constraints?: FeeRuleEffectiveDateConstraint | null) {
  if (!constraints?.locked_through || !constraints.earliest_effective_date) return ''
  return `已确认或已付款结算锁定至 ${constraints.locked_through}；新规则最早可从 ${constraints.earliest_effective_date} 生效。`
}

export function feeRuleHistoricalSaveWarning(
  effectiveDate: string,
  rules: ReadonlyArray<FeeRuleVersionSummary>,
) {
  const normalized = String(effectiveDate || '').trim()
  const next = rules
    .filter((rule) => String(rule.effective_from || '').trim() > normalized)
    .sort((left, right) => left.effective_from.localeCompare(right.effective_from))[0]
  if (!normalized || !next) return ''
  const effectiveTo = addDateOnlyDays(next.effective_from, -1)
  if (!effectiveTo) return ''
  return `所选日期只会保存 ${normalized} 至 ${effectiveTo} 的历史规则；${next.effective_from} 起的后续版本不会改变。`
}

export function feeRuleCopyTargetEffectiveDate(
  rules: ReadonlyArray<FeeRuleVersionSummary>,
  constraints: FeeRuleEffectiveDateConstraint | null | undefined,
  fallbackDate: string,
) {
  const current = rules.find((rule) => rule.is_current)
  if (current?.effective_from && !isFeeRuleEffectiveDateLocked(current.effective_from, constraints)) {
    return current.effective_from
  }
  return constraints?.earliest_effective_date || fallbackDate
}

export function feeRuleSaveErrorMessage(error: any, constraints?: FeeRuleEffectiveDateConstraint | null) {
  const code = String(error?.code || error?.message || '').trim()
  if (code === 'rule_effective_date_locked') {
    const current = error?.constraints || constraints
    return feeRuleEffectiveDateLockMessage(current) || '该日期涉及已确认或已付款的历史结算，请选择锁定周期之后的日期。'
  }
  return String(error?.message || '费用规则保存失败')
}

export function cleaningPropertyTypeItems<T extends Record<string, unknown>>(defaults: T) {
  return CLEANING_PROPERTY_TYPES.map((propertyType) => ({
    ...defaults,
    component_type: 'cleaning_task' as const,
    property_type: propertyType,
  }))
}

export function feeRuleItemsValidationError(items: FeeRuleDraftItem[]) {
  const cleaningItems = items.filter((item) => item.component_type === 'cleaning_task')
  if (cleaningItems.length) {
    const configuredTypes = cleaningItems.map((item) => String(item.property_type || '').trim()).filter(Boolean)
    if (new Set(configuredTypes).size !== configuredTypes.length) return '同一房型只能配置一次'
    if (
      configuredTypes.length !== CLEANING_PROPERTY_TYPES.length
      || CLEANING_PROPERTY_TYPES.some((propertyType) => !configuredTypes.includes(propertyType))
    ) return '清洁规则必须完整配置 6 种房型单价'
  }

  const otherComponents = items
    .map((item) => item.component_type)
    .filter((componentType): componentType is FeeComponentType => Boolean(componentType && componentType !== 'cleaning_task'))
  if (new Set(otherComponents).size !== otherComponents.length) return '同一版本中，相同计算方式只能配置一次'
  return null
}

export function cleaningRuleItemLabel(propertyType?: string | null) {
  const normalized = String(propertyType || '').trim()
  return normalized ? `清洁：${normalized}` : '清洁：旧统一单价'
}

export function dollarsToCents(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) throw new Error('invalid_rate_dollars')
  return Math.round((parsed + Number.EPSILON) * 100)
}

export function centsToDollars(value: unknown) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed / 100 : 0
}

export function defaultComponentForPersonType(personType: string): FeeComponentType {
  if (personType === 'cleaner') return 'cleaning_task'
  if (personType === 'inspector') return 'inspection_day'
  if (personType === 'warehouse') return 'warehouse_hour'
  if (personType === 'trial') return 'trial_day'
  if (personType === 'external') return 'external_day'
  return 'cleaning_task'
}
