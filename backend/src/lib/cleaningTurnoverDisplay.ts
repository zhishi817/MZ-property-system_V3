export type CleaningTurnoverTaskLike = {
  id?: any
  taskId?: any
  property_id?: any
  propertyId?: any
  task_type?: any
  taskType?: any
  order_id?: any
  orderId?: any
  task_date?: any
  taskDate?: any
  checkout_time?: any
  checkoutTime?: any
  summary_checkout_time?: any
  summaryCheckoutTime?: any
  checkin_time?: any
  checkinTime?: any
  summary_checkin_time?: any
  summaryCheckinTime?: any
  guest_special_request?: any
  guestSpecialRequest?: any
  order_note?: any
  orderNote?: any
  old_code?: any
  oldCode?: any
  new_code?: any
  newCode?: any
  keys_required?: any
  keysRequired?: any
  order_keys_required?: any
  orderKeysRequired?: any
  nights?: any
  order_nights?: any
  orderNights?: any
  nights_override?: any
  nightsOverride?: any
  order_checkin?: any
  orderCheckin?: any
  order_checkout?: any
  orderCheckout?: any
}

export type CleaningTurnoverConflict = {
  field: string
  canonical_value: any
  manual_value: any
  manual_task_id: string
  resolution: 'kept_canonical' | 'ignored_placeholder'
}

export type CleaningTurnoverDisplay = {
  property_id: string | null
  task_date: string | null
  checkout_order_id: string | null
  checkin_order_id: string | null
  checkout_time: string | null
  checkin_time: string | null
  is_late_checkout: boolean
  is_early_checkin: boolean
  is_late_checkin: boolean
  guest_request_checkout: string | null
  guest_request_checkin: string | null
  guest_request_summary: string | null
  old_code: string | null
  new_code: string | null
  keys_required_checkout: number | null
  keys_required_checkin: number | null
  stayed_nights: number | null
  remaining_nights: number | null
  active_source_ids: string[]
  superseded_source_ids: string[]
  all_related_source_ids: string[]
  conflicts: CleaningTurnoverConflict[]
}

const DEFAULT_CHECKOUT_TIME = '10am'
const DEFAULT_CHECKIN_TIME = '3pm'

function text(value: any): string {
  return String(value ?? '').trim()
}

function nullableText(value: any): string | null {
  const s = text(value)
  const normalized = s.toLowerCase()
  if (normalized === 'null' || normalized === 'undefined') return null
  return s ? s : null
}

function firstText(...values: any[]): string | null {
  for (const value of values) {
    const s = nullableText(value)
    if (s) return s
  }
  return null
}

function numberOrNull(value: any): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function intOrNull(value: any): number | null {
  const n = numberOrNull(value)
  return n == null ? null : Math.max(0, Math.trunc(n))
}

function clampKeys(value: any): number | null {
  const n = numberOrNull(value)
  if (n == null) return null
  return Math.max(1, Math.min(2, Math.trunc(n)))
}

function taskId(row: CleaningTurnoverTaskLike | null | undefined): string | null {
  return firstText(row?.id, row?.taskId)
}

function taskType(row: CleaningTurnoverTaskLike | null | undefined): string {
  return text(row?.task_type ?? row?.taskType).toLowerCase()
}

function isCheckout(row: CleaningTurnoverTaskLike | null | undefined): boolean {
  return taskType(row) === 'checkout_clean' || taskType(row) === 'checkout'
}

function isCheckin(row: CleaningTurnoverTaskLike | null | undefined): boolean {
  return taskType(row) === 'checkin_clean' || taskType(row) === 'checkin'
}

function ymd(value: any): string | null {
  const s = text(value).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function diffDays(a: any, b: any): number | null {
  const start = ymd(a)
  const end = ymd(b)
  if (!start || !end) return null
  const da = Date.parse(`${start}T00:00:00Z`)
  const db = Date.parse(`${end}T00:00:00Z`)
  if (!Number.isFinite(da) || !Number.isFinite(db)) return null
  const diff = Math.round((db - da) / 86400000)
  return diff >= 0 ? diff : null
}

export function parseCleaningDisplayTimeMinutes(value: any): number | null {
  const raw = text(value).toLowerCase().replace(/\s+/g, '')
  if (!raw) return null
  const hm = /^(\d{1,2})(?::|\.)(\d{1,2})(am|pm)?$/.exec(raw)
  const hap = /^(\d{1,2})(am|pm)$/.exec(raw)
  const cn = /^(\d{1,2})[:：]?(\d{0,2})(上午|早上|中午|下午|晚上)?$/.exec(raw)
  let hour: number | null = null
  let minute = 0
  let suffix = ''
  if (hm) {
    hour = Number(hm[1])
    minute = Number(hm[2])
    suffix = hm[3] || ''
  } else if (hap) {
    hour = Number(hap[1])
    suffix = hap[2]
  } else if (cn) {
    hour = Number(cn[1])
    minute = cn[2] ? Number(cn[2]) : 0
    const period = cn[3] || ''
    if (period === '下午' || period === '晚上') suffix = 'pm'
    if (period === '上午' || period === '早上') suffix = 'am'
  }
  if (hour == null || !Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (hour < 0 || hour > 24 || minute < 0 || minute >= 60) return null
  if (suffix === 'pm' && hour < 12) hour += 12
  if (suffix === 'am' && hour === 12) hour = 0
  if (hour === 24 && minute !== 0) return null
  return hour * 60 + minute
}

function taskNights(row: CleaningTurnoverTaskLike | null | undefined): number | null {
  const direct = intOrNull(row?.nightsOverride ?? row?.nights_override ?? row?.orderNights ?? row?.order_nights ?? row?.nights)
  if (direct != null) return direct
  return diffDays(row?.orderCheckin ?? row?.order_checkin, row?.orderCheckout ?? row?.order_checkout)
}

function orderId(row: CleaningTurnoverTaskLike | null | undefined): string | null {
  return firstText(row?.orderId, row?.order_id)
}

function checkoutTime(row: CleaningTurnoverTaskLike | null | undefined): string | null {
  return firstText(row?.checkoutTime, row?.checkout_time, row?.summaryCheckoutTime, row?.summary_checkout_time)
}

function checkinTime(row: CleaningTurnoverTaskLike | null | undefined): string | null {
  return firstText(row?.checkinTime, row?.checkin_time, row?.summaryCheckinTime, row?.summary_checkin_time)
}

function keysRequired(row: CleaningTurnoverTaskLike | null | undefined): number | null {
  return clampKeys(row?.orderKeysRequired ?? row?.order_keys_required ?? row?.keysRequired ?? row?.keys_required)
}

function guestRequest(row: CleaningTurnoverTaskLike | null | undefined): string | null {
  return firstText(row?.orderNote, row?.order_note, row?.guestSpecialRequest, row?.guest_special_request)
}

function fieldValue(row: CleaningTurnoverTaskLike, field: string): any {
  if (field === 'checkout_time') return checkoutTime(row)
  if (field === 'checkin_time') return checkinTime(row)
  if (field === 'keys_required') return keysRequired(row)
  if (field === 'nights') return taskNights(row)
  if (field === 'guest_special_request') return firstText(row.guestSpecialRequest, row.guest_special_request)
  if (field === 'old_code') return firstText(row.oldCode, row.old_code)
  if (field === 'new_code') return firstText(row.newCode, row.new_code)
  return null
}

function sameDisplayValue(a: any, b: any): boolean {
  if (a == null && b == null) return true
  if (typeof a === 'number' || typeof b === 'number') {
    const an = numberOrNull(a)
    const bn = numberOrNull(b)
    return an == null && bn == null ? true : an === bn
  }
  return text(a) === text(b)
}

function unique(values: any[]): string[] {
  return Array.from(new Set(values.map((value) => text(value)).filter(Boolean)))
}

export function buildCleaningTurnoverDisplay(params: {
  propertyId?: any
  taskDate?: any
  checkoutTask?: CleaningTurnoverTaskLike | null
  checkinTask?: CleaningTurnoverTaskLike | null
  activeRows?: CleaningTurnoverTaskLike[]
  supersededRows?: CleaningTurnoverTaskLike[]
}): CleaningTurnoverDisplay {
  const activeRows = (params.activeRows || []).filter(Boolean)
  const supersededRows = (params.supersededRows || []).filter(Boolean)
  const checkout = params.checkoutTask || activeRows.find(isCheckout) || null
  const checkin = params.checkinTask || activeRows.find(isCheckin) || null
  const checkoutT = checkout ? (checkoutTime(checkout) || DEFAULT_CHECKOUT_TIME) : null
  const checkinT = checkin ? (checkinTime(checkin) || DEFAULT_CHECKIN_TIME) : null
  const checkoutMinutes = parseCleaningDisplayTimeMinutes(checkoutT)
  const checkinMinutes = parseCleaningDisplayTimeMinutes(checkinT)
  const defaultCheckoutMinutes = parseCleaningDisplayTimeMinutes(DEFAULT_CHECKOUT_TIME) || 10 * 60
  const defaultCheckinMinutes = parseCleaningDisplayTimeMinutes(DEFAULT_CHECKIN_TIME) || 15 * 60
  const checkoutRequest = guestRequest(checkout)
  const checkinRequest = guestRequest(checkin)
  const conflicts: CleaningTurnoverConflict[] = []
	  const pushConflict = (manual: CleaningTurnoverTaskLike, field: string, canonical: any, manualValue: any) => {
	    const id = taskId(manual)
	    if (!id) return
	    if (manualValue == null || manualValue === '') return
	    if (sameDisplayValue(canonical, manualValue)) return
	    if (field === 'nights' && numberOrNull(manualValue) === 0) {
	      const canonicalNights = numberOrNull(canonical)
	      if (canonicalNights != null && canonicalNights > 0) return
	    }
	    conflicts.push({
      field,
      canonical_value: canonical,
      manual_value: manualValue,
      manual_task_id: id,
      resolution: 'kept_canonical',
    })
  }
  for (const manual of supersededRows) {
    const canonical = isCheckout(manual) ? checkout : isCheckin(manual) ? checkin : null
    if (!canonical) continue
    pushConflict(manual, isCheckout(manual) ? 'checkout_time' : 'checkin_time', isCheckout(manual) ? checkoutT : checkinT, fieldValue(manual, isCheckout(manual) ? 'checkout_time' : 'checkin_time'))
    pushConflict(manual, 'keys_required', keysRequired(canonical), fieldValue(manual, 'keys_required'))
    pushConflict(manual, 'nights', taskNights(canonical), fieldValue(manual, 'nights'))
    pushConflict(manual, 'guest_special_request', guestRequest(canonical), fieldValue(manual, 'guest_special_request'))
    pushConflict(manual, isCheckout(manual) ? 'old_code' : 'new_code', isCheckout(manual) ? firstText(checkout?.oldCode, checkout?.old_code) : firstText(checkin?.newCode, checkin?.new_code), fieldValue(manual, isCheckout(manual) ? 'old_code' : 'new_code'))
  }
  const activeSourceIds = unique(activeRows.map(taskId))
  const supersededSourceIds = unique(supersededRows.map(taskId))
  return {
    property_id: firstText(params.propertyId, checkout?.['property_id' as keyof CleaningTurnoverTaskLike], checkin?.['property_id' as keyof CleaningTurnoverTaskLike]) || null,
    task_date: ymd(params.taskDate) || ymd(checkout?.taskDate ?? checkout?.task_date) || ymd(checkin?.taskDate ?? checkin?.task_date),
    checkout_order_id: orderId(checkout),
    checkin_order_id: orderId(checkin),
    checkout_time: checkoutT,
    checkin_time: checkinT,
    is_late_checkout: checkoutMinutes != null ? checkoutMinutes > defaultCheckoutMinutes : false,
    is_early_checkin: checkinMinutes != null ? checkinMinutes < defaultCheckinMinutes : false,
    is_late_checkin: checkinMinutes != null ? checkinMinutes > defaultCheckinMinutes : false,
    guest_request_checkout: checkoutRequest,
    guest_request_checkin: checkinRequest,
    guest_request_summary: unique([checkoutRequest, checkinRequest]).join('；') || null,
    old_code: firstText(checkout?.oldCode, checkout?.old_code),
    new_code: firstText(checkin?.newCode, checkin?.new_code),
    keys_required_checkout: keysRequired(checkout),
    keys_required_checkin: keysRequired(checkin),
    stayed_nights: taskNights(checkout),
    remaining_nights: taskNights(checkin),
    active_source_ids: activeSourceIds,
    superseded_source_ids: supersededSourceIds,
    all_related_source_ids: unique([...activeSourceIds, ...supersededSourceIds]),
    conflicts,
  }
}

export function mergeCleaningTurnoverDisplays(displays: Array<CleaningTurnoverDisplay | null | undefined>): CleaningTurnoverDisplay | null {
  const list = displays.filter(Boolean) as CleaningTurnoverDisplay[]
  if (!list.length) return null
  const checkoutDisplay = list.find((item) => item.checkout_order_id || item.checkout_time) || list[0]
  const checkinDisplay = list.find((item) => item.checkin_order_id || item.checkin_time) || list[0]
  const activeSourceIds = unique(list.flatMap((item) => item.active_source_ids || []))
  const supersededSourceIds = unique(list.flatMap((item) => item.superseded_source_ids || []))
  const checkoutRequest = checkoutDisplay.guest_request_checkout || null
  const checkinRequest = checkinDisplay.guest_request_checkin || null
  return {
    property_id: checkoutDisplay.property_id || checkinDisplay.property_id || list[0].property_id,
    task_date: checkoutDisplay.task_date || checkinDisplay.task_date || list[0].task_date,
    checkout_order_id: checkoutDisplay.checkout_order_id || null,
    checkin_order_id: checkinDisplay.checkin_order_id || null,
    checkout_time: checkoutDisplay.checkout_time || null,
    checkin_time: checkinDisplay.checkin_time || null,
    is_late_checkout: checkoutDisplay.is_late_checkout,
    is_early_checkin: checkinDisplay.is_early_checkin,
    is_late_checkin: checkinDisplay.is_late_checkin,
    guest_request_checkout: checkoutRequest,
    guest_request_checkin: checkinRequest,
    guest_request_summary: unique([checkoutRequest, checkinRequest, ...list.map((item) => item.guest_request_summary)]).join('；') || null,
    old_code: checkoutDisplay.old_code || null,
    new_code: checkinDisplay.new_code || null,
    keys_required_checkout: checkoutDisplay.keys_required_checkout,
    keys_required_checkin: checkinDisplay.keys_required_checkin,
    stayed_nights: checkoutDisplay.stayed_nights,
    remaining_nights: checkinDisplay.remaining_nights,
    active_source_ids: activeSourceIds,
    superseded_source_ids: supersededSourceIds,
    all_related_source_ids: unique([...activeSourceIds, ...supersededSourceIds]),
    conflicts: list.flatMap((item) => item.conflicts || []),
  }
}
