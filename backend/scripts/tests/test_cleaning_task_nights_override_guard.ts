import assert from 'assert'
import { shouldIgnoreNightsOverrideForAutoCheckinTask } from '../../src/lib/cleaningTaskNightOverride'

assert.equal(shouldIgnoreNightsOverrideForAutoCheckinTask({ order_id: 'order-1', task_type: 'checkin_clean', source: 'auto', auto_sync_enabled: true }), true)
assert.equal(shouldIgnoreNightsOverrideForAutoCheckinTask({ order_id: 'order-1', type: 'checkin_clean', source: 'auto' }), true)
assert.equal(shouldIgnoreNightsOverrideForAutoCheckinTask({ order_id: 'order-1', task_type: 'checkin_clean', source: 'auto', auto_sync_enabled: false }), false)
assert.equal(shouldIgnoreNightsOverrideForAutoCheckinTask({ order_id: 'order-1', task_type: 'checkin_clean', source: 'manual', auto_sync_enabled: true }), false)
assert.equal(shouldIgnoreNightsOverrideForAutoCheckinTask({ order_id: 'order-1', task_type: 'checkout_clean', source: 'auto', auto_sync_enabled: true }), false)

process.stdout.write('test_cleaning_task_nights_override_guard: ok\\n')
