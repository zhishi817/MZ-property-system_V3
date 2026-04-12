import { Router } from 'express'
import { streamWorkTaskEvents } from '../services/workTaskEvents'

export const router = Router()

router.get('/stream', async (req, res) => {
  try {
    await streamWorkTaskEvents(req, res)
  } catch (error: any) {
    if (!res.headersSent) {
      return res.status(500).json({ message: String(error?.message || 'work_task_event_stream_failed') })
    }
    try { res.end() } catch {}
  }
})

export default router
