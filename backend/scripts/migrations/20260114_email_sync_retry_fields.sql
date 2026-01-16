ALTER TABLE email_sync_items
  ADD COLUMN IF NOT EXISTS retry_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_email_sync_items_retry_due
  ON email_sync_items(account, status, next_retry_at)
  WHERE status = 'retry' AND next_retry_at IS NOT NULL;
