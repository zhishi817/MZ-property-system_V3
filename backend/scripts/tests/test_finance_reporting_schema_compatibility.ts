import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const backendRoot = path.resolve(__dirname, '../..')
const finance = fs.readFileSync(path.join(backendRoot, 'src/modules/finance.ts'), 'utf8')
const routeStart = finance.indexOf("router.get('/rent-segments'")
const routeEnd = finance.indexOf("router.get('/rent-income-by-property'", routeStart)

assert.ok(routeStart >= 0, 'rent-segments route must exist')
assert.ok(routeEnd > routeStart, 'rent-segments route boundary must exist')

const rentSegmentsRoute = finance.slice(routeStart, routeEnd)
const expectedOrderSegmentCols = "const orderSegmentCols = 'id, property_id, stay_type, checkin, checkout, price, cleaning_fee, nights, net_income, status, count_in_income, confirmation_code, guest_name, source, created_at'"

assert.ok(rentSegmentsRoute.includes(expectedOrderSegmentCols), 'rent-segments must use the deployed compatible orders field list')
assert.doesNotMatch(rentSegmentsRoute, /orderSegmentCols[^\n]*\bchannel\b/)
assert.doesNotMatch(rentSegmentsRoute, /orderSegmentCols[^\n]*\bupdated_at\b/)

console.log('test_finance_reporting_schema_compatibility: ok')
