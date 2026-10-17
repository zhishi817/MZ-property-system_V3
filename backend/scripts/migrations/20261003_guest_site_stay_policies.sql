BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF to_regclass('public.guest_site_property_displays') IS NULL THEN
    RAISE EXCEPTION 'guest_site_property_displays_missing';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS guest_site_stay_policy_versions (
  id text PRIMARY KEY,
  scope_type text NOT NULL,
  property_id text,
  section text NOT NULL,
  status text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  supersedes_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  published_at timestamptz,
  published_by text,
  CONSTRAINT guest_site_stay_policy_scope_check
    CHECK (scope_type IN ('company', 'property')),
  CONSTRAINT guest_site_stay_policy_scope_property_check
    CHECK (
      (scope_type = 'company' AND property_id IS NULL)
      OR (scope_type = 'property' AND BTRIM(COALESCE(property_id, '')) <> '')
    ),
  CONSTRAINT guest_site_stay_policy_section_check
    CHECK (section IN ('house_rules', 'cancellation_policy', 'stay_times', 'stay_services')),
  CONSTRAINT guest_site_stay_policy_status_check
    CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT guest_site_stay_policy_revision_check
    CHECK (revision >= 1),
  CONSTRAINT guest_site_stay_policy_content_check
    CHECK (jsonb_typeof(content) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_guest_site_stay_policy_company_draft
  ON guest_site_stay_policy_versions(section)
  WHERE scope_type = 'company' AND status = 'draft';

CREATE UNIQUE INDEX IF NOT EXISTS uq_guest_site_stay_policy_company_published
  ON guest_site_stay_policy_versions(section)
  WHERE scope_type = 'company' AND status = 'published';

CREATE UNIQUE INDEX IF NOT EXISTS uq_guest_site_stay_policy_property_draft
  ON guest_site_stay_policy_versions(property_id, section)
  WHERE scope_type = 'property' AND status = 'draft';

CREATE UNIQUE INDEX IF NOT EXISTS uq_guest_site_stay_policy_property_published
  ON guest_site_stay_policy_versions(property_id, section)
  WHERE scope_type = 'property' AND status = 'published';

CREATE INDEX IF NOT EXISTS idx_guest_site_stay_policy_history
  ON guest_site_stay_policy_versions(scope_type, property_id, section, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS guest_site_property_policy_sections (
  property_id text NOT NULL,
  section text NOT NULL,
  mode text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  decided_at timestamptz NOT NULL DEFAULT now(),
  decided_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (property_id, section),
  CONSTRAINT guest_site_property_policy_section_check
    CHECK (section IN ('house_rules', 'cancellation_policy', 'stay_times', 'stay_services')),
  CONSTRAINT guest_site_property_policy_mode_check
    CHECK (mode IN ('legacy', 'follow_company', 'override')),
  CONSTRAINT guest_site_property_policy_revision_check
    CHECK (revision >= 1)
);

CREATE INDEX IF NOT EXISTS idx_guest_site_property_policy_mode
  ON guest_site_property_policy_sections(section, mode, property_id);

CREATE OR REPLACE FUNCTION guest_site_initialize_property_policy_sections()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO guest_site_property_policy_sections
    (property_id, section, mode, revision, decided_at, updated_at)
  SELECT NEW.property_id, section_name, 'follow_company', 1, now(), now()
  FROM (
    VALUES
      ('house_rules'),
      ('cancellation_policy'),
      ('stay_times'),
      ('stay_services')
  ) AS sections(section_name)
  ON CONFLICT (property_id, section) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guest_site_initialize_property_policy_sections
  ON guest_site_property_displays;

CREATE TRIGGER trg_guest_site_initialize_property_policy_sections
AFTER INSERT ON guest_site_property_displays
FOR EACH ROW
EXECUTE FUNCTION guest_site_initialize_property_policy_sections();

CREATE TABLE IF NOT EXISTS guest_site_stay_policy_audits (
  id text PRIMARY KEY,
  action text NOT NULL,
  scope_type text NOT NULL,
  property_id text,
  section text NOT NULL,
  version_id text,
  actor_id text,
  before_json jsonb,
  after_json jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guest_site_stay_policy_audit_action_check
    CHECK (action IN ('draft_saved', 'section_published', 'mode_changed', 'bulk_mode_changed')),
  CONSTRAINT guest_site_stay_policy_audit_scope_check
    CHECK (scope_type IN ('company', 'property')),
  CONSTRAINT guest_site_stay_policy_audit_section_check
    CHECK (section IN ('house_rules', 'cancellation_policy', 'stay_times', 'stay_services')),
  CONSTRAINT guest_site_stay_policy_audit_before_check
    CHECK (before_json IS NULL OR jsonb_typeof(before_json) = 'object'),
  CONSTRAINT guest_site_stay_policy_audit_after_check
    CHECK (after_json IS NULL OR jsonb_typeof(after_json) = 'object'),
  CONSTRAINT guest_site_stay_policy_audit_metadata_check
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_guest_site_stay_policy_audits_subject
  ON guest_site_stay_policy_audits(scope_type, property_id, section, created_at DESC);

-- Existing display records stay on their exact legacy values until an operator
-- explicitly chooses follow-company or publishes a property override. This
-- inserts mode metadata only; it does not alter house_rules or arrival times.
INSERT INTO guest_site_property_policy_sections
  (property_id, section, mode, revision, decided_at, updated_at)
SELECT d.property_id, section_name, 'legacy', 1, now(), now()
FROM guest_site_property_displays d
CROSS JOIN (
  VALUES
    ('house_rules'),
    ('cancellation_policy'),
    ('stay_times'),
    ('stay_services')
) AS sections(section_name)
ON CONFLICT (property_id, section) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('20261003_guest_site_stay_policies')
ON CONFLICT (version) DO NOTHING;

COMMIT;
