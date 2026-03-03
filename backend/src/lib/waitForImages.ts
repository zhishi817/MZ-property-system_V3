export type WaitForImagesOptions = {
  timeoutMs?: number
  scroll?: boolean
  tryFallbackAttr?: string
  maxFailedUrls?: number
}

export async function waitForImages(page: any, options?: WaitForImagesOptions): Promise<{ total: number; notLoaded: number; failedUrls: string[] }> {
  const timeoutMs = Math.max(1000, Math.min(180000, Number(options?.timeoutMs || 20000)))
  const scroll = options?.scroll !== false
  const fallbackAttr = String(options?.tryFallbackAttr || '').trim()
  const maxFailedUrls = Math.max(0, Math.min(50, Number(options?.maxFailedUrls || 12)))
  const r = await page.evaluate(async ({ timeoutMs, scroll, fallbackAttr, maxFailedUrls }: any) => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const imgs = Array.from(document.images || []) as HTMLImageElement[]
    for (const img of imgs) {
      try { (img as any).loading = 'eager' } catch {}
      try { (img as any).decoding = 'sync' } catch {}
    }

    const scrollThrough = async () => {
      try { window.scrollTo(0, 0) } catch {}
      await sleep(20)
      const doc = document.documentElement
      const h = Math.max(doc?.scrollHeight || 0, document.body?.scrollHeight || 0, 0)
      const step = Math.max(200, Math.floor((window.innerHeight || 900) * 0.85))
      for (let y = 0; y <= h; y += step) {
        try { window.scrollTo(0, y) } catch {}
        await sleep(20)
      }
      try { window.scrollTo(0, 0) } catch {}
      await sleep(20)
    }

    const isOk = (img: HTMLImageElement) => {
      const complete = !!(img as any).complete
      const w = Number((img as any).naturalWidth || 0)
      return complete && w > 0
    }

    const tryFallbackOnce = async (img: HTMLImageElement, deadline: number) => {
      if (!fallbackAttr) return
      const fb = String(img.getAttribute(fallbackAttr) || '').trim()
      if (!fb) return
      const cur = String((img as any).currentSrc || (img as any).src || '').trim()
      if (!cur || cur === fb) return
      const complete = !!(img as any).complete
      const w = Number((img as any).naturalWidth || 0)
      if (!(complete && w === 0)) return
      let done = false
      const onDone = () => { done = true }
      try { img.addEventListener('load', onDone, { once: true } as any) } catch {}
      try { img.addEventListener('error', onDone, { once: true } as any) } catch {}
      try { (img as any).src = fb } catch {}
      while (!done && Date.now() < deadline) await sleep(30)
    }

    const deadline = Date.now() + timeoutMs
    if (scroll) await scrollThrough()
    while (Date.now() < deadline) {
      let pending = 0
      for (const img of imgs) {
        if (isOk(img)) continue
        pending += 1
        await tryFallbackOnce(img, deadline)
      }
      if (pending === 0) break
      await sleep(80)
      if (scroll) await scrollThrough()
    }

    const failed: string[] = []
    for (const img of imgs) {
      if (isOk(img)) continue
      const u = String((img as any).currentSrc || (img as any).src || '').trim()
      if (u) failed.push(u)
      if (maxFailedUrls && failed.length >= maxFailedUrls) break
    }
    const notLoaded = imgs.filter((img) => !isOk(img)).length
    return { total: imgs.length, notLoaded, failedUrls: failed }
  }, { timeoutMs, scroll, fallbackAttr: fallbackAttr ? fallbackAttr : '', maxFailedUrls })
  return { total: Number(r?.total || 0), notLoaded: Number(r?.notLoaded || 0), failedUrls: Array.isArray(r?.failedUrls) ? r.failedUrls.map((x: any) => String(x || '')).filter(Boolean) : [] }
}
