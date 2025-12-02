import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import { pgPool } from '../src/dbAdapter'

async function run() {
  if (!pgPool) {
    console.error('DATABASE_URL not set. Please configure backend/.env')
    process.exit(1)
  }

  const stmts: string[] = [
    `CREATE TABLE IF NOT EXISTS properties (
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
    );`,
    `CREATE INDEX IF NOT EXISTS idx_properties_region ON properties(region);`,
    `CREATE INDEX IF NOT EXISTS idx_properties_type ON properties(type);`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS code text;`,
    `CREATE UNIQUE INDEX IF NOT EXISTS unique_properties_code ON properties(code);`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS landlord_id text;`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS updated_at timestamptz;`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS created_by text;`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS updated_by text;`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS aircon_model text;`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS building_facility_floor text;`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS building_notes text;`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS orientation text;`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS fireworks_view boolean;`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false;`,

    `CREATE TABLE IF NOT EXISTS landlords (
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
    );`,
    `CREATE INDEX IF NOT EXISTS idx_landlords_name ON landlords(name);`,
    `ALTER TABLE landlords ADD COLUMN IF NOT EXISTS property_ids text[];`,
    `ALTER TABLE landlords ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false;`,

    `CREATE TABLE IF NOT EXISTS orders (
      id text PRIMARY KEY,
      source text,
      external_id text,
      property_id text REFERENCES properties(id) ON DELETE SET NULL,
      guest_name text,
      checkin date,
      checkout date,
      price numeric,
      currency text,
      status text,
      idempotency_key text UNIQUE,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_orders_property ON orders(property_id);`,
    `CREATE INDEX IF NOT EXISTS idx_orders_checkout ON orders(checkout);`,

    `CREATE TABLE IF NOT EXISTS cleaning_tasks (
      id text PRIMARY KEY,
      property_id text REFERENCES properties(id) ON DELETE SET NULL,
      date date,
      status text,
      assignee_id text,
      scheduled_at timestamptz,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_date ON cleaning_tasks(date);`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_property ON cleaning_tasks(property_id);`
    ,
    `CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      username text UNIQUE,
      email text UNIQUE,
      password_hash text NOT NULL,
      role text NOT NULL,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);`,
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`
    ,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_password_hash text;`
    ,
    `CREATE TABLE IF NOT EXISTS key_sets (
      id text PRIMARY KEY,
      set_type text,
      status text,
      code text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_key_sets_code ON key_sets(code);`,
    `CREATE INDEX IF NOT EXISTS idx_key_sets_type ON key_sets(set_type);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS unique_key_sets_code_type ON key_sets(code, set_type);`,
    `CREATE TABLE IF NOT EXISTS key_items (
      id text PRIMARY KEY,
      key_set_id text REFERENCES key_sets(id) ON DELETE CASCADE,
      item_type text,
      code text,
      photo_url text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_key_items_set ON key_items(key_set_id);`,
    `CREATE INDEX IF NOT EXISTS idx_key_items_type ON key_items(item_type);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS unique_key_items_set_type ON key_items(key_set_id, item_type);`,
    `CREATE TABLE IF NOT EXISTS key_flows (
      id text PRIMARY KEY,
      key_set_id text REFERENCES key_sets(id) ON DELETE CASCADE,
      action text,
      timestamp timestamptz,
      note text,
      old_code text,
      new_code text
    );`,
    `CREATE INDEX IF NOT EXISTS idx_key_flows_set ON key_flows(key_set_id);`
    ,
    `CREATE TABLE IF NOT EXISTS finance_transactions (
      id text PRIMARY KEY,
      kind text NOT NULL,
      amount numeric NOT NULL,
      currency text NOT NULL,
      ref_type text,
      ref_id text,
      occurred_at date NOT NULL,
      note text,
      category text,
      property_id text REFERENCES properties(id) ON DELETE SET NULL,
      invoice_url text,
      category_detail text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_finance_transactions_date ON finance_transactions(occurred_at);`,
    `CREATE INDEX IF NOT EXISTS idx_finance_transactions_kind ON finance_transactions(kind);`,
    `CREATE INDEX IF NOT EXISTS idx_finance_transactions_property ON finance_transactions(property_id);`
    ,
    `CREATE TABLE IF NOT EXISTS company_expenses (
      id text PRIMARY KEY,
      occurred_at date NOT NULL,
      amount numeric NOT NULL,
      currency text NOT NULL,
      category text,
      category_detail text,
      note text,
      invoice_url text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_company_expenses_date ON company_expenses(occurred_at);`
    ,
    `ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS created_by text;`
    ,
    `CREATE TABLE IF NOT EXISTS property_expenses (
      id text PRIMARY KEY,
      property_id text REFERENCES properties(id) ON DELETE SET NULL,
      occurred_at date NOT NULL,
      amount numeric NOT NULL,
      currency text NOT NULL,
      category text,
      category_detail text,
      note text,
      invoice_url text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_property_expenses_pid ON property_expenses(property_id);`,
    `CREATE INDEX IF NOT EXISTS idx_property_expenses_date ON property_expenses(occurred_at);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_expenses ON company_expenses(occurred_at, category, amount, (coalesce(note,'')));`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_expenses ON property_expenses(property_id, occurred_at, category, amount, (coalesce(note,'')));`
    ,
    `ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS created_by text;`
    ,
    `CREATE TABLE IF NOT EXISTS company_incomes (
      id text PRIMARY KEY,
      occurred_at date NOT NULL,
      amount numeric NOT NULL,
      currency text NOT NULL,
      category text,
      note text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_company_incomes_date ON company_incomes(occurred_at);`,
    `CREATE INDEX IF NOT EXISTS idx_company_incomes_cat ON company_incomes(category);`
    ,
    `CREATE TABLE IF NOT EXISTS property_incomes (
      id text PRIMARY KEY,
      property_id text REFERENCES properties(id) ON DELETE SET NULL,
      occurred_at date NOT NULL,
      amount numeric NOT NULL,
      currency text NOT NULL,
      category text,
      note text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_property_incomes_pid ON property_incomes(property_id);`,
    `CREATE INDEX IF NOT EXISTS idx_property_incomes_date ON property_incomes(occurred_at);`
    ,
    `CREATE TABLE IF NOT EXISTS cms_pages (
      id text PRIMARY KEY,
      slug text UNIQUE,
      title text,
      content text,
      status text,
      published_at date,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_cms_pages_status ON cms_pages(status);`
    ,
    `CREATE TABLE IF NOT EXISTS property_maintenance (
      id text PRIMARY KEY,
      property_id text REFERENCES properties(id) ON DELETE SET NULL,
      occurred_at date NOT NULL,
      worker_name text,
      details jsonb,
      notes text,
      created_by text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_property_maintenance_pid ON property_maintenance(property_id);`,
    `CREATE INDEX IF NOT EXISTS idx_property_maintenance_date ON property_maintenance(occurred_at);`,
    `ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls jsonb;`
    ,
    `ALTER TABLE property_maintenance ALTER COLUMN details TYPE text USING details::text;`
    ,
    `DO $$ BEGIN BEGIN ALTER TABLE property_maintenance ALTER COLUMN photo_urls TYPE jsonb USING to_jsonb(photo_urls); EXCEPTION WHEN others THEN NULL; END; END $$;`
    ,
    `ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS property_code text;`
  ]

  for (const sql of stmts) {
    await pgPool.query(sql)
  }

  console.log('Database initialized')
  await pgPool.end()
}

run().catch(async (e) => {
  console.error(e)
  if (pgPool) await pgPool.end()
  process.exit(1)
})
