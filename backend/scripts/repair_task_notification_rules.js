require('dotenv').config({ path: require('path').resolve(process.cwd(), '.env.local') })

const { Pool } = require('pg')
const { randomUUID } = require('crypto')

const TASK_EVENT_TYPES = [
  'CLEANING_TASK_UPDATED',
  'CLEANING_COMPLETED',
  'INSPECTION_COMPLETED',
  'KEY_PHOTO_UPLOADED',
  'ISSUE_REPORTED',
  'WORK_TASK_UPDATED',
  'WORK_TASK_COMPLETED',
  'KEY_UPLOAD_REMINDER',
  'KEY_UPLOAD_SLA_REMINDER',
  'KEY_UPLOAD_SLA_ESCALATION',
  'GUEST_LUGGAGE_UPDATED',
]

const MANAGER_ROLES = ['admin', 'offline_manager', 'customer_service']

const SAFE_FALLBACK_SELECTORS = {
  CLEANING_TASK_UPDATED: ['cleaning_task_users', 'manager_users'],
  CLEANING_COMPLETED: ['cleaning_task_users', 'manager_users'],
  INSPECTION_COMPLETED: ['inspection_task_users', 'manager_users'],
  KEY_PHOTO_UPLOADED: ['cleaning_task_users', 'manager_users'],
  ISSUE_REPORTED: ['manager_users'],
  WORK_TASK_COMPLETED: ['work_task_users', 'manager_users'],
}

function summarize(rows) {
  const byEvent = {}
  for (const row of rows || []) {
    const eventType = String(row?.event_type || '').trim()
    const recipientType = String(row?.recipient_type || '').trim()
    if (!eventType || !recipientType) continue
    const summary = byEvent[eventType] || { user_selectors: 0, non_manager_role_selectors: 0 }
    if (recipientType === 'user') summary.user_selectors += 1
    if (recipientType === 'role') summary.non_manager_role_selectors += 1
    byEvent[eventType] = summary
  }
  return byEvent
}

async function main() {
  const apply = process.argv.includes('--apply')
  if (process.argv.some((arg) => arg === '--help' || arg === '-h')) {
    console.log('Usage: node scripts/repair_task_notification_rules.js [--apply]')
    console.log('Without --apply this script is read-only and only reports unsafe legacy selectors.')
    return
  }

  const connectionString = String(process.env.DATABASE_URL || '').trim()
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } })
  const client = await pool.connect()
  try {
    const unsafeSelectors = await client.query(
      `SELECT event_type, recipient_type
         FROM notification_event_rule_selectors
        WHERE event_type = ANY($1::text[])
          AND (
            recipient_type = 'user'
            OR (
              recipient_type = 'role'
              AND LOWER(TRIM(recipient_value)) <> ALL($2::text[])
            )
          )`,
      [TASK_EVENT_TYPES, MANAGER_ROLES],
    )
    const summary = summarize(unsafeSelectors.rows)
    if (!apply) {
      console.log(JSON.stringify({ mode: 'check', affected_event_types: summary, affected_selector_count: unsafeSelectors.rowCount || 0 }, null, 2))
      return
    }

    await client.query('BEGIN')
    const deleted = await client.query(
      `DELETE FROM notification_event_rule_selectors
        WHERE event_type = ANY($1::text[])
          AND (
            recipient_type = 'user'
            OR (
              recipient_type = 'role'
              AND LOWER(TRIM(recipient_value)) <> ALL($2::text[])
            )
          )
      RETURNING event_type`,
      [TASK_EVENT_TYPES, MANAGER_ROLES],
    )
    const changedEventTypes = Array.from(new Set((deleted.rows || []).map((row) => String(row?.event_type || '').trim()).filter(Boolean)))
    const remaining = changedEventTypes.length
      ? await client.query(
        `SELECT DISTINCT event_type
           FROM notification_event_rule_selectors
          WHERE event_type = ANY($1::text[])`,
        [changedEventTypes],
      )
      : { rows: [] }
    const eventTypesWithSelectors = new Set((remaining.rows || []).map((row) => String(row?.event_type || '').trim()).filter(Boolean))
    for (const eventType of changedEventTypes) {
      if (eventTypesWithSelectors.has(eventType)) continue
      for (const audience of SAFE_FALLBACK_SELECTORS[eventType] || []) {
        await client.query(
          `INSERT INTO notification_event_rule_selectors (id, event_type, recipient_type, recipient_value)
           VALUES ($1,$2,'audience',$3)
           ON CONFLICT (event_type, recipient_type, recipient_value) DO NOTHING`,
          [randomUUID(), eventType, audience],
        )
      }
    }
    if (changedEventTypes.length) {
      await client.query(
        `UPDATE notification_event_rules
            SET version = version + 1,
                updated_at = now(),
                note = COALESCE(NULLIF(note, ''), '历史不安全任务通知选择器已移除')
          WHERE event_type = ANY($1::text[])`,
        [changedEventTypes],
      )
    }
    await client.query('COMMIT')
    console.log(JSON.stringify({ mode: 'apply', affected_event_types: summary, removed_selector_count: deleted.rowCount || 0 }, null, 2))
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(`[notification-rule-repair] ${String(error?.message || 'failed')}`)
  process.exit(1)
})
