-- Repair orders table for external/internal maintenance workflow
CREATE TABLE IF NOT EXISTS repair_orders (
  id text PRIMARY KEY,
  property_id text REFERENCES properties(id) ON DELETE SET NULL,
  category text,
  category_detail text,
  detail text,
  attachment_urls jsonb,
  submitter_id text,
  submitter_name text,
  submitted_at timestamptz DEFAULT now(),
  urgency text, -- urgent|high|medium|low
  status text, -- pending|assigned|in_progress|completed|canceled
  assignee_id text,
  eta date,
  completed_at timestamptz,
  remark text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_repair_orders_property ON repair_orders(property_id);
CREATE INDEX IF NOT EXISTS idx_repair_orders_status ON repair_orders(status);
CREATE INDEX IF NOT EXISTS idx_repair_orders_urgency ON repair_orders(urgency);
CREATE INDEX IF NOT EXISTS idx_repair_orders_submitted ON repair_orders(submitted_at);

-- Row level security (open SELECT; write/delete via app-layer RBAC)
ALTER TABLE repair_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS repair_orders_select ON repair_orders;
CREATE POLICY repair_orders_select ON repair_orders FOR SELECT USING (true);
