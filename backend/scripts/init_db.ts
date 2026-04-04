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
    `ALTER TABLE landlords ADD COLUMN IF NOT EXISTS emails text[];`,
    `CREATE TABLE IF NOT EXISTS landlord_management_fee_rules (
      id text PRIMARY KEY,
      landlord_id text NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
      effective_from_month text NOT NULL,
      management_fee_rate numeric NOT NULL,
      note text,
      created_at timestamptz DEFAULT now(),
      created_by text
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_landlord_management_fee_rules_landlord_month ON landlord_management_fee_rules(landlord_id, effective_from_month);`,
    `CREATE INDEX IF NOT EXISTS idx_landlord_management_fee_rules_lookup ON landlord_management_fee_rules(landlord_id, effective_from_month DESC);`,

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
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS note text;`,
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
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS order_id text;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS type text DEFAULT 'checkout_cleaning';`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS auto_managed boolean DEFAULT true;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS locked boolean DEFAULT false;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS reschedule_required boolean DEFAULT false;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS task_type text;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS task_date date;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS auto_sync_enabled boolean DEFAULT true;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS sync_fingerprint text;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS source text DEFAULT 'auto';`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS note text;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checkout_time text;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checkin_time text;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS cleaner_id text;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspector_id text;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS nights_override int;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS old_code text;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS new_code text;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_cleaning_tasks_order_type') THEN
        CREATE UNIQUE INDEX uniq_cleaning_tasks_order_type ON cleaning_tasks(order_id, type) WHERE order_id IS NOT NULL;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_cleaning_tasks_order_task_type_v3') THEN
        BEGIN
          ALTER TABLE cleaning_tasks ADD CONSTRAINT uniq_cleaning_tasks_order_task_type_v3 UNIQUE (order_id, task_type);
        EXCEPTION WHEN others THEN NULL;
        END;
      END IF;
    END $$;`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_property_date ON cleaning_tasks(property_id, date);`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_status ON cleaning_tasks(status);`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_task_date ON cleaning_tasks(task_date);`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_order_id ON cleaning_tasks(order_id);`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS started_at timestamptz;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS finished_at timestamptz;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS key_photo_uploaded_at timestamptz;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS lockbox_video_uploaded_at timestamptz;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS geo_lat numeric;`,
    `ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS geo_lng numeric;`,
    `CREATE TABLE IF NOT EXISTS cleaning_sync_logs (id text PRIMARY KEY, job_id text, order_id text, task_id text, action text, before jsonb, after jsonb, meta jsonb, created_at timestamptz DEFAULT now());`,
    `ALTER TABLE cleaning_sync_logs ADD COLUMN IF NOT EXISTS job_id text;`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_sync_logs_order ON cleaning_sync_logs(order_id);`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_sync_logs_created_at ON cleaning_sync_logs(created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_sync_logs_action ON cleaning_sync_logs(action);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_cleaning_sync_logs_job_action_task ON cleaning_sync_logs(job_id, action, task_id) WHERE job_id IS NOT NULL;`,
    `CREATE TABLE IF NOT EXISTS cleaning_offline_tasks (id text PRIMARY KEY, date date NOT NULL, task_type text NOT NULL DEFAULT 'other', title text NOT NULL, content text NOT NULL DEFAULT '', kind text NOT NULL, status text NOT NULL, urgency text NOT NULL, property_id text, assignee_id text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_offline_tasks_date ON cleaning_offline_tasks(date);`,
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
      color_hex text NOT NULL DEFAULT '#3B82F6',
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);`,
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`
    ,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_password_hash text;`
    ,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS color_hex text NOT NULL DEFAULT '#3B82F6';`
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
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_fin_tx_cancel_fee_per_order ON finance_transactions(ref_type, ref_id, category) WHERE category = 'cancel_fee';`
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
    `ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS property_id text REFERENCES properties(id) ON DELETE SET NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_company_incomes_property ON company_incomes(property_id);`
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
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id text PRIMARY KEY,
      entity text NOT NULL,
      entity_id text NOT NULL,
      action text NOT NULL,
      actor_id text,
      ip text,
      user_agent text,
      before_json jsonb,
      after_json jsonb,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);`
    ,
    `CREATE TABLE IF NOT EXISTS invoice_companies (
      id text PRIMARY KEY,
      code text,
      legal_name text NOT NULL,
      trading_name text,
      abn text NOT NULL,
      address_line1 text,
      address_line2 text,
      address_city text,
      address_state text,
      address_postcode text,
      address_country text,
      phone text,
      email text,
      logo_url text,
      bank_account_name text,
      bank_bsb text,
      bank_account_no text,
      payment_note text,
      is_default boolean DEFAULT false,
      status text DEFAULT 'active',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_companies_abn ON invoice_companies(abn);`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_companies_status ON invoice_companies(status);`
    ,
    `CREATE TABLE IF NOT EXISTS invoices (
      id text PRIMARY KEY,
      company_id text REFERENCES invoice_companies(id) ON DELETE RESTRICT,
      invoice_no text,
      biz_unique_key text,
      issue_date date,
      due_date date,
      currency text DEFAULT 'AUD',
      status text DEFAULT 'draft',
      bill_to_name text,
      bill_to_email text,
      bill_to_address text,
      subtotal numeric,
      tax_total numeric,
      total numeric,
      amount_paid numeric DEFAULT 0,
      amount_due numeric,
      primary_source_type text,
      primary_source_id text,
      notes text,
      terms text,
      issued_at timestamptz,
      sent_at timestamptz,
      paid_at timestamptz,
      voided_at timestamptz,
      refunded_at timestamptz,
      void_reason text,
      refund_reason text,
      created_by text,
      updated_by text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz
    );`,
    `CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);`,
    `CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);`,
    `CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices(issue_date);`,
    `CREATE INDEX IF NOT EXISTS idx_invoices_invoice_no ON invoices(invoice_no);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_company_invoice_no ON invoices(company_id, invoice_no) WHERE invoice_no IS NOT NULL;`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_biz_unique_key ON invoices(biz_unique_key) WHERE biz_unique_key IS NOT NULL AND COALESCE(status, '') <> 'void';`
    ,
    `CREATE TABLE IF NOT EXISTS invoice_sources (
      invoice_id text REFERENCES invoices(id) ON DELETE CASCADE,
      source_type text NOT NULL,
      source_id text NOT NULL,
      label text,
      created_at timestamptz DEFAULT now(),
      PRIMARY KEY (invoice_id, source_type, source_id)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_sources_type_id ON invoice_sources(source_type, source_id);`
    ,
    `CREATE TABLE IF NOT EXISTS invoice_line_items (
      id text PRIMARY KEY,
      invoice_id text REFERENCES invoices(id) ON DELETE CASCADE,
      description text NOT NULL,
      quantity numeric NOT NULL,
      unit_price numeric NOT NULL,
      gst_type text NOT NULL,
      tax_amount numeric NOT NULL,
      line_subtotal numeric NOT NULL,
      line_total numeric NOT NULL,
      sort_order integer DEFAULT 0
    );`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice ON invoice_line_items(invoice_id);`
    ,
    `CREATE TABLE IF NOT EXISTS invoice_files (
      id text PRIMARY KEY,
      invoice_id text REFERENCES invoices(id) ON DELETE CASCADE,
      kind text DEFAULT 'pdf',
      url text NOT NULL,
      file_name text,
      mime_type text,
      file_size integer,
      sha256 text,
      created_by text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_files_invoice ON invoice_files(invoice_id);`
    ,
    `CREATE TABLE IF NOT EXISTS invoice_send_logs (
      id text PRIMARY KEY,
      invoice_id text REFERENCES invoices(id) ON DELETE CASCADE,
      channel text DEFAULT 'manual',
      to_email text,
      cc_email text,
      subject text,
      body text,
      status text DEFAULT 'sent',
      error text,
      created_by text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_send_logs_invoice ON invoice_send_logs(invoice_id, created_at);`
    ,
    `CREATE TABLE IF NOT EXISTS number_sequences (
      id text PRIMARY KEY,
      company_id text REFERENCES invoice_companies(id) ON DELETE CASCADE,
      year integer NOT NULL,
      next_value integer NOT NULL,
      padding integer DEFAULT 6,
      format text DEFAULT '{prefix}-{year}-{seq}',
      updated_at timestamptz,
      UNIQUE(company_id, year)
    );`
    ,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS count_in_income boolean;`
    ,
    `CREATE TABLE IF NOT EXISTS cms_pages (
      id text PRIMARY KEY,
      slug text UNIQUE,
      title text,
      content text,
      status text,
      published_at date,
      page_type text NOT NULL DEFAULT 'generic',
      category text,
      pinned boolean NOT NULL DEFAULT false,
      urgent boolean NOT NULL DEFAULT false,
      audience_scope text,
      expires_at date,
      updated_at timestamptz DEFAULT now(),
      updated_by text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_cms_pages_status ON cms_pages(status);`,
    `CREATE INDEX IF NOT EXISTS idx_cms_pages_type ON cms_pages(page_type);`,
    `CREATE INDEX IF NOT EXISTS idx_cms_pages_pinned ON cms_pages(pinned, published_at);`,
    `CREATE INDEX IF NOT EXISTS idx_cms_pages_expires ON cms_pages(expires_at);`
    ,
    `CREATE TABLE IF NOT EXISTS company_secret_items (
      id text PRIMARY KEY,
      title text NOT NULL,
      username text,
      secret_enc text NOT NULL,
      note text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      updated_by text
    );`,
    `CREATE INDEX IF NOT EXISTS idx_company_secret_items_updated ON company_secret_items(updated_at DESC);`,
    `CREATE TABLE IF NOT EXISTS company_secret_access_logs (
      id text PRIMARY KEY,
      secret_item_id text NOT NULL REFERENCES company_secret_items(id) ON DELETE CASCADE,
      user_id text,
      action text NOT NULL,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_company_secret_logs_item ON company_secret_access_logs(secret_item_id, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_company_secret_logs_user ON company_secret_access_logs(user_id, created_at DESC);`
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
    `ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls text[];`
    ,
    `ALTER TABLE property_maintenance ALTER COLUMN details TYPE text USING details::text;`
    ,
    `DO $$ 
    DECLARE dt text; udt text;
    BEGIN
      BEGIN
        SELECT data_type, udt_name INTO dt, udt
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'property_maintenance'
          AND column_name = 'photo_urls'
        LIMIT 1;
        IF NOT (dt = 'ARRAY' AND udt = '_text') THEN
          ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls_text text[];
          UPDATE property_maintenance SET photo_urls_text = ARRAY[]::text[] WHERE photo_urls_text IS NULL;
          UPDATE property_maintenance
          SET photo_urls_text = ARRAY(SELECT jsonb_array_elements_text(to_jsonb(photo_urls)))
          WHERE jsonb_typeof(to_jsonb(photo_urls)) = 'array';
          UPDATE property_maintenance
          SET photo_urls_text = ARRAY[trim(both '"' from to_jsonb(photo_urls)::text)]
          WHERE jsonb_typeof(to_jsonb(photo_urls)) = 'string';
          ALTER TABLE property_maintenance DROP COLUMN IF EXISTS photo_urls;
          ALTER TABLE property_maintenance RENAME COLUMN photo_urls_text TO photo_urls;
          ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls text[];
        END IF;
      EXCEPTION WHEN others THEN NULL;
      END;
    END $$;`
    ,
    `ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS property_code text;`
    ,
    `CREATE TABLE IF NOT EXISTS roles (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text,
      created_at timestamptz DEFAULT now()
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_roles_name ON roles(name);`
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
    `ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS category_detail text;`,
    `CREATE TABLE IF NOT EXISTS cleaning_sync_retry_jobs (
      id text PRIMARY KEY,
      order_id text NOT NULL,
      action text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempts int NOT NULL DEFAULT 0,
      max_attempts int NOT NULL DEFAULT 8,
      next_retry_at timestamptz NOT NULL DEFAULT now(),
      last_error_code text,
      last_error_message text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_sync_retry_jobs_status_next ON cleaning_sync_retry_jobs(status, next_retry_at);`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_sync_retry_jobs_order ON cleaning_sync_retry_jobs(order_id);`,
    `CREATE TABLE IF NOT EXISTS cleaning_sync_jobs (
      id text PRIMARY KEY,
      order_id text NOT NULL,
      action text NOT NULL,
      fingerprint text,
      payload_snapshot jsonb,
      status text NOT NULL DEFAULT 'pending',
      attempts int NOT NULL DEFAULT 0,
      max_attempts int NOT NULL DEFAULT 10,
      next_retry_at timestamptz NOT NULL DEFAULT now(),
      running_started_at timestamptz,
      last_error_code text,
      last_error_message text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_sync_jobs_status_next ON cleaning_sync_jobs(status, next_retry_at);`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_sync_jobs_order ON cleaning_sync_jobs(order_id);`,
    `CREATE INDEX IF NOT EXISTS idx_cleaning_sync_jobs_running ON cleaning_sync_jobs(running_started_at);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_cleaning_sync_jobs_order_action_active ON cleaning_sync_jobs(order_id, action) WHERE status IN ('pending','running');`
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
