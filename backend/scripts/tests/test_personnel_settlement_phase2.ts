import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  buildPersonnelFeeRuleEffectiveDateConstraint,
  canonicalizePersonnelFeeRulePriceBasis,
  validatePersonnelFeeRuleInput,
} from '../../src/lib/personnelSettlementRules'
import { CLEANING_PROPERTY_TYPES } from '../../src/lib/personnelSettlement'

const backendRoot = path.resolve(__dirname, '../..')
const service = fs.readFileSync(path.join(backendRoot, 'src/lib/personnelSettlementRules.ts'), 'utf8')
const router = fs.readFileSync(path.join(backendRoot, 'src/modules/personnel_settlements.ts'), 'utf8')
const page = fs.readFileSync(path.resolve(backendRoot, '../frontend/src/app/finance/settlements/page.tsx'), 'utf8')
const drawer = fs.readFileSync(path.resolve(backendRoot, '../frontend/src/app/finance/settlements/FeeRuleDrawer.tsx'), 'utf8')
const ui = fs.readFileSync(path.resolve(backendRoot, '../frontend/src/app/finance/settlements/feeRuleUi.ts'), 'utf8')
const preview = fs.readFileSync(path.join(backendRoot, 'src/lib/personnelSettlementPreview.ts'), 'utf8')

const cleaningItems = CLEANING_PROPERTY_TYPES.map((propertyType, index) => ({
  component_type: 'cleaning_task' as const,
  conditions: { property_type: propertyType },
  rate_cents: 12_500 + index * 100,
  priority: CLEANING_PROPERTY_TYPES.length - index,
}))

const valid = validatePersonnelFeeRuleInput({
  name: '  Cleaner weekly rule  ',
  effective_date: '2026-09-10',
  price_basis: 'exclusive_gst',
  notes: '  Phase 2  ',
  items: [
    ...cleaningItems,
    { component_type: 'overtime_hour', rate_cents: 4_500, priority: 1 },
  ],
})
assert.strictEqual(valid.name, 'Cleaner weekly rule')
assert.strictEqual(valid.notes, 'Phase 2')
assert.strictEqual(valid.items[0].conditions.property_type, '一房一卫')
assert.strictEqual(valid.items[5].conditions.property_type, '4房3.5卫')
assert.deepStrictEqual(valid.items.slice(0, 6).map((item) => item.priority), [6, 5, 4, 3, 2, 1])
assert.throws(() => validatePersonnelFeeRuleInput({
  name: 'Duplicate',
  effective_date: '2026-09-10',
  price_basis: 'inclusive_gst',
  items: [
    ...cleaningItems,
    { ...cleaningItems[0], priority: 99 },
  ],
}), /invalid_rule_duplicate_cleaning_property_type/)
assert.throws(() => validatePersonnelFeeRuleInput({
  name: 'Incomplete cleaning rates',
  effective_date: '2026-09-10',
  price_basis: 'exclusive_gst',
  items: cleaningItems.slice(0, 5),
}), /invalid_rule_cleaning_property_type_rates_incomplete/)
assert.throws(() => validatePersonnelFeeRuleInput({
  name: 'Legacy flat rate',
  effective_date: '2026-09-10',
  price_basis: 'exclusive_gst',
  items: [{ component_type: 'cleaning_task', rate_cents: 3500 }],
}), /invalid_rule_cleaning_property_type/)
assert.throws(() => validatePersonnelFeeRuleInput({
  name: 'Invalid date',
  effective_date: '2026-02-30',
  price_basis: 'exclusive_gst',
  items: [{ component_type: 'inspection_day', rate_cents: 1000 }],
}), /invalid_rule_effective_date/)
assert.throws(() => validatePersonnelFeeRuleInput({
  name: 'Invalid rate',
  effective_date: '2026-09-10',
  price_basis: 'exclusive_gst',
  items: [{ component_type: 'inspection_day', rate_cents: 1.5 }],
}), /invalid_rule_rate_cents/)

assert.deepStrictEqual(buildPersonnelFeeRuleEffectiveDateConstraint('2026-09-06'), {
  locked_through: '2026-09-06',
  earliest_effective_date: '2026-09-07',
})
assert.deepStrictEqual(buildPersonnelFeeRuleEffectiveDateConstraint(null), {
  locked_through: null,
  earliest_effective_date: null,
})
assert.strictEqual(canonicalizePersonnelFeeRulePriceBasis('registered', 'inclusive_gst'), 'inclusive_gst')
assert.strictEqual(canonicalizePersonnelFeeRulePriceBasis('not_registered', 'inclusive_gst'), 'exclusive_gst')

assert.match(router, /router\.get\('\/profiles\/:userId\/rules'/)
assert.match(router, /router\.post\('\/profiles\/:userId\/rules'/)
assert.match(router, /router\.get\('\/profiles\/:userId\/rule-constraints'/)
assert.match(router, /requirePerm\('personnel_settlements\.rules\.manage'\)/)
assert.match(service, /status='active'/)
assert.match(service, /effective_to=\$1::date - 1/)
assert.match(service, /rule_effective_date_locked/)
assert.match(service, /FOR UPDATE/)
assert.match(service, /conditions/)
assert.match(router, /property_type: z\.enum\(CLEANING_PROPERTY_TYPES\)/)
assert.match(preview, /NULLIF\(TRIM\(p\.type\), ''\) AS property_type/)
assert.match(preview, /missing_or_unsupported_property_type/)
assert.match(preview, /missing_cleaning_property_type_rate/)
assert.match(page, /label: '费用规则'/)
assert.match(page, /mode === 'detail' && canManageRules/)
assert.match(page, /rules\.find\(\(rule\) => rule\.is_current\)/)
assert.match(page, /当前费用规则/)
assert.match(page, /feeRulePriceBasisLabel\(selected\.gst_status, detailCurrentRule\.price_basis\)/)
assert.match(page, /feeRuleItemLabel\(item\)/)
assert.match(drawer, /规则历史/)
assert.match(drawer, /补齐清洁房型/)
assert.match(drawer, /disabledDate=/)
assert.match(drawer, /loadHistory\(saved\?\.effective_from \|\| values\.effective_date\.format\('YYYY-MM-DD'\)\)/)
assert.match(drawer, /复制到当前版本/)
assert.match(drawer, /确认保存为历史版本/)
assert.match(drawer, /历史费用规则已保存/)
assert.match(drawer, /feeRuleCopyTargetEffectiveDate/)
assert.match(drawer, /props\.gstStatus === 'not_registered'/)
assert.match(drawer, /不适用（未注册 GST，GST 为 \$0）/)
assert.match(service, /canonicalizePersonnelFeeRulePriceBasis/)
assert.match(ui, /未含 GST（注册 GST 后另加 10%）/)
assert.match(ui, /已含 GST（系统从总额中拆分 GST）/)
assert.match(ui, /新规则最早可从/)

console.log('personnel settlement phase2 contract tests passed')
