export type PasswordOnlyTaskReorderEntry = {
  id: string
  sort_index: number
}

type QueryResult = { rowCount?: number | null }

export type PasswordOnlyTaskReorderClient = {
  query: (sql: string, params?: any[]) => Promise<QueryResult>
}

export async function updatePasswordOnlyTaskSortOrder(params: {
  client: PasswordOnlyTaskReorderClient
  entries: PasswordOnlyTaskReorderEntry[]
  date: string
  userId: string
}) {
  const entries = Array.from(new Map(
    params.entries.map((entry) => [String(entry.id || '').trim(), {
      id: String(entry.id || '').trim(),
      sort_index: Number(entry.sort_index),
    }]),
  ).values()).filter((entry) => entry.id && Number.isInteger(entry.sort_index) && entry.sort_index > 0)
  if (!entries.length) return

  const result = await params.client.query(
    `UPDATE cleaning_tasks AS t
     SET sort_index_inspector = v.sort_index, updated_at = now()
     FROM jsonb_to_recordset($1::jsonb) AS v(id text, sort_index integer)
     WHERE t.id::text = v.id
       AND COALESCE(t.task_date, t.date)::date = $2::date
       AND lower(COALESCE(t.status, '')) NOT IN ('done', 'completed', 'ready', 'inspected', 'keys_hung', 'pending_review', 'review_pending', 'awaiting_review', 'closed', 'replaced', 'cancelled', 'canceled')
       AND COALESCE(
         t.execution_state,
         CASE WHEN lower(COALESCE(t.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled' ELSE 'active' END
       ) = 'active'
       AND lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
       AND lower(COALESCE(t.inspection_scope, 'inspect_and_hang')) = 'password_only'
       AND t.assignee_id::text = $3::text`,
    [JSON.stringify(entries), params.date, params.userId],
  )
  if (Number(result?.rowCount || 0) !== entries.length) {
    throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  }
}
