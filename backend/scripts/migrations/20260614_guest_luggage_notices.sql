CREATE TABLE IF NOT EXISTS guest_luggage_notices (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  task_date date NOT NULL,
  note text,
  photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id, task_date)
);

CREATE INDEX IF NOT EXISTS idx_guest_luggage_notices_task
  ON guest_luggage_notices(task_date, property_id);

CREATE TABLE IF NOT EXISTS guest_luggage_acknowledgements (
  notice_id text NOT NULL REFERENCES guest_luggage_notices(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  notice_version integer NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(notice_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_guest_luggage_ack_user
  ON guest_luggage_acknowledgements(user_id, acknowledged_at DESC);
