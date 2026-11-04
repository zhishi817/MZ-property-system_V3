import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  computeMonthSegmentsForOrders,
  computeOwnerRentIncomeWithExistingProration,
  computeOwnerStatementMonthSegmentsForOrders,
  shouldIncludeOrderInOwnerStatement,
  sumSegmentsVisibleNetIncome,
} from '../../src/lib/orderMonthSegments'
import { buildCompanyRevenueReport } from '../../src/lib/companyRevenueReport'

function ids(rows: any[]): string[] {
  return rows.map((row) => String(row.id || '')).sort()
}

function main() {
  const orders: any[] = [
    { id: 'cancel-zero-unchecked', property_id: 'p1', checkin: '2026-03-02', checkout: '2026-03-04', net_income: 0, status: 'cancelled', count_in_income: false },
    { id: 'cancel-paid-checked', property_id: 'p1', checkin: '2026-03-05', checkout: '2026-03-07', net_income: 400, status: 'canceled', count_in_income: true },
    { id: 'cancel-paid-unchecked', property_id: 'p1', checkin: '2026-03-08', checkout: '2026-03-10', net_income: 300, status: 'CANCELLED', count_in_income: false },
    { id: 'normal-zero', property_id: 'p1', checkin: '2026-03-11', checkout: '2026-03-13', net_income: 0, status: 'confirmed', count_in_income: false },
    { id: 'normal-paid', property_id: 'p1', checkin: '2026-03-14', checkout: '2026-03-16', net_income: 500, status: 'confirmed', count_in_income: true },
    { id: 'restored', property_id: 'p1', checkin: '2026-03-17', checkout: '2026-03-18', net_income: 200, status: 'confirmed', count_in_income: true },
    { id: 'cancel-pending', property_id: 'p1', checkin: '2026-03-19', checkout: '2026-03-21', net_income: 250, status: 'cancellation_pending', count_in_income: false },
  ]

  assert.equal(shouldIncludeOrderInOwnerStatement(orders[0]), false)
  assert.equal(shouldIncludeOrderInOwnerStatement(orders[1]), false)
  assert.equal(shouldIncludeOrderInOwnerStatement(orders[3]), true)
  assert.equal(shouldIncludeOrderInOwnerStatement(orders[6]), true, 'cancellation_pending is active until cancellation reaches a terminal status')

  const ownerSegments = computeOwnerStatementMonthSegmentsForOrders(orders, '2026-03')
  assert.deepEqual(ids(ownerSegments), ['cancel-pending', 'normal-paid', 'normal-zero', 'restored'])
  assert.equal(sumSegmentsVisibleNetIncome(ownerSegments), 950)
  assert.equal(ownerSegments.find((row) => row.id === 'normal-zero')?.nights, 2, 'normal $0 stays remain visible and count nights')

  const sharedPendingSegments = computeMonthSegmentsForOrders([orders[6]], '2026-03')
  assert.equal(sharedPendingSegments.length, 0, 'shared/company segmentation retains its pre-MZ-102 cancellation-like status semantics')
  const companyPendingReport = buildCompanyRevenueReport({
    month: '2026-03',
    orders: [orders[6]],
    properties: [{ id: 'p1', code: 'P1', landlord_id: 'l1' }],
    landlords: [{ id: 'l1', management_fee_rate: 0.1, property_ids: ['p1'] }],
    managementFeeRulesByLandlord: { l1: [{ effective_from_month: '2026-01', management_fee_rate: 0.1 }] },
    companyIncomes: [],
    companyExpenses: [],
    includeDeleted: false,
  })
  assert.equal(companyPendingReport.summary.total_income, 0, 'owner-only status correction must not change company report income')
  assert.equal(companyPendingReport.income_rows.length, 0, 'owner-only status correction must not add derived company rows')

  const crossMonthCancelled = {
    id: 'cancel-cross-month',
    property_id: 'p1',
    checkin: '2026-03-30',
    checkout: '2026-04-03',
    net_income: 800,
    status: 'cancelled',
    count_in_income: true,
  }
  assert.equal(computeOwnerStatementMonthSegmentsForOrders([crossMonthCancelled], '2026-03').length, 0)
  assert.equal(computeOwnerStatementMonthSegmentsForOrders([crossMonthCancelled], '2026-04').length, 0)
  assert.equal(
    computeOwnerStatementMonthSegmentsForOrders([{ ...crossMonthCancelled, status: 'cancellation_pending', count_in_income: false }], '2026-04').length,
    1,
    'cancellation_pending remains eligible even when count_in_income is false',
  )
  assert.equal(
    computeOwnerStatementMonthSegmentsForOrders([{ ...crossMonthCancelled, status: 'confirmed' }], '2026-04').length,
    1,
    'restoring a cancelled order to an active status makes it eligible again',
  )

  const existingProrationOrder = {
    id: 'normal-existing-proration',
    property_id: 'p1',
    checkin: '2026-03-30',
    checkout: '2026-04-02',
    nights: 3,
    net_income: 300,
    status: 'confirmed',
    count_in_income: true,
  }
  assert.equal(
    computeOwnerRentIncomeWithExistingProration([existingProrationOrder], '2026-03'),
    100,
    'property revenue keeps the existing active-order March proration',
  )
  assert.equal(
    computeOwnerRentIncomeWithExistingProration([existingProrationOrder], '2026-04'),
    100,
    'management-fee basis keeps the existing active-order April proration',
  )
  assert.equal(
    computeOwnerRentIncomeWithExistingProration([{ ...existingProrationOrder, status: 'cancelled' }], '2026-03'),
    0,
    'terminal cancellations are excluded without changing active-order arithmetic',
  )
  assert.equal(
    computeOwnerRentIncomeWithExistingProration([{ ...existingProrationOrder, status: 'cancellation_pending', count_in_income: false }], '2026-03'),
    100,
    'cancellation_pending remains eligible under the existing proration',
  )

  const financeSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/finance.ts'), 'utf8')
  const rentSegmentsStart = financeSource.indexOf("router.get('/rent-segments'")
  const rentIncomeStart = financeSource.indexOf("router.get('/rent-income-by-property'", rentSegmentsStart)
  const managementFeeStart = financeSource.indexOf("router.post('/management-fee/calc'", rentIncomeStart)
  const managementFeeEnd = financeSource.indexOf("router.get('/management-fee/history'", managementFeeStart)
  assert.ok(rentSegmentsStart >= 0 && rentIncomeStart > rentSegmentsStart && managementFeeStart > rentIncomeStart && managementFeeEnd > managementFeeStart)
  assert.match(financeSource.slice(rentSegmentsStart, rentIncomeStart), /computeOwnerStatementMonthSegmentsForOrders\(enriched, m\.monthKey\)/)
  assert.match(financeSource.slice(rentIncomeStart, managementFeeStart), /computeOwnerStatementMonthSegmentsForOrders\(enriched, m\.monthKey\)/)
  assert.match(financeSource.slice(managementFeeStart, managementFeeEnd), /computeOwnerRentIncomeWithExistingProration\(ords, ym\)/)

  const propertyRevenueStart = financeSource.indexOf("router.get('/property-revenue'")
  const propertyRevenueEnd = financeSource.indexOf("function parseMonthKeyOrNull", propertyRevenueStart)
  assert.ok(propertyRevenueStart >= 0 && propertyRevenueEnd > propertyRevenueStart)
  assert.match(financeSource.slice(propertyRevenueStart, propertyRevenueEnd), /computeOwnerRentIncomeWithExistingProration\(ords, ym\)/)

  console.log('OK test_owner_monthly_statement_orders')
}

main()
