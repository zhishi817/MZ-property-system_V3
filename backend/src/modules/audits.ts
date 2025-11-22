import { Router } from 'express'
import { db } from '../store'

export const router = Router()

router.get('/', (req, res) => {
  const { entity } = req.query as { entity?: string }
  const list = entity ? db.audits.filter(a => a.entity === entity) : db.audits
  res.json(list.slice(-500))
})