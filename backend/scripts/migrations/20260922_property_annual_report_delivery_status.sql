BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF to_regclass('public.properties') IS NULL THEN
    RAISE EXCEPTION 'annual_report_delivery_status_requires_properties';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS property_annual_report_delivery_status (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  fiscal_year integer NOT NULL,
  sent_to_owner boolean NOT NULL DEFAULT false,
  sent_at timestamptz,
  sent_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT property_annual_report_delivery_status_fy_check CHECK (fiscal_year BETWEEN 2000 AND 2200),
  CONSTRAINT property_annual_report_delivery_status_sent_check CHECK (
    (sent_to_owner = true AND sent_at IS NOT NULL)
    OR (sent_to_owner = false AND sent_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_annual_report_delivery_status_property_fy
  ON property_annual_report_delivery_status(property_id, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_property_annual_report_delivery_status_fy
  ON property_annual_report_delivery_status(fiscal_year, sent_to_owner, property_id);

INSERT INTO schema_migrations (version)
VALUES ('20260922_property_annual_report_delivery_status')
ON CONFLICT (version) DO NOTHING;

COMMIT;
