export function deriveThumbUrl(u: string): string {
  const s = String(u || '').trim()
  if (!s) return ''
  if (/\.thumb\.jpg($|\?)/i.test(s)) return s
  try {
    const uu = new URL(s)
    const p = String(uu.pathname || '')
    if (p.endsWith('/public/r2-image') || p.endsWith('/r2-image')) {
      return uu.toString()
    }
  } catch {}
  const q = s.indexOf('?')
  if (q >= 0) return `${s.slice(0, q)}.thumb.jpg${s.slice(q)}`
  return `${s}.thumb.jpg`
}
