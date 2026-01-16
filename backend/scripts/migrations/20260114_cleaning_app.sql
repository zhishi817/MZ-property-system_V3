-- Cleaning App incremental schema (only add, no modify existing behavior)
-- Extend cleaning_tasks
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS finished_at timestamptz;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS key_photo_uploaded_at timestamptz;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS lockbox_video_uploaded_at timestamptz;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS geo_lat numeric;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS geo_lng numeric;

-- Media linked to cleaning tasks
CREATE TABLE IF NOT EXISTS cleaning_task_media (
  id text PRIMARY KEY,
  task_id text REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
  type text, -- key_photo | lockbox_video | issue_photo
  url text NOT NULL,
  captured_at timestamptz,
  lat numeric,
  lng numeric,
  uploader_id text,
  size integer,
  mime text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task ON cleaning_task_media(task_id);
CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_type ON cleaning_task_media(type);

-- Consumable usages during cleaning
CREATE TABLE IF NOT EXISTS cleaning_consumable_usages (
  id text PRIMARY KEY,
  task_id text REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
  item_id text,
  qty integer,
  need_restock boolean DEFAULT false,
  note text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cleaning_consumables_task ON cleaning_consumable_usages(task_id);

-- Web Push subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id text,
  endpoint text PRIMARY KEY,
  p256dh text,
  auth text,
  ua text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

-- Optional cleaning issues table (can reuse maintenance; provided here for isolation)
CREATE TABLE IF NOT EXISTS cleaning_issues (
  id text PRIMARY KEY,
  task_id text REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
  title text,
  detail text,
  severity text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cleaning_issues_task ON cleaning_issues(task_id);

