export type SchedulePart = {
  task_id: string | null
  status: string
  assignee_id: string | null
  assignee_name: string | null
  time: string | null
  code: string | null
  note: string | null
}

export type ScheduleMission = {
  key: string
  date: string
  order_id: string | null
  property_id: string | null
  property_code: string | null
  nights: number | null
  checkout: SchedulePart | null
  checkin: SchedulePart | null
}

export function missionTitle(m: ScheduleMission) {
  const code = m.property_code || m.property_id || ''
  const co = m.checkout
  const ci = m.checkin
  const coTxt = co ? `${co.time ? `${co.time}` : ''}退房` : ''
  const ciTxt = ci ? `${ci.time ? `${ci.time}` : ''}入住` : ''
  const mid = (co && ci) ? `${coTxt} ${ciTxt}` : (co ? coTxt : ciTxt)
  return `${code} ${mid}`.trim()
}

export function statusLabel(s: string) {
  const v = String(s || '')
  if (v === 'pending') return '待分配'
  if (v === 'scheduled' || v === 'in_progress') return '进行中'
  if (v === 'done' || v === 'ready' || v === 'cleaned' || v === 'restocked' || v === 'inspected') return '已完成'
  if (v === 'canceled') return '已取消'
  return v || '-'
}
