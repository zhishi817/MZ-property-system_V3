BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_au text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS legal_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_account_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_bsb text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_account_number text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_abn text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_id_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS visa_document_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS visa_grant_number text;

CREATE TABLE IF NOT EXISTS cleaning_day_end_media (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  date date NOT NULL,
  kind text NOT NULL DEFAULT 'backup_key_return',
  url text NOT NULL,
  captured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cleaning_day_end_media ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'backup_key_return';
CREATE INDEX IF NOT EXISTS idx_cleaning_day_end_media_user_date ON cleaning_day_end_media(user_id, date);
CREATE INDEX IF NOT EXISTS idx_cleaning_day_end_media_date ON cleaning_day_end_media(date);

CREATE TABLE IF NOT EXISTS cleaning_day_end_handover (
  user_id text NOT NULL,
  date date NOT NULL,
  no_dirty_linen boolean NOT NULL DEFAULT false,
  no_warehouse_key boolean NOT NULL DEFAULT false,
  submitted_at timestamptz,
  key_submitted_at timestamptz,
  dirty_linen_submitted_at timestamptz,
  warehouse_key_submitted_at timestamptz,
  consumable_submitted_at timestamptz,
  reject_submitted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);
ALTER TABLE cleaning_day_end_handover ADD COLUMN IF NOT EXISTS no_warehouse_key boolean NOT NULL DEFAULT false;
ALTER TABLE cleaning_day_end_handover ADD COLUMN IF NOT EXISTS key_submitted_at timestamptz;
ALTER TABLE cleaning_day_end_handover ADD COLUMN IF NOT EXISTS dirty_linen_submitted_at timestamptz;
ALTER TABLE cleaning_day_end_handover ADD COLUMN IF NOT EXISTS warehouse_key_submitted_at timestamptz;
ALTER TABLE cleaning_day_end_handover ADD COLUMN IF NOT EXISTS consumable_submitted_at timestamptz;
ALTER TABLE cleaning_day_end_handover ADD COLUMN IF NOT EXISTS reject_submitted_at timestamptz;
ALTER TABLE cleaning_day_end_handover ALTER COLUMN submitted_at DROP DEFAULT;
ALTER TABLE cleaning_day_end_handover ALTER COLUMN submitted_at DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cleaning_day_end_handover_date ON cleaning_day_end_handover(date);

CREATE TABLE IF NOT EXISTS cleaning_day_end_reject_items (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  date date NOT NULL,
  linen_type text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  used_room text NOT NULL,
  photos_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cleaning_day_end_reject_items_user_date ON cleaning_day_end_reject_items(user_id, date);

CREATE TABLE IF NOT EXISTS cleaning_task_media (
  id text PRIMARY KEY,
  task_id text REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
  type text,
  url text NOT NULL,
  note text,
  captured_at timestamptz,
  lat numeric,
  lng numeric,
  uploader_id text,
  size integer,
  mime text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE cleaning_task_media ADD COLUMN IF NOT EXISTS note text;
CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task ON cleaning_task_media(task_id);
CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_type ON cleaning_task_media(type);
CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task_type ON cleaning_task_media(task_id, type);
CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task_type_captured_created ON cleaning_task_media(task_id, type, captured_at DESC, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('20260902_r5_1_request_schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;
