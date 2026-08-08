import { beforeEach, describe, expect, it, vi } from 'vitest'

const postJSON = vi.hoisted(() => vi.fn())
const deleteJSON = vi.hoisted(() => vi.fn())

vi.mock('./api', () => ({ postJSON, deleteJSON }))

import { assignInternalMaintenance, createInternalMaintenanceFeedback, deleteInternalMaintenanceFeedback, internalMaintenanceAssignmentChanged, internalMaintenanceAssignPath, internalMaintenanceFeedbackCreatePath, internalMaintenanceFeedbackDeletePath } from './maintenanceWorkflowActions'

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
