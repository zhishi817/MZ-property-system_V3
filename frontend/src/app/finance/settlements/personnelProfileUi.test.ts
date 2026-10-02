import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  PERSONNEL_PAYMENT_METHOD_LABELS,
  isValidAustralianAbn,
  normalizePersonnelPaymentMethod,
  normalizeAustralianAbn,
  personnelPaymentMethodRequiresBankDetails,
  personnelProfileSaveErrorMessage,
} from './personnelProfileUi'

describe('personnel settlement profile UI', () => {
  it('normalizes ABN input and validates length without a mathematical checksum', () => {
    expect(normalizeAustralianAbn('53 004-085 616')).toBe('53004085616')
    expect(isValidAustralianAbn('53 004 085 616')).toBe(true)
    expect(isValidAustralianAbn('00000000000')).toBe(true)
    expect(isValidAustralianAbn('12 345 678 901')).toBe(true)
    expect(isValidAustralianAbn('1234')).toBe(false)
  })

  it('maps the backend ABN format error to a user-facing explanation', () => {
    expect(personnelProfileSaveErrorMessage({ code: 'invalid_abn' })).toContain('11 位数字')
    expect(personnelProfileSaveErrorMessage({ code: 'invalid_abn' })).not.toContain('校验和')
    expect(personnelProfileSaveErrorMessage(new Error('unexpected_error'))).toBe('unexpected_error')
    expect(personnelProfileSaveErrorMessage({ code: 'profile_version_stale' })).toContain('刷新列表')
    expect(personnelProfileSaveErrorMessage({ code: 'profile_effective_date_forward_move_not_allowed' })).toContain('只能保持不变或向前调整')
  })

  it('uses bank transfer for historical profiles and only requires bank details for that method', () => {
    expect(normalizePersonnelPaymentMethod(undefined)).toBe('bank_transfer')
    expect(PERSONNEL_PAYMENT_METHOD_LABELS.cash).toBe('现金支付')
    expect(PERSONNEL_PAYMENT_METHOD_LABELS.foreign_currency).toBe('外币支付')
    expect(PERSONNEL_PAYMENT_METHOD_LABELS.other).toBe('其他支付方式')
    expect(personnelPaymentMethodRequiresBankDetails('bank_transfer')).toBe(true)
    expect(personnelPaymentMethodRequiresBankDetails('cash')).toBe(false)
  })

  it('distinguishes profile and fee-rule effective dates in the drawers', () => {
    const profilePage = fs.readFileSync(path.resolve(process.cwd(), 'src/app/finance/settlements/page.tsx'), 'utf8')
    const feeRuleDrawer = fs.readFileSync(path.resolve(process.cwd(), 'src/app/finance/settlements/FeeRuleDrawer.tsx'), 'utf8')

    expect(profilePage).toContain('label="结算资料生效日期"')
    expect(profilePage).toContain('控制供应方/税务资料、人员类型、付款方式和结算开关从哪一天开始生效；银行资料不按日期建立历史版本。')
    expect(feeRuleDrawer).toContain('label="费用规则生效日期"')
    expect(feeRuleDrawer).toContain('控制本页计费方式和单价从哪一天开始用于结算。')
  })

  it('edits the loaded current profile version and sends its version boundary to the backend', () => {
    const profilePage = fs.readFileSync(path.resolve(process.cwd(), 'src/app/finance/settlements/page.tsx'), 'utf8')

    expect(profilePage).toContain('effective_date: detail.effective_from ? dayjs(detail.effective_from) : dayjs()')
    expect(profilePage).toContain('if (selected.effective_from) payload.current_effective_date = selected.effective_from')
    expect(profilePage).toContain('这里修改当前生效版本')
    expect(profilePage).toContain('银行资料保存到人员主资料并立即生效')
    expect(profilePage).toContain('当前生效日期为 ${saved.effective_from')
    expect(profilePage).toContain("date.isAfter(dayjs(selected.effective_from), 'day')")
  })

  it('shows only the current fee rule in the profile detail drawer without widening rule permissions', () => {
    const profilePage = fs.readFileSync(path.resolve(process.cwd(), 'src/app/finance/settlements/page.tsx'), 'utf8')

    expect(profilePage).toContain("mode === 'detail' && canManageRules")
    expect(profilePage).toContain('/rules`')
    expect(profilePage).toContain('rules.find((rule) => rule.is_current)')
    expect(profilePage).toContain('当前费用规则')
    expect(profilePage).toContain('当前生效')
    expect(profilePage).not.toContain('detailRuleHistory.map')
    expect(profilePage).toContain('生效期间：')
    expect(profilePage).toContain('feeRulePriceBasisLabel(selected.gst_status, detailCurrentRule.price_basis)')
    expect(profilePage).toContain('feeRuleItemLabel(item)')
  })

  it('keeps ABN and GST optional while enforcing registered-GST ABN and conditional bank fields', () => {
    const profilePage = fs.readFileSync(path.resolve(process.cwd(), 'src/app/finance/settlements/page.tsx'), 'utf8')

    expect(profilePage).toContain('GST 状态（可选）')
    expect(profilePage).toContain('allowClear placeholder="可留空（未确认）"')
    expect(profilePage).not.toContain("{ required: true, message: '请输入 ABN' }")
    expect(profilePage).toContain("form.getFieldValue('gst_status') === 'registered'")
    expect(profilePage).toContain('PERSONNEL_PAYMENT_METHOD_LABELS')
    expect(profilePage).toContain('personnelPaymentMethodRequiresBankDetails(watchedPaymentMethod)')
    expect(profilePage).toContain('原有银行资料会保留')
  })

  it('opens weekly settlements first and keeps the workflow tabs in priority order', () => {
    const profilePage = fs.readFileSync(path.resolve(process.cwd(), 'src/app/finance/settlements/page.tsx'), 'utf8')
    const weeklyTab = profilePage.indexOf("{ key: 'weekly', label: '周结算'")
    const claimsTab = profilePage.indexOf("{ key: 'claims', label: '工作量反馈'")
    const profilesTab = profilePage.indexOf("key: 'profiles'")

    expect(profilePage).toContain("useState('weekly')")
    expect(weeklyTab).toBeGreaterThan(-1)
    expect(claimsTab).toBeGreaterThan(weeklyTab)
    expect(profilesTab).toBeGreaterThan(claimsTab)
  })
})
