import { describe, expect, it } from 'vitest'
import { cleaningNightsDisplayLabels, cleaningTaskFlowLabelText, isDeferredInspectionDisplayTask, resolveTaskCenterColumns } from './taskCenterDisplay'

describe('taskCenterDisplay', () => {
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
})
