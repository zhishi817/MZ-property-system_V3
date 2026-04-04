import { describe, expect, it } from 'vitest'
import { findLandlordForProperty, resolveManagementFeeRuleForMonth } from './managementFeeRules'

describe('management fee rules', () => {
  it('resolves the effective rule for a month', () => {
    const landlord = {
      id: 'l1',
      management_fee_rules: [
        { effective_from_month: '2026-05', management_fee_rate: 0.12 },
        { effective_from_month: '2025-01', management_fee_rate: 0.1 },
      ],
    }
    expect(resolveManagementFeeRuleForMonth(landlord, '2026-04').rate).toBe(0.1)
    expect(resolveManagementFeeRuleForMonth(landlord, '2026-05').rate).toBe(0.12)
  })

  it('returns missing baseline when no rule exists', () => {
    const landlord = { id: 'l1', management_fee_rate: 0.1, management_fee_rules: [] }
    const resolved = resolveManagementFeeRuleForMonth(landlord, '2026-05')
    expect(resolved.rate).toBeNull()
    expect(resolved.hasBaseline).toBe(false)
  })

  it('finds landlord by property link first and falls back to landlord id', () => {
    const landlords = [
      { id: 'l1', property_ids: ['p1'] },
      { id: 'l2', property_ids: ['p2'] },
    ]
    expect(findLandlordForProperty(landlords, 'p1', null)?.id).toBe('l1')
    expect(findLandlordForProperty(landlords, 'px', 'l2')?.id).toBe('l2')
  })
})
