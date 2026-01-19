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
  created_at timestamptz DEFAULT now(),
  code text,
  landlord_id text,
  updated_at timestamptz,
  created_by text,
  updated_by text,
  aircon_model text,
  building_facility_floor text,
  building_notes text,
  orientation text,
  fireworks_view boolean,
  archived boolean DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_properties_region ON properties(region);
CREATE INDEX IF NOT EXISTS idx_properties_type ON properties(type);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS biz_category text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS building_facility_other text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS bedroom_ac text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS airbnb_listing_name text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS booking_listing_name text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS airbnb_listing_id text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS booking_listing_id text;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_properties_code'
  ) THEN
    ALTER TABLE properties ADD CONSTRAINT unique_properties_code UNIQUE (code);
  END IF;
END $$;

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
  created_at timestamptz DEFAULT now(),
  property_ids text[],
  archived boolean DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_landlords_name ON landlords(name);

ALTER TABLE landlords ADD COLUMN IF NOT EXISTS emails text[];
CREATE INDEX IF NOT EXISTS idx_landlords_emails_gin ON landlords USING gin (emails);

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
  cleaning_fee numeric,
  net_income numeric,
  avg_nightly_price numeric,
  nights integer,
  currency text,
  status text,
  idempotency_key text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_property ON orders(property_id);
CREATE INDEX IF NOT EXISTS idx_orders_checkout ON orders(checkout);

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

CREATE TABLE IF NOT EXISTS order_import_staging (
  id text PRIMARY KEY,
  channel text,
  raw_row jsonb,
  reason text,
  listing_name text,
  listing_id text,
  property_code text,
  property_id text REFERENCES properties(id) ON DELETE SET NULL,
  status text DEFAULT 'unmatched',
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_order_import_staging_status ON order_import_staging(status);
CREATE INDEX IF NOT EXISTS idx_order_import_staging_created ON order_import_staging(created_at);

CREATE TABLE IF NOT EXISTS cleaning_tasks (
  id text PRIMARY KEY,
  property_id text REFERENCES properties(id) ON DELETE SET NULL,
  date date,
  status text,
  assignee_id text,
  scheduled_at timestamptz,
  old_code text,
  new_code text,
  note text,
  checkout_time text,
  checkin_time text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cleaning_date ON cleaning_tasks(date);
CREATE INDEX IF NOT EXISTS idx_cleaning_property ON cleaning_tasks(property_id);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  username text UNIQUE,
  email text UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL,
  delete_password_hash text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

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

CREATE TABLE IF NOT EXISTS calendar_events (
  id text PRIMARY KEY,
  date date NOT NULL,
  start_time text,
  end_time text,
  type text,
  title text,
  property_id text REFERENCES properties(id) ON DELETE SET NULL,
  assignee_id text,
  note text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(date);
CREATE INDEX IF NOT EXISTS idx_calendar_events_property ON calendar_events(property_id);

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

ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS confirmation_code text;
ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE email_sync_items ADD COLUMN IF NOT EXISTS error_message text;

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

-- Company-level payouts (not tied to a single landlord)
CREATE TABLE IF NOT EXISTS company_payouts (
  id text PRIMARY KEY,
  period_from date,
  period_to date,
  amount numeric,
  invoice_no text,
  note text,
  status text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_company_payouts_period ON company_payouts(period_from, period_to);

-- Split expenses: company_expenses and property_expenses
CREATE TABLE IF NOT EXISTS company_expenses (
  id text PRIMARY KEY,
  occurred_at date NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL,
  category text,
  category_detail text,
  note text,
  invoice_url text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_company_expenses_date ON company_expenses(occurred_at);
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS category_detail text;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS month_key text;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS paid_date date;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS status text;

CREATE TABLE IF NOT EXISTS property_expenses (
  id text PRIMARY KEY,
  property_id text REFERENCES properties(id),
  occurred_at date NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL,
  category text,
  category_detail text,
  note text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_property_expenses_pid ON property_expenses(property_id);
CREATE INDEX IF NOT EXISTS idx_property_expenses_date ON property_expenses(occurred_at);
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS category_detail text;
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS month_key text;
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS paid_date date;
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS status text;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_expenses ON company_expenses(occurred_at, category, amount, (coalesce(note,'')));
CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_expenses ON property_expenses(property_id, occurred_at, category, amount, (coalesce(note,'')));

-- Independent invoices bound strictly to property_expenses.id
CREATE TABLE IF NOT EXISTS expense_invoices (
  id text PRIMARY KEY,
  expense_id text REFERENCES property_expenses(id) ON DELETE CASCADE,
  url text NOT NULL,
  file_name text,
  mime_type text,
  file_size integer,
  created_at timestamptz DEFAULT now(),
  created_by text
);
CREATE INDEX IF NOT EXISTS idx_expense_invoices_expense ON expense_invoices(expense_id);

-- Split incomes: company_incomes and property_incomes
CREATE TABLE IF NOT EXISTS company_incomes (
  id text PRIMARY KEY,
  occurred_at date NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL,
  category text,
  note text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_company_incomes_date ON company_incomes(occurred_at);
CREATE INDEX IF NOT EXISTS idx_company_incomes_cat ON company_incomes(category);

CREATE TABLE IF NOT EXISTS property_incomes (
  id text PRIMARY KEY,
  property_id text REFERENCES properties(id),
  occurred_at date NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL,
  category text,
  note text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_property_incomes_pid ON property_incomes(property_id);
CREATE INDEX IF NOT EXISTS idx_property_incomes_date ON property_incomes(occurred_at);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text;
DO $$ BEGIN BEGIN ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_idempotency_key_key; EXCEPTION WHEN others THEN NULL; END; BEGIN DROP INDEX IF EXISTS idx_orders_idempotency_key_unique; EXCEPTION WHEN others THEN NULL; END; END $$;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_orders_confirmation_code_unique'
  ) THEN
    BEGIN
      DROP INDEX IF EXISTS idx_orders_confirmation_code_unique;
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_orders_source_confirmation_code_unique'
  ) THEN
    BEGIN
      DROP INDEX IF EXISTS idx_orders_source_confirmation_code_unique;
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_src_cc_pid_unique ON orders(source, confirmation_code, property_id) WHERE confirmation_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_conf_pid_unique ON orders(confirmation_code, property_id) WHERE confirmation_code IS NOT NULL AND property_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS recurring_payments (
  id text PRIMARY KEY,
  property_id text REFERENCES properties(id) ON DELETE SET NULL,
  scope text,
  vendor text,
  category text,
  category_detail text,
  amount numeric,
  due_day_of_month integer,
  remind_days_before integer DEFAULT 3,
  status text,
  last_paid_date date,
  next_due_date date,
  pay_account_name text,
  pay_bsb text,
  pay_account_number text,
  pay_ref text,
  expense_id text,
  expense_resource text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_recurring_payments_status ON recurring_payments(status);
CREATE INDEX IF NOT EXISTS idx_recurring_payments_next_due ON recurring_payments(next_due_date);
CREATE INDEX IF NOT EXISTS idx_recurring_payments_scope ON recurring_payments(scope);
ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS category_detail text;
ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS payment_type text;
ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS bpay_code text;
ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS pay_mobile_number text;
ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS report_category text;

CREATE TABLE IF NOT EXISTS fixed_expenses (
  id text PRIMARY KEY,
  property_id text REFERENCES properties(id) ON DELETE SET NULL,
  scope text,
  vendor text,
  category text,
  amount numeric,
  due_day_of_month integer,
  remind_days_before integer,
  status text,
  pay_account_name text,
  pay_bsb text,
  pay_account_number text,
  pay_ref text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_fixed_expenses_scope ON fixed_expenses(scope);
CREATE INDEX IF NOT EXISTS idx_fixed_expenses_status ON fixed_expenses(status);
CREATE INDEX IF NOT EXISTS idx_company_expenses_month_fixed ON company_expenses(month_key, fixed_expense_id);
CREATE INDEX IF NOT EXISTS idx_property_expenses_month_fixed ON property_expenses(month_key, fixed_expense_id);

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
  "group" text,
  category text,
  item_name text,
  brand text,
  condition text,
  quantity integer DEFAULT 1,
  unit_price numeric DEFAULT 0,
  total_price numeric DEFAULT 0,
  is_custom boolean DEFAULT false,
  price_list_id text,
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
  category text,
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
  grp text,
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
  fee_type text,
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

CREATE TABLE IF NOT EXISTS order_cancellations (
  id uuid PRIMARY KEY,
  confirmation_code text UNIQUE,
  message_id text,
  header_date timestamptz,
  subject text,
  sender text,
  source text,
  account text,
  created_at timestamptz DEFAULT now()
);
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
