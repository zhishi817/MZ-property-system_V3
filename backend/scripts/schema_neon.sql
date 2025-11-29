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