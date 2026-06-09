export type PropertyLike = {
  id: string
  code?: string
  address?: string
  region?: string | null
  archived?: boolean | null
}

export function cmpPropertyCode(a?: string, b?: string) {
  const A = String(a || '').trim().toUpperCase()
  const B = String(b || '').trim().toUpperCase()
  if (!A && !B) return 0
  if (!A) return 1
  if (!B) return -1
  const isDigitA = /\d/.test(A[0] || '')
  const isDigitB = /\d/.test(B[0] || '')
  if (isDigitA !== isDigitB) return isDigitA ? -1 : 1
  const tok = (s: string) => s.match(/\d+|[A-Z]+|[^A-Z0-9]+/g) || []
  const ta = tok(A)
  const tb = tok(B)
  const n = Math.min(ta.length, tb.length)
  for (let i = 0; i < n; i++) {
    const xa = ta[i]
    const xb = tb[i]
    const da = /^\d+$/.test(xa)
    const db = /^\d+$/.test(xb)
    if (da && db) {
      const va = Number(xa)
      const vb = Number(xb)
      if (va !== vb) return va - vb
    } else {
      const c = xa.localeCompare(xb)
      if (c !== 0) return c
    }
  }
  if (ta.length !== tb.length) return ta.length - tb.length
  return A.localeCompare(B)
}

export function sortProperties<T extends PropertyLike>(arr: T[]): T[] {
  return sortPropertiesByRegionThenCode(arr)
}

export const PROPERTY_REGION_ORDER = ['Melbourne','Southbank','South Melbourne','West Melbourne','St Kilda','Docklands'] as const

function propertyRegionSortKey(r?: string | null) {
  const s = String(r || '').trim()
  if (!s || s === '其他' || s === '未分区') return { bucket: 2, rank: 0, name: '' }
  const idx = (PROPERTY_REGION_ORDER as readonly string[]).indexOf(s)
  if (idx >= 0) return { bucket: 0, rank: idx, name: s }
  return { bucket: 1, rank: 0, name: s }
}

export function cmpPropertyRegion(a?: string | null, b?: string | null) {
  const A = propertyRegionSortKey(a)
  const B = propertyRegionSortKey(b)
  if (A.bucket !== B.bucket) return A.bucket - B.bucket
  if (A.rank !== B.rank) return A.rank - B.rank
  return A.name.localeCompare(B.name)
}

export function sortPropertiesByRegionThenCode<T extends PropertyLike>(arr: T[]): T[] {
  return (Array.isArray(arr) ? arr : []).slice().sort((a, b) => {
    const byRegion = cmpPropertyRegion((a as any).region, (b as any).region)
    if (byRegion !== 0) return byRegion
    return cmpPropertyCode(a.code, b.code)
  })
}

export function filterActiveProperties<T extends PropertyLike>(arr: T[]): T[] {
  return (Array.isArray(arr) ? arr : []).filter((item) => item?.archived !== true)
}

export function sortActivePropertiesByRegionThenCode<T extends PropertyLike>(arr: T[]): T[] {
  return sortPropertiesByRegionThenCode(filterActiveProperties(arr))
}
