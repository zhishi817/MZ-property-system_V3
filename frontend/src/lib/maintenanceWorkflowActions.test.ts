import { beforeEach, describe, expect, it, vi } from 'vitest'

const postJSON = vi.hoisted(() => vi.fn())
const deleteJSON = vi.hoisted(() => vi.fn())

vi.mock('./api', () => ({ postJSON, deleteJSON }))

import { approveInternalMaintenance, assignInternalMaintenance, correctInternalMaintenanceCompletion, createInternalMaintenanceFeedback, deleteInternalMaintenanceFeedback, internalMaintenanceAssignmentChanged, internalMaintenanceAssignPath, internalMaintenanceFeedbackCreatePath, internalMaintenanceFeedbackDeletePath, internalMaintenanceHasNewCompletionPhoto, internalMaintenanceReviewPath, internalMaintenanceWorkflowPath, manageInternalMaintenanceWorkflow, shouldAutoApproveInternalMaintenanceSettlement, shouldUpdateInternalMaintenanceRecordViaCrud } from './maintenanceWorkflowActions'

describe('internal maintenance workflow assignment', () => {
  beforeEach(() => {
    postJSON.mockReset()
    deleteJSON.mockReset()
  })

  it('uses the dedicated workflow action instead of the generic CRUD update', async () => {
    postJSON.mockResolvedValue({ ok: true, id: 'record-1', status: 'assigned' })

    await assignInternalMaintenance({
      recordId: 'record-1',
      assigneeId: 'user-1',
      scheduledDate: '2026-08-05',
      recordPatch: { details: '[{"content":"漏水"}]' },
      operationId: 'operation-1',
    })

    expect(internalMaintenanceAssignPath('record-1')).toBe('/maintenance/workflow/internal/record-1/assign')
    expect(postJSON).toHaveBeenCalledWith('/maintenance/workflow/internal/record-1/assign', {
      assignee_id: 'user-1',
      scheduled_date: '2026-08-05',
      record_patch: { details: '[{"content":"漏水"}]' },
      operation_id: 'operation-1',
    }, { timeoutMs: 10_000 })
  })

  it('requires the workflow action only when the selected person or date changes', () => {
    expect(internalMaintenanceAssignmentChanged({
      currentAssigneeId: 'user-1',
      currentScheduledDate: '2026-08-05T00:00:00.000Z',
      nextAssigneeId: 'user-1',
      nextScheduledDate: '2026-08-05',
    })).toBe(false)
    expect(internalMaintenanceAssignmentChanged({
      currentAssigneeId: 'user-1',
      currentScheduledDate: '2026-08-05',
      nextAssigneeId: 'user-2',
      nextScheduledDate: '2026-08-05',
    })).toBe(true)
  })

  it('does not send a second generic CRUD update after the assignment workflow saves the record patch', () => {
    expect(shouldUpdateInternalMaintenanceRecordViaCrud({
      assignmentChanged: true,
      recordActualRepairerWithCompletion: false,
    })).toBe(false)
    expect(shouldUpdateInternalMaintenanceRecordViaCrud({
      assignmentChanged: false,
      recordActualRepairerWithCompletion: false,
    })).toBe(true)
    expect(shouldUpdateInternalMaintenanceRecordViaCrud({
      assignmentChanged: true,
      recordActualRepairerWithCompletion: true,
    })).toBe(true)
  })

  it('does not treat unchanged rejected-review photos as a new completion submission', () => {
    expect(internalMaintenanceHasNewCompletionPhoto(
      ['maintenance/after-1.jpg', 'maintenance/after-2.jpg'],
      ['maintenance/after-2.jpg', 'maintenance/after-1.jpg'],
    )).toBe(false)
    expect(internalMaintenanceHasNewCompletionPhoto(
      ['maintenance/after-1.jpg', 'maintenance/after-2.jpg'],
      ['maintenance/after-1.jpg'],
    )).toBe(false)
    expect(internalMaintenanceHasNewCompletionPhoto(
      ['maintenance/after-1.jpg'],
      ['maintenance/after-1.jpg', 'maintenance/rework-after.jpg'],
    )).toBe(true)
  })

  it('approves a pending-review maintenance record through the audited workflow route', async () => {
    postJSON.mockResolvedValue({ ok: true, id: 'record-1', status: 'closed' })

    await approveInternalMaintenance({ recordId: 'record/1', operationId: 'review-operation-1' })

    expect(internalMaintenanceReviewPath('record/1')).toBe('/maintenance/workflow/internal/record%2F1/review')
    expect(postJSON).toHaveBeenCalledWith('/maintenance/workflow/internal/record%2F1/review', {
      decision: 'approved',
      operation_id: 'review-operation-1',
    }, { timeoutMs: 10_000 })
  })

  it('records a missing actual repairer atomically with pending-review approval', async () => {
    postJSON.mockResolvedValue({ ok: true, id: 'record-1', status: 'closed' })

    await approveInternalMaintenance({ recordId: 'record/1', assigneeId: 'repairer-1', operationId: 'review-operation-2' })

    expect(postJSON).toHaveBeenCalledWith('/maintenance/workflow/internal/record%2F1/review', {
      decision: 'approved',
      assignee_id: 'repairer-1',
      operation_id: 'review-operation-2',
    }, { timeoutMs: 10_000 })
  })

  it('records the actual completion date atomically with pending-review approval', async () => {
    postJSON.mockResolvedValue({ ok: true, id: 'record-1', status: 'closed' })

    await approveInternalMaintenance({
      recordId: 'record/1',
      assigneeId: 'repairer-1',
      completedAt: '2026-08-13',
      operationId: 'review-operation-3',
    })

    expect(postJSON).toHaveBeenCalledWith('/maintenance/workflow/internal/record%2F1/review', {
      decision: 'approved',
      assignee_id: 'repairer-1',
      completed_at: '2026-08-13',
      operation_id: 'review-operation-3',
    }, { timeoutMs: 10_000 })
  })

  it('returns rejected review to the server workflow without requiring an assignee', async () => {
    postJSON.mockResolvedValue({ ok: true, id: 'record-1', status: 'pending_assignment' })

    await manageInternalMaintenanceWorkflow({
      recordId: 'record/1',
      action: 'review',
      decision: 'rejected',
      reason: '需要重新安排维修',
      operationId: 'reject-operation-1',
    })

    expect(postJSON).toHaveBeenCalledWith('/maintenance/workflow/internal/record%2F1/review', {
      decision: 'rejected',
      reason: '需要重新安排维修',
      operation_id: 'reject-operation-1',
    }, { timeoutMs: 10_000 })
  })

  it('corrects closed completion information through the audited workflow route', async () => {
    postJSON.mockResolvedValue({ ok: true, id: 'record-1', status: 'closed' })

    await correctInternalMaintenanceCompletion({
      recordId: 'record/1',
      completedAt: '2026-08-26',
      assigneeId: 'repairer-2',
      completionPhotoUrls: ['maintenance/after-repaired.jpg'],
      completionNote: null,
      reason: '原完成日期录入错误',
      operationId: 'correct-operation-1',
    })

    expect(postJSON).toHaveBeenCalledWith('/maintenance/workflow/internal/record%2F1/correct_completion', {
      completed_at: '2026-08-26',
      assignee_id: 'repairer-2',
      completion_photo_urls: ['maintenance/after-repaired.jpg'],
      completion_note: null,
      reason: '原完成日期录入错误',
      operation_id: 'correct-operation-1',
    }, { timeoutMs: 10_000 })
  })

  it('only auto-approves a settlement for a permission holder in a pending-review status', () => {
    expect(shouldAutoApproveInternalMaintenanceSettlement({ status: 'review_pending', payMethod: 'rent_deduction', canManageWorkflow: true })).toBe(true)
    expect(shouldAutoApproveInternalMaintenanceSettlement({ status: 'pending_review', payMethod: 'company_pay', canManageWorkflow: true })).toBe(true)
    expect(shouldAutoApproveInternalMaintenanceSettlement({ status: 'in_progress', payMethod: 'rent_deduction', canManageWorkflow: true })).toBe(false)
    expect(shouldAutoApproveInternalMaintenanceSettlement({ status: 'pending_review', payMethod: '', canManageWorkflow: true })).toBe(false)
    expect(shouldAutoApproveInternalMaintenanceSettlement({ status: 'pending_review', payMethod: 'rent_deduction', canManageWorkflow: false })).toBe(false)
  })

  it('uses the auditable workflow route for manager completion', async () => {
    postJSON.mockResolvedValue({ ok: true, id: 'record-1', status: 'pending_review' })

    await manageInternalMaintenanceWorkflow({
      recordId: 'record/1',
      action: 'manager_complete',
      assigneeId: 'repairer-1',
      completionPhotoUrls: ['maintenance/after.jpg'],
      completionNote: '已更换马桶盖',
      completedAt: '2026-09-03',
      operationId: 'complete-operation-1',
    })

    expect(internalMaintenanceWorkflowPath('record/1', 'manager_complete')).toBe('/maintenance/workflow/internal/record%2F1/manager_complete')
    expect(postJSON).toHaveBeenCalledWith('/maintenance/workflow/internal/record%2F1/manager_complete', {
      assignee_id: 'repairer-1',
      completion_photo_urls: ['maintenance/after.jpg'],
      completion_note: '已更换马桶盖',
      completed_at: '2026-09-03',
      operation_id: 'complete-operation-1',
    }, { timeoutMs: 10_000 })
  })

  it('creates a web repair through the feedback workflow without an assignee', async () => {
    postJSON.mockResolvedValue({ ok: true, id: 'record-2' })

    await createInternalMaintenanceFeedback({
      propertyId: 'property-1',
      area: '客厅',
      detail: '沙发腿松动',
      mediaUrls: ['maintenance/before.jpg'],
      invoiceDescriptionEn: 'Sofa repair',
      submitId: 'create-operation-1',
    })

    expect(internalMaintenanceFeedbackCreatePath()).toBe('/mzapp/property-feedbacks')
    expect(postJSON).toHaveBeenCalledWith('/mzapp/property-feedbacks', {
      kind: 'maintenance',
      property_id: 'property-1',
      area: '客厅',
      detail: '沙发腿松动',
      media_urls: ['maintenance/before.jpg'],
      invoice_description_en: 'Sofa repair',
      submit_id: 'create-operation-1',
      step_key: 'web_maintenance_feedback_create',
    }, { timeoutMs: 30_000 })
  })

  it('deletes a web repair through the audited feedback soft-delete endpoint', async () => {
    deleteJSON.mockResolvedValue({ ok: true, deleted: true })

    await deleteInternalMaintenanceFeedback('record/1')

    expect(internalMaintenanceFeedbackDeletePath('record/1')).toBe('/mzapp/property-feedbacks/maintenance/record%2F1')
    expect(deleteJSON).toHaveBeenCalledWith('/mzapp/property-feedbacks/maintenance/record%2F1', { timeoutMs: 30_000 })
  })
})
