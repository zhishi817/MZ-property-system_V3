import dayjs from 'dayjs'

export type SortKey = 'email_header_at' | 'checkin' | 'checkout'
export type SortOrder = 'ascend' | 'descend'

export function sortOrders<T extends { [k: string]: any }>(list: T[], key: SortKey, order: SortOrder): T[] {
  const arr = Array.isArray(list) ? [...list] : []
  arr.sort((a,b)=> {
    const av = a?.[key] ? dayjs(a[key]).valueOf() : 0
    const bv = b?.[key] ? dayjs(b[key]).valueOf() : 0
    const r = av - bv
    return order==='ascend' ? r : -r
  })
  return arr
}
