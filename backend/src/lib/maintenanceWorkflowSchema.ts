type SqlClient = {
  query: (sql: string, params?: any[]) => Promise<unknown>
}

export const MAINTENANCE_WORKFLOW_STATUSES = [
  'pending_assignment',
  'assigned',
  'in_progress',
  'pending_review',
  'closed',
  'cancelled',
] as const

export const INTERNAL_MAINTENANCE_FEEDBACK_SOURCES = [
  'cleaning_feedback',
  'inspection_feedback',
  'manager_feedback',
] as const

export const MAINTENANCE_WORK_TASK_SOURCE_TYPES = {
  internal: 'property_maintenance',
  external: 'external_maintenance_orders',
} as const

export class MaintenanceWorkflowSchemaNotReady extends Error {
  constructor() {
    super('maintenance_workflow_schema_not_ready')
    this.name = 'MaintenanceWorkflowSchemaNotReady'
  }
}

const READINESS_QUERIES = [
  `SELECT id, property_id, occurred_at, details, created_by, created_at,
          feedback_source, source_task_id, status, assignee_id, eta, assigned_at,
          assigned_by, started_at, submitted_at, submitter_name, completion_photo_urls,
          photo_urls, repair_photo_urls, repair_notes, category_detail, work_no, area,
          invoice_description_en, dedup_fingerprint, client_item_id, review_status, reviewed_at,
          reviewed_by, review_note, review_notes, closed_at, closed_by, cancelled_at,
          cancelled_by, cancel_reason, reopened_at, reopened_by, reopen_reason, updated_at
     FROM property_maintenance
    LIMIT 0`,
  `SELECT id, order_no, client_name, details, status, assignee_id, scheduled_date,
          completion_photo_urls, completion_notes, reviewed_at, reviewed_by, review_note,
          closed_at, closed_by, cancelled_at, cancelled_by, cancel_reason, reopened_at,
          reopened_by, reopen_reason, created_by, created_at, updated_at
     FROM external_maintenance_orders
    LIMIT 0`,
  `SELECT id, maintenance_domain, record_id, event_type, from_status, to_status,
          actor_user_id, actor_name, reason, payload, created_at
     FROM maintenance_workflow_events
    LIMIT 0`,
  `SELECT id, task_kind, source_type, source_id, property_id, title, summary,
          scheduled_date, assignee_id, status, urgency, created_by, updated_by,
          created_at, updated_at
     FROM work_tasks
    LIMIT 0`,
]

/**
 * Request paths must only verify schema readiness. All DDL is owned by the
 * controlled maintenance migration and must run before these APIs are enabled.
 */
export async function assertMaintenanceWorkflowSchemaReady(client: SqlClient) {
  try {
    for (const sql of READINESS_QUERIES) await client.query(sql)
  } catch {
    throw new MaintenanceWorkflowSchemaNotReady()
  }
}
