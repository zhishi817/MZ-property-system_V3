BEGIN;

CREATE TABLE IF NOT EXISTS audit_logs (
  id text PRIMARY KEY,
  entity text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  actor_id text,
  ip text,
  user_agent text,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

COMMIT;

