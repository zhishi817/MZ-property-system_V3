import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'
import {
  canUseSettlementAction,
  formatClaimTimeRange,
  formatDateOnly,
  formatPersonnelDuration,
  formatSettlementWeekRange,
  formatMoney,
  getClaimReviewInputMode,
  mondayForDate,
  previousCompletedWeekStart,
} from './settlementWorkflowUi'

describe('settlement workflow UI', () => {
  it('normalizes selected dates to Monday and defaults to the last completed week', () => {
    expect(mondayForDate(dayjs('2026-09-06')).format('YYYY-MM-DD')).toBe('2026-08-31')
    expect(mondayForDate(dayjs('2026-09-09')).format('YYYY-MM-DD')).toBe('2026-09-07')
    expect(previousCompletedWeekStart(dayjs('2026-09-11')).format('YYYY-MM-DD')).toBe('2026-08-31')
    expect(formatSettlementWeekRange(dayjs('2026-09-09'))).toBe('2026-09-07 至 2026-09-13')
  })

  it('shows management and payout actions only for allowed status and permission', () => {
    const manager = { canManage: true, canPayout: false, canBank: false }
    const finance = { canManage: false, canPayout: true, canBank: true }
    const financeWithoutBank = { canManage: false, canPayout: true, canBank: false }
    expect(canUseSettlementAction('confirmed', 'return_for_confirmation', manager)).toBe(true)
    expect(canUseSettlementAction('confirmed', 'return_for_confirmation', finance)).toBe(true)
    expect(canUseSettlementAction('confirmed', 'confirm_paid', manager)).toBe(false)
    expect(canUseSettlementAction('confirmed', 'confirm_paid', finance)).toBe(true)
    expect(canUseSettlementAction('confirmed', 'confirm_paid', financeWithoutBank)).toBe(false)
    expect(canUseSettlementAction('finance_approved', 'confirm_paid', finance)).toBe(true)
    expect(canUseSettlementAction('disputed', 'resolve_dispute', manager)).toBe(true)
    expect(canUseSettlementAction('disputed', 'resolve_dispute', finance)).toBe(true)
    expect(canUseSettlementAction('disputed', 'resolve_dispute', { canManage: false, canPayout: false, canBank: false })).toBe(false)
    expect(canUseSettlementAction('disputed', 'reopen', manager)).toBe(false)
    expect(canUseSettlementAction('paid', 'void', finance)).toBe(false)
  })

  it('formats integer cents as AUD', () => {
    expect(formatMoney(12555)).toContain('125.55')
    expect(formatDateOnly('2026-09-13')).toBe('13/09/2026')
  })

  it('formats settlement work duration with the same hour and minute wording as mobile', () => {
    expect(formatPersonnelDuration(70)).toBe('1 小时 10 分钟')
    expect(formatPersonnelDuration(360)).toBe('6 小时')
    expect(formatPersonnelDuration(40)).toBe('40 分钟')
    expect(formatPersonnelDuration(0)).toBe('-')
  })

  it('selects only the input that matches each claim calculation basis', () => {
    expect(getClaimReviewInputMode('warehouse_hour')).toBe('time_range')
    expect(getClaimReviewInputMode('new_property_task')).toBe('time_range')
    expect(getClaimReviewInputMode('external_day')).toBe('day')
    expect(getClaimReviewInputMode('external_task')).toBe('quantity')
    expect(getClaimReviewInputMode('subsidy_amount')).toBe('amount')
    expect(formatClaimTimeRange('2026-09-14T17:10:00+10:00', '2026-09-14T18:00:00+10:00')).toBe('17:10–18:00')
  })

  it('labels both filters as weeks and keeps claim work dates separate', () => {
    const weeklyPanel = fs.readFileSync(path.resolve(process.cwd(), 'src/app/finance/settlements/WeeklySettlementsPanel.tsx'), 'utf8')
    const claimsPanel = fs.readFileSync(path.resolve(process.cwd(), 'src/app/finance/settlements/WorkloadClaimsPanel.tsx'), 'utf8')

    expect(weeklyPanel).toContain('<Typography.Text strong>结算周</Typography.Text>')
    expect(weeklyPanel).toContain('picker="week"')
    expect(weeklyPanel).not.toContain('生成 / 重算所选周')
    expect(weeklyPanel).not.toContain('批量生成与发起记录')
    expect(weeklyPanel).toContain('合作方先在移动端提交上一完整周的工作量')
    expect(weeklyPanel).toContain("missing_effective_profile: '该人员在任务日期没有已启用的结算资料。'")
    expect(weeklyPanel).toContain("label: '重新核对'")
    expect(weeklyPanel).toContain('重新核对结算')
    expect(weeklyPanel).toContain('本周补充内容')
    expect(weeklyPanel).toContain('确认自动汇总金额')
    expect(weeklyPanel).toContain('特殊调整总额')
    expect(weeklyPanel).toContain('已自动计入本周结算')
    expect(weeklyPanel).toContain('重新发起给')
    expect(weeklyPanel).toContain('确认并自动计入')
    expect(weeklyPanel).toContain('反馈已确认并自动计入')
    expect(weeklyPanel).toContain('确认并重新发起')
    expect(weeklyPanel).toContain('确认已付款')
    expect(weeklyPanel).toContain('退回合作方再次确认')
    expect(weeklyPanel).toContain('退回再次确认')
    expect(weeklyPanel).toContain('请先在银行完成转账')
    expect(weeklyPanel).not.toContain('登记转账')
    expect(weeklyPanel).not.toContain('payment_amount_cents')
    expect(weeklyPanel).not.toContain('银行转账编号')
    expect(weeklyPanel).not.toContain('转账编号')
    expect(weeklyPanel).not.toContain('payment_reference')
    expect(weeklyPanel).toContain("title: '付款日期'")
    expect(weeklyPanel).not.toContain("action === 'resolve_dispute' || action === 'void'")
    expect(claimsPanel).toContain('<Typography.Text strong>所属周</Typography.Text>')
    expect(claimsPanel).toContain('picker="week"')
    expect(claimsPanel).toContain("{ title: '工作日期', dataIndex: 'service_date'")
    expect(claimsPanel).toContain('系统自动计算')
    expect(claimsPanel).toContain('确认计入金额')
    expect(claimsPanel).toContain('确认并计入')
    expect(claimsPanel).not.toContain('直接确认金额（AUD，可选）')
  })
})
