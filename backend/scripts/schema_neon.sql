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
  idempotency_key text UNIQUE,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_property ON orders(property_id);
CREATE INDEX IF NOT EXISTS idx_orders_checkout ON orders(checkout);

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
  invoice_url text,
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
-- Orders confirmation_code column and unique index (non-null only)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_confirmation_code_unique ON orders(confirmation_code) WHERE confirmation_code IS NOT NULL;

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