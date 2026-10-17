BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS guest_site_contact_messages (
  id text PRIMARY KEY,
  submission_id uuid NOT NULL UNIQUE,
  guest_name text NOT NULL,
  guest_email text NOT NULL,
  message text NOT NULL,
  dedupe_hash text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  admin_note text,
  handled_by text,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guest_site_contact_messages_status_check CHECK (status IN ('new', 'contacted', 'closed')),
  CONSTRAINT guest_site_contact_messages_name_length_check CHECK (char_length(guest_name) BETWEEN 1 AND 161),
  CONSTRAINT guest_site_contact_messages_email_length_check CHECK (char_length(guest_email) BETWEEN 3 AND 180),
  CONSTRAINT guest_site_contact_messages_message_length_check CHECK (char_length(message) BETWEEN 1 AND 2000),
  CONSTRAINT guest_site_contact_messages_dedupe_hash_check CHECK (dedupe_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_guest_site_contact_messages_status_created
  ON guest_site_contact_messages(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guest_site_contact_messages_dedupe_created
  ON guest_site_contact_messages(dedupe_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guest_site_contact_messages_created
  ON guest_site_contact_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guest_site_contact_messages_email_created
  ON guest_site_contact_messages(guest_email, created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('20261001_guest_site_contact_messages')
ON CONFLICT (version) DO NOTHING;

COMMIT;
