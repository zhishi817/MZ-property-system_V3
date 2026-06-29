import { describe, expect, it } from 'vitest'
import { cleaningTaskFlowLabelText, isDeferredInspectionDisplayTask } from './taskCenterDisplay'

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
})
