import { Router } from 'express'
import { db } from '../store'
import { hasPg, pgPool } from '../dbAdapter'

export const router = Router()

router.get('/', (req, res) => {
  const { entity, entity_id, limit: limitRaw, cursor, before } = req.query as { entity?: string; entity_id?: string; limit?: string; cursor?: string; before?: string }
  ;(async () => {
    try {
      if (hasPg && pgPool) {
        const limit = Math.max(1, Math.min(500, Number(limitRaw || 200)))
        const params: any[] = []
        const where: string[] = []
        if (entity) { params.push(String(entity)); where.push(`a.entity=$${params.length}`) }
        if (entity_id) { params.push(String(entity_id)); where.push(`a.entity_id=$${params.length}`) }
        const beforeTs = String(before || '').trim() || String(cursor || '').trim()
        if (beforeTs) { params.push(beforeTs); where.push(`a.created_at < $${params.length}::timestamptz`) }
        params.push(limit)
        const sql = `
          SELECT
            a.*,
            u.username AS actor_username,
            u.display_name AS actor_display_name,
            u.email AS actor_email
          FROM audit_logs a
          LEFT JOIN users u ON u.id = a.actor_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY a.created_at DESC
          LIMIT $${params.length}
        `
        const r = await pgPool.query(sql, params)
        const items = (r?.rows || []).map((row: any) => {
          const actor = (row.actor_id || row.actor_username || row.actor_display_name || row.actor_email)
            ? {
                id: row.actor_id ? String(row.actor_id) : null,
                username: row.actor_username ? String(row.actor_username) : null,
                display_name: row.actor_display_name ? String(row.actor_display_name) : null,
                email: row.actor_email ? String(row.actor_email) : null,
              }
            : null
          return { ...row, actor }
        })
        const nextCursor = items.length ? String(items[items.length - 1]?.created_at || '') : ''
        return res.json({ items, next_cursor: nextCursor || null })
      }
    } catch {
    }
    const limit = Math.max(1, Math.min(500, Number(limitRaw || 200)))
    const byId: Record<string, any> = Object.fromEntries((db.users || []).map((u: any) => [String(u.id), u]))
    const list = entity
      ? db.audits.filter(a => a.entity === entity && (!entity_id || a.entity_id === entity_id))
      : db.audits
    const sliced = list.slice(-limit)
    const items = sliced.map((a: any) => {
      const u = a.actor_id ? byId[String(a.actor_id)] : null
      const actor = u ? { id: String(u.id), username: u.username ? String(u.username) : null, display_name: u.display_name ? String(u.display_name) : null, email: u.email ? String(u.email) : null } : null
      const createdAt = a.created_at || a.timestamp || null
      const beforeJson = (a.before_json !== undefined) ? a.before_json : (a.before !== undefined ? a.before : null)
      const afterJson = (a.after_json !== undefined) ? a.after_json : (a.after !== undefined ? a.after : null)
      return { ...a, created_at: createdAt, before_json: beforeJson, after_json: afterJson, actor }
    })
    return res.json({ items, next_cursor: null })
  })()
})
