export type InspectionMode = 'pending_decision' | 'same_day' | 'deferred' | 'self_complete' | 'checked_done'
export type InspectionScope = 'inspect_and_hang' | 'password_only'
export type TaskExecutionSemantics =
  | 'cleaning_execution'
  | 'checkin_inspection'
  | 'inspection_execution'
  | 'key_or_password_action'
  | 'mixed_cleaning_inspection'
  | 'work_task'
export type CleaningTaskExecutionSemantics = Exclude<TaskExecutionSemantics, 'work_task'>

const VALID_INSPECTION_MODES = new Set<InspectionMode>(['pending_decision', 'same_day', 'deferred', 'self_complete', 'checked_done'])
export const TERMINAL_DEFERRED_INSPECTION_STATUSES = [
  'inspected',
  'done',
  'completed',
  'ready',
  'keys_hung',
  'cancelled',
  'canceled',
] as const
const TERMINAL_DEFERRED_INSPECTION_STATUS_SET = new Set<string>(TERMINAL_DEFERRED_INSPECTION_STATUSES)
const KEY_HANDOVER_PENDING_REQUIREMENTS = new Set<string>([
  'cleaning_consumables',
  'cleaning_property_photo',
  'inspection_photos',
])
const KEY_PHOTO_CURRENT_PROGRESS_STATUSES = new Set<string>(['in_progress', 'cleaning'])
const VALID_TASK_EXECUTION_SEMANTICS = new Set<TaskExecutionSemantics>([
  'cleaning_execution',
  'checkin_inspection',
  'inspection_execution',
  'key_or_password_action',
  'mixed_cleaning_inspection',
  'work_task',
])

function inspectionDayOnly(value: any): string | null {
  const day = String(value || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

function melbourneDayOnly(value: any): string | null {
  const date = new Date(String(value || ''))
  if (!Number.isFinite(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return inspectionDayOnly(`${byType.year}-${byType.month}-${byType.day}`)
}

/**
 * A queued mobile submission can be persisted after midnight even though all
 * of its immutable media was captured on the task's scheduled business day.
 * In that narrow, evidence-backed case the record belongs to the task day;
 * otherwise the actual persisted execution time remains authoritative.  This
 * deliberately does not infer a date from room, status, or upload latency.
 */
export function cleaningExecutionBusinessDate(params: {
  taskDate?: any
  performedAt?: any
  evidenceCapturedAt?: any[] | null
}): string | null {
  const taskDate = inspectionDayOnly(params.taskDate)
  const performedDate = melbourneDayOnly(params.performedAt)
  const captured = Array.isArray(params.evidenceCapturedAt) ? params.evidenceCapturedAt : []
  if (!taskDate || !captured.length) return performedDate
  const capturedDates = captured.map(melbourneDayOnly)
  if (capturedDates.some((date) => !date) || capturedDates.some((date) => date !== taskDate)) return performedDate
  return taskDate
}

/** SQL equivalent of `cleaningExecutionBusinessDate` for immutable action
 * audits. The alias is restricted to a plain SQL identifier because callers
 * use this inside candidate/date predicates. */
export function cleaningAuditBusinessDateSql(alias = 'audit'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('invalid audit alias')
  const evidence = `CASE WHEN jsonb_typeof(${alias}.metadata->'evidence_snapshot') = 'array' THEN ${alias}.metadata->'evidence_snapshot' ELSE '[]'::jsonb END`
  const scheduled = `${alias}.metadata#>>'{task_snapshot,scheduled_service_date}'`
  return `CASE
    WHEN ${scheduled} ~ '^\\d{4}-\\d{2}-\\d{2}$'
      AND jsonb_array_length(${evidence}) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(${evidence}) evidence_item
        WHERE CASE
          WHEN COALESCE(evidence_item->>'captured_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}[T ]'
            THEN (((evidence_item->>'captured_at')::timestamptz AT TIME ZONE 'Australia/Melbourne')::date)::text
          ELSE ''
        END <> ${scheduled}
      )
      THEN (${scheduled})::date
    ELSE (${alias}.performed_at AT TIME ZONE 'Australia/Melbourne')::date
  END`
}

export function resolveBoardInspectionDueDate(params: {
  inspectionMode: InspectionMode
  requestedDueDate?: any
  previousDueDate?: any
  previousInspectionMode?: any
  modeChangeAction?: 'set' | null
}): string | null {
  if (params.previousInspectionMode === 'deferred' && params.inspectionMode !== 'deferred' && params.modeChangeAction !== 'set') {
    throw new Error('inspection_mode_change_confirmation_required')
  }
  if (params.inspectionMode !== 'deferred') return null
  const due = inspectionDayOnly(params.requestedDueDate) || inspectionDayOnly(params.previousDueDate)
  if (!due) throw new Error('inspection_due_date_required')
  return due
}

export function normalizeTaskExecutionSemantics(value: any): TaskExecutionSemantics | null {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return null
  if (raw === 'key_handover_execution') return 'key_or_password_action'
  return VALID_TASK_EXECUTION_SEMANTICS.has(raw as TaskExecutionSemantics) ? (raw as TaskExecutionSemantics) : null
}

export function isKeyOrPasswordActionSemantics(value: any): boolean {
  return normalizeTaskExecutionSemantics(value) === 'key_or_password_action'
}

export function normalizeInspectionScope(value: any): InspectionScope {
  const raw = String(value || '').trim().toLowerCase()
  return raw === 'password_only' ? 'password_only' : 'inspect_and_hang'
}

export type InspectionTaskAssignment = {
  userId: string | null
  userName: string | null
  source: 'inspector' | 'assignee' | null
}

/**
 * Resolve the person responsible for an inspection projection without
 * borrowing a cleaner or combining the id from one person with another
 * person's name. Pure check-in tasks are saved through the generic assignee
 * field, while checkout inspection tasks continue to require inspector_id.
 */
export function resolveInspectionTaskAssignment(task: {
  task_type?: any
  inspection_scope?: any
  inspector_id?: any
  inspector_name?: any
  assignee_id?: any
  assignee_name?: any
}): InspectionTaskAssignment {
  const inspectorId = String(task?.inspector_id || '').trim()
  const assigneeId = String(task?.assignee_id || '').trim()
  const inspectorName = String(task?.inspector_name || '').trim()
  const assigneeName = String(task?.assignee_name || '').trim()

  if (inspectorId) {
    return {
      userId: inspectorId,
      userName: inspectorName || (assigneeId === inspectorId ? assigneeName : '') || null,
      source: 'inspector',
    }
  }

  const taskType = String(task?.task_type || '').trim().toLowerCase()
  if (
    taskType === 'checkin_clean'
    && normalizeInspectionScope(task?.inspection_scope) === 'inspect_and_hang'
    && assigneeId
  ) {
    return {
      userId: assigneeId,
      userName: assigneeName || null,
      source: 'assignee',
    }
  }

  return { userId: null, userName: null, source: null }
}

export type CleaningKeyHandoverProjection = {
  state: 'completed'
  source_task_id: string
  completed_at: string | null
  confirmation_source: 'video' | 'manual'
  media_evidence_present: boolean
  workflow_finalization_pending: boolean
  missing_requirements: string[]
}

/**
 * Project the key-handover fact independently from the shared cleaning
 * workflow state.  A checkout inspection can have a valid access video while
 * the task remains in another workflow state because cleaner-owned evidence
 * is still missing. The media marker passed here is derived from the exact
 * task's current lockbox-video row; ordinary workflow transitions must not
 * erase that physical handover fact.
 */
export function projectCleaningKeyHandover(input: {
  taskId?: any
  status?: any
  executionState?: any
  lockboxVideoUrl?: any
  latestUploadAudit?: {
    performed_as_action?: any
    performed_at?: any
    status_before?: any
    status_after?: any
    metadata?: any
  } | null
  manualConfirmedAt?: any
}): CleaningKeyHandoverProjection | null {
  const taskId = String(input.taskId || '').trim()
  const status = String(input.status || '').trim().toLowerCase()
  const executionState = String(input.executionState || '').trim().toLowerCase()
  const lockboxVideoUrl = String(input.lockboxVideoUrl || '').trim()
  const manualConfirmedAt = String(input.manualConfirmedAt || '').trim()
  if (!taskId) return null
  if (['cancelled', 'canceled', 'superseded', 'deleted'].includes(executionState)) return null
  if (status === 'cancelled' || status === 'canceled') return null

  const audit = input.latestUploadAudit || null
  const auditMetadata = audit?.metadata && typeof audit.metadata === 'object' ? audit.metadata : {}
  const finalizationPending = auditMetadata.finalization_pending === true
  const missingRequirements: string[] = Array.from(new Set<string>(
    (Array.isArray(auditMetadata.missing_requirements) ? auditMetadata.missing_requirements : [])
      .map((value: any) => String(value || '').trim().toLowerCase())
      .filter((value: string) => KEY_HANDOVER_PENDING_REQUIREMENTS.has(value)),
  ))

  // The exact task's current video is the strongest handover fact. Follow-up
  // cleaning, restocking, inspection, assignment, or material-completion
  // transitions may change the shared workflow status, but must not downgrade
  // this fact or make a later manual marker hide the media evidence.
  if (lockboxVideoUrl) {
    return {
      state: 'completed',
      source_task_id: taskId,
      completed_at: String(audit?.performed_at || '').trim() || null,
      confirmation_source: 'video',
      media_evidence_present: true,
      workflow_finalization_pending: finalizationPending && missingRequirements.length > 0,
      missing_requirements: finalizationPending ? missingRequirements : [],
    }
  }

  // A manager may explicitly confirm the physical handover without uploading
  // a video. It proves the physical fact but not media completeness or wider
  // workflow completion.
  if (status === 'keys_hung' && manualConfirmedAt) {
    return {
      state: 'completed',
      source_task_id: taskId,
      completed_at: manualConfirmedAt,
      confirmation_source: 'manual',
      media_evidence_present: false,
      workflow_finalization_pending: false,
      missing_requirements: [],
    }
  }
  return null
}

export function isActiveCleaningTurnoverCandidate(task: any): boolean {
  const status = String(task?.status || task?.raw_status || '').trim().toLowerCase()
  const executionState = String(task?.execution_state || '').trim().toLowerCase()
  if (status === 'cancelled' || status === 'canceled') return false
  return !['cancelled', 'canceled', 'superseded', 'deleted'].includes(executionState)
}

export type CanonicalCleaningTurnoverPair = {
  checkout: any
  checkin: any
  source_ids: [string, string]
  business_identity: string
}

function cleaningSourceId(task: any): string {
  return String(task?.__raw_id || task?.source_id || task?.id || '').trim()
}

function explicitCheckoutLinkPair(checkout: any, checkin: any): boolean {
  const checkoutId = cleaningSourceId(checkout)
  const checkinId = cleaningSourceId(checkin)
  const linkedCheckoutId = String(checkin?.linked_checkout_task_id || '').trim()
  const checkoutPropertyId = String(checkout?.property_id || checkout?.__prop_id || '').trim()
  const checkinPropertyId = String(checkin?.property_id || checkin?.__prop_id || '').trim()
  const checkoutTaskDate = inspectionDayOnly(checkout?.task_date ?? checkout?.date ?? checkout?.__date)
  const checkinTaskDate = inspectionDayOnly(checkin?.task_date ?? checkin?.date ?? checkin?.__date)
  return !!checkoutId
    && !!checkinId
    && checkoutId !== checkinId
    && linkedCheckoutId === checkoutId
    && !!checkoutPropertyId
    && checkoutPropertyId === checkinPropertyId
    && !!checkoutTaskDate
    && checkoutTaskDate === checkinTaskDate
}

/**
 * Returns only unambiguous booking-boundary pairs.  Property/date is checked
 * as part of the boundary contract but is never the identity by itself.
 */
export function canonicalCleaningTurnoverPairs(tasks: any[]): CanonicalCleaningTurnoverPair[] {
  const rows = (Array.isArray(tasks) ? tasks : []).filter(isActiveCleaningTurnoverCandidate)
  const checkouts = rows.filter((row) => cleaningInspectionTaskKind(row?.task_type ?? row?.type) === 'checkout')
  const checkins = rows.filter((row) => cleaningInspectionTaskKind(row?.task_type ?? row?.type) === 'checkin')
  const candidates: CanonicalCleaningTurnoverPair[] = []
  for (const checkout of checkouts) {
    for (const checkin of checkins) {
      const sourceIds = canonicalKeyHandoverSourceIds([checkout, checkin])
      if (sourceIds.length !== 2) continue
      const checkoutOrderId = String(checkout?.order_id || '').trim()
      const checkinOrderId = String(checkin?.order_id || '').trim()
      const explicitlyLinked = explicitCheckoutLinkPair(checkout, checkin)
      candidates.push({
        checkout,
        checkin,
        source_ids: [sourceIds[0], sourceIds[1]],
        business_identity: explicitlyLinked
          ? `turnover_link:${sourceIds[0]}:${sourceIds[1]}`
          : `turnover:${checkoutOrderId}:${checkinOrderId}`,
      })
    }
  }
  const occurrenceCount = new Map<string, number>()
  for (const pair of candidates) {
    for (const sourceId of pair.source_ids) {
      occurrenceCount.set(sourceId, (occurrenceCount.get(sourceId) || 0) + 1)
    }
  }
  return candidates.filter((pair) => pair.source_ids.every((sourceId) => occurrenceCount.get(sourceId) === 1))
}

function pendingHandoverRowSourceId(task: any): string {
  return String(task?.__raw_id || task?.source_id || task?.id || '').trim()
}

function pendingHandoverRowBusinessIdentity(task: any): string {
  return String(task?.__business_identity || task?.business_identity || '').trim()
}

function pendingHandoverInspectorId(task: any): string {
  return String(
    task?.__work_record_actor_user_id
      || task?.__assignee_inspector
      || task?.inspector_id
      || '',
  ).trim()
}

/**
 * A completed inspection can leave a read-only `to_hang_keys` record while
 * the exact incoming check-in remains active.  When both rows are the unique
 * halves of one canonical turnover, keep the record as phase history on the
 * active turnover card instead of emitting a second card.
 *
 * This is intentionally fail-closed: it does not merge reassigned/cancelled
 * records, deferred projections, unassigned work, date changes, ambiguous
 * turnover candidates, or rows belonging to another inspection actor.
 */
export function reconcilePendingHandoverInspectorGroups(
  groups0: Map<string, any[]>,
  canonicalPairs0: CanonicalCleaningTurnoverPair[],
): Map<string, any[]> {
  const groups = new Map<string, any[]>(
    Array.from(groups0 || new Map<string, any[]>()).map(([key, rows]) => [key, Array.isArray(rows) ? [...rows] : []]),
  )
  const canonicalPairs = Array.isArray(canonicalPairs0) ? canonicalPairs0 : []

  for (const [recordKey, recordRows] of Array.from(groups.entries())) {
    if (recordRows.length !== 1) continue
    const record = recordRows[0]
    if (String(record?.__work_record_state || '').trim().toLowerCase() !== 'completed') continue
    if (cleaningInspectionTaskKind(record?.task_type) !== 'checkout') continue
    if (String(record?.__inspection_mode || record?.inspection_mode || '').trim().toLowerCase() !== 'same_day') continue
    if (normalizeInspectionScope(record?.__inspection_scope ?? record?.inspection_scope) !== 'inspect_and_hang') continue
    if (projectInspectorTaskStatus(record?.raw_status ?? record?.status, record?.__inspection_scope ?? record?.inspection_scope) !== 'to_hang_keys') continue
    if (String(record?.__manager_merge_isolation_key || '').trim()) continue
    if (record?.__is_deferred_projection === true) continue
    if (record?.__deferred_checkin_arrangement || record?.__deferred_inspection_display_merge) continue

    const recordDate = inspectionDayOnly(record?.__work_record_date ?? record?.__date)
    const originalDate = inspectionDayOnly(record?.__original_scheduled_date ?? record?.task_date)
    const recordSourceId = pendingHandoverRowSourceId(record)
    const recordBusinessIdentity = pendingHandoverRowBusinessIdentity(record)
    const recordActorId = String(record?.__work_record_actor_user_id || '').trim()
    const recordInspectorId = String(record?.__assignee_inspector || record?.inspector_id || '').trim()
    const recordSourceInspectorId = String(record?.__source_inspector_assignee_id || '').trim()
    if (!recordDate || !originalDate || recordDate !== originalDate) continue
    if (
      !recordSourceId
      || !recordBusinessIdentity
      || !recordActorId
      || !recordInspectorId
      || recordInspectorId !== recordActorId
      || !recordSourceInspectorId
      || recordSourceInspectorId !== recordActorId
    ) continue

    const matchingPairs = canonicalPairs.filter((pair) => {
      const checkoutSourceId = pendingHandoverRowSourceId(pair?.checkout)
      const checkoutDate = inspectionDayOnly(pair?.checkout?.task_date ?? pair?.checkout?.date ?? pair?.checkout?.__date)
      const checkinDate = inspectionDayOnly(pair?.checkin?.task_date ?? pair?.checkin?.date ?? pair?.checkin?.__date)
      return checkoutSourceId === recordSourceId
        && pair.business_identity === recordBusinessIdentity
        && checkoutDate === recordDate
        && checkinDate === recordDate
    })
    if (matchingPairs.length !== 1) continue
    const pair = matchingPairs[0]
    const checkinSourceId = pendingHandoverRowSourceId(pair.checkin)
    const checkinAssignment = resolveInspectionTaskAssignment(pair.checkin)
    // A temporary/manual action grant is not an assignment.  The live
    // incoming source must itself name the same inspector as the immutable
    // checkout record before the record can be embedded into that live card.
    if (!checkinAssignment.userId || checkinAssignment.userId !== recordActorId) continue

    const targets = Array.from(groups.entries()).filter(([candidateKey, candidateRows]) => {
      if (candidateKey === recordKey || candidateRows.length !== 1) return false
      const candidate = candidateRows[0]
      if (String(candidate?.__work_record_state || '').trim()) return false
      if (cleaningInspectionTaskKind(candidate?.task_type) !== 'checkin') return false
      if (String(candidate?.__inspection_mode || candidate?.inspection_mode || '').trim().toLowerCase() !== 'same_day') return false
      if (pendingHandoverRowSourceId(candidate) !== checkinSourceId) return false
      if (pendingHandoverRowBusinessIdentity(candidate) !== recordBusinessIdentity) return false
      if (inspectionDayOnly(candidate?.__date ?? candidate?.task_date) !== recordDate) return false
      if (String(candidate?.__manager_merge_isolation_key || '').trim()) return false
      if (candidate?.__is_deferred_projection === true) return false
      if (candidate?.__deferred_checkin_arrangement || candidate?.__deferred_inspection_display_merge) return false
      if (!isActiveCleaningTurnoverCandidate(candidate)) return false
      if (isInspectionFinishedStatus(candidate?.raw_status ?? candidate?.status)) return false
      if (String(candidate?.__source_inspector_assignee_id || '').trim() !== recordActorId) return false
      return pendingHandoverInspectorId(candidate) === recordActorId
    })
    if (targets.length !== 1) continue

    const [targetKey, targetRows] = targets[0]
    groups.set(targetKey, [
      { ...record, __pending_handover_record_embedded: true },
      ...targetRows,
    ])
    groups.delete(recordKey)
  }

  return groups
}

export function cleaningTaskBusinessIdentity(params: {
  checkoutOrderId?: any
  checkinOrderId?: any
  sourceId?: any
}): string | null {
  const checkoutOrderId = String(params?.checkoutOrderId || '').trim()
  const checkinOrderId = String(params?.checkinOrderId || '').trim()
  if (checkoutOrderId && checkinOrderId && checkoutOrderId !== checkinOrderId) {
    return `turnover:${checkoutOrderId}:${checkinOrderId}`
  }
  const sourceId = String(params?.sourceId || '').trim()
  return sourceId ? `cleaning_task:${sourceId}` : null
}

export function isDeferredInspectionExecutionDayProjection(params: {
  displayMergeEligible?: any
  hasDisplayCheckinSource?: any
  groupDate?: any
  effectiveInspectionDate?: any
}): boolean {
  const groupDate = inspectionDayOnly(params?.groupDate)
  const effectiveInspectionDate = inspectionDayOnly(params?.effectiveInspectionDate)
  return params?.displayMergeEligible === true
    && params?.hasDisplayCheckinSource === true
    && !!groupDate
    && groupDate === effectiveInspectionDate
}

export function deferredInspectionManagerTimingAuthority(
  children0: any[],
  mergedTurnoverDisplay0: any,
): {
  deferredInspectionMerged: boolean
  currentDayCheckout: boolean | null
  checkoutTimingAuthoritative: boolean
  turnoverDisplay: any
} {
  const children = Array.isArray(children0) ? children0 : []
  const deferredInspectionMerged = children.some((child) => child?.deferred_inspection_merged === true)
  const currentDayCheckout = deferredInspectionMerged
    ? children.some((child) => child?.deferred_inspection_current_day_checkout === true)
    : null
  const checkoutTimingAuthoritative = !deferredInspectionMerged || currentDayCheckout === true
  const mergedTurnoverDisplay = mergedTurnoverDisplay0 || null
  return {
    deferredInspectionMerged,
    currentDayCheckout,
    checkoutTimingAuthoritative,
    turnoverDisplay: deferredInspectionMerged && currentDayCheckout === false
      ? {
          ...(mergedTurnoverDisplay || {}),
          checkout_time: null,
          is_late_checkout: false,
        }
      : mergedTurnoverDisplay,
  }
}

/**
 * A two-source key-handover fact may only be shared by one reliable turnover:
 * either an explicit same-property/same-date check-in -> checkout relation, or
 * the canonical booking boundary between two distinct orders. Room/date/
 * assignee grouping alone is deliberately insufficient.
 */
export function canonicalKeyHandoverSourceIds(tasks: any[]): string[] {
  const rows = (Array.isArray(tasks) ? tasks : []).filter(Boolean)
  if (rows.length === 1) {
    if (!isActiveCleaningTurnoverCandidate(rows[0])) return []
    const sourceId = String(rows[0]?.__raw_id || rows[0]?.source_id || rows[0]?.id || '').trim()
    return sourceId ? [sourceId] : []
  }
  if (rows.length !== 2
    || rows.some((row) => String(row?.__work_record_state || '').trim())
    || rows.some((row) => !isActiveCleaningTurnoverCandidate(row))) return []

  const checkout = rows.find((row) => cleaningInspectionTaskKind(row?.task_type ?? row?.type) === 'checkout')
  const checkin = rows.find((row) => cleaningInspectionTaskKind(row?.task_type ?? row?.type) === 'checkin')
  if (!checkout || !checkin) return []

  const checkoutId = cleaningSourceId(checkout)
  const checkinId = cleaningSourceId(checkin)
  const checkoutOrderId = String(checkout?.order_id || '').trim()
  const checkinOrderId = String(checkin?.order_id || '').trim()
  const checkoutPropertyId = String(checkout?.property_id || checkout?.__prop_id || '').trim()
  const checkinPropertyId = String(checkin?.property_id || checkin?.__prop_id || '').trim()
  const checkoutTaskDate = inspectionDayOnly(checkout?.task_date ?? checkout?.date ?? checkout?.__date)
  const checkinTaskDate = inspectionDayOnly(checkin?.task_date ?? checkin?.date ?? checkin?.__date)
  const outgoingCheckoutDate = inspectionDayOnly(checkout?.order_checkout)
  const incomingCheckinDate = inspectionDayOnly(checkin?.order_checkin)

  if (!checkoutId || !checkinId || checkoutId === checkinId) return []
  if (explicitCheckoutLinkPair(checkout, checkin)) return [checkoutId, checkinId]
  if (!checkoutOrderId || !checkinOrderId || checkoutOrderId === checkinOrderId) return []
  if (!checkoutPropertyId || checkoutPropertyId !== checkinPropertyId) return []
  if (!checkoutTaskDate || checkoutTaskDate !== checkinTaskDate) return []
  if (outgoingCheckoutDate !== checkoutTaskDate || incomingCheckinDate !== checkinTaskDate) return []
  return [checkoutId, checkinId]
}

/**
 * A manager projection may contain only the currently visible phase of an
 * otherwise canonical turnover (for example, the checkout completion record
 * after the check-in phase has been suppressed). Keep the full, explicit
 * booking-boundary source set in that case. Any unrelated active source still
 * fails closed, so property/date similarity alone can never borrow evidence.
 */
export function canonicalKeyHandoverSourceIdsForProjection(
  relationRows: any[],
  activeSourceIds0: any[],
): string[] {
  const canonicalSourceIds = canonicalKeyHandoverSourceIds(relationRows)
  const activeSourceIds = Array.from(new Set(
    (Array.isArray(activeSourceIds0) ? activeSourceIds0 : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  ))
  if (!canonicalSourceIds.length || !activeSourceIds.length) return []
  return activeSourceIds.every((sourceId) => canonicalSourceIds.includes(sourceId))
    ? canonicalSourceIds
    : []
}

export function mergeCleaningKeyHandoverProjections(
  tasks: any[],
  canonicalSourceIds: string[],
): CleaningKeyHandoverProjection | null {
  const allowedSourceIds = new Set(
    (Array.isArray(canonicalSourceIds) ? canonicalSourceIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )
  if (!allowedSourceIds.size || allowedSourceIds.size > 2) return null
  const facts = (Array.isArray(tasks) ? tasks : [])
    .map((task) => task?.key_handover)
    .filter((fact): fact is CleaningKeyHandoverProjection => (
      fact?.state === 'completed'
      && allowedSourceIds.has(String(fact?.source_task_id || '').trim())
    ))
  if (!facts.length) return null
  const videoFacts = facts.filter((fact) => fact.confirmation_source === 'video' || fact.media_evidence_present === true)
  const preferredFacts = videoFacts.length ? videoFacts : facts
  const latest = preferredFacts.slice().sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')))[0]
  const missingRequirements = Array.from(new Set(
    facts.flatMap((fact) => Array.isArray(fact.missing_requirements) ? fact.missing_requirements.map(String) : []),
  ))
  return {
    ...latest,
    workflow_finalization_pending: facts.some((fact) => fact.workflow_finalization_pending === true),
    missing_requirements: missingRequirements,
  }
}

export function hasCheckoutCheckinTurnover(rows: Array<{ task_type?: any; type?: any }>): boolean {
  const kinds = new Set((Array.isArray(rows) ? rows : []).map((row) => (
    cleaningInspectionTaskKind(row?.task_type ?? row?.type)
  )))
  return kinds.has('checkout') && kinds.has('checkin')
}

export function normalizeTurnoverInspectionScope(params: {
  inspectionScope?: any
  hasCheckoutCheckinTurnover?: boolean
}): InspectionScope {
  return params?.hasCheckoutCheckinTurnover
    ? 'inspect_and_hang'
    : normalizeInspectionScope(params?.inspectionScope)
}

export function normalizeInspectionMode(value: any): InspectionMode | null {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return null
  return VALID_INSPECTION_MODES.has(raw as InspectionMode) ? (raw as InspectionMode) : null
}

export function isInspectionModeAllowedForTask(params: {
  taskType?: any
  inspectionScope?: any
  inspectionMode?: any
}): boolean {
  const mode = normalizeInspectionMode(params?.inspectionMode)
  if (!mode) return false
  if (cleaningInspectionTaskKind(params?.taskType) !== 'checkin') return true
  if (normalizeInspectionScope(params?.inspectionScope) !== 'password_only') return true
  return mode !== 'self_complete' && mode !== 'checked_done'
}

export function sanitizeInspectionModeForTask(params: {
  taskType?: any
  inspectionScope?: any
  inspectionMode?: InspectionMode | null | undefined
}): InspectionMode {
  const mode = params?.inspectionMode || 'pending_decision'
  if (!isInspectionModeAllowedForTask({
    taskType: params?.taskType,
    inspectionScope: params?.inspectionScope,
    inspectionMode: mode,
  })) {
    return 'same_day'
  }
  return mode
}

export function cleaningInspectionTaskKind(taskType: any): 'checkout' | 'checkin' | 'stayover' | 'other' {
  const raw = String(taskType || '').trim().toLowerCase()
  if (raw === 'checkout_clean') return 'checkout'
  if (raw === 'checkin_clean') return 'checkin'
  if (raw === 'stayover_clean') return 'stayover'
  return 'other'
}

export function isCheckinKeyHandoverTask(task: { task_type?: any; inspection_scope?: any }): boolean {
  return cleaningInspectionTaskKind(task?.task_type) === 'checkin' && normalizeInspectionScope(task?.inspection_scope) === 'password_only'
}

export function isCleaningExecutionTask(task: { task_type?: any; inspection_scope?: any }): boolean {
  return cleaningInspectionTaskKind(task?.task_type) !== 'checkin'
}

export function cleaningTaskExecutionSemantics(params: {
  roleKind?: any
  taskType?: any
  inspectionScope?: any
  hasCleaningExecution?: boolean
  hasInspectionExecution?: boolean
  hasKeyHandoverExecution?: boolean
}): CleaningTaskExecutionSemantics {
  if (params?.hasKeyHandoverExecution) return 'key_or_password_action'
  if (params?.hasCleaningExecution && params?.hasInspectionExecution) return 'mixed_cleaning_inspection'
  const role = String(params?.roleKind || '').trim().toLowerCase()
  if (role === 'executor' || role === 'execution') return 'key_or_password_action'
  if (role === 'cleaner' || role === 'cleaning') return 'cleaning_execution'
  if (isCheckinKeyHandoverTask({ task_type: params?.taskType, inspection_scope: params?.inspectionScope })) return 'key_or_password_action'
  if (cleaningInspectionTaskKind(params?.taskType) === 'checkin') return 'checkin_inspection'
  return 'inspection_execution'
}

export function isInspectionFinishedStatus(status: any): boolean {
  const raw = String(status || '').trim().toLowerCase()
  return raw === 'inspected' || raw === 'done' || raw === 'completed' || raw === 'ready' || raw === 'keys_hung'
}

export function isTerminalDeferredInspectionStatus(status: any): boolean {
  return TERMINAL_DEFERRED_INSPECTION_STATUS_SET.has(String(status || '').trim().toLowerCase())
}

/** The exact task's current lockbox video is the physical handover fact. */
export function lockboxVideoConfirmsCurrentTaskState(params: {
  status?: any
  lockboxVideoUrl?: any
}): boolean {
  return !!String(params?.lockboxVideoUrl || '').trim()
}

export function keyPhotoConfirmsCurrentTaskProgress(params: {
  status?: any
  keyPhotoUrl?: any
}): boolean {
  if (!String(params?.keyPhotoUrl || '').trim()) return false
  return KEY_PHOTO_CURRENT_PROGRESS_STATUSES.has(String(params?.status || '').trim().toLowerCase())
}

/**
 * An overdue deferred inspection without a stored checkout/check-in
 * arrangement is an independent source of work. Keep it out of ordinary
 * date/property turnover de-duplication so its assignee, state, and evidence
 * cannot leak into a later booking.
 */
export function unlinkedDeferredInspectionMergeKey(params: {
  sourceId?: any
  inspectionMode?: any
  hasExplicitInspectionRelation?: boolean
}): string | null {
  if (normalizeInspectionMode(params?.inspectionMode) !== 'deferred') return null
  if (params?.hasExplicitInspectionRelation === true) return null
  const sourceId = String(params?.sourceId || '').trim()
  return sourceId ? `deferred:${sourceId}` : null
}

export function withInspectionMergeIsolation(baseKey: string, isolationKey?: any): string {
  const isolated = String(isolationKey || '').trim()
  return isolated ? `${baseKey}|${isolated}` : baseKey
}

export function openDeferredInspectionStatusSql(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('invalid_sql_alias')
  const terminalStatuses = TERMINAL_DEFERRED_INSPECTION_STATUSES.map((status) => `'${status}'`).join(', ')
  return `lower(COALESCE(${alias}.status, '')) NOT IN (${terminalStatuses})`
}

export function projectInspectorTaskStatus(status: any, inspectionScope: any): string {
  const raw = String(status || '').trim().toLowerCase()
  if (raw !== 'inspected') return raw
  return normalizeInspectionScope(inspectionScope) === 'password_only' ? 'done' : 'to_hang_keys'
}

export function isCleaningDoneLikeStatus(status: any): boolean {
  const raw = String(status || '').trim().toLowerCase()
  return (
    raw === 'cleaned' ||
    raw === 'restock_pending' ||
    raw === 'restocked' ||
    raw === 'inspected' ||
    raw === 'done' ||
    raw === 'completed' ||
    raw === 'ready' ||
    raw === 'keys_hung'
  )
}

export function defaultInspectionModeForTaskType(taskType: any): InspectionMode {
  const kind = cleaningInspectionTaskKind(taskType)
  if (kind === 'stayover') return 'self_complete'
  if (kind === 'checkin') return 'same_day'
  return 'pending_decision'
}

export function effectiveInspectionMode(task: {
  task_type?: any
  inspection_mode?: any
  inspection_scope?: any
  status?: any
  cleaner_id?: any
  inspector_id?: any
}): InspectionMode {
  const explicit = normalizeInspectionMode(task?.inspection_mode)
  if (explicit) {
    return sanitizeInspectionModeForTask({
      taskType: task?.task_type,
      inspectionScope: task?.inspection_scope,
      inspectionMode: explicit,
    })
  }
  const kind = cleaningInspectionTaskKind(task?.task_type)
  if (kind === 'stayover') return 'self_complete'
  if (kind === 'checkin') return 'same_day'
  if (kind === 'checkout') {
    if (String(task?.inspector_id || '').trim()) return 'same_day'
    if (isCleaningDoneLikeStatus(task?.status)) return 'self_complete'
    return 'pending_decision'
  }
  if (String(task?.inspector_id || '').trim()) return 'same_day'
  return 'pending_decision'
}

/**
 * Legacy participant fallback for the submit_inspection business action.
 * Manual work-task grants are evaluated separately by the route.
 */
export function isCleaningTaskInspectionSubmitParticipant(task: {
  task_type?: any
  type?: any
  inspection_mode?: any
  inspection_scope?: any
  status?: any
  inspector_id?: any
  assignee_id?: any
}, userId: any): boolean {
  const uid = String(userId || '').trim()
  if (!uid) return false
  const mode = effectiveInspectionMode(task)
  const scope = normalizeInspectionScope(task?.inspection_scope)
  const kind = cleaningInspectionTaskKind(task?.task_type ?? task?.type)
  if (scope === 'password_only') return false
  if (mode !== 'same_day' && mode !== 'deferred') return false
  const inspectorId = String(task?.inspector_id || '').trim()
  const assigneeId = String(task?.assignee_id || '').trim()
  if (kind === 'checkin') return inspectorId === uid || assigneeId === uid
  if (kind === 'checkout') return inspectorId ? inspectorId === uid : assigneeId === uid
  return !!inspectorId && inspectorId === uid
}

export function deferredProjectionDate(params: {
  inspectionMode: InspectionMode
  inspectionDueDate?: any
  dateFrom: string
  dateTo: string
  status?: any
}): string | null {
  if (params.inspectionMode !== 'deferred') return null
  const due = String(params.inspectionDueDate || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null
  const from = String(params.dateFrom || '').slice(0, 10)
  const to = String(params.dateTo || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null
  if (due > to) return null
  if (due < from && (isInspectionFinishedStatus(params.status) || ['cancelled', 'canceled'].includes(String(params.status || '').trim().toLowerCase()))) {
    return null
  }
  return due < from ? from : due
}

export function mobileInspectionProjectionDate(params: {
  inspectionMode: InspectionMode
  inspectionDueDate?: any
  taskDate?: any
  dateFrom: string
  dateTo: string
  status?: any
}): string | null {
  if (params.inspectionMode === 'deferred') {
    return deferredProjectionDate(params)
  }

  const taskDate = String(params.taskDate || '').slice(0, 10)
  const from = String(params.dateFrom || '').slice(0, 10)
  const to = String(params.dateTo || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(taskDate)) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null
  if (taskDate < from || taskDate > to) return null
  if (params.inspectionMode === 'same_day') return taskDate

  const status = String(params.status || '').trim().toLowerCase()
  if (params.inspectionMode === 'self_complete' && status === 'keys_hung') return taskDate
  return null
}

export function mergeInspectionPlan(
  rows: Array<{
    task_type?: any
    inspection_mode?: any
    inspection_due_date?: any
    inspector_id?: any
    status?: any
  }>,
): { inspectionMode: InspectionMode; inspectionDueDate: string | null } {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : []
  if (!list.length) return { inspectionMode: 'pending_decision', inspectionDueDate: null }

  const kindOf = (row: any) => cleaningInspectionTaskKind(row?.task_type)
  const checkoutRows = list.filter((row) => kindOf(row) === 'checkout')
  const actionableRows = checkoutRows.length
    ? checkoutRows
    : list.filter((row) => kindOf(row) !== 'stayover')
  const relevantRows = actionableRows.length ? actionableRows : list

  const dueDateFor = (row: any) => {
    const s = String(row?.inspection_due_date || '').slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
  }

  for (const row of relevantRows) {
    if (effectiveInspectionMode(row) === 'deferred') {
      return {
        inspectionMode: 'deferred',
        inspectionDueDate: dueDateFor(row),
      }
    }
  }

  if (relevantRows.some((row) => effectiveInspectionMode(row) === 'same_day')) {
    return { inspectionMode: 'same_day', inspectionDueDate: null }
  }

  if (relevantRows.some((row) => effectiveInspectionMode(row) === 'pending_decision')) {
    return { inspectionMode: 'pending_decision', inspectionDueDate: null }
  }

  if (relevantRows.some((row) => effectiveInspectionMode(row) === 'checked_done')) {
    return { inspectionMode: 'checked_done', inspectionDueDate: null }
  }

  if (relevantRows.every((row) => effectiveInspectionMode(row) === 'self_complete')) {
    return { inspectionMode: 'self_complete', inspectionDueDate: null }
  }

  return { inspectionMode: 'pending_decision', inspectionDueDate: null }
}

function mergedTaskStatus(statuses: any[]): string {
  const values = statuses.map((status) => String(status || '').trim().toLowerCase() || 'pending')
  if (values.length && values.every((status) => status === 'cancelled' || status === 'canceled')) return 'cancelled'
  const rank = (status: string) => {
    if (status === 'keys_hung') return 90
    if (status === 'done' || status === 'completed' || status === 'ready') return 80
    if (status === 'inspected') return 75
    if (status === 'cleaned' || status === 'restock_pending' || status === 'restocked' || status === 'to_inspect' || status === 'to_hang_keys') return 70
    if (status === 'in_progress') return 50
    if (status === 'assigned' || status === 'scheduled') return 40
    if (status === 'pending' || status === 'todo' || status === 'unassigned') return 10
    return 0
  }
  let best = ''
  let bestRank = -1
  for (const status of values) {
    const nextRank = rank(status)
    if (nextRank > bestRank) {
      best = status
      bestRank = nextRank
    }
  }
  if (best) return best
  return 'pending'
}

function matchingId(rows: any[], pick: (row: any) => any): { matches: boolean; value: string | null } {
  if (!rows.length) return { matches: true, value: null }
  const values = rows.map((row) => String(pick(row) || '').trim())
  return {
    matches: values.every((value) => value === values[0]),
    value: values[0] || null,
  }
}

export function mergeTurnoverTaskPlan(
  rows: Array<{
    task_type?: any
    cleaner_id?: any
    assignee_id?: any
    inspector_id?: any
    status?: any
    inspection_mode?: any
    inspection_scope?: any
    inspection_due_date?: any
  }>,
): {
  cleanerId: string | null
  assigneeId: string | null
  inspectorId: string | null
  status: string
  inspectionMode: InspectionMode
  inspectionScope: InspectionScope
  inspectionDueDate: string | null
} {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : []
  const checkoutRows = list.filter((row) => cleaningInspectionTaskKind(row?.task_type) === 'checkout')
  const primaryRows = checkoutRows.length ? checkoutRows : list
  const cleaner = matchingId(primaryRows, (row) => row?.cleaner_id || row?.assignee_id)
  const assignee = matchingId(primaryRows, (row) => row?.assignee_id)
  const inspectionRows = checkoutRows.length
    ? checkoutRows
    : list.filter((row) => cleaningInspectionTaskKind(row?.task_type) !== 'stayover')
  const inspector = matchingId(inspectionRows.length ? inspectionRows : list, (row) => row?.inspector_id)
  const inspectionPlan = mergeInspectionPlan(list)
  const cleanerId = cleaner.matches ? cleaner.value : null
  const hasTurnover = hasCheckoutCheckinTurnover(list)

  return {
    cleanerId,
    assigneeId: assignee.matches ? (assignee.value || cleanerId) : cleanerId,
    inspectorId: inspector.matches ? inspector.value : null,
    status: mergedTaskStatus(list.map((row) => row?.status)),
    inspectionMode: inspectionPlan.inspectionMode,
    inspectionScope: normalizeTurnoverInspectionScope({
      inspectionScope: list.find((row) => cleaningInspectionTaskKind(row?.task_type) === 'checkin')?.inspection_scope,
      hasCheckoutCheckinTurnover: hasTurnover,
    }),
    inspectionDueDate: inspectionPlan.inspectionDueDate,
  }
}
