\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database() <> 'mz124_bills_pilot' THEN RAISE EXCEPTION 'wrong fixture database'; END IF; END $$;
BEGIN;
CREATE TABLE properties(id text primary key, code text, address text, region text, archived boolean default false);
CREATE TABLE property_bill_configurations(property_id text references properties(id),category text,status text,updated_by text,updated_at timestamptz default now(),account_number text,vendor text,cycle_months int,due_date date, primary key(property_id,category));
CREATE TABLE recurring_payments(id text primary key,status text,property_id text references properties(id),category text,category_detail text,other_bill_name text,vendor text,amount numeric,bill_account_no text,frequency_months int,due_day_of_month int,bill_expected_day_of_month int,payment_type text,pay_account_name text,pay_bsb text,pay_account_number text,pay_ref text,bpay_code text,pay_mobile_number text,bill_period_start_day_of_month int,bill_period_start_month_offset int,bill_period_end_day_of_month int,bill_period_end_month_offset int,remind_days_before int,start_month_key text,note text,template_kind text default 'property_payable',scope text default 'property',cashflow_type text default 'expense',updated_by text,updated_at timestamptz);
CREATE TABLE property_expenses(id text primary key, fixed_expense_id text references recurring_payments(id), property_id text references properties(id),category text,generated_from text, deleted_at timestamptz,amount_confirmed boolean,bill_received_date date,paid_date date,due_date date,status text,amount numeric);
CREATE TABLE roles(id text primary key,name text unique);
CREATE TABLE role_permissions(role_id text references roles(id),permission_code text,primary key(role_id,permission_code));
INSERT INTO roles VALUES ('pilot-editor','pilot-editor'),('pilot-viewer','pilot-viewer');
INSERT INTO role_permissions VALUES
 ('pilot-editor','menu.finance'),('pilot-viewer','menu.finance'),
 ('pilot-editor','menu.finance.property_payables.visible'),('pilot-viewer','menu.finance.property_payables.visible'),
 ('pilot-editor','recurring_payments.view'),('pilot-viewer','recurring_payments.view'),
 ('pilot-editor','recurring_payments.write');
INSERT INTO properties VALUES ('pilot-property','QA-124-01','合成测试房源','Docklands',false),('pilot-second','QA-124-02','合成对照房源','Docklands',false);
INSERT INTO property_bill_configurations(property_id,category,status,updated_by) VALUES ('pilot-property','water','company','pilot-editor');
INSERT INTO recurring_payments (id,status,property_id,category,vendor,amount,bill_account_no,frequency_months,due_day_of_month,bill_expected_day_of_month,payment_type,start_month_key)
VALUES ('pilot-target','active','pilot-property','water','样板水费 A',125.40,'QA-ACCT-124',3,30,15,'bpay','2026-01'),('pilot-sibling','active','pilot-property','water','样板水费 B',70,'QA-ACCT-125',3,30,15,'bank_account','2026-01');
INSERT INTO property_expenses VALUES ('pilot-history','pilot-target','pilot-property','water','recurring_payments',NULL,true,'2026-06-15','2026-06-28','2026-06-30','paid',125.40);
COMMIT;
