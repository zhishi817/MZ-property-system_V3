import { postJSON } from './api'

export type MaintenanceWorkflowActionResponse = {
  ok: boolean
  status: string
  id: string
}

export function internalMaintenanceAssignmentChanged(input: {
  currentAssigneeId?: string | null
  currentScheduledDate?: string | null
  nextAssigneeId?: string | null
  nextScheduledDate?: string | null
}) {
  const assignee = (value: string | null | undefined) => String(value || '').trim()
  const date = (value: string | null | undefined) => String(value || '').trim().slice(0, 10)
  return assignee(input.currentAssigneeId) !== assignee(input.nextAssigneeId)
    || date(input.currentScheduledDate) !== date(input.nextScheduledDate)
}

export function internalMaintenanceAssignPath(recordId: string) {
  const id = String(recordId || '').trim()
  if (!id) throw new Error('maintenance_record_id_required')
  return `/maintenance/workflow/internal/${encodeURIComponent(id)}/assign`
}

export async function assignInternalMaintenance(input: {
  recordId: string
  assigneeId: string
  scheduledDate: string | null
  recordPatch?: Record<string, any>
  operationId?: string
}) {
  const assigneeId = String(input.assigneeId || '').trim()
  if (!assigneeId) throw new Error('maintenance_assignee_required')
  return postJSON<MaintenanceWorkflowActionResponse>(internalMaintenanceAssignPath(input.recordId), {
    assignee_id: assigneeId,
    scheduled_date: input.scheduledDate,
    ...(input.recordPatch && Object.keys(input.recordPatch).length ? { record_patch: input.recordPatch } : {}),
    ...(String(input.operationId || '').trim() ? { operation_id: String(input.operationId).trim() } : {}),
  }, { timeoutMs: 10_000 })
}
