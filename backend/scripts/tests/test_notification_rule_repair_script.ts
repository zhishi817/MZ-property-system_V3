import assert from 'assert'
import fs from 'fs'
import path from 'path'

const script = fs.readFileSync(path.resolve(__dirname, '..', 'repair_task_notification_rules.js'), 'utf8')

assert.match(script, /Without --apply this script is read-only/)
assert.match(script, /const apply = process\.argv\.includes\('--apply'\)/)
assert.match(script, /recipient_type = 'user'/)
assert.match(script, /recipient_type = 'role'/)
assert.match(script, /LOWER\(TRIM\(recipient_value\)\) <> ALL\(\$2::text\[\]\)/)
assert.match(script, /SAFE_FALLBACK_SELECTORS/)
assert.match(script, /INSERT INTO notification_event_rule_selectors/)
assert.match(script, /UPDATE notification_event_rules/)
assert.match(script, /version = version \+ 1/)

console.log('test_notification_rule_repair_script: ok')
