import dayjs from 'dayjs'

export type OrderLike = { id: string; checkin?: string; checkout?: string }

export type Segment = {
  id: string
  startIdx: number
  endIdx: number
}

export function dayIndex(dateStr: string, monthStart: dayjs.Dayjs): number {
  const d = dayjs(dateStr)
  return d.startOf('day').diff(monthStart.startOf('day'), 'day')
}

export function buildSegments(orders: OrderLike[], monthStart: dayjs.Dayjs, monthEnd: dayjs.Dayjs): Segment[] {
  const segs: Segment[] = []
  for (const o of orders) {
    const ci = dayjs(String(o.checkin || '').slice(0, 10)).startOf('day')
    const co = dayjs(String(o.checkout || '').slice(0, 10)).startOf('day')
    if (!ci.isValid() || !co.isValid()) continue
    if (!(co.format('YYYY-MM-DD') > monthStart.format('YYYY-MM-DD') && ci.format('YYYY-MM-DD') < monthEnd.format('YYYY-MM-DD'))) continue
    segs.push({ id: o.id, startIdx: dayIndex(ci.format('YYYY-MM-DD'), monthStart), endIdx: dayIndex(co.format('YYYY-MM-DD'), monthStart) })
  }
  segs.sort((a, b) => a.startIdx - b.startIdx || a.endIdx - b.endIdx)
  return segs
}

export function placeIntoLanes(segs: Segment[]): Record<string, number> {
  const lanesEnd: number[] = []
  const map: Record<string, number> = {}
  for (const seg of segs) {
    let placed = false
    for (let i = 0; i < lanesEnd.length; i++) {
      if (seg.startIdx >= lanesEnd[i]) {
        map[seg.id] = i
        lanesEnd[i] = seg.endIdx
        placed = true
        break
      }
    }
    if (!placed) {
      map[seg.id] = lanesEnd.length
      lanesEnd.push(seg.endIdx)
    }
  }
  return map
}
