import assert from 'assert'

async function main() {
  process.env.DATABASE_URL = ''
  const { offlineTaskSchema, OFFLINE_TASK_STORAGE_URGENCY } = require('../../src/modules/cleaning') as typeof import('../../src/modules/cleaning')
  const base = {
    date: '2026-07-24',
    task_type: 'other',
    title: '送暖气',
    content: '请联系执行人',
    kind: 'manual',
    status: 'todo',
    assignee_id: 'staff-1',
  }

  const withoutUrgency = offlineTaskSchema.safeParse(base)
  assert.equal(withoutUrgency.success, true)
  assert.equal((withoutUrgency as any).data.urgency, undefined)

  const legacyClientPayload = offlineTaskSchema.safeParse({ ...base, urgency: 'urgent' })
  assert.equal(legacyClientPayload.success, true)
  assert.equal(OFFLINE_TASK_STORAGE_URGENCY, 'medium')

  process.stdout.write('test_offline_task_urgency_contract: ok\n')
}

void main()
