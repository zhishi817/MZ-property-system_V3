import { deleteJSON, postJSON } from './api'

export type MaintenanceWorkflowActionResponse = {
  ok: boolean
  status: string
  id: string
}

export type InternalMaintenanceFeedbackCreateResponse = {
  ok: boolean
  id?: string
  existing_id?: string
}

export type InternalMaintenanceFeedbackDeleteResponse = {
  ok: boolean
  deleted: boolean
}

export function internalMaintenanceFeedbackCreatePath() {
  return '/mzapp/property-feedbacks'
}

export function internalMaintenanceFeedbackDeletePath(recordId: string) {
  const id = String(recordId || '').trim()
  if (!id) throw new Error('maintenance_record_id_required')
  return `/mzapp/property-feedbacks/maintenance/${encodeURIComponent(id)}`
}

export async function deleteInternalMaintenanceFeedback(recordId: string) {
  return deleteJSON<InternalMaintenanceFeedbackDeleteResponse>(
    internalMaintenanceFeedbackDeletePath(recordId),
    { timeoutMs: 30_000 },
  )
}

export async function createInternalMaintenanceFeedback(input: {
  propertyId: string
  area: string
  detail: string
  mediaUrls?: string[]
  invoiceDescriptionEn?: string | null
  submitId: string
}) {
  const propertyId = String(input.propertyId || '').trim()
  const area = String(input.area || '').trim()
  const detail = String(input.detail || '').trim()
  if (!propertyId || !area || !detail) throw new Error('maintenance_feedback_fields_required')
  const submitId = String(input.submitId || '').trim()
  if (!submitId) throw new Error('maintenance_submit_id_required')
  return postJSON<InternalMaintenanceFeedbackCreateResponse>(internalMaintenanceFeedbackCreatePath(), {
    kind: 'maintenance',
    property_id: propertyId,
    area,
    detail,
    media_urls: Array.from(new Set((input.mediaUrls || []).map((url) => String(url || '').trim()).filter(Boolean))),
    invoice_description_en: String(input.invoiceDescriptionEn || '').trim() || undefined,
    submit_id: submitId,
    step_key: 'web_maintenance_feedback_create',
  }, { timeoutMs: 30_000 })
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
