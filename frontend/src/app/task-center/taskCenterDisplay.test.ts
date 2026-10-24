import { describe, expect, it } from 'vitest'
import { cleaningNightsDisplayLabels, cleaningTaskFlowLabelText, deferredInspectionConflictPresentation, deferredInspectionMergePresentation, guestReadyNotificationPresentation, guestReadyOperationId, hasTaskCenterRequiredExecutor, isDeferredInspectionDisplayTask, maintenanceDetailContentText, resolveTaskCenterColumns, taskCenterBoardInspectionDueDate, taskCenterDailyGroupCounts, taskCenterInspectionAssignmentPatch, taskCenterInspectionAssignmentTaskIds } from './taskCenterDisplay'

describe('taskCenterDisplay', () => {
  it('reuses the guest-ready operation id for the same authoritative version', () => {
    expect(guestReadyOperationId({ orderId: 'order-1', action: 'mark', expectedVersion: 4 }))
      .toBe('guest-ready:mark:4:order-1')
    expect(guestReadyOperationId({ orderId: 'order-1', action: 'mark', expectedVersion: 5 }))
      .toBe('guest-ready:mark:5:order-1')
    expect(guestReadyOperationId({ orderId: '', action: 'mark', expectedVersion: 4 })).toBeNull()
  })

  it('treats deferred inspection tasks as inspection-oriented display', () => {
    expect(isDeferredInspectionDisplayTask({
      task_source: 'cleaning',
      task_kind: 'checkout_clean',
      inspection_mode: 'deferred',
      deferred_inspection_view: false,
    })).toBe(true)
    expect(cleaningTaskFlowLabelText({
      task_source: 'cleaning',
      task_kind: 'checkout_clean',
      inspection_mode: 'deferred',
      checkout_task_date: '2026-06-22',
      title: 'Docklands 831402',
      detail: '10am退房',
    })).toBe('延期检查，6月22日退房')
    expect(cleaningTaskFlowLabelText({
      task_source: 'cleaning',
      task_kind: 'deferred_inspection',
      deferred_inspection_view: true,
      checkout_task_dates: ['2026-06-21', '2026-06-22'],
    })).toBe('延期检查，6月21日、6月22日退房')
  })

  it('keeps non-deferred cleaning labels unchanged', () => {
    expect(cleaningTaskFlowLabelText({
      task_source: 'cleaning',
      task_kind: 'checkout_clean',
      inspection_mode: 'same_day',
    })).toBe('退房')
    expect(cleaningTaskFlowLabelText({
      task_source: 'cleaning',
      task_kind: 'checkin_clean',
      inspection_mode: 'same_day',
    })).toBe('入住')
  })

  it('keeps an unchanged deferred inspection date when saving board changes', () => {
    expect(taskCenterBoardInspectionDueDate({
      inspectionMode: 'deferred',
      inspectionDueDate: null,
      previousInspectionMode: 'deferred',
      previousInspectionDueDate: '2026-09-07',
    })).toBe('2026-09-07')
    expect(taskCenterBoardInspectionDueDate({
      inspectionMode: 'deferred',
      inspectionDueDate: null,
      previousInspectionMode: 'pending_decision',
      previousInspectionDueDate: null,
    })).toBeNull()
    expect(taskCenterBoardInspectionDueDate({
      inspectionMode: 'same_day',
      inspectionDueDate: null,
      previousInspectionMode: 'deferred',
      previousInspectionDueDate: '2026-09-07',
    })).toBeNull()
  })

  it('presents deferred inspection check-in conflicts with the danger label and schedule', () => {
    expect(deferredInspectionConflictPresentation({
      task_source: 'cleaning',
      task_kind: 'deferred_inspection',
      deferred_inspection_view: true,
      deferred_checkin_conflict: true,
      inspection_due_date: '2026-08-03',
      conflict_checkin_task_date: '2026-08-02',
      conflict_checkin_time: '15:30',
    })).toEqual({
      key: 'deferred-checkin-conflict',
      label: '入住冲突',
      tone: 'danger',
      detail: '原定检查 2026-08-03；入住 2026-08-02 15:30',
    })
    expect(deferredInspectionConflictPresentation({ deferred_checkin_conflict: false })).toBeNull()
  })

  it('labels only a verified deferred-inspection merge and uses the two source dates', () => {
    expect(deferredInspectionMergePresentation({
      task_source: 'cleaning',
      deferred_inspection_merged: true,
      deferred_inspection_original_checkout_date: '2026-10-23',
      deferred_inspection_effective_date: '2026-10-24',
    })).toEqual({
      key: 'deferred-inspection-merged',
      label: '是延期检查',
      tone: 'info',
      detail: '原退房 2026-10-23 → 本次检查 2026-10-24',
    })
    expect(deferredInspectionMergePresentation({
      task_source: 'cleaning',
      deferred_inspection_merged: false,
      deferred_inspection_original_checkout_date: '2026-10-23',
      deferred_inspection_effective_date: '2026-10-24',
    })).toBeNull()
    expect(deferredInspectionMergePresentation({
      task_source: 'cleaning',
      deferred_inspection_merged: true,
    })?.detail).toBe('')
  })

  it('writes a merged deferred/check-in assignment only to the check-in source task', () => {
    expect(taskCenterInspectionAssignmentTaskIds({
      task_source: 'cleaning',
      task_id: 'display-card',
      task_ids: ['deferred-task', 'checkin-task'],
      active_source_ids: ['deferred-task', 'checkin-task'],
      inspection_action_task_id: 'checkin-task',
    })).toEqual(['checkin-task'])
    expect(taskCenterInspectionAssignmentTaskIds({
      task_source: 'cleaning',
      task_id: 'regular-turnover',
      task_ids: ['checkout-task', 'checkin-task'],
      active_source_ids: ['checkout-task', 'checkin-task'],
    })).toEqual(['checkout-task', 'checkin-task'])
  })

  it('shows stayed and remaining nights on turnover cards', () => {
    expect(cleaningNightsDisplayLabels({
      task_source: 'cleaning',
      task_kind: 'turnover',
      task_ids: ['checkout-task', 'checkin-task'],
      turnover_display: { stayed_nights: 4, remaining_nights: 3 },
      nights: 3,
    })).toEqual(['已住 4晚', '待住 3晚'])
    expect(cleaningNightsDisplayLabels({
      task_source: 'cleaning',
      task_kind: 'turnover',
      task_ids: ['checkout-task', 'checkin-task'],
      turnover_display: { stayed_nights: null, remaining_nights: 3 },
    })).toEqual(['待住 3晚'])
    expect(cleaningNightsDisplayLabels({
      task_source: 'cleaning',
      task_kind: 'checkin_clean',
      nights: 3,
    })).toEqual(['住3晚'])
  })

  it('resolves task-center columns from the usable board width', () => {
    expect(resolveTaskCenterColumns(0)).toBe(4)
    expect(resolveTaskCenterColumns(580)).toBe(1)
    expect(resolveTaskCenterColumns(760)).toBe(2)
    expect(resolveTaskCenterColumns(1100)).toBe(3)
    expect(resolveTaskCenterColumns(1220)).toBe(3)
    expect(resolveTaskCenterColumns(1320)).toBe(4)
    expect(resolveTaskCenterColumns(1800)).toBe(4)
  })

  it('keeps pure check-in inspector-row assignments on the executor field', () => {
    expect(taskCenterInspectionAssignmentPatch({ isPureCheckin: true, inspectorId: 'mia' })).toEqual({
      assignee_id: 'mia',
      cleaner_id: null,
      inspector_id: null,
      inspection_mode: 'same_day',
    })
    expect(taskCenterInspectionAssignmentPatch({ isPureCheckin: true, inspectorId: null })).toEqual({
      assignee_id: null,
      cleaner_id: null,
      inspector_id: null,
      inspection_mode: 'pending_decision',
    })
    expect(taskCenterInspectionAssignmentPatch({ isPureCheckin: false, inspectorId: 'oscar' })).toEqual({
      inspector_id: 'oscar',
      inspection_mode: 'same_day',
    })
    expect(taskCenterInspectionAssignmentPatch({
      isPureCheckin: false,
      inspectorId: 'angela',
      currentInspectionMode: 'deferred',
    })).toEqual({ inspector_id: 'angela', inspection_mode: 'deferred' })
    expect(taskCenterInspectionAssignmentPatch({
      isPureCheckin: false,
      inspectorId: null,
      currentInspectionMode: 'deferred',
    })).toEqual({ inspector_id: null, inspection_mode: 'deferred' })
  })

  it('requires a cleaner even when a regular cleaning task already has an inspector', () => {
    expect(hasTaskCenterRequiredExecutor({
      task_source: 'cleaning',
      task_kind: 'checkout_clean',
      inspector_id: 'zhi-f',
    })).toBe(false)
    expect(hasTaskCenterRequiredExecutor({
      task_source: 'cleaning',
      task_kind: 'checkout_clean',
      cleaner_id: 'mia',
      inspector_id: 'zhi-f',
    })).toBe(true)
    expect(hasTaskCenterRequiredExecutor({
      task_source: 'cleaning',
      task_kind: 'checkin_clean',
      assignee_id: 'zhi-f',
    })).toBe(true)
  })

  it('shows structured maintenance content as readable text instead of raw JSON', () => {
    expect(maintenanceDetailContentText('{"content":"衣柜门脱轨"}')).toBe('衣柜门脱轨')
    expect(maintenanceDetailContentText('{"description":"水龙头漏水"}')).toBe('水龙头漏水')
    expect(maintenanceDetailContentText('衣柜门脱轨')).toBe('衣柜门脱轨')
  })

  it('counts authorized daily groups independently from search and dedupes turnover cards', () => {
    expect(taskCenterDailyGroupCounts([
      { execution_list_visible: true, daily_stats_group: 'turnover', daily_stats_key: 'turnover:2026-10-04:p1' },
      { execution_list_visible: true, daily_stats_group: 'turnover', daily_stats_key: 'turnover:2026-10-04:p1' },
      ...Array.from({ length: 6 }, (_, index) => ({
        execution_list_visible: true,
        daily_stats_group: 'inspection' as const,
        daily_stats_key: `inspection:2026-10-04:p${index + 1}`,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        execution_list_visible: true,
        daily_stats_group: 'offline' as const,
        daily_stats_key: `offline:2026-10-12:assigned-${index + 1}`,
      })),
      ...Array.from({ length: 7 }, (_, index) => ({
        execution_list_visible: false,
        daily_stats_group: 'offline' as const,
        daily_stats_key: `offline:2026-10-12:unassigned-${index + 1}`,
      })),
      { execution_list_visible: false, daily_stats_group: null, daily_stats_key: null },
    ])).toEqual({ turnover: 1, inspection: 6, offline: 10 })
  })

  it('presents guest-ready notification state without implying a message was sent by the app', () => {
    expect(guestReadyNotificationPresentation({ guest_ready_notification: { status: 'not_notified' } }, 'customer_service')).toEqual({
      label: '客人未通知',
      tone: 'pending',
      detail: '',
    })
    expect(guestReadyNotificationPresentation({
      guest_ready_notification: {
        status: 'notified',
        notified_at: '2026-10-04T01:02:03.000Z',
        notified_by_name: '客服 A',
      },
    }, 'customer_service')).toEqual({
      label: '已通知客人',
      tone: 'success',
      detail: '客服 A · 2026-10-04T01:02:03.000Z',
    })
    for (const role of ['admin', 'offline_manager', 'cleaner', 'cleaning_inspector']) {
      expect(guestReadyNotificationPresentation({ guest_ready_notification: { status: 'not_notified' } }, role)).toBeNull()
    }
  })
})
