import assert from 'assert'
import fs from 'fs'
import path from 'path'

process.env.DATABASE_URL = ''

async function main() {
  const { canViewPropertyHistoryFeedbackMedia } = await import('../../src/modules/cleaning_app')
  const pool = { query: () => { throw new Error('No database access permitted') } }
  const user = { sub: 'current-cleaner', role: 'cleaner' }
  const base = {
    feedback_source_type: 'property_maintenance', property_id: 'property-a',
    source_task_id: 'old-task', photo_urls: ['maintenance/report.jpg'],
  }
  const calls: any[] = []
  const allowed = async (...args: any[]) => {
    calls.push(args)
    return { exists: true, canViewHistory: args[1] === 'property-a' && args[2] === 'current-task', canCreate: false, feedbackSource: null }
  }
  for (const source_task_id of ['old-task', null, 'obsolete-projection']) {
    for (const feedback_source_type of ['property_maintenance', 'property_deep_cleaning', 'property_daily_necessities']) {
      assert.equal(await canViewPropertyHistoryFeedbackMedia(pool, user, { ...base, source_task_id, feedback_source_type }, 'current-task', 'maintenance/report.jpg', allowed), true)
    }
  }
  assert.equal(calls.length, 9)
  assert.equal(calls[0][0], user)
  assert.equal(calls[0][3], pool)
  assert.equal(await canViewPropertyHistoryFeedbackMedia(pool, user, base, 'unauthorized-task', 'maintenance/report.jpg', allowed), false)
  assert.equal(await canViewPropertyHistoryFeedbackMedia(pool, user, { ...base, property_id: 'property-b' }, 'current-task', 'maintenance/report.jpg', allowed), false)
  for (const row of [
    { ...base, historical_work_record_media: true },
    { ...base, feedback_source_type: 'external_maintenance_orders' },
    { ...base, property_id: null },
    { ...base, photo_urls: ['maintenance/other.jpg'] },
    { ...base, photo_urls: ['mzapp/expenses/receipt.jpg'] },
    { ...base, photo_urls: [], invoice_url: 'maintenance/report.jpg' },
    { ...base, photo_urls: [], project_items: [{ receipt_urls: ['maintenance/report.jpg'] }] },
  ]) {
    const key = row.photo_urls?.[0] === 'mzapp/expenses/receipt.jpg' ? 'mzapp/expenses/receipt.jpg' : 'maintenance/report.jpg'
    const count = calls.length
    assert.equal(await canViewPropertyHistoryFeedbackMedia(pool, user, row, 'current-task', key, allowed), false)
    assert.equal(calls.length, count, 'ineligible references never reach property authorization')
  }
  assert.equal(await canViewPropertyHistoryFeedbackMedia(pool, user, base, '', 'maintenance/report.jpg', allowed), false)
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
  assert.match(source, /propertyHistoryRequested && \(!sourceTaskId \|\| requestedWorkTaskIdRaw \|\| guestLuggageId \|\| hasDayEndContext \|\| hasScopedMediaContext\)/)
  assert.match(source, /offlineRow && propertyHistoryRequested/)
  assert.match(source, /feedbackMediaRows\.length === 1/)
  assert.match(source, /hasGuestLuggageSourceConflict \|\| hasRecordedSourceConflict \|\| hasDayEndFeedbackSourceConflict\s*\? false\s*:\s*propertyHistoryRequested\s*\? canViewPropertyHistoryMedia/)
  console.log('property feedback history media: passed (isolated authorization mocks; no DB/API writes)')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
