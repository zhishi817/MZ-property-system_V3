export type OrderCancellationPermissionState = {
  canSelectCancelled: boolean
  disabledReason: string | null
  guidance: string | null
}

function isCancelledStatus(raw: unknown): boolean {
  const value = String(raw || '').trim().toLowerCase()
  return value === 'cancelled' || value === 'canceled'
}

export function orderCancellationPermissionState(input: {
  currentStatus?: unknown
  hasCancelPermission: boolean
  hasCancelOverridePermission: boolean
}): OrderCancellationPermissionState {
  if (isCancelledStatus(input.currentStatus)) {
    return { canSelectCancelled: true, disabledReason: null, guidance: null }
  }
  if (!input.hasCancelPermission) {
    return {
      canSelectCancelled: false,
      disabledReason: '当前账号缺少“订单：取消”权限，不能将已确认订单改为已取消。',
      guidance: null,
    }
  }
  if (!input.hasCancelOverridePermission) {
    return {
      canSelectCancelled: true,
      disabledReason: null,
      guidance: '可取消未锁定订单；结算期已锁定时还需要“订单：取消（绕过校验）”权限。',
    }
  }
  return { canSelectCancelled: true, disabledReason: null, guidance: null }
}
