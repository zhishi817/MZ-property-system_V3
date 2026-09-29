BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM schema_migrations
     WHERE version = '20260902_r5_2a_core_task_schema'
  ) THEN
    RAISE EXCEPTION 'personnel_settlement_requires_20260902_r5_2a_core_task_schema';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS personnel_settlement_profiles (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  effective_from date NOT NULL,
  effective_to date,
  settlement_enabled boolean NOT NULL DEFAULT false,
  person_type text NOT NULL,
  supplier_legal_name text,
  supplier_business_name text,
  abn text,
  gst_status text NOT NULL DEFAULT 'unconfirmed',
  gst_effective_from date,
  invoice_document_type text NOT NULL DEFAULT 'supplier_invoice',
  currency text NOT NULL DEFAULT 'AUD',
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personnel_settlement_profiles_person_type_check CHECK (
    person_type IN ('cleaner', 'inspector', 'warehouse', 'trial', 'external', 'mixed')
  ),
  CONSTRAINT personnel_settlement_profiles_document_type_check CHECK (
    invoice_document_type = 'supplier_invoice'
  ),
  CONSTRAINT personnel_settlement_profiles_currency_check CHECK (currency = 'AUD'),
  CONSTRAINT personnel_settlement_profiles_gst_status_check CHECK (
    gst_status IN ('unconfirmed', 'registered', 'not_registered')
  ),
  CONSTRAINT personnel_settlement_profiles_gst_effective_check CHECK (
    (gst_status = 'unconfirmed' AND gst_effective_from IS NULL)
    OR (gst_status <> 'unconfirmed' AND gst_effective_from IS NOT NULL)
  ),
  CONSTRAINT personnel_settlement_profiles_date_check CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personnel_settlement_profiles_user_start
  ON personnel_settlement_profiles(user_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_personnel_settlement_profiles_active
  ON personnel_settlement_profiles(user_id, effective_from, effective_to)
  WHERE settlement_enabled = true;

CREATE TABLE IF NOT EXISTS personnel_settlement_profile_audits (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  profile_id text NOT NULL REFERENCES personnel_settlement_profiles(id) ON DELETE RESTRICT,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_source text NOT NULL,
  reason text NOT NULL,
  effective_date date NOT NULL,
  before_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personnel_settlement_profile_audits_source_check CHECK (
    actor_source IN ('mobile_self', 'web_admin')
  ),
  CONSTRAINT personnel_settlement_profile_audits_reason_check CHECK (
    NULLIF(TRIM(reason), '') IS NOT NULL
  )
);
CREATE INDEX IF NOT EXISTS idx_personnel_settlement_profile_audits_user
  ON personnel_settlement_profile_audits(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS personnel_fee_rules (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  effective_from date NOT NULL,
  effective_to date,
  price_basis text NOT NULL,
  currency text NOT NULL DEFAULT 'AUD',
  notes text,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personnel_fee_rules_status_check CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT personnel_fee_rules_price_basis_check CHECK (price_basis IN ('exclusive_gst', 'inclusive_gst')),
  CONSTRAINT personnel_fee_rules_currency_check CHECK (currency = 'AUD'),
  CONSTRAINT personnel_fee_rules_date_check CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personnel_fee_rules_user_start_name
  ON personnel_fee_rules(user_id, effective_from, name);
CREATE INDEX IF NOT EXISTS idx_personnel_fee_rules_active
  ON personnel_fee_rules(user_id, effective_from, effective_to)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS personnel_fee_rule_items (
  id text PRIMARY KEY,
  rule_id text NOT NULL REFERENCES personnel_fee_rules(id) ON DELETE CASCADE,
  component_type text NOT NULL,
  property_id text,
  task_type text,
  priority integer NOT NULL DEFAULT 0,
  rate_cents bigint NOT NULL,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personnel_fee_rule_items_component_check CHECK (
    component_type IN (
      'cleaning_task', 'inspection_day', 'warehouse_hour',
      'trial_task', 'trial_day', 'trial_hour',
      'external_task', 'external_day', 'external_hour',
      'weekly_fixed', 'subsidy_amount', 'overtime_hour',
      'new_property_task', 'custom_amount'
    )
  ),
  CONSTRAINT personnel_fee_rule_items_rate_check CHECK (rate_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_personnel_fee_rule_items_lookup
  ON personnel_fee_rule_items(rule_id, component_type, priority DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personnel_fee_rule_items_scope
  ON personnel_fee_rule_items(
    rule_id,
    component_type,
    COALESCE(property_id, ''),
    COALESCE(task_type, ''),
    priority
  );

CREATE TABLE IF NOT EXISTS personnel_settlement_batches (
  id text PRIMARY KEY,
  week_start date NOT NULL,
  week_end date NOT NULL,
  timezone text NOT NULL DEFAULT 'Australia/Melbourne',
  source_cutoff_at timestamptz NOT NULL,
  calculation_version text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  generated_by text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  finalized_by text,
  finalized_at timestamptz,
  error_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT personnel_settlement_batches_period_check CHECK (week_end = week_start + 6),
  CONSTRAINT personnel_settlement_batches_timezone_check CHECK (timezone = 'Australia/Melbourne'),
  CONSTRAINT personnel_settlement_batches_status_check CHECK (
    status IN ('draft', 'open_confirmation', 'under_finance_review', 'finalized', 'failed')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personnel_settlement_batches_week
  ON personnel_settlement_batches(week_start, week_end);

CREATE TABLE IF NOT EXISTS personnel_weekly_settlements (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES personnel_settlement_batches(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  profile_snapshot jsonb NOT NULL,
  rule_snapshot jsonb NOT NULL,
  subtotal_cents bigint NOT NULL DEFAULT 0,
  gst_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'AUD',
  status text NOT NULL DEFAULT 'draft',
  workload_amount_confirmed_at timestamptz,
  workload_amount_confirmation_note text,
  disputed_at timestamptz,
  dispute_note text,
  finance_reviewed_by text,
  finance_reviewed_at timestamptz,
  supplier_invoice_number text,
  invoice_media_id text,
  invoice_generated_at timestamptz,
  company_expense_id text,
  paid_by text,
  paid_at timestamptz,
  payment_reference text,
  payment_destination_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personnel_weekly_settlements_currency_check CHECK (currency = 'AUD'),
  CONSTRAINT personnel_weekly_settlements_amounts_check CHECK (
    subtotal_cents >= 0 AND gst_cents >= 0 AND total_cents = subtotal_cents + gst_cents
  ),
  CONSTRAINT personnel_weekly_settlements_status_check CHECK (
    status IN ('draft', 'awaiting_confirmation', 'confirmed', 'disputed', 'finance_approved', 'paid', 'void')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personnel_weekly_settlements_batch_user
  ON personnel_weekly_settlements(batch_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personnel_weekly_settlements_company_expense
  ON personnel_weekly_settlements(company_expense_id)
  WHERE company_expense_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS personnel_settlement_lines (
  id text PRIMARY KEY,
  settlement_id text NOT NULL REFERENCES personnel_weekly_settlements(id) ON DELETE RESTRICT,
  component_type text NOT NULL,
  service_date date NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_audit_id text,
  property_id text,
  task_type text,
  description text,
  quantity_numerator bigint NOT NULL,
  quantity_denominator bigint NOT NULL,
  unit_rate_cents bigint NOT NULL,
  subtotal_cents bigint NOT NULL,
  gst_cents bigint NOT NULL,
  total_cents bigint NOT NULL,
  price_basis text NOT NULL,
  calculation_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personnel_settlement_lines_quantity_check CHECK (
    quantity_numerator >= 0 AND quantity_denominator > 0
  ),
  CONSTRAINT personnel_settlement_lines_amounts_check CHECK (
    unit_rate_cents >= 0 AND subtotal_cents >= 0 AND gst_cents >= 0
    AND total_cents = subtotal_cents + gst_cents
  ),
  CONSTRAINT personnel_settlement_lines_price_basis_check CHECK (
    price_basis IN ('exclusive_gst', 'inclusive_gst')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personnel_settlement_lines_source
  ON personnel_settlement_lines(settlement_id, component_type, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_personnel_settlement_lines_service_date
  ON personnel_settlement_lines(service_date, component_type);

CREATE TABLE IF NOT EXISTS personnel_workload_claims (
  id text PRIMARY KEY,
  submitter_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  service_date date NOT NULL,
  claim_type text NOT NULL,
  property_id text,
  cleaning_task_id text,
  started_at timestamptz,
  ended_at timestamptz,
  duration_minutes integer,
  approved_duration_minutes integer,
  requested_quantity numeric(12,3),
  approved_quantity numeric(12,3),
  requested_amount_cents bigint,
  approved_amount_cents bigint,
  note text,
  status text NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personnel_workload_claims_type_check CHECK (
    claim_type IN (
      'warehouse_hour', 'trial_task', 'trial_day', 'trial_hour',
      'external_task', 'external_day', 'external_hour',
      'subsidy_amount', 'overtime_hour', 'new_property_task', 'custom_amount'
    )
  ),
  CONSTRAINT personnel_workload_claims_status_check CHECK (
    status IN ('draft', 'submitted', 'approved', 'rejected', 'returned')
  ),
  CONSTRAINT personnel_workload_claims_time_check CHECK (
    started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at
  ),
  CONSTRAINT personnel_workload_claims_values_check CHECK (
    (duration_minutes IS NULL OR duration_minutes >= 0)
    AND (approved_duration_minutes IS NULL OR approved_duration_minutes >= 0)
    AND (requested_quantity IS NULL OR requested_quantity >= 0)
    AND (approved_quantity IS NULL OR approved_quantity >= 0)
    AND (requested_amount_cents IS NULL OR requested_amount_cents >= 0)
    AND (approved_amount_cents IS NULL OR approved_amount_cents >= 0)
  )
);
CREATE INDEX IF NOT EXISTS idx_personnel_workload_claims_user_week
  ON personnel_workload_claims(submitter_user_id, service_date, status);
CREATE INDEX IF NOT EXISTS idx_personnel_workload_claims_review
  ON personnel_workload_claims(status, submitted_at);

CREATE TABLE IF NOT EXISTS personnel_workload_claim_evidence (
  id text PRIMARY KEY,
  claim_id text NOT NULL REFERENCES personnel_workload_claims(id) ON DELETE CASCADE,
  media_id text NOT NULL,
  storage_key text NOT NULL,
  mime_type text,
  byte_size bigint,
  original_file_name text,
  uploaded_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personnel_workload_claim_evidence_size_check CHECK (byte_size IS NULL OR byte_size >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personnel_workload_claim_evidence_media
  ON personnel_workload_claim_evidence(media_id);
CREATE INDEX IF NOT EXISTS idx_personnel_workload_claim_evidence_claim
  ON personnel_workload_claim_evidence(claim_id, created_at);

WITH target_roles AS (
  SELECT id, name
    FROM roles
   WHERE name IN ('admin', 'finance_staff', 'cleaning_manager', 'offline_manager')
), role_grants(role_name, permission_code) AS (
  VALUES
    ('admin', 'personnel_settlements.profiles.view'),
    ('admin', 'personnel_settlements.profiles.manage'),
    ('admin', 'personnel_settlements.bank.manage'),
    ('admin', 'personnel_settlements.rules.manage'),
    ('admin', 'menu.finance.personnel_settlements.visible'),
    ('finance_staff', 'personnel_settlements.profiles.view'),
    ('finance_staff', 'personnel_settlements.profiles.manage'),
    ('finance_staff', 'personnel_settlements.bank.manage'),
    ('finance_staff', 'personnel_settlements.rules.manage'),
    ('finance_staff', 'menu.finance.personnel_settlements.visible'),
    ('cleaning_manager', 'personnel_settlements.profiles.view'),
    ('cleaning_manager', 'personnel_settlements.profiles.manage'),
    ('cleaning_manager', 'personnel_settlements.rules.manage'),
    ('cleaning_manager', 'menu.finance.personnel_settlements.visible'),
    ('offline_manager', 'personnel_settlements.profiles.view'),
    ('offline_manager', 'personnel_settlements.profiles.manage'),
    ('offline_manager', 'personnel_settlements.rules.manage'),
    ('offline_manager', 'menu.finance.personnel_settlements.visible')
)
INSERT INTO role_permissions (id, role_id, permission_code)
SELECT md5(target_roles.id || ':' || role_grants.permission_code),
       target_roles.id,
       role_grants.permission_code
  FROM target_roles
  JOIN role_grants ON role_grants.role_name = target_roles.name
ON CONFLICT (role_id, permission_code) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('20260910_personnel_settlement_phase1')
ON CONFLICT (version) DO NOTHING;

COMMIT;
