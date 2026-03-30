BEGIN;

ALTER TABLE cleaning_tasks
  ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS cleaning_day_end_media (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  date date NOT NULL,
  kind text NOT NULL DEFAULT 'backup_key_return',
  url text NOT NULL,
  captured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cleaning_day_end_media_user_date
  ON cleaning_day_end_media(user_id, date);

CREATE INDEX IF NOT EXISTS idx_cleaning_day_end_media_date
  ON cleaning_day_end_media(date);

COMMIT;
