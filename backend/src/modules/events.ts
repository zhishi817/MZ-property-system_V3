import { Router } from 'express'

type SSEClient = { write: (chunk: any) => void; end: () => void }
const orderClients = new Set<SSEClient>()
const cleaningClients = new Set<SSEClient>()

export const router = Router()

router.get('/orders', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  const client: SSEClient = { write: (chunk: any) => res.write(chunk), end: () => res.end() }
  orderClients.add(client)
  res.write(`event: ping\n`)
  res.write(`data: ${JSON.stringify({ t: Date.now() })}\n\n`)
  req.on('close', () => { orderClients.delete(client) })
})

router.get('/cleaning', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  const client: SSEClient = { write: (chunk: any) => res.write(chunk), end: () => res.end() }
  cleaningClients.add(client)
  res.write(`event: ping\n`)
  res.write(`data: ${JSON.stringify({ t: Date.now() })}\n\n`)
  req.on('close', () => { cleaningClients.delete(client) })
})

export function broadcastOrdersUpdated(payload?: any) {
  const data = JSON.stringify({ type: 'orders-updated', ...(payload || {}) })
  for (const c of orderClients) {
    try { c.write(`event: message\n`) } catch {}
    try { c.write(`data: ${data}\n\n`) } catch {}
  }
}

export function broadcastCleaningEvent(payload?: any) {
  const data = JSON.stringify({ type: 'cleaning', ...(payload || {}) })
  for (const c of cleaningClients) {
    try { c.write(`event: message\n`) } catch {}
    try { c.write(`data: ${data}\n\n`) } catch {}
  }
}

export default router
