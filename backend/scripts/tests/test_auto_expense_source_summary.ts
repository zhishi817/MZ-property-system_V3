import assert from 'node:assert/strict'
import { dailyNecessitiesSourceSummary, deepCleaningSourceSummary, maintenanceSourceSummary } from '../../src/lib/autoExpenseSourceSummary'

function testMaintenancePrefersInvoiceDescriptionEn() {
  const out = maintenanceSourceSummary({
    invoice_description_en: 'Curtain Repair - Custom Fabricated Replacement Part & Reinstallation',
    details: [{ content: '窗帘使用时脱落掉地上，再次安装时配件不全，现场重新加工，做了一个配件，安装后使用正常。' }],
    repair_notes: '中文备注',
  })
  assert.equal(out, 'Curtain Repair - Custom Fabricated Replacement Part & Reinstallation')
}

function testDeepCleaningPrefersInvoiceDescriptionEn() {
  const out = deepCleaningSourceSummary({
    invoice_description_en: 'Deep cleaning - mold treatment and balcony detailing',
    project_desc: '深度清洁阳台和霉菌处理',
    details: [{ content: '中文详情' }],
    notes: '中文备注',
  })
  assert.equal(out, 'Deep cleaning - mold treatment and balcony detailing')
}

function testFallsBackWhenEnglishDescriptionMissing() {
  const maintenanceOut = maintenanceSourceSummary({
    details: [{ content: '窗户铰链松动并重新固定' }],
    repair_notes: '备用中文备注',
  })
  const deepCleaningOut = deepCleaningSourceSummary({
    project_desc: 'Mattress steam clean and stain removal',
    details: [{ content: '中文详情' }],
  })
  assert.equal(maintenanceOut, '窗户铰链松动并重新固定')
  assert.equal(deepCleaningOut, 'Mattress steam clean and stain removal')
}

function testDailyNecessitiesPrefersInvoiceDescriptionEn() {
  const out = dailyNecessitiesSourceSummary({
    invoice_description_en: 'Daily supplies replacement - towel set',
    item_name: '毛巾',
    quantity: 2,
    note: '中文备注',
  })
  assert.equal(out, 'Daily supplies replacement - towel set')
}

function testDailyNecessitiesFallbackIncludesItemQuantityAndNote() {
  const out = dailyNecessitiesSourceSummary({
    item_name: 'Toilet paper',
    quantity: 3,
    note: '客厅柜补货',
  })
  assert.equal(out, '日用品更换：Toilet paper；数量 3；客厅柜补货')
}

function testEmptyRowsStaySafe() {
  assert.equal(maintenanceSourceSummary({}), '')
  assert.equal(deepCleaningSourceSummary({}), '')
  assert.equal(dailyNecessitiesSourceSummary({}), '日用品更换')
}

testMaintenancePrefersInvoiceDescriptionEn()
testDeepCleaningPrefersInvoiceDescriptionEn()
testFallsBackWhenEnglishDescriptionMissing()
testDailyNecessitiesPrefersInvoiceDescriptionEn()
testDailyNecessitiesFallbackIncludesItemQuantityAndNote()
testEmptyRowsStaySafe()

console.log('test_auto_expense_source_summary: ok')
