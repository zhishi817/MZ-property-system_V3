export function normalizeUrlList(input: any): string[] {
  let v: any = input
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) v = []
    else if (s[0] === '[') {
      try {
        v = JSON.parse(s)
      } catch {
        v = [s]
      }
    } else {
      v = [s]
    }
  }
  if (!Array.isArray(v)) v = (v === null || v === undefined) ? [] : [v]
  return v
    .filter((x: any) => typeof x === 'string')
    .map((x: string) => x.trim())
    .filter(Boolean)
}
