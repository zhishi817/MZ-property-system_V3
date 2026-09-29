import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  isValidAustralianAbn,
  normalizeAustralianAbn,
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
  })

  it('distinguishes profile and fee-rule effective dates in the drawers', () => {
    const profilePage = fs.readFileSync(path.resolve(process.cwd(), 'src/app/finance/settlements/page.tsx'), 'utf8')
    const feeRuleDrawer = fs.readFileSync(path.resolve(process.cwd(), 'src/app/finance/settlements/FeeRuleDrawer.tsx'), 'utf8')

    expect(profilePage).toContain('label="结算资料生效日期"')
    expect(profilePage).toContain('控制本页姓名、ABN、GST、人员类型、结算开关及银行资料从哪一天开始生效。')
    expect(feeRuleDrawer).toContain('label="费用规则生效日期"')
    expect(feeRuleDrawer).toContain('控制本页计费方式和单价从哪一天开始用于结算。')
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
    expect(profilePage).toContain('PRICE_BASIS_LABELS[detailCurrentRule.price_basis]')
    expect(profilePage).toContain('feeRuleItemLabel(item)')
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
