BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version = '20260930_personnel_settlement_payment_method'
  ) THEN
    RAISE EXCEPTION 'personnel_settlement_carry_adjustments_requires_payment_method';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS personnel_settlement_carry_adjustments (
  id text PRIMARY KEY,
  source_settlement_id text NOT NULL REFERENCES personnel_weekly_settlements(id) ON DELETE RESTRICT,
  source_adjustment_id text NOT NULL,
  target_settlement_id text REFERENCES personnel_weekly_settlements(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_week_start date NOT NULL,
  source_week_end date NOT NULL,
  target_week_start date NOT NULL,
  target_week_end date NOT NULL,
  recorded_subtotal_difference_cents bigint NOT NULL,
  recorded_gst_difference_cents bigint NOT NULL,
  recorded_total_difference_cents bigint NOT NULL,
  previously_applied_subtotal_cents bigint NOT NULL DEFAULT 0,
  previously_applied_gst_cents bigint NOT NULL DEFAULT 0,
  previously_applied_total_cents bigint NOT NULL DEFAULT 0,
  applied_subtotal_cents bigint NOT NULL,
  applied_gst_cents bigint NOT NULL,
  applied_total_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  reason text NOT NULL,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_by text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personnel_settlement_carry_adjustments_source_period_check
    CHECK (source_week_end = source_week_start + 6),
  CONSTRAINT personnel_settlement_carry_adjustments_target_period_check
    CHECK (target_week_end = target_week_start + 6),
  CONSTRAINT personnel_settlement_carry_adjustments_next_week_check
    CHECK (target_week_start = source_week_start + 7),
  CONSTRAINT personnel_settlement_carry_adjustments_recorded_amounts_check
    CHECK (recorded_total_difference_cents
      = recorded_subtotal_difference_cents + recorded_gst_difference_cents),
  CONSTRAINT personnel_settlement_carry_adjustments_previously_applied_amounts_check
    CHECK (previously_applied_total_cents
      = previously_applied_subtotal_cents + previously_applied_gst_cents),
  CONSTRAINT personnel_settlement_carry_adjustments_applied_amounts_check
    CHECK (
      (applied_subtotal_cents <> 0 OR applied_gst_cents <> 0)
      AND applied_total_cents = applied_subtotal_cents + applied_gst_cents
      AND applied_subtotal_cents
        = recorded_subtotal_difference_cents - previously_applied_subtotal_cents
      AND applied_gst_cents
        = recorded_gst_difference_cents - previously_applied_gst_cents
      AND applied_total_cents
        = recorded_total_difference_cents - previously_applied_total_cents
    ),
  CONSTRAINT personnel_settlement_carry_adjustments_status_check
    CHECK (status IN ('scheduled', 'included_in_target')),
  CONSTRAINT personnel_settlement_carry_adjustments_source_adjustment_unique
    UNIQUE (source_settlement_id, source_adjustment_id)
);

CREATE INDEX IF NOT EXISTS idx_personnel_settlement_carry_adjustments_target_week
  ON personnel_settlement_carry_adjustments(target_week_start, user_id, applied_at, id);
CREATE INDEX IF NOT EXISTS idx_personnel_settlement_carry_adjustments_source
  ON personnel_settlement_carry_adjustments(source_settlement_id, applied_at, id);

ALTER TABLE personnel_settlement_lines
  DROP CONSTRAINT IF EXISTS personnel_settlement_lines_amounts_check;
ALTER TABLE personnel_settlement_lines
  ADD CONSTRAINT personnel_settlement_lines_amounts_check CHECK (
    (
      component_type = 'post_payment_adjustment'
      AND source_type = 'post_payment_adjustment'
      AND quantity_numerator = 1
      AND quantity_denominator = 1
      AND (subtotal_cents <> 0 OR gst_cents <> 0)
      AND unit_rate_cents = total_cents
      AND total_cents = subtotal_cents + gst_cents
      AND price_basis = 'inclusive_gst'
    )
    OR
    (
      component_type <> 'post_payment_adjustment'
      AND unit_rate_cents >= 0
      AND subtotal_cents >= 0
      AND gst_cents >= 0
      AND total_cents = subtotal_cents + gst_cents
    )
  ) NOT VALID;
ALTER TABLE personnel_settlement_lines
  VALIDATE CONSTRAINT personnel_settlement_lines_amounts_check;

INSERT INTO schema_migrations (version)
VALUES ('20261013_personnel_settlement_carry_adjustments')
ON CONFLICT (version) DO NOTHING;

COMMIT;
