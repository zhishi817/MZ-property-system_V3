export type TurnoverEditPlanIssue = {
  code: 'cross_day_relation' | 'existing_date_unsaved'
  message: string
}

export function validateTurnoverEditPlan(params: {
  pendingAddCheckout?: boolean
  pendingAddCheckin?: boolean
  linkingExisting?: boolean
  checkoutDate: string
  checkinDate: string
  initialCheckoutDate: string
  initialCheckinDate: string
}): TurnoverEditPlanIssue | null {
  if ((params.pendingAddCheckout || params.pendingAddCheckin || params.linkingExisting)
    && params.checkoutDate !== params.checkinDate) {
    return {
      code: 'cross_day_relation',
      message: '跨日退房与入住不能建立同日周转关联；请使用独立新增或延期检查流程。',
    }
  }
  if (params.pendingAddCheckout && params.checkinDate !== params.initialCheckinDate) {
    return {
      code: 'existing_date_unsaved',
      message: '入住日期尚未保存；请先保存日期修改，再重新打开并新增退房。',
    }
  }
  if (params.pendingAddCheckin && params.checkoutDate !== params.initialCheckoutDate) {
    return {
      code: 'existing_date_unsaved',
      message: '退房日期尚未保存；请先保存日期修改，再重新打开并新增入住。',
    }
  }
  if (params.linkingExisting
    && (params.checkoutDate !== params.initialCheckoutDate || params.checkinDate !== params.initialCheckinDate)) {
    return {
      code: 'existing_date_unsaved',
      message: '任务日期尚未保存；请先保存修改，再关联同日周转。',
    }
  }
  return null
}

export function turnoverEditPersistedSignature(value: {
  checkoutDate: string
  checkinDate: string
  status: string
  cleanerId: string | null
  newCheckoutCleanerId?: string | null
  inspectorId: string | null
  inspectionScope: string
  keysRequiredCheckin: number
  keysRequiredCheckout: number
  guestSpecialRequest: string
  nightsOverride: number | null
  checkoutPassword: string
  checkinPassword: string
  checkoutTime: string
  checkinTime: string
}) {
  return JSON.stringify({ ...value, newCheckoutCleanerId: value.newCheckoutCleanerId ?? null })
}

export function validateTurnoverEditMutationIsolation(params: {
  pendingAddCheckout?: boolean
  pendingAddCheckin?: boolean
  initialSignature: string
  currentSignature: string
}): TurnoverEditPlanIssue | null {
  if (!params.pendingAddCheckout && !params.pendingAddCheckin) return null
  let initial: Record<string, unknown>
  let current: Record<string, unknown>
  try {
    initial = JSON.parse(params.initialSignature)
    current = JSON.parse(params.currentSignature)
  } catch {
    return {
      code: 'existing_date_unsaved',
      message: '无法确认现有任务是否有未保存修改；请关闭后重新打开再新增关联任务。',
    }
  }
  const allowedNewSideFields = new Set(params.pendingAddCheckout
    ? ['newCheckoutCleanerId', 'keysRequiredCheckout', 'checkoutPassword', 'checkoutTime']
    : ['inspectionScope', 'keysRequiredCheckin', 'checkinPassword', 'checkinTime', 'nightsOverride'])
  const changedExistingFields = Array.from(new Set([...Object.keys(initial), ...Object.keys(current)]))
    .filter((key) => !allowedNewSideFields.has(key) && initial[key] !== current[key])
  if (!changedExistingFields.length) return null
  return {
    code: 'existing_date_unsaved',
    message: '现有任务还有未保存修改；请先保存并重新打开，再新增关联任务。',
  }
}
