BEGIN;
SET LOCAL lock_timeout = '5s';

-- R5-2B is deliberately migration-first. The application may only read this
-- marker at startup; it must never recreate guide tables on an HTTP request.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '20260902_r5_1_request_schema'
  ) THEN
    RAISE EXCEPTION 'r5_1_request_schema_not_ready';
  END IF;
  IF to_regclass('public.properties') IS NULL THEN
    RAISE EXCEPTION 'properties_missing';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS property_guides (
  id text PRIMARY KEY,
  property_id text REFERENCES properties(id) ON DELETE CASCADE,
  language text NOT NULL,
  version text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  base_version text,
  building_key text,
  copied_from_id text,
  copied_at timestamptz,
  copied_by text,
  status text NOT NULL,
  content_json jsonb,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  published_at timestamptz
);

-- Historical public-guide creation predated the copy/revision fields. Keep the
-- canonical final shape additive and retain copied guide rows with NULL owner.
ALTER TABLE property_guides ALTER COLUMN property_id DROP NOT NULL;
ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS base_version text;
ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS building_key text;
ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS copied_from_id text;
ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS copied_at timestamptz;
ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS copied_by text;

CREATE INDEX IF NOT EXISTS idx_property_guides_property_id ON property_guides(property_id);
CREATE INDEX IF NOT EXISTS idx_property_guides_lang ON property_guides(property_id, language);
CREATE INDEX IF NOT EXISTS idx_property_guides_status ON property_guides(status);
CREATE INDEX IF NOT EXISTS idx_property_guides_building_key ON property_guides(building_key);
CREATE INDEX IF NOT EXISTS idx_property_guides_building_lang_base ON property_guides(building_key, language, base_version);

-- Preserve the legacy deterministic reconciliation once, under migration
-- control. Existing production preflight found no duplicate property rows.
UPDATE property_guides g
SET
  base_version = COALESCE(NULLIF(g.base_version, ''), regexp_replace(COALESCE(g.version, ''), '-copy-.*$', '')),
  building_key = COALESCE(
    NULLIF(g.building_key, ''),
    NULLIF(trim(p.building_name), ''),
    upper(regexp_replace(COALESCE(p.code, ''), '^([A-Za-z]+-?\\d+).*$', '\\1')),
    p.code
  )
FROM properties p
WHERE g.property_id = p.id
  AND (
    g.base_version IS NULL OR g.base_version = '' OR g.building_key IS NULL OR g.building_key = ''
  );

WITH ranked AS (
  SELECT
    id,
    property_id,
    row_number() OVER (
      PARTITION BY property_id
      ORDER BY (status = 'published') DESC, published_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC
    ) AS rn
  FROM property_guides
  WHERE property_id IS NOT NULL
)
UPDATE property_guides g
SET property_id = NULL,
    status = 'archived',
    updated_at = now()
FROM ranked r
WHERE g.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_property_guides_property_id
  ON property_guides(property_id)
  WHERE property_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS property_guide_revisions (
  id bigserial PRIMARY KEY,
  guide_id text NOT NULL REFERENCES property_guides(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  action text NOT NULL,
  content_json jsonb,
  change_note text,
  changed_by text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_property_guide_revisions_guide_id ON property_guide_revisions(guide_id);
CREATE INDEX IF NOT EXISTS idx_property_guide_revisions_changed_at ON property_guide_revisions(changed_at);

CREATE TABLE IF NOT EXISTS property_guide_public_links (
  token_hash text PRIMARY KEY,
  token_enc text,
  guide_id text NOT NULL REFERENCES property_guides(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
ALTER TABLE property_guide_public_links ADD COLUMN IF NOT EXISTS token_enc text;
ALTER TABLE property_guide_public_links ALTER COLUMN expires_at DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_property_guide_links_guide_id ON property_guide_public_links(guide_id);
CREATE INDEX IF NOT EXISTS idx_property_guide_links_expires_at ON property_guide_public_links(expires_at);

CREATE TABLE IF NOT EXISTS property_guide_public_sessions (
  session_id_hash text PRIMARY KEY,
  token_hash text NOT NULL REFERENCES property_guide_public_links(token_hash) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_property_guide_sessions_token_hash ON property_guide_public_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_property_guide_sessions_expires_at ON property_guide_public_sessions(expires_at);

CREATE TABLE IF NOT EXISTS property_guide_link_sync_logs (
  id bigserial PRIMARY KEY,
  synced_at timestamptz NOT NULL DEFAULT now(),
  mode text NOT NULL,
  status text NOT NULL,
  source_property_id text,
  target_property_id text,
  guide_id text,
  token_hash text,
  old_link text,
  new_link text,
  error_message text
);
CREATE INDEX IF NOT EXISTS idx_pgls_target ON property_guide_link_sync_logs(target_property_id, synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_pgls_status ON property_guide_link_sync_logs(status, synced_at DESC);

-- Validate the full runtime contract before advertising the marker. Do not
-- require token_enc to be non-null: historical opaque links cannot be safely
-- reconstructed and must preserve their existing fallback behaviour.
DO $$
DECLARE
  relation_name text;
  required_column text;
BEGIN
  FOR relation_name, required_column IN
    SELECT * FROM (VALUES
      ('property_guides', 'id'), ('property_guides', 'property_id'), ('property_guides', 'language'),
      ('property_guides', 'version'), ('property_guides', 'revision'), ('property_guides', 'base_version'),
      ('property_guides', 'building_key'), ('property_guides', 'copied_from_id'), ('property_guides', 'copied_at'),
      ('property_guides', 'copied_by'), ('property_guides', 'status'), ('property_guides', 'content_json'),
      ('property_guide_revisions', 'guide_id'), ('property_guide_revisions', 'revision'),
      ('property_guide_public_links', 'token_hash'), ('property_guide_public_links', 'token_enc'),
      ('property_guide_public_links', 'guide_id'), ('property_guide_public_links', 'expires_at'),
      ('property_guide_public_sessions', 'session_id_hash'), ('property_guide_public_sessions', 'token_hash'),
      ('property_guide_link_sync_logs', 'id'), ('property_guide_link_sync_logs', 'synced_at')
    ) AS required(relation_name, required_column)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_attribute
      WHERE attrelid = to_regclass('public.' || relation_name)
        AND attname = required_column
        AND NOT attisdropped
    ) THEN
      RAISE EXCEPTION 'r5_2b_property_guides %.% missing', relation_name, required_column;
    END IF;
  END LOOP;
  IF to_regclass('public.uq_property_guides_property_id') IS NULL
     OR to_regclass('public.idx_property_guide_links_guide_id') IS NULL
     OR to_regclass('public.idx_property_guide_sessions_token_hash') IS NULL
     OR to_regclass('public.idx_pgls_target') IS NULL THEN
    RAISE EXCEPTION 'r5_2b_property_guides_indexes_missing';
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('20260910_r5_2b_property_guides_schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;
