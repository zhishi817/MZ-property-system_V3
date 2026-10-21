import assert from 'node:assert/strict'
import {
  cleaningCompletionAuditWhereSql,
  isCleaningCompletionAudit,
} from '../../src/lib/cleaningCompletionEvidence'

assert.equal(isCleaningCompletionAudit({ performed_as_action: 'complete_cleaning' }), true)
assert.equal(isCleaningCompletionAudit({
  performed_as_action: 'complete_cleaning',
  status_after: 'in_progress',
  metadata: {
    route: 'cleaning_app.tasks.completion_photos',
    step: 'completion_photos_saved',
  },
}), false)
assert.equal(isCleaningCompletionAudit({
  performed_as_action: 'complete_cleaning',
  status_after: 'cleaned',
  metadata: { route: 'cleaning_app.tasks.self_complete' },
}), true)
assert.equal(isCleaningCompletionAudit({
  performed_as_action: 'fill_supplies',
  status_after: 'cleaned',
  metadata: { route: 'cleaning_app.tasks.consumables' },
}), true)
assert.equal(isCleaningCompletionAudit({
  performed_as_action: 'fill_supplies',
  status_after: 'restock_pending',
  metadata: { route: 'cleaning_app.tasks.consumables' },
}), true)
assert.equal(isCleaningCompletionAudit({
  performed_as_action: 'fill_supplies',
  status_after: 'cleaned',
}), true, 'legacy completion evidence without route metadata remains compatible when the terminal status is allowlisted')
assert.equal(isCleaningCompletionAudit({
  performed_as_action: 'fill_supplies',
  status_after: 'restocked',
  metadata: { route: 'legacy.unknown.route', step: 'legacy_unknown_step' },
}), true, 'unknown legacy route/step does not override an allowlisted terminal status')
assert.equal(isCleaningCompletionAudit({
  performed_as_action: 'fill_supplies',
  status_after: 'in_progress',
  metadata: { route: 'cleaning_app.tasks.consumables' },
}), false)
assert.equal(isCleaningCompletionAudit({
  performed_as_action: 'fill_supplies',
  status_after: 'cleaned',
  metadata: { route: 'mzapp.cleaning_tasks.restock_proof' },
}), false)
assert.equal(isCleaningCompletionAudit({
  performed_as_action: 'fill_supplies',
  status_after: 'cleaned',
  metadata: { step: 'completion_photos_saved' },
}), false)
assert.equal(isCleaningCompletionAudit({
  performed_as_action: 'submit_inspection',
  status_after: 'inspected',
}), false)

// Production read-only acceptance samples (2026-10-20/21 Melbourne): these
// exact evidence shapes were missing from the deployed complete_cleaning-only
// history path for AdaWang, Barbara and Elise.  Names/property codes are kept
// only as diagnostic labels; authorization still comes from the audit actor.
for (const sample of [
  ['AdaWang', 'WSP3709B', 'restock_pending'],
  ['AdaWang', 'MV1708E', 'cleaned'],
  ['AdaWang', 'MV1608E', 'cleaned'],
  ['Barbara', 'EB2206', 'cleaned'],
  ['Barbara', 'AU2117', 'restock_pending'],
  ['Barbara', 'MSQ3401E', 'restock_pending'],
  ['Elise', 'EQ2312', 'cleaned'],
  ['Elise', 'UT2602', 'restock_pending'],
  ['Elise', 'EQ3401', 'cleaned'],
] as const) {
  const [person, property, statusAfter] = sample
  assert.equal(isCleaningCompletionAudit({
    performed_as_action: 'fill_supplies',
    status_after: statusAfter,
    metadata: { route: 'cleaning_app.tasks.consumables' },
  }), true, `${person}/${property} formal completion evidence must restore the history candidate`)
}

const sql = cleaningCompletionAuditWhereSql('audit')
assert.match(sql, /audit\.performed_as_action = 'complete_cleaning'/)
assert.match(sql, /audit\.performed_as_action = 'fill_supplies'/)
assert.match(sql, /mzapp\.cleaning_tasks\.restock_proof/)
assert.match(sql, /cleaning_app\.tasks\.completion_photos/)
assert.match(sql, /completion_photos_saved/)
assert.match(sql, /COALESCE\(audit\.metadata->>'route', ''\)/, 'missing legacy route metadata must use the compatibility path')
assert.throws(() => cleaningCompletionAuditWhereSql('audit; DELETE FROM cleaning_tasks'), /invalid_sql_alias/)

// Evidence is evaluated inside the caller's requested Melbourne date range.
// There is intentionally no 7- or 14-day age cutoff in this classifier.
assert.doesNotMatch(sql, /2026-|CURRENT_DATE|INTERVAL/i)

console.log('cleaning completion evidence contract passed')
