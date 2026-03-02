export class AsyncSemaphore {
  private readonly max: number
  private readonly queueLimit: number
  private active = 0
  private queue: Array<(release: () => void) => void> = []

  constructor(max: number, queueLimit: number = Number.POSITIVE_INFINITY) {
    const m = Number(max)
    const q = Number(queueLimit)
    this.max = Number.isFinite(m) ? Math.max(1, Math.floor(m)) : 1
    this.queueLimit = Number.isFinite(q) ? Math.max(0, Math.floor(q)) : Number.POSITIVE_INFINITY
  }

  getActiveCount() {
    return this.active
  }

  getPendingCount() {
    return this.queue.length
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1
      let released = false
      return () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        this.drain()
      }
    }
    if (this.queue.length >= this.queueLimit) {
      const err: any = new Error('queue limit reached')
      err.code = 'QUEUE_LIMIT'
      throw err
    }
    return new Promise((resolve) => {
      this.queue.push(resolve)
    })
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private drain() {
    while (this.active < this.max && this.queue.length) {
      const next = this.queue.shift()
      if (!next) break
      this.active += 1
      let released = false
      next(() => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        this.drain()
      })
    }
  }
}
