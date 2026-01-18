-- Properties table
CREATE TABLE IF NOT EXISTS properties (
  id text PRIMARY KEY,
  address text,
  type text,
  capacity integer,
  region text,
  area_sqm integer,
  building_name text,
  building_facilities text[],
  building_contact_name text,
  building_contact_phone text,
  building_contact_email text,
  bed_config text,
  tv_model text,
  wifi_ssid text,
  wifi_password text,
  router_location text,
  safety_smoke_alarm text,
  safety_extinguisher text,
  safety_first_aid text,
  notes text,
  floor text,
  parking_type text,
  parking_space text,
  access_type text,
  access_guide_link text,
  keybox_location text,
  keybox_code text,
  garage_guide_link text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_properties_region ON properties(region);
CREATE INDEX IF NOT EXISTS idx_properties_type ON properties(type);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS code text;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_properties_code'
  ) THEN
    ALTER TABLE properties ADD CONSTRAINT unique_properties_code UNIQUE (code);
  END IF;
END $$;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS landlord_id text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS aircon_model text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS building_facility_floor text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS building_notes text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS orientation text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS fireworks_view boolean;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false;

-- Landlords table
CREATE TABLE IF NOT EXISTS landlords (
  id text PRIMARY KEY,
  name text,
  company_name text,
  phone text,
  email text,
  tax_no text,
  abn text,
  share_ratio numeric,
  management_fee_rate numeric,
  payout_bsb text,
  payout_account text,
  payout_day integer,
  status text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_landlords_name ON landlords(name);

ALTER TABLE landlords ADD COLUMN IF NOT EXISTS property_ids text[];
ALTER TABLE landlords ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false;

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  source text,
  external_id text,
  property_id text REFERENCES properties(id) ON DELETE SET NULL,
  guest_name text,
  guest_phone text,
  checkin date,
  checkout date,
  price numeric,
  currency text,
  status text,
  idempotency_key text UNIQUE,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_property ON orders(property_id);
CREATE INDEX IF NOT EXISTS idx_orders_checkout ON orders(checkout);
-- Extend orders for email ingestion
ALTER TABLE orders ADD COLUMN IF NOT EXISTS email_header_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS year_inferred boolean DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cleaning_fee numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS net_income numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS avg_nightly_price numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS nights integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_checkin_text text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_checkout_text text;

-- Email sync state for IMAP incremental/backfill
CREATE TABLE IF NOT EXISTS email_sync_state (
  account text PRIMARY KEY,
  last_uid bigint DEFAULT 0,
  last_checked_at timestamptz,
  last_backfill_at timestamptz,
  last_connected_at timestamptz,
  consecutive_failures integer DEFAULT 0,
  cooldown_until timestamptz
);

ALTER TABLE email_sync_state ADD COLUMN IF NOT EXISTS last_connected_at timestamptz;
ALTER TABLE email_sync_state ADD COLUMN IF NOT EXISTS consecutive_failures integer DEFAULT 0;
ALTER TABLE email_sync_state ADD COLUMN IF NOT EXISTS cooldown_until timestamptz;

-- Email sync run metrics
CREATE TABLE IF NOT EXISTS email_sync_runs (
  id bigserial PRIMARY KEY,
  account text NOT NULL,
  scanned integer DEFAULT 0,
  matched integer DEFAULT 0,
  inserted integer DEFAULT 0,
  failed integer DEFAULT 0,
  skipped_duplicate integer DEFAULT 0,
  last_uid_before bigint,
  last_uid_after bigint,
  error_code text,
  error_message text,
  duration_ms integer,
  status text,
  started_at timestamptz DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_email_sync_runs_account_started ON email_sync_runs(account, started_at);

ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS found_uids_count integer DEFAULT 0;
ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS matched_count integer DEFAULT 0;
ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS failed_count integer DEFAULT 0;
ALTER TABLE email_sync_runs ADD COLUMN IF NOT EXISTS cursor_after bigint;

-- Email sync per-UID audit items
CREATE TABLE IF NOT EXISTS email_sync_items (
  id bigserial PRIMARY KEY,
  run_id uuid,
  account text,
  uid bigint,
  status text,
  error_code text,
  error_message text,
  message_id text,
  mailbox text,
  subject text,
  sender text,
  header_date timestamptz,
  reason text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_sync_items_run_uid ON email_sync_items(run_id, uid);

-- Raw email archive for matched messages
CREATE TABLE IF NOT EXISTS email_orders_raw (
  source text NOT NULL,
  uid bigint,
  message_id text,
  header_date timestamptz,
  envelope jsonb,
  html text,
  plain text,
  status text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(source, uid),
  UNIQUE(message_id)
);
-- Ensure columns exist
ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS html text;
ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS plain text;
ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS envelope jsonb;
ALTER TABLE email_orders_raw ADD COLUMN IF NOT EXISTS extra jsonb;
-- Ensure unique indexes for upsert strategies
CREATE UNIQUE INDEX IF NOT EXISTS email_orders_raw_uq_source_uid ON email_orders_raw(source, uid);
CREATE UNIQUE INDEX IF NOT EXISTS email_orders_raw_uq_message_id ON email_orders_raw(message_id);

-- Email sync items audit columns
ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS confirmation_code text;

-- Cleaning tasks table
CREATE TABLE IF NOT EXISTS cleaning_tasks (
  id text PRIMARY KEY,
  property_id text REFERENCES properties(id) ON DELETE SET NULL,
  date date,
  status text,
  assignee_id text,
  scheduled_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cleaning_date ON cleaning_tasks(date);
CREATE INDEX IF NOT EXISTS idx_cleaning_property ON cleaning_tasks(property_id);

-- Extend cleaning_tasks with additional fields used by calendar UI
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS old_code text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS new_code text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checkout_time text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checkin_time text;

-- Users table for system login
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  username text UNIQUE,
  email text UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_password_hash text;

-- Key sets and items
CREATE TABLE IF NOT EXISTS key_sets (
  id text PRIMARY KEY,
  set_type text,
  status text,
  code text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_key_sets_code ON key_sets(code);
CREATE INDEX IF NOT EXISTS idx_key_sets_type ON key_sets(set_type);
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_key_sets_code_type'
  ) THEN
    ALTER TABLE key_sets ADD CONSTRAINT unique_key_sets_code_type UNIQUE (code, set_type);
  END IF;
END $$;

-- Property Onboarding: 主记录
CREATE TABLE IF NOT EXISTS property_onboarding (
  id text PRIMARY KEY,
  property_id text REFERENCES properties(id) ON DELETE SET NULL,
  address_snapshot text,
  owner_user_id text,
  onboarding_date date,
  status text,
  remark text,
  daily_items_total numeric DEFAULT 0,
  furniture_appliance_total numeric DEFAULT 0,
  decor_total numeric DEFAULT 0,
  oneoff_fees_total numeric DEFAULT 0,
  grand_total numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  created_by text,
  updated_at timestamptz,
  updated_by text
);
CREATE INDEX IF NOT EXISTS idx_onboarding_property ON property_onboarding(property_id);

-- Property Onboarding Items: 日用品/家具/家电/软装
CREATE TABLE IF NOT EXISTS property_onboarding_items (
  id text PRIMARY KEY,
  onboarding_id text REFERENCES property_onboarding(id) ON DELETE CASCADE,
  "group" text, -- daily|furniture|appliance|decor
  category text, -- 卧室|厨房|卫生间|其他（仅 daily 使用）
  item_name text,
  brand text,
  condition text, -- New|Used（家具/家电/软装）
  quantity integer DEFAULT 1,
  unit_price numeric DEFAULT 0,
  total_price numeric DEFAULT 0,
  is_custom boolean DEFAULT false, -- 日用品自定义项
  price_list_id text, -- 引用 daily_items_price_list.id
  remark text,
  created_at timestamptz DEFAULT now(),
  created_by text
);
CREATE INDEX IF NOT EXISTS idx_onboarding_items_onb ON property_onboarding_items(onboarding_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_items_group ON property_onboarding_items("group");
CREATE INDEX IF NOT EXISTS idx_onboarding_items_category ON property_onboarding_items(category);

-- 固定日用品价格表（可维护）
CREATE TABLE IF NOT EXISTS daily_items_price_list (
  id text PRIMARY KEY,
  category text, -- 卧室|厨房|卫生间|其他
  item_name text NOT NULL,
  unit_price numeric NOT NULL,
  currency text DEFAULT 'AUD',
  is_active boolean DEFAULT true,
  updated_at timestamptz,
  updated_by text
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_items_price ON daily_items_price_list(category, item_name);
ALTER TABLE daily_items_price_list ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE daily_items_price_list ADD COLUMN IF NOT EXISTS default_quantity integer;

ALTER TABLE property_onboarding_items ADD COLUMN IF NOT EXISTS unit text;

-- 家具/家电价格表（可维护）
CREATE TABLE IF NOT EXISTS fa_items_price_list (
  id text PRIMARY KEY,
  grp text, -- furniture | appliance
  item_name text NOT NULL,
  unit_price numeric NOT NULL,
  currency text DEFAULT 'AUD',
  unit text,
  default_quantity integer,
  is_active boolean DEFAULT true,
  updated_at timestamptz,
  updated_by text
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fa_items_price ON fa_items_price_list(grp, item_name);

-- 一次性上线费用
CREATE TABLE IF NOT EXISTS property_onboarding_fees (
  id text PRIMARY KEY,
  onboarding_id text REFERENCES property_onboarding(id) ON DELETE CASCADE,
  fee_type text, -- 平台上线费/人工安装费/第一次清洁&床品费/拍照费/其他
  name text,
  unit_price numeric DEFAULT 0,
  quantity integer DEFAULT 1,
  total_price numeric DEFAULT 0,
  include_in_property_cost boolean DEFAULT true,
  remark text,
  created_at timestamptz DEFAULT now(),
  created_by text
);
CREATE INDEX IF NOT EXISTS idx_onboarding_fees_onb ON property_onboarding_fees(onboarding_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_fees_type ON property_onboarding_fees(fee_type);

-- 发票/附件
CREATE TABLE IF NOT EXISTS property_onboarding_attachments (
  id text PRIMARY KEY,
  onboarding_id text REFERENCES property_onboarding(id) ON DELETE CASCADE,
  item_id text REFERENCES property_onboarding_items(id) ON DELETE SET NULL,
  fee_id text REFERENCES property_onboarding_fees(id) ON DELETE SET NULL,
  url text NOT NULL,
  file_name text,
  mime_type text,
  file_size integer,
  created_at timestamptz DEFAULT now(),
  created_by text
);
CREATE INDEX IF NOT EXISTS idx_onboarding_attachments_onb ON property_onboarding_attachments(onboarding_id);


CREATE TABLE IF NOT EXISTS key_items (
  id text PRIMARY KEY,
  key_set_id text REFERENCES key_sets(id) ON DELETE CASCADE,
  item_type text,
  code text,
  photo_url text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_key_items_set ON key_items(key_set_id);
CREATE INDEX IF NOT EXISTS idx_key_items_type ON key_items(item_type);
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_key_items_set_type'
  ) THEN
    ALTER TABLE key_items ADD CONSTRAINT unique_key_items_set_type UNIQUE (key_set_id, item_type);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS key_flows (
  id text PRIMARY KEY,
  key_set_id text REFERENCES key_sets(id) ON DELETE CASCADE,
  action text,
  timestamp timestamptz,
  note text,
  old_code text,
  new_code text
);
CREATE INDEX IF NOT EXISTS idx_key_flows_set ON key_flows(key_set_id);

ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE landlords ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE cleaning_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE key_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE key_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE key_flows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS properties_select ON properties;
CREATE POLICY properties_select ON properties FOR SELECT USING (true);
DROP POLICY IF EXISTS properties_write ON properties;
CREATE POLICY properties_write ON properties FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS properties_update ON properties;
CREATE POLICY properties_update ON properties FOR UPDATE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops'))) WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS properties_delete ON properties;
CREATE POLICY properties_delete ON properties FOR DELETE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));

DROP POLICY IF EXISTS landlords_select ON landlords;
CREATE POLICY landlords_select ON landlords FOR SELECT USING (true);
DROP POLICY IF EXISTS landlords_insert ON landlords;
CREATE POLICY landlords_insert ON landlords FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS landlords_update ON landlords;
CREATE POLICY landlords_update ON landlords FOR UPDATE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops'))) WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS landlords_delete ON landlords;
CREATE POLICY landlords_delete ON landlords FOR DELETE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));

DROP POLICY IF EXISTS orders_select ON orders;
CREATE POLICY orders_select ON orders FOR SELECT USING (true);
DROP POLICY IF EXISTS orders_insert ON orders;
CREATE POLICY orders_insert ON orders FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));
DROP POLICY IF EXISTS orders_update ON orders;
CREATE POLICY orders_update ON orders FOR UPDATE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops'))) WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS orders_delete ON orders;
CREATE POLICY orders_delete ON orders FOR DELETE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));

DROP POLICY IF EXISTS cleaning_select ON cleaning_tasks;
CREATE POLICY cleaning_select ON cleaning_tasks FOR SELECT USING (true);
DROP POLICY IF EXISTS cleaning_insert ON cleaning_tasks;
CREATE POLICY cleaning_insert ON cleaning_tasks FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS cleaning_update ON cleaning_tasks;
CREATE POLICY cleaning_update ON cleaning_tasks FOR UPDATE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops'))) WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS cleaning_delete ON cleaning_tasks;
CREATE POLICY cleaning_delete ON cleaning_tasks FOR DELETE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));

-- Generic calendar events for non-cleaning items (other tasks, inspections, maintenance, etc.)
CREATE TABLE IF NOT EXISTS calendar_events (
  id text PRIMARY KEY,
  date date NOT NULL,
  start_time text,
  end_time text,
  type text, -- e.g., other, inspection, maintenance
  title text,
  property_id text REFERENCES properties(id) ON DELETE SET NULL,
  assignee_id text,
  note text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(date);
CREATE INDEX IF NOT EXISTS idx_calendar_events_property ON calendar_events(property_id);

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendar_events_select ON calendar_events;
CREATE POLICY calendar_events_select ON calendar_events FOR SELECT USING (true);
DROP POLICY IF EXISTS calendar_events_insert ON calendar_events;
CREATE POLICY calendar_events_insert ON calendar_events FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS calendar_events_update ON calendar_events;
CREATE POLICY calendar_events_update ON calendar_events FOR UPDATE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops'))) WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS calendar_events_delete ON calendar_events;
CREATE POLICY calendar_events_delete ON calendar_events FOR DELETE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));

DROP POLICY IF EXISTS users_select_self ON users;
CREATE POLICY users_select_self ON users FOR SELECT USING (id = auth.uid()::text OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));
DROP POLICY IF EXISTS users_update_self ON users;
CREATE POLICY users_update_self ON users FOR UPDATE USING (id = auth.uid()::text OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin')) WITH CHECK (id = auth.uid()::text OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));
DROP POLICY IF EXISTS users_insert_admin ON users;
CREATE POLICY users_insert_admin ON users FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));
DROP POLICY IF EXISTS users_delete_admin ON users;
CREATE POLICY users_delete_admin ON users FOR DELETE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));

DROP POLICY IF EXISTS keysets_select ON key_sets;
CREATE POLICY keysets_select ON key_sets FOR SELECT USING (true);
DROP POLICY IF EXISTS keysets_write ON key_sets;
CREATE POLICY keysets_write ON key_sets FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));
DROP POLICY IF EXISTS keysets_update ON key_sets;
CREATE POLICY keysets_update ON key_sets FOR UPDATE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin')) WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));
DROP POLICY IF EXISTS keysets_delete ON key_sets;
CREATE POLICY keysets_delete ON key_sets FOR DELETE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));

DROP POLICY IF EXISTS keyitems_select ON key_items;
CREATE POLICY keyitems_select ON key_items FOR SELECT USING (true);
DROP POLICY IF EXISTS keyitems_write ON key_items;
CREATE POLICY keyitems_write ON key_items FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));
DROP POLICY IF EXISTS keyitems_update ON key_items;
CREATE POLICY keyitems_update ON key_items FOR UPDATE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin')) WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));
DROP POLICY IF EXISTS keyitems_delete ON key_items;
CREATE POLICY keyitems_delete ON key_items FOR DELETE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));

DROP POLICY IF EXISTS keyflows_select ON key_flows;
CREATE POLICY keyflows_select ON key_flows FOR SELECT USING (true);
DROP POLICY IF EXISTS keyflows_insert ON key_flows;
CREATE POLICY keyflows_insert ON key_flows FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS keyflows_update ON key_flows;
CREATE POLICY keyflows_update ON key_flows FOR UPDATE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin')) WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));
DROP POLICY IF EXISTS keyflows_delete ON key_flows;
CREATE POLICY keyflows_delete ON key_flows FOR DELETE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));

-- Finance transactions
CREATE TABLE IF NOT EXISTS finance_transactions (
  id text PRIMARY KEY,
  kind text,
  amount numeric,
  currency text,
  ref_type text,
  ref_id text,
  occurred_at timestamptz,
  note text,
  category text,
  category_detail text,
  property_id text REFERENCES properties(id) ON DELETE SET NULL,
  invoice_url text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finance_transactions_property ON finance_transactions(property_id);
CREATE INDEX IF NOT EXISTS idx_finance_transactions_occurred ON finance_transactions(occurred_at);

ALTER TABLE finance_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finance_select ON finance_transactions;
CREATE POLICY finance_select ON finance_transactions FOR SELECT USING (true);
DROP POLICY IF EXISTS finance_insert ON finance_transactions;
CREATE POLICY finance_insert ON finance_transactions FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS finance_update ON finance_transactions;
CREATE POLICY finance_update ON finance_transactions FOR UPDATE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops'))) WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS finance_delete ON finance_transactions;
CREATE POLICY finance_delete ON finance_transactions FOR DELETE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));

-- Payouts
CREATE TABLE IF NOT EXISTS payouts (
  id text PRIMARY KEY,
  landlord_id text,
  period_from date,
  period_to date,
  amount numeric,
  invoice_no text,
  status text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payouts_landlord ON payouts(landlord_id);

ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payouts_select ON payouts;
CREATE POLICY payouts_select ON payouts FOR SELECT USING (true);
DROP POLICY IF EXISTS payouts_insert ON payouts;
CREATE POLICY payouts_insert ON payouts FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS payouts_update ON payouts;
CREATE POLICY payouts_update ON payouts FOR UPDATE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops'))) WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops')));
DROP POLICY IF EXISTS payouts_delete ON payouts;
CREATE POLICY payouts_delete ON payouts FOR DELETE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role = 'admin'));

-- Order internal deductions
CREATE TABLE IF NOT EXISTS order_internal_deductions (
  id text PRIMARY KEY,
  order_id text REFERENCES orders(id) ON DELETE CASCADE,
  amount numeric NOT NULL,
  currency text,
  category text,
  note text NOT NULL,
  created_by text,
  created_at timestamptz DEFAULT now(),
  is_active boolean DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_order_deductions_order_active ON order_internal_deductions(order_id, is_active);

ALTER TABLE order_internal_deductions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_deductions_select ON order_internal_deductions;
CREATE POLICY order_deductions_select ON order_internal_deductions FOR SELECT USING (true);
DROP POLICY IF EXISTS order_deductions_insert ON order_internal_deductions;
CREATE POLICY order_deductions_insert ON order_internal_deductions FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops','finance_staff','customer_service')));
DROP POLICY IF EXISTS order_deductions_update ON order_internal_deductions;
CREATE POLICY order_deductions_update ON order_internal_deductions FOR UPDATE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops','finance_staff','customer_service'))) WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops','finance_staff','customer_service')));
DROP POLICY IF EXISTS order_deductions_delete ON order_internal_deductions;
CREATE POLICY order_deductions_delete ON order_internal_deductions FOR DELETE USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid()::text AND u.role IN ('admin','ops','finance_staff','customer_service')));

ALTER TABLE order_internal_deductions ADD COLUMN IF NOT EXISTS item_desc text;
DO $$ BEGIN
  BEGIN
    ALTER TABLE order_internal_deductions ALTER COLUMN note DROP NOT NULL;
  EXCEPTION WHEN others THEN
    NULL;
  END;
END $$;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_received boolean DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_currency text DEFAULT 'AUD';
DO $$ BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_conf_pid_unique ON orders(confirmation_code, property_id) WHERE confirmation_code IS NOT NULL AND property_id IS NOT NULL;
  EXCEPTION WHEN others THEN
    NULL;
  END;
END $$;
CREATE TABLE IF NOT EXISTS order_duplicate_attempts (
  id text PRIMARY KEY,
  payload jsonb,
  reasons text[],
  similar_ids text[],
  actor_id text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS expense_fingerprints (
  key text PRIMARY KEY,
  expire_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS expense_dedup_logs (
  id text PRIMARY KEY,
  resource text NOT NULL,
  resource_id text,
  fingerprint text,
  mode text,
  result text,
  operator_id text,
  reasons text[],
  latency_ms integer,
  created_at timestamptz DEFAULT now()
);
-- Property recurring payments reporting category for revenue mapping
ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS report_category text;
-- Relax status check to include transitional states
DO $$ BEGIN
  BEGIN
    ALTER TABLE email_sync_items DROP CONSTRAINT IF EXISTS email_sync_items_status_check;
  EXCEPTION WHEN undefined_object THEN
    NULL;
  END;
  BEGIN
    ALTER TABLE email_sync_items ADD CONSTRAINT email_sync_items_status_check CHECK (status IN ('scanned','parsed','inserted','skipped','not_matched'));
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END $$;
