import assert from 'assert'
import { offlinePasswordStructureIssue } from '../../src/lib/companyOfflinePasswordRules'

function main() {
  assert.deepEqual(
    offlinePasswordStructureIssue({ secret_kind: 'backup_key', property_ids: [], box_number: '1', location: 'A 座 1 号信箱' }),
    { path: 'property_ids', message: 'at least one linked property is required' },
  )
  assert.deepEqual(
    offlinePasswordStructureIssue({ secret_kind: 'backup_key', property_ids: ['property-1'], location: 'A 座 1 号信箱' }),
    { path: 'box_number', message: 'password box number is required' },
  )
  assert.deepEqual(
    offlinePasswordStructureIssue({ secret_kind: 'backup_key', property_ids: ['property-1'], box_number: '1', location: ' ' }),
    { path: 'location', message: 'password box location is required' },
  )
  assert.equal(
    offlinePasswordStructureIssue({ secret_kind: 'backup_key', property_ids: ['property-1'], box_number: '1', location: 'A 座入口右侧 1 号信箱' }),
    null,
  )
  assert.equal(
    offlinePasswordStructureIssue({ secret_kind: 'office', location: '' }),
    null,
  )
  assert.deepEqual(
    offlinePasswordStructureIssue({ secret_kind: 'company_rotating', rotation_interval_days: null }),
    { path: 'rotation_interval_days', message: 'rotation interval is required' },
  )
  process.stdout.write('test_offline_password_structure: ok\n')
}

main()
