import { describe, expect, it } from 'vitest'
import {
  CLEANING_PROPERTY_TYPES,
  FEE_COMPONENT_LABELS,
  centsToDollars,
  cleaningPropertyTypeItems,
  cleaningRuleItemLabel,
  defaultComponentForPersonType,
  dollarsToCents,
  feeRuleCopyTargetEffectiveDate,
  feeRuleEffectiveDateLockMessage,
  feeRuleHistoricalSaveWarning,
  feeRuleItemsValidationError,
  feeRulePriceBasisForGstStatus,
  feeRulePriceBasisLabel,
  feeRuleSaveErrorMessage,
  isFeeRuleEffectiveDateLocked,
} from './feeRuleUi'

describe('feeRuleUi', () => {
  it('converts displayed AUD values to integer cents without floating point drift', () => {
    expect(dollarsToCents(125.55)).toBe(12555)
    expect(dollarsToCents('0.10')).toBe(10)
    expect(centsToDollars(12555)).toBe(125.55)
  })

  it('chooses the expected first calculation method by person type', () => {
    expect(defaultComponentForPersonType('cleaner')).toBe('cleaning_task')
    expect(defaultComponentForPersonType('inspector')).toBe('inspection_day')
    expect(defaultComponentForPersonType('warehouse')).toBe('warehouse_hour')
    expect(defaultComponentForPersonType('trial')).toBe('trial_day')
    expect(defaultComponentForPersonType('external')).toBe('external_day')
  })

  it('rejects invalid or unsafe displayed rates', () => {
    expect(() => dollarsToCents(-1)).toThrow('invalid_rate_dollars')
    expect(() => dollarsToCents(Number.NaN)).toThrow('invalid_rate_dollars')
    expect(() => dollarsToCents(1_000_001)).toThrow('invalid_rate_dollars')
  })

  it('builds and validates the complete six-room-type cleaning matrix', () => {
    const items = cleaningPropertyTypeItems({ rate_dollars: 100 })
    expect(items.map((item) => item.property_type)).toEqual(CLEANING_PROPERTY_TYPES)
    expect(feeRuleItemsValidationError(items)).toBeNull()
    expect(feeRuleItemsValidationError(items.slice(0, 5))).toBe('清洁规则必须完整配置 6 种房型单价')
    expect(feeRuleItemsValidationError([...items, { ...items[0] }])).toBe('同一房型只能配置一次')
  })

  it('labels room-type and legacy flat cleaning rules clearly', () => {
    expect(cleaningRuleItemLabel('两房两卫')).toBe('清洁：两房两卫')
    expect(cleaningRuleItemLabel(null)).toBe('清洁：旧统一单价')
  })

  it('labels new-property work as an hourly calculation method', () => {
    expect(FEE_COMPONENT_LABELS.new_property_task).toBe('上新房：每小时')
  })

  it('removes the GST price-basis choice for non-registered personnel', () => {
    expect(feeRulePriceBasisForGstStatus('registered', 'inclusive_gst')).toBe('inclusive_gst')
    expect(feeRulePriceBasisForGstStatus('not_registered', 'inclusive_gst')).toBe('exclusive_gst')
    expect(feeRulePriceBasisLabel('not_registered', 'inclusive_gst')).toContain('不适用')
  })

  it('keeps non-cleaning calculation methods unique', () => {
    expect(feeRuleItemsValidationError([
      { component_type: 'warehouse_hour' },
      { component_type: 'warehouse_hour' },
    ])).toBe('同一版本中，相同计算方式只能配置一次')
  })

  it('explains and pre-validates the immutable settlement date boundary', () => {
    const constraints = { locked_through: '2026-09-06', earliest_effective_date: '2026-09-07' }
    expect(isFeeRuleEffectiveDateLocked('2026-09-06', constraints)).toBe(true)
    expect(isFeeRuleEffectiveDateLocked('2026-09-07', constraints)).toBe(false)
    expect(feeRuleEffectiveDateLockMessage(constraints)).toContain('新规则最早可从 2026-09-07 生效')
    expect(feeRuleSaveErrorMessage({ code: 'rule_effective_date_locked' }, constraints)).toContain('2026-09-07')
    expect(feeRuleSaveErrorMessage({ message: 'rule_effective_date_locked', constraints }, null)).not.toContain('rule_effective_date_locked')
  })

  it('warns when a save only changes a historical interval', () => {
    const rules = [
      { effective_from: '2026-09-14', effective_to: null, is_current: true },
      { effective_from: '2026-09-07', effective_to: '2026-09-13', is_current: false },
    ]
    expect(feeRuleHistoricalSaveWarning('2026-09-07', rules)).toBe(
      '所选日期只会保存 2026-09-07 至 2026-09-13 的历史规则；2026-09-14 起的后续版本不会改变。',
    )
    expect(feeRuleHistoricalSaveWarning('2026-09-14', rules)).toBe('')
  })

  it('copies a historical rule to the writable current boundary', () => {
    const rules = [
      { effective_from: '2026-09-14', effective_to: null, is_current: true },
      { effective_from: '2026-09-07', effective_to: '2026-09-13', is_current: false },
    ]
    expect(feeRuleCopyTargetEffectiveDate(rules, {
      locked_through: '2026-09-06', earliest_effective_date: '2026-09-07',
    }, '2026-09-25')).toBe('2026-09-14')
    expect(feeRuleCopyTargetEffectiveDate(rules, {
      locked_through: '2026-09-14', earliest_effective_date: '2026-09-15',
    }, '2026-09-25')).toBe('2026-09-15')
  })
})
