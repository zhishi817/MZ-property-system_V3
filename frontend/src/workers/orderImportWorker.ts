export default {} as any
// @ts-ignore
self.onmessage = (e: MessageEvent) => {
  try {
    const text = String((e.data && e.data.text) || '')
    const lines = text.split(/\r?\n/).filter(l => l && l.trim().length)
    const total = Math.max(0, lines.length - 1)
    // @ts-ignore
    self.postMessage({ ok: true, total })
  } catch {
    // @ts-ignore
    self.postMessage({ ok: false, total: 0 })
  }
}
