export const CLEANING_COMPLETION_AUDIT_STATUSES = [
  'cleaned',
  'restock_pending',
  'restocked',
  'to_inspect',
  'to_hang_keys',
  'keys_hung',
  'inspected',
  'ready',
  'completed',
  'done',
] as const

const CLEANING_COMPLETION_AUDIT_STATUS_SET = new Set<string>(CLEANING_COMPLETION_AUDIT_STATUSES)

export type CleaningCompletionAuditCandidate = {
  performed_as_action?: unknown
  status_after?: unknown
  metadata?: {
    route?: unknown
    step?: unknown
  } | null
}

function normalized(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

export function isCleaningCompletionAudit(candidate: CleaningCompletionAuditCandidate) {
  const action = normalized(candidate?.performed_as_action)
  const route = normalized(candidate?.metadata?.route)
  const step = normalized(candidate?.metadata?.step)
  if (route === 'cleaning_app.tasks.completion_photos' || step === 'completion_photos_saved') return false
  if (action === 'complete_cleaning') return true
  if (action !== 'fill_supplies') return false
  if (route === 'mzapp.cleaning_tasks.restock_proof') return false
  return CLEANING_COMPLETION_AUDIT_STATUS_SET.has(normalized(candidate?.status_after))
}

export function cleaningCompletionAuditWhereSql(alias: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('invalid_sql_alias')
  const completedStatuses = CLEANING_COMPLETION_AUDIT_STATUSES.map((status) => `'${status}'`).join(', ')
  return `(
    lower(COALESCE(${alias}.metadata->>'route', '')) <> 'cleaning_app.tasks.completion_photos'
    AND lower(COALESCE(${alias}.metadata->>'step', '')) <> 'completion_photos_saved'
    AND (
      ${alias}.performed_as_action = 'complete_cleaning'
      OR (
        ${alias}.performed_as_action = 'fill_supplies'
        AND lower(COALESCE(${alias}.metadata->>'route', '')) <> 'mzapp.cleaning_tasks.restock_proof'
        AND lower(COALESCE(${alias}.status_after, '')) IN (${completedStatuses})
      )
    )
  )`
}
