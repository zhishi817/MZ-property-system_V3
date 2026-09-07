import { Router } from 'express'
import { requireR5TaskRuntimeSchema, R5TaskRuntimeSchemaNotReady } from '../lib/r5RequestSchema'
import { streamWorkTaskEvents } from '../services/workTaskEvents'

export const router = Router()

router.get('/stream', requireR5TaskRuntimeSchema, async (req, res) => {
  try {
    await streamWorkTaskEvents(req, res)
  } catch (error: any) {
    if (!res.headersSent) {
      if (error instanceof R5TaskRuntimeSchemaNotReady) {
        return res.status(503).json({ code: error.code })
      }
      return res.status(500).json({ message: String(error?.message || 'work_task_event_stream_failed') })
    }
    try { res.end() } catch {}
  }
})

export default router
