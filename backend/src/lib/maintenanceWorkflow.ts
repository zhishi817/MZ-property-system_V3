import { MAINTENANCE_WORKFLOW_STATUSES } from './maintenanceWorkflowSchema'

export const MAINTENANCE_WORKFLOW_MANAGE_PERMISSION = 'property_maintenance.workflow.manage'

export type MaintenanceWorkflowStatus = typeof MAINTENANCE_WORKFLOW_STATUSES[number]
export type MaintenanceWorkflowAction =
  | 'assign'
  | 'start'
  | 'submit'
  | 'executor_complete'
  | 'executor_unfinished'
  | 'manager_start'
  | 'manager_complete'
  | 'review_approved'
  | 'review_rejected'
  | 'correct_completion'
  | 'reopen'
  | 'cancel'
  | 'hold'

export function normalizeMaintenanceWorkflowStatus(rawStatus: any, rawReviewStatus?: any): MaintenanceWorkflowStatus {
  const status = String(rawStatus || '').trim().toLowerCase()
  const reviewStatus = String(rawReviewStatus || '').trim().toLowerCase()
  if (status === 'closed' || reviewStatus === 'approved' || reviewStatus === 'closed') return 'closed'
  if (status === 'cancelled' || status === 'canceled') return 'cancelled'
  if (status === 'pending_review' || status === 'review_pending' || status === 'awaiting_review') return 'pending_review'
  if (status === 'completed' || status === 'done' || status === 'ready') return 'pending_review'
  if (status === 'in_progress' || status === 'repairing' || status === 'started') return 'in_progress'
  if (status === 'assigned') return 'assigned'
  return 'pending_assignment'
}

export function maintenanceWorkTaskStatus(status: MaintenanceWorkflowStatus): string {
  if (status === 'pending_assignment') return 'todo'
  if (status === 'closed') return 'done'
  return status
}

export function availableMaintenanceActions(input: {
  status: MaintenanceWorkflowStatus
  isManager: boolean
  isAssignedExecutor: boolean
}): string[] {
  const actions = new Set<string>()
  if (input.isManager) {
    if (input.status === 'pending_assignment' || input.status === 'assigned' || input.status === 'in_progress') {
      actions.add('assign')
      actions.add('cancel')
    }
    if (input.status === 'pending_assignment' || input.status === 'assigned') actions.add('manager_start')
    if (input.status === 'pending_assignment' || input.status === 'assigned' || input.status === 'in_progress') actions.add('manager_complete')
    if (input.status === 'in_progress') actions.add('hold')
    if (input.status === 'pending_review') actions.add('review')
    if (input.status === 'closed') {
      actions.add('correct_completion')
      actions.add('reopen')
    }
  }
  if (input.isAssignedExecutor) {
    if (input.status === 'assigned' || input.status === 'in_progress') {
      // Any active internal user may be assigned. The assignee is the only
      // executor; the workflow route records an implicit start when needed.
      actions.add('executor_complete')
      actions.add('executor_unfinished')
    }
  }
  return Array.from(actions)
}

export function validateMaintenanceWorkflowAction(input: {
  action: MaintenanceWorkflowAction
  status: MaintenanceWorkflowStatus
  isManager: boolean
  isAssignedExecutor: boolean
  completionPhotoCount?: number
  reason?: string | null
}): { ok: true } | { ok: false; code: string } {
  const reason = String(input.reason || '').trim()
  const managerActions: MaintenanceWorkflowAction[] = ['assign', 'manager_start', 'manager_complete', 'review_approved', 'review_rejected', 'correct_completion', 'reopen', 'cancel']
  if (managerActions.includes(input.action) && !input.isManager) return { ok: false, code: 'maintenance_manager_required' }
  if (['start', 'submit', 'executor_complete', 'executor_unfinished'].includes(input.action) && !input.isAssignedExecutor) return { ok: false, code: 'maintenance_assignee_required' }
  if (input.action === 'hold' && !input.isManager) return { ok: false, code: 'maintenance_manager_required' }
  if (input.action === 'assign' && !['pending_assignment', 'assigned', 'in_progress'].includes(input.status)) return { ok: false, code: 'maintenance_transition_invalid' }
  if (input.action === 'start' && input.status !== 'assigned') return { ok: false, code: 'maintenance_transition_invalid' }
  if (input.action === 'manager_start' && !['pending_assignment', 'assigned', 'in_progress'].includes(input.status)) return { ok: false, code: 'maintenance_transition_invalid' }
  if (input.action === 'submit' && input.status !== 'in_progress') return { ok: false, code: 'maintenance_transition_invalid' }
  if (input.action === 'manager_complete' && !['pending_assignment', 'assigned', 'in_progress'].includes(input.status)) return { ok: false, code: 'maintenance_transition_invalid' }
  if (input.action === 'executor_complete' && !['assigned', 'in_progress'].includes(input.status)) return { ok: false, code: 'maintenance_transition_invalid' }
  if (input.action === 'executor_unfinished' && !['assigned', 'in_progress'].includes(input.status)) return { ok: false, code: 'maintenance_transition_invalid' }
  if ((input.action === 'submit' || input.action === 'executor_complete' || input.action === 'manager_complete' || input.action === 'review_approved') && Number(input.completionPhotoCount || 0) < 1) {
    return { ok: false, code: 'maintenance_completion_photo_required' }
  }
  if (input.action === 'executor_unfinished' && !reason) return { ok: false, code: 'maintenance_unfinished_reason_required' }
  if ((input.action === 'review_approved' || input.action === 'review_rejected') && input.status !== 'pending_review') {
    return { ok: false, code: 'maintenance_transition_invalid' }
  }
  if (input.action === 'review_rejected' && !reason) return { ok: false, code: 'maintenance_review_reason_required' }
  if (input.action === 'correct_completion') {
    if (input.status !== 'closed') return { ok: false, code: 'maintenance_transition_invalid' }
    if (!reason) return { ok: false, code: 'maintenance_completion_correction_reason_required' }
  }
  if (input.action === 'reopen' && input.status !== 'closed') return { ok: false, code: 'maintenance_transition_invalid' }
  if (input.action === 'cancel') {
    if (!['pending_assignment', 'assigned', 'in_progress'].includes(input.status)) return { ok: false, code: 'maintenance_transition_invalid' }
    if (!reason) return { ok: false, code: 'maintenance_cancel_reason_required' }
  }
  if (input.action === 'hold') {
    if (input.status !== 'in_progress') return { ok: false, code: 'maintenance_transition_invalid' }
    if (!reason) return { ok: false, code: 'maintenance_hold_reason_required' }
  }
  return { ok: true }
}
