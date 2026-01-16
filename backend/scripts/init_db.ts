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
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS airbnb_listing_name text;`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS booking_listing_name text;`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS airbnb_listing_id text;`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS booking_listing_id text;`,

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
      idempotency_key text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_orders_property ON orders(property_id);`,
    `CREATE INDEX IF NOT EXISTS idx_orders_checkout ON orders(checkout);`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text;`,
    `DO $$ BEGIN BEGIN ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_idempotency_key_key; EXCEPTION WHEN others THEN NULL; END; BEGIN DROP INDEX IF EXISTS idx_orders_idempotency_key_unique; EXCEPTION WHEN others THEN NULL; END; END $$;`,
    `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_orders_confirmation_code_unique') THEN
        BEGIN DROP INDEX IF EXISTS idx_orders_confirmation_code_unique; EXCEPTION WHEN others THEN NULL; END;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_orders_source_confirmation_code_unique') THEN
        BEGIN DROP INDEX IF EXISTS idx_orders_source_confirmation_code_unique; EXCEPTION WHEN others THEN NULL; END;
      END IF;
    END $$;`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_src_cc_pid_unique ON orders(source, confirmation_code, property_id) WHERE confirmation_code IS NOT NULL;`,
    `CREATE TABLE IF NOT EXISTS order_import_staging (
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
    );`,
    `CREATE INDEX IF NOT EXISTS idx_order_import_staging_status ON order_import_staging(status);`,
    `CREATE INDEX IF NOT EXISTS idx_order_import_staging_created ON order_import_staging(created_at);`,

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
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS started_at timestamptz;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS finished_at timestamptz;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS key_photo_uploaded_at timestamptz;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS lockbox_video_uploaded_at timestamptz;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS geo_lat numeric;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS geo_lng numeric;`,
    `CREATE TABLE IF NOT EXISTS cleaning_task_media (id text PRIMARY KEY, task_id text REFERENCES cleaning_tasks(id) ON DELETE CASCADE, type text, url text NOT NULL, captured_at timestamptz, lat numeric, lng numeric, uploader_id text, size integer, mime text, created_at timestamptz DEFAULT now());`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task ON cleaning_task_media(task_id);`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_type ON cleaning_task_media(type);`,
    `CREATE TABLE IF NOT EXISTS cleaning_consumable_usages (id text PRIMARY KEY, task_id text REFERENCES cleaning_tasks(id) ON DELETE CASCADE, item_id text, qty integer, need_restock boolean DEFAULT false, note text, created_at timestamptz DEFAULT now());`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_consumables_task ON cleaning_consumable_usages(task_id);`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (user_id text, endpoint text PRIMARY KEY, p256dh text, auth text, ua text, created_at timestamptz DEFAULT now());`,
    `CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);`,
    `CREATE TABLE IF NOT EXISTS cleaning_issues (id text PRIMARY KEY, task_id text REFERENCES cleaning_tasks(id) ON DELETE CASCADE, title text, detail text, severity text, created_at timestamptz DEFAULT now());`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_issues_task ON cleaning_issues(task_id);`,
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
    `ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;`
    ,
    `ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS month_key text;`
    ,
    `ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS due_date date;`
    ,
    `ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS paid_date date;`
    ,
    `ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS status text;`
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
    `ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;`
    ,
    `ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS month_key text;`
    ,
    `ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS due_date date;`
    ,
    `ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS paid_date date;`
    ,
    `ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS status text;`
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
    ,
    `CREATE TABLE IF NOT EXISTS role_permissions (
      id text PRIMARY KEY,
      role_id text NOT NULL,
      permission_code text NOT NULL,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_perm ON role_permissions(role_id, permission_code);`,
    `CREATE INDEX IF NOT EXISTS idx_role_perm_role ON role_permissions(role_id);`
    ,
    `CREATE TABLE IF NOT EXISTS sessions (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz DEFAULT now(),
      last_seen_at timestamptz DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked boolean NOT NULL DEFAULT false,
      ip text,
      user_agent text,
      device text
    );`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(user_id) WHERE revoked = false;`
    ,
    `ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS category_detail text;`
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
