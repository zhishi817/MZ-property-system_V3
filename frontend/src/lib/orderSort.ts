import dayjs from 'dayjs'

export type SortKey = 'email_header_at' | 'checkin' | 'checkout'
export type SortOrder = 'ascend' | 'descend'

function timestamp(value: unknown): number | null {
  if (!value) return null
  const parsed = dayjs(value as any)
  return parsed.isValid() ? parsed.valueOf() : null
}

function compareTimestamp(a: unknown, b: unknown): number {
  const av = timestamp(a)
  const bv = timestamp(b)
  if (av == null && bv == null) return 0
  if (av == null) return -1
  if (bv == null) return 1
  return av - bv
}

export function sortOrders<T extends { [k: string]: any }>(list: T[], key: SortKey, order: SortOrder): T[] {
  const arr = Array.isArray(list) ? [...list] : []
  arr.sort((a,b)=> {
    const primary = compareTimestamp(a?.[key], b?.[key])
    if (primary) return order === 'ascend' ? primary : -primary

    // 取消只改变状态，不能改变首次记录时间或列表位置。相同/缺失的
    // 主排序时间用创建时间和稳定 ID 兜底，避免数据库返回顺序造成跳位。
    const created = compareTimestamp(a?.created_at ?? a?.createdAt, b?.created_at ?? b?.createdAt)
    if (created) return order === 'ascend' ? created : -created

    const id = String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
    return order === 'ascend' ? id : -id
  })
  return arr
}
