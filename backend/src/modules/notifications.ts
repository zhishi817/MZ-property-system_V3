import { Router } from 'express'
import { requireAnyPerm, requirePerm } from '../auth'
import { hasPg, pgInsert, pgDeleteByUrl, pgSelect } from '../dbAdapter'

export const router = Router()

router.post('/push/subscribe', requireAnyPerm(['cleaning_app.push.subscribe','cleaning_app.sse.subscribe']), async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const { endpoint, keys, ua } = req.body || {}
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) return res.status(400).json({ message: 'invalid subscription' })
  try {
    if (hasPg) {
      const rec = { user_id: String(user.sub || ''), endpoint: String(endpoint), p256dh: String(keys.p256dh), auth: String(keys.auth), ua: String(ua || '') }
      await pgInsert('push_subscriptions', rec as any, true)
      return res.json({ ok: true })
    }
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

router.post('/push/send', requirePerm('guest.notify'), async (req, res) => {
  const { user_id, payload } = req.body || {}
  if (!user_id) return res.status(400).json({ message: 'missing user_id' })
  try {
    if (hasPg) {
      const rows = await pgSelect('push_subscriptions', '*', { user_id }) as any[]
      return res.json({ sent_to: (rows || []).length })
    }
    return res.json({ sent_to: 0 })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

export default router
