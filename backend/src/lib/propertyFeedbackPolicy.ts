function parseItems(value: any): any[] {
  try { const parsed = JSON.parse(String(value || '[]')); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}

/** Lock evidence is server-owned, including expenses which outlive task projections. */
export function propertyFeedbackMutationLocked(row: any): boolean {
  const status = String(row?.status || '').trim().toLowerCase()
  const pending = ['', 'open', 'pending', 'pending_assignment', 'need_replace', 'todo', 'unassigned']
  if (!pending.includes(status) || row?.deleted_at || row?.completed_at || row?.replacement_at
    || row?.assigned_at || String(row?.assignee_id || '').trim()
    || row?.feedback_has_assignment || row?.feedback_has_expense || row?.feedback_has_history) return true
  const hasCosts = (value: any): boolean => {
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) =>
      /(?:amount|cost|price|fee)$/.test(key) && Number(child) !== 0 && Number.isFinite(Number(child))
      || (typeof child === 'object' && hasCosts(child)))
  }
  if (hasCosts(row)) return true
  const items = Array.isArray(row?.project_items) ? row.project_items : parseItems(row?.project_items) || []
  return items.some((item: any) => item?.completed_at || item?.ended_at || item?.assignee_id
    || ['completed', 'done', 'in_progress'].includes(String(item?.status || '').toLowerCase()) || hasCosts(item))
}

export async function enrichPropertyFeedbackLocks(client: any, kind: 'maintenance' | 'deep_cleaning' | 'daily_necessities', row: any) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM work_tasks w WHERE w.source_type = $1 AND w.source_id::text = $2
         AND (NULLIF(w.assignee_id::text, '') IS NOT NULL
           OR lower(COALESCE(w.status, '')) NOT IN ('', 'open', 'pending', 'todo', 'unassigned', 'pending_assignment'))
     ) AS feedback_has_assignment,
     (EXISTS (SELECT 1 FROM maintenance_workflow_events e
       WHERE $3 = 'maintenance' AND e.maintenance_domain = 'internal' AND e.record_id::text = $2
         AND (e.to_status IN ('assigned','in_progress','pending_review','closed')
           OR e.event_type IN ('assigned','reassigned','assignment_reconciled','started','manager_started','manager_complete','executor_complete')))
      OR EXISTS (SELECT 1 FROM audit_logs a WHERE (a.entity = $1 OR ($3 = 'daily_necessities' AND a.entity = 'DailyReplacement')) AND a.entity_id::text = $2
         AND (a.before_json->>'feedback_history_locked' = 'true'
           OR NULLIF(a.before_json->>'assignee_id', '') IS NOT NULL
           OR NULLIF(a.after_json->>'assignee_id', '') IS NOT NULL
           OR a.before_json->>'status' IN ('assigned','in_progress','completed','closed','replaced')
           OR a.after_json->>'status' IN ('assigned','in_progress','completed','closed','replaced')))
      OR EXISTS (SELECT 1 FROM work_task_events event WHERE event.source_type = 'work_tasks'
        AND ($1 || ':' || $2) = ANY(event.source_ref_ids)
        AND (NULLIF(event.payload->'patch'->>'assignee_id', '') IS NOT NULL
          OR event.payload->'patch'->>'status' IN ('assigned','in_progress','completed','done','closed')))) AS feedback_has_history,
     (EXISTS (SELECT 1 FROM property_expenses e
       WHERE (to_jsonb(e)->>'ref_id' = $2 AND to_jsonb(e)->>'ref_type' IN ($1, $3))
          OR to_jsonb(e)->>'generated_from' = $2)
      OR EXISTS (SELECT 1 FROM company_expenses e
       WHERE (to_jsonb(e)->>'ref_id' = $2 AND to_jsonb(e)->>'ref_type' IN ($1, $3))
          OR to_jsonb(e)->>'generated_from' = $2)
      OR EXISTS (SELECT 1 FROM audit_logs a
        WHERE a.entity IN ('property_expenses', 'company_expenses')
          AND ((a.before_json->>'ref_id' = $2 AND a.before_json->>'ref_type' IN ($1, $3))
            OR (a.after_json->>'ref_id' = $2 AND a.after_json->>'ref_type' IN ($1, $3))
            OR a.before_json->>'generated_from' = $2 OR a.after_json->>'generated_from' = $2))) AS feedback_has_expense`,
    [`property_${kind}`, String(row.id), kind],
  )
  if (!result?.rows?.[0]) throw new Error('property_feedback_lock_evidence_unavailable')
  return { ...row, ...result.rows[0] }
}

/** Serialize source mutations with task assignment, and preserve irreversible
 * business evidence before a manager correction can clear current row fields. */
export async function lockPropertyFeedbackMutationSource(client: any, sourceType: string, id: string, actorId: string) {
  if (!['property_maintenance', 'property_deep_cleaning', 'property_daily_necessities'].includes(sourceType)) return true
  const result = await client.query(`SELECT * FROM ${sourceType} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])
  const row = result.rows?.[0]
  if (!row) return false
  const kind = sourceType.slice('property_'.length) as 'maintenance' | 'deep_cleaning' | 'daily_necessities'
  const evidence = await enrichPropertyFeedbackLocks(client, kind, row)
  if (propertyFeedbackMutationLocked(evidence) && !evidence.feedback_has_history) {
    await client.query(
      `INSERT INTO audit_logs (id, entity, entity_id, action, actor_id, before_json, after_json, created_at)
       VALUES ($1, $2, $3, 'feedback_lock_preserved', $4, $5::jsonb, $5::jsonb, now())`,
      [require('uuid').v4(), sourceType, id, actorId || null, JSON.stringify({ feedback_history_locked: true })],
    )
  }
  return true
}

/** Apply the same source-first lock order to explicit manual expense references.
 * Unrelated accounting sources retain their existing behavior. */
export async function lockPropertyFeedbackExpenseReferences(client: any, rows: any[], existingRows: any[] = []) {
  // Already-orphaned historical expenses remain correctable/removable. Only a
  // newly attached reference requires a live source; every live source is locked.
  const existingRefs = new Set(existingRows.filter(Boolean).flatMap((row) => {
    const type = String(row.ref_type || '').replace(/^property_/, '')
    return [`property_${type}:${String(row.ref_id || '').trim()}`, `generated:${String(row.generated_from || '').trim()}`]
  }))
  const refs = new Map<string, { sourceType: string; id: string; required: boolean }>()
  for (const row of rows.filter(Boolean)) {
    const type = String(row.ref_type || '').replace(/^property_/, '')
    const id = String(row.ref_id || '').trim()
    if (['maintenance', 'deep_cleaning', 'daily_necessities'].includes(type) && id) {
      refs.set(`property_${type}:${id}`, { sourceType: `property_${type}`, id, required: !existingRefs.has(`property_${type}:${id}`) })
    }
    const generated = String(row.generated_from || '').trim()
    if (generated && generated !== id) {
      // Legacy generated_from is the source record ID, not a resource name.
      for (const kind of ['maintenance', 'deep_cleaning', 'daily_necessities']) {
        const sourceType = `property_${kind}`
        const found = await client.query(`SELECT id FROM ${sourceType} WHERE id = $1 LIMIT 1`, [generated])
        if (found.rows?.length) refs.set(`${sourceType}:${generated}`, { sourceType, id: generated, required: !existingRefs.has(`generated:${generated}`) })
      }
    }
  }
  for (const key of Array.from(refs.keys()).sort()) {
    const ref = refs.get(key)!
    if (!await lockPropertyFeedbackMutationSource(client, ref.sourceType, ref.id, '') && ref.required) {
      throw new Error('property_feedback_not_found')
    }
  }
}

/** Called after source locks: never overwrite a reference changed while waiting. */
export async function assertPropertyFeedbackExpenseReferenceUnchanged(client: any, resource: 'property_expenses' | 'company_expenses', id: string, previous: any) {
  const current = (await client.query(`SELECT * FROM ${resource} WHERE id = $1 FOR UPDATE`, [id])).rows?.[0]
  const signature = (value: any) => value
    ? JSON.stringify(['ref_type', 'ref_id', 'generated_from', 'fixed_expense_id', 'month_key'].map(key => String(value[key] || '')))
    : null
  if (signature(current) !== signature(previous)) throw new Error('feedback_expense_reference_conflict')
}

/** Recurring-key upserts and ordinary expense edits share a key lock before
 * source locks, including an absent row which cannot yet be row-locked. */
export async function lockPropertyFeedbackExpenseKeys(client: any, resource: string, rows: any[]) {
  const keys = new Set(rows.filter(Boolean).flatMap(row => {
    const fixedId = String(row.fixed_expense_id || '').trim()
    const month = String(row.month_key || '').trim()
    return fixedId && month ? [`${fixedId}:${month}`] : []
  }))
  for (const key of Array.from(keys).sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [`feedback-expense:${resource}`, key])
  }
}
