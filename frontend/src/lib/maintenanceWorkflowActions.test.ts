import { beforeEach, describe, expect, it, vi } from 'vitest'

const postJSON = vi.hoisted(() => vi.fn())

vi.mock('./api', () => ({ postJSON }))

import { assignInternalMaintenance, internalMaintenanceAssignmentChanged, internalMaintenanceAssignPath } from './maintenanceWorkflowActions'

describe('internal maintenance workflow assignment', () => {
  beforeEach(() => postJSON.mockReset())

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
})
