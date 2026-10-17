BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS guest_site_amenity_templates (
  id text PRIMARY KEY,
  scope text NOT NULL,
  scope_key text NOT NULL DEFAULT '',
  name text NOT NULL,
  amenity_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  updated_by text,
  CONSTRAINT guest_site_amenity_templates_scope_check
    CHECK (scope IN ('company', 'building')),
  CONSTRAINT guest_site_amenity_templates_scope_key_check
    CHECK (
      scope_key = BTRIM(scope_key)
      AND (
        (scope = 'company' AND scope_key = '')
        OR (scope = 'building' AND scope_key <> '')
      )
    ),
  CONSTRAINT guest_site_amenity_templates_name_check
    CHECK (name = BTRIM(name) AND name <> '' AND char_length(name) <= 120),
  CONSTRAINT guest_site_amenity_templates_candidates_check
    CHECK (jsonb_typeof(amenity_candidates) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_guest_site_amenity_templates_scope_name
  ON guest_site_amenity_templates(scope, LOWER(scope_key), LOWER(name));

CREATE INDEX IF NOT EXISTS idx_guest_site_amenity_templates_list
  ON guest_site_amenity_templates(scope, scope_key, is_active, updated_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('20261002_guest_site_amenity_templates')
ON CONFLICT (version) DO NOTHING;

COMMIT;
