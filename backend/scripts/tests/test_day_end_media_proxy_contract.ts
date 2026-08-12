import assert from 'assert'
import fs from 'fs'
import path from 'path'

function main() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
  const routeStart = source.indexOf("'/media/image'")
  const routeEnd = source.indexOf("'/upload'", routeStart)
  assert(routeStart >= 0 && routeEnd > routeStart, 'authenticated image route must exist')
  const route = source.slice(routeStart, routeEnd)

  assert.match(source, /function findDayEndHandoverMediaRows/, 'day-end media requires a dedicated persisted-association lookup')
  assert.match(source, /FROM cleaning_day_end_media/, 'standard day-end photos must resolve through their exact persisted media rows')
  assert.match(source, /FROM cleaning_day_end_reject_items/, 'reject-linen photos must resolve through their exact persisted JSON association')
  assert.match(source, /user_id = \$1::text\s+AND date = \$2::date/, 'day-end association lookup must stay bound to one owner and one date')
  assert.match(route, /day_end_user_id/, 'the authenticated proxy must receive the explicit day-end owner context')
  assert.match(route, /day_end_date/, 'the authenticated proxy must receive the explicit day-end date context')
  assert.match(route, /dayEndRows\.length === 1/, 'ambiguous day-end media references must fail closed')
  assert.match(route, /canViewDayEndHandoverMedia/, 'day-end media must re-check the authenticated reader before object access')
  assert.match(source, /String\(row\?\.user_id \|\| ''\)\.trim\(\) === userId \|\| canViewDayEndForAllUsers\(user\)/, 'only the recorded owner or the existing day-end manager roles may read the photo')
  assert.match(route, /sourceTaskId \|\| requestedWorkTaskIdRaw/, 'day-end context cannot be combined with feedback or work-task read context')
  assert.match(route, /media_not_found/, 'an authorized but missing day-end object must remain a distinct 404 result')

  process.stdout.write('test_day_end_media_proxy_contract: ok\n')
}

main()
