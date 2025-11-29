import { Router } from 'express'
import { login, me, setDeletePassword } from '../auth'
import { hasSupabase, supaSelect, supaUpdate } from '../supabase'
import { hasPg, pgSelect, pgUpdate } from '../dbAdapter'

export const router = Router()

router.post('/login', login)
router.get('/me', me)
router.post('/delete-password', setDeletePassword)

router.post('/forgot', async (req, res) => {
  const { email } = req.body || {}
  if (!email) return res.status(400).json({ message: 'missing email' })
  try {
    let user: any = null
    if (hasPg) { const rows = await pgSelect('users', '*', { email }); user = rows && (rows as any[])[0] }
    if (!user && hasSupabase) { const rows: any = await supaSelect('users', '*', { email }); user = rows && rows[0] }
    const exists = !!user
    // Normally generate token and send email; here we store a timestamp hint if user exists
    const payload: any = { reset_requested_at: new Date().toISOString() }
    if (exists) {
      if (hasPg) { await pgUpdate('users', user.id, payload as any) }
      else if (hasSupabase) { await supaUpdate('users', user.id, payload) }
    }
    return res.json({ ok: true })
  } catch (e: any) { return res.status(500).json({ message: e.message }) }
})
