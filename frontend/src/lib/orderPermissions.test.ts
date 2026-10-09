import { describe, expect, it } from 'vitest'
import { orderCancellationPermissionState } from './orderPermissions'

describe('orderCancellationPermissionState', () => {
  it('disables a new cancellation and explains the missing permission', () => {
    const state = orderCancellationPermissionState({
      currentStatus: 'confirmed',
      hasCancelPermission: false,
      hasCancelOverridePermission: false,
    })
    expect(state.canSelectCancelled).toBe(false)
    expect(state.disabledReason).toContain('订单：取消')
  })

  it('allows ordinary cancellation while explaining the locked-period boundary', () => {
    const state = orderCancellationPermissionState({
      currentStatus: 'confirmed',
      hasCancelPermission: true,
      hasCancelOverridePermission: false,
    })
    expect(state.canSelectCancelled).toBe(true)
    expect(state.guidance).toContain('结算期已锁定')
  })

  it('allows cancellation without a warning when both permissions are effective', () => {
    expect(orderCancellationPermissionState({
      currentStatus: 'confirmed',
      hasCancelPermission: true,
      hasCancelOverridePermission: true,
    })).toEqual({ canSelectCancelled: true, disabledReason: null, guidance: null })
  })

  it('keeps an already-cancelled order editable without granting a new transition', () => {
    expect(orderCancellationPermissionState({
      currentStatus: 'cancelled',
      hasCancelPermission: false,
      hasCancelOverridePermission: false,
    })).toEqual({ canSelectCancelled: true, disabledReason: null, guidance: null })
  })
})
