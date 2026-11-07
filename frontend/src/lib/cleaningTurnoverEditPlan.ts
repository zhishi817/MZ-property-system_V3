export type TurnoverEditPlanIssue = {
  code: 'cross_day_relation' | 'existing_date_unsaved'
  message: string
}

export function exactCleaningCardEditSourceIds(sourceIds: unknown[]) {
  return Array.from(new Set(sourceIds.map((value) => String(value || '').trim()).filter(Boolean)))
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

export type TurnoverEditOperation = {
  operationId: string
  persistedSignature: string
}

export function resolveTurnoverEditOperation(params: {
  previous?: TurnoverEditOperation | null
  persistedSignature: string
  createOperationId: () => string
}) {
  const previousId = String(params.previous?.operationId || '').trim()
  if (previousId && params.previous?.persistedSignature === params.persistedSignature) {
    return { operationId: previousId, persistedSignature: params.persistedSignature }
  }
  const operationId = String(params.createOperationId() || '').trim()
  if (!operationId) throw new Error('无法创建安全的保存重试标识，请重试')
  return { operationId, persistedSignature: params.persistedSignature }
}

type AtomicCleaningPatch = Record<string, unknown>

export function buildTurnoverAtomicEditItems(params: {
  ids: string[]
  checkoutIds: string[]
  checkinIds: string[]
  basePatch: AtomicCleaningPatch
  checkoutPatch?: AtomicCleaningPatch
  checkinPatch?: AtomicCleaningPatch
  manualKeysByTaskId?: Record<string, 1 | 2>
}) {
  const checkoutIds = new Set(params.checkoutIds.map((id) => String(id || '').trim()).filter(Boolean))
  const checkinIds = new Set(params.checkinIds.map((id) => String(id || '').trim()).filter(Boolean))
  const manualKeysByTaskId = params.manualKeysByTaskId || {}
  return Array.from(new Set(params.ids.map((id) => String(id || '').trim()).filter(Boolean)))
    .sort()
    .map((id) => ({
      id,
      patch: {
        ...params.basePatch,
        ...(checkoutIds.has(id) ? (params.checkoutPatch || {}) : {}),
        ...(checkinIds.has(id) ? (params.checkinPatch || {}) : {}),
        ...(manualKeysByTaskId[id] == null ? {} : { keys_required: manualKeysByTaskId[id] }),
      },
    }))
}

export function normalizeAtomicOrderKeyUpdates(updates: Array<{ order_id: string; keys_required: 1 | 2 }>) {
  const byOrderId = new Map<string, 1 | 2>()
  for (const update of updates) {
    const orderId = String(update.order_id || '').trim()
    if (!orderId) continue
    const existing = byOrderId.get(orderId)
    if (existing != null && existing !== update.keys_required) {
      throw new Error('同一订单不能在一次保存中设置不同的钥匙套数')
    }
    byOrderId.set(orderId, update.keys_required)
  }
  return Array.from(byOrderId.entries())
    .map(([order_id, keys_required]) => ({ order_id, keys_required }))
    .sort((a, b) => a.order_id.localeCompare(b.order_id))
}
