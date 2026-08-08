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

let maintenanceWorkflowFoundationReady = false
let maintenanceWorkflowFoundationEnsuring: Promise<void> | null = null

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

export async function ensureMaintenanceWorkflowFoundation(client: SqlClient) {
  if (maintenanceWorkflowFoundationReady) return
  if (maintenanceWorkflowFoundationEnsuring) return maintenanceWorkflowFoundationEnsuring
  maintenanceWorkflowFoundationEnsuring = (async () => {
    await client.query(`
      ALTER TABLE property_maintenance
        ADD COLUMN IF NOT EXISTS feedback_source text NOT NULL DEFAULT 'legacy',
        ADD COLUMN IF NOT EXISTS source_task_id text,
        ADD COLUMN IF NOT EXISTS status text,
        ADD COLUMN IF NOT EXISTS assignee_id text,
        ADD COLUMN IF NOT EXISTS eta date,
        ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
        ADD COLUMN IF NOT EXISTS assigned_by text,
        ADD COLUMN IF NOT EXISTS started_at timestamptz,
        ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
        ADD COLUMN IF NOT EXISTS completion_photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS repair_notes text,
        ADD COLUMN IF NOT EXISTS review_status text,
        ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
        ADD COLUMN IF NOT EXISTS reviewed_by text,
        ADD COLUMN IF NOT EXISTS review_note text,
        ADD COLUMN IF NOT EXISTS closed_at timestamptz,
        ADD COLUMN IF NOT EXISTS closed_by text,
        ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
        ADD COLUMN IF NOT EXISTS cancelled_by text,
        ADD COLUMN IF NOT EXISTS cancel_reason text,
        ADD COLUMN IF NOT EXISTS reopened_at timestamptz,
        ADD COLUMN IF NOT EXISTS reopened_by text,
        ADD COLUMN IF NOT EXISTS reopen_reason text,
        ADD COLUMN IF NOT EXISTS updated_at timestamptz;
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS external_maintenance_orders (
        id text PRIMARY KEY,
        order_no text,
        client_name text NOT NULL DEFAULT '',
        client_contact_name text,
        client_contact_phone text,
        client_contact_email text,
        site_name text NOT NULL DEFAULT '',
        site_address text,
        access_notes text,
        external_reference text,
        source_channel text NOT NULL DEFAULT 'external_manual',
        requested_at date,
        scheduled_date date,
        area text,
        details text NOT NULL DEFAULT '',
        urgency text NOT NULL DEFAULT 'medium',
        status text NOT NULL DEFAULT 'pending_assignment'
          CHECK (status IN ('pending_assignment', 'assigned', 'in_progress', 'pending_review', 'closed', 'cancelled')),
        assignee_id text,
        assigned_at timestamptz,
        assigned_by text,
        started_at timestamptz,
        submitted_at timestamptz,
        completion_photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
        completion_notes text,
        reviewed_at timestamptz,
        reviewed_by text,
        review_note text,
        closed_at timestamptz,
        closed_by text,
        cancelled_at timestamptz,
        cancelled_by text,
        cancel_reason text,
        reopened_at timestamptz,
        reopened_by text,
        reopen_reason text,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_external_maintenance_orders_order_no ON external_maintenance_orders(order_no) WHERE NULLIF(BTRIM(order_no), '') IS NOT NULL;`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_external_maintenance_orders_status_schedule ON external_maintenance_orders(status, scheduled_date);`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_external_maintenance_orders_assignee_status ON external_maintenance_orders(assignee_id, status);`)
    await client.query(`CREATE TABLE IF NOT EXISTS maintenance_workflow_events (
      id text PRIMARY KEY,
      maintenance_domain text NOT NULL CHECK (maintenance_domain IN ('internal', 'external')),
      record_id text NOT NULL,
      event_type text NOT NULL,
      from_status text,
      to_status text,
      actor_user_id text,
      actor_name text,
      reason text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_maintenance_workflow_events_record ON maintenance_workflow_events(maintenance_domain, record_id, created_at DESC);`)
    maintenanceWorkflowFoundationReady = true
  })().catch((error) => {
    maintenanceWorkflowFoundationEnsuring = null
    throw error
  }).finally(() => {
    if (maintenanceWorkflowFoundationReady) maintenanceWorkflowFoundationEnsuring = null
  })
  return maintenanceWorkflowFoundationEnsuring
}
