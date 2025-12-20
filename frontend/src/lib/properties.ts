export type PropertyLike = { id: string; code?: string; address?: string }

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
  return (Array.isArray(arr) ? arr : []).slice().sort((a, b) => cmpPropertyCode(a.code, b.code))
}

const REGION_ORDER = ['Melbourne','Southbank','South Melbourne','West Melbourne','St Kilda','Docklands']
function regionRank(r?: string) {
  const s = String(r || '')
  const idx = REGION_ORDER.indexOf(s)
  return idx >= 0 ? idx : REGION_ORDER.length + 1
}

export function sortPropertiesByRegionThenCode<T extends PropertyLike & { region?: string }>(arr: T[]): T[] {
  return (Array.isArray(arr) ? arr : []).slice().sort((a, b) => {
    const ra = regionRank((a as any).region)
    const rb = regionRank((b as any).region)
    if (ra !== rb) return ra - rb
    return cmpPropertyCode(a.code, b.code)
  })
}