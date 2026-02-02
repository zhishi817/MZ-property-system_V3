import { Router } from 'express'
import { db } from '../store'
import { hasPg, pgPool } from '../dbAdapter'

export const router = Router()

router.get('/', (req, res) => {
  const { entity, entity_id } = req.query as { entity?: string; entity_id?: string }
  ;(async () => {
    try {
      if (hasPg && pgPool) {
        const rows = entity && entity_id
          ? await pgPool.query('SELECT * FROM audit_logs WHERE entity=$1 AND entity_id=$2 ORDER BY created_at DESC LIMIT 500', [entity, entity_id])
          : entity
            ? await pgPool.query('SELECT * FROM audit_logs WHERE entity=$1 ORDER BY created_at DESC LIMIT 500', [entity])
            : await pgPool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500')
        return res.json(rows?.rows || [])
      }
    } catch {
    }
    const list = entity
      ? db.audits.filter(a => a.entity === entity && (!entity_id || a.entity_id === entity_id))
      : db.audits
    return res.json(list.slice(-500))
  })()
})
