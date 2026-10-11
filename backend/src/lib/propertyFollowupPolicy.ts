export const PROPERTY_FOLLOWUP_SOURCE_TYPES = [
  'property_maintenance',
  'property_deep_cleaning',
  'property_daily_necessities',
] as const

export type PropertyFollowupSourceType = typeof PROPERTY_FOLLOWUP_SOURCE_TYPES[number]

export type PropertyFollowupAssignmentState = {
  assigneeId: string | null
  status: 'todo' | 'assigned' | 'in_progress'
}

const REVIEW_ONLY_STATUSES = new Set([
  'pending_review',
  'review_pending',
  'awaiting_review',
])
const TERMINAL_STATUSES = new Set([
  'cancelled',
  'canceled',
  'closed',
])
const COMPLETED_STATUSES = new Set([
  'completed',
  'done',
  'ready',
])
const CLOSED_REVIEW_STATUSES = new Set([
  'approved',
  'closed',
  'completed',
  'done',
  'ready',
])

function normalized(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

function id(value: unknown) {
  return String(value ?? '').trim() || null
}

export function isPropertyFollowupSourceType(value: unknown): value is PropertyFollowupSourceType {
  return PROPERTY_FOLLOWUP_SOURCE_TYPES.includes(normalized(value) as PropertyFollowupSourceType)
}

export function propertyFollowupTaskId(sourceType: PropertyFollowupSourceType, sourceId: unknown) {
  const id = String(sourceId ?? '').trim()
  return id ? `${sourceType}:${id}` : ''
}

export function parsePropertyFollowupTaskId(value: unknown): {
  sourceType: PropertyFollowupSourceType
  sourceId: string
} | null {
  const taskId = String(value ?? '').trim()
  const separator = taskId.indexOf(':')
  if (separator <= 0 || separator === taskId.length - 1) return null
  const sourceType = taskId.slice(0, separator)
  const sourceId = taskId.slice(separator + 1).trim()
  if (!isPropertyFollowupSourceType(sourceType) || !sourceId) return null
  return { sourceType, sourceId }
}

/**
 * Web scheduling candidates are intentionally broader than the Mobile daily
 * execution list: an active, date-matched source remains schedulable before an
 * executor is assigned. Review-only, terminal and completed workflows do not.
 */
export function isActivePropertyFollowupSource(input: {
  sourceType: unknown
  status?: unknown
  reviewStatus?: unknown
  deletedAt?: unknown
}) {
  const sourceType = normalized(input.sourceType)
  const status = normalized(input.status)
  const reviewStatus = normalized(input.reviewStatus)
  if (!isPropertyFollowupSourceType(sourceType)) return false
  if (String(input.deletedAt ?? '').trim()) return false
  if (sourceType === 'property_daily_necessities') return (status || 'need_replace') === 'need_replace'
  if (REVIEW_ONLY_STATUSES.has(status) || REVIEW_ONLY_STATUSES.has(reviewStatus)) return false
  if (TERMINAL_STATUSES.has(status) || TERMINAL_STATUSES.has(reviewStatus)) return false
  if (COMPLETED_STATUSES.has(status) || CLOSED_REVIEW_STATUSES.has(reviewStatus)) return false
  return true
}

/**
 * Assignment authority differs by workflow:
 * - maintenance is source-owned, so stale work projections never override it;
 * - deep-cleaning currently persists Web assignments in work_tasks, so an
 *   existing work projection is authoritative (including an explicit null
 *   after unassign); the source is only the pre-materialization fallback;
 * - daily necessities is projection-owned and reads only from work_tasks.
 */
export function resolvePropertyFollowupAssignment(input: {
  sourceType: PropertyFollowupSourceType
  sourceAssigneeId?: unknown
  sourceStatus?: unknown
  workAssigneeId?: unknown
  workProjectionExists?: boolean
}): PropertyFollowupAssignmentState {
  const sourceAssigneeId = id(input.sourceAssigneeId)
  const workAssigneeId = id(input.workAssigneeId)
  const sourceStatus = normalized(input.sourceStatus)
  const sourceInProgress = ['in_progress', 'repairing', 'started'].includes(sourceStatus)

  if (input.sourceType === 'property_maintenance') {
    return {
      assigneeId: sourceAssigneeId,
      status: sourceInProgress ? 'in_progress' : sourceAssigneeId ? 'assigned' : 'todo',
    }
  }
  const assigneeId = input.sourceType === 'property_deep_cleaning'
    ? input.workProjectionExists ? workAssigneeId : sourceAssigneeId
    : workAssigneeId
  return {
    assigneeId,
    status: sourceInProgress ? 'in_progress' : assigneeId ? 'assigned' : 'todo',
  }
}

/** Keep source-derived text out of client-controlled save diffs and updates. */
export function canonicalizePropertyFollowupAssignmentForSave<
  T extends Record<string, unknown>,
  B extends { source_type?: unknown; title?: unknown; summary?: unknown; urgency?: unknown },
>(assignment: T, before: B | null | undefined): T {
  if (!isPropertyFollowupSourceType(before?.source_type)) return { ...assignment }
  return {
    ...assignment,
    title: before?.title,
    summary: before?.summary,
    urgency: before?.urgency,
  }
}
