import assert from 'node:assert/strict'
import {
  buildDailyNecessityAutoExpenseDecision,
  computeDailyNecessityAmount,
  normalizeDailyNecessityPayMethod,
  normalizeDailyNecessityStatus,
} from '../../src/lib/dailyNecessitiesAutoExpense'

function testAmountUsesSellingUnitPrice() {
  assert.equal(computeDailyNecessityAmount({ quantity: 2, unit_price: 7.5 }), 15)
  assert.equal(computeDailyNecessityAmount({ quantity: 3, cost_unit_price: 1.2, unit_price: 4 }), 12)
}

function testLandlordReplacementBuildsConsumablesExpenseDecision() {
  const decision = buildDailyNecessityAutoExpenseDecision({
    id: 'daily-1',
    property_id: 'prop-1',
    status: 'replaced',
    pay_method: 'landlord_pay',
    replacement_at: '2026-07-03T10:30:00+10:00',
    item_name: 'Toilet paper',
    quantity: 2,
    unit_price: 6.25,
    invoice_description_en: 'Daily supplies replacement - toilet paper',
  })

  assert.equal(decision.refType, 'daily_necessities')
  assert.equal(decision.refId, 'daily-1')
  assert.equal(decision.propertyId, 'prop-1')
  assert.equal(decision.status, 'completed')
  assert.equal(decision.payMethod, 'landlord_pay')
  assert.equal(decision.occurredAt, '2026-07-03')
  assert.equal(decision.amount, 12.5)
  assert.equal(decision.category, 'consumables')
  assert.equal(decision.categoryDetail, '日用品更换')
  assert.equal(decision.sourceTitle, '日用品更换 Toilet paper')
  assert.equal(decision.sourceSummary, 'Daily supplies replacement - toilet paper')
}

function testStatusAndPayMethodNormalization() {
  assert.equal(normalizeDailyNecessityStatus('need_replace'), 'pending')
  assert.equal(normalizeDailyNecessityStatus('no_action'), 'void')
  assert.equal(normalizeDailyNecessityStatus('已更换'), 'completed')
  assert.equal(normalizeDailyNecessityPayMethod('房东支付'), 'landlord_pay')
  assert.equal(normalizeDailyNecessityPayMethod('company_pay'), 'company_pay')
}

testAmountUsesSellingUnitPrice()
testLandlordReplacementBuildsConsumablesExpenseDecision()
testStatusAndPayMethodNormalization()

console.log('test_daily_necessities_auto_expense: ok')
