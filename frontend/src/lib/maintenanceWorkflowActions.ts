import { deleteJSON, postJSON } from './api'

export type MaintenanceWorkflowActionResponse = {
  ok: boolean
  status: string
  id: string
  can_manage_workflow?: boolean
  available_actions?: string[]
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

export function shouldUpdateInternalMaintenanceRecordViaCrud(input: {
  assignmentChanged: boolean
  recordActualRepairerWithCompletion: boolean
}) {
  return !input.assignmentChanged || input.recordActualRepairerWithCompletion
}

export function internalMaintenanceAssignPath(recordId: string) {
  const id = String(recordId || '').trim()
  if (!id) throw new Error('maintenance_record_id_required')
  return `/maintenance/workflow/internal/${encodeURIComponent(id)}/assign`
}

export function internalMaintenanceReviewPath(recordId: string) {
  return internalMaintenanceWorkflowPath(recordId, 'review')
}

export function internalMaintenanceWorkflowPath(recordId: string, action: string) {
  const id = String(recordId || '').trim()
  if (!id) throw new Error('maintenance_record_id_required')
  const safeAction = String(action || '').trim()
  if (!safeAction) throw new Error('maintenance_workflow_action_required')
  return `/maintenance/workflow/internal/${encodeURIComponent(id)}/${encodeURIComponent(safeAction)}`
}

export function shouldAutoApproveInternalMaintenanceSettlement(input: {
  status?: string | null
  payMethod?: string | null
  canManageWorkflow?: boolean
}) {
  const status = String(input.status || '').trim().toLowerCase()
  const payMethod = String(input.payMethod || '').trim()
  return ['pending_review', 'review_pending', 'awaiting_review', 'completed', 'done', 'ready'].includes(status)
    && !!payMethod
    && input.canManageWorkflow === true
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

export async function approveInternalMaintenance(input: {
  recordId: string
  assigneeId?: string | null
  completedAt?: string | null
  operationId?: string
}) {
  return postJSON<MaintenanceWorkflowActionResponse>(internalMaintenanceReviewPath(input.recordId), {
    decision: 'approved',
    ...(String(input.assigneeId || '').trim() ? { assignee_id: String(input.assigneeId).trim() } : {}),
    ...(String(input.completedAt || '').trim() ? { completed_at: String(input.completedAt).trim() } : {}),
    ...(String(input.operationId || '').trim() ? { operation_id: String(input.operationId).trim() } : {}),
  }, { timeoutMs: 10_000 })
}

export async function manageInternalMaintenanceWorkflow(input: {
  recordId: string
  action: 'manager_start' | 'manager_complete' | 'review' | 'reopen' | 'cancel'
  assigneeId?: string | null
  decision?: 'approved' | 'rejected'
  completionPhotoUrls?: string[]
  completionNote?: string | null
  completedAt?: string | null
  reason?: string | null
  operationId?: string
}) {
  const completionPhotoUrls = Array.from(new Set((input.completionPhotoUrls || []).map((url) => String(url || '').trim()).filter(Boolean)))
  return postJSON<MaintenanceWorkflowActionResponse>(internalMaintenanceWorkflowPath(input.recordId, input.action), {
    ...(String(input.assigneeId || '').trim() ? { assignee_id: String(input.assigneeId).trim() } : {}),
    ...(input.decision ? { decision: input.decision } : {}),
    ...(completionPhotoUrls.length ? { completion_photo_urls: completionPhotoUrls } : {}),
    ...(String(input.completionNote || '').trim() ? { completion_note: String(input.completionNote).trim() } : {}),
    ...(String(input.completedAt || '').trim() ? { completed_at: String(input.completedAt).trim() } : {}),
    ...(String(input.reason || '').trim() ? { reason: String(input.reason).trim() } : {}),
    ...(String(input.operationId || '').trim() ? { operation_id: String(input.operationId).trim() } : {}),
  }, { timeoutMs: 10_000 })
}
