export function debugOnce(tag: string, ...args: any[]) {
  try {
    if (typeof window !== 'undefined') {
      const k = `dbg:${tag}`
      const w = window as any
      if (!w.__dbgKeys) w.__dbgKeys = new Set<string>()
      const set: Set<string> = w.__dbgKeys
      if (set.has(k)) return
      set.add(k)
      // only log in dev
      if (process.env.NODE_ENV === 'development') console.log(tag, ...args)
    } else {
      if (process.env.NODE_ENV === 'development') console.log(tag, ...args)
    }
  } catch {}
}