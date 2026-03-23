CREATE TABLE IF NOT EXISTS mzapp_alerts (
  id text PRIMARY KEY,
  kind text NOT NULL,
  target_user_id text NOT NULL,
  level text NOT NULL,
  date date,
  position integer,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_mzapp_alerts_target_unread ON mzapp_alerts(target_user_id, read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_mzapp_alerts_kind ON mzapp_alerts(kind);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mzapp_alerts_dedupe ON mzapp_alerts(kind, target_user_id, date, position, level);

