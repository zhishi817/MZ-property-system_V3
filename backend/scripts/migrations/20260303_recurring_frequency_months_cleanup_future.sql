BEGIN;

DO $$
DECLARE
  cur_month text := to_char(((now() at time zone 'Australia/Melbourne')::date), 'YYYY-MM');
BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS property_expenses_backup_20260303_freq AS SELECT * FROM property_expenses WHERE 1=0;');
  EXECUTE format('CREATE TABLE IF NOT EXISTS company_expenses_backup_20260303_freq AS SELECT * FROM company_expenses WHERE 1=0;');

  EXECUTE format($SQL$
    INSERT INTO property_expenses_backup_20260303_freq
    SELECT pe.*
    FROM property_expenses pe
    JOIN recurring_payments rp ON rp.id = pe.fixed_expense_id
    WHERE pe.month_key >= %L
      AND COALESCE(pe.status,'unpaid') <> 'paid'
      AND (pe.generated_from = 'recurring_payments' OR (coalesce(pe.generated_from,'') = '' AND coalesce(pe.note,'') ILIKE 'Fixed payment%%'))
      AND COALESCE(rp.frequency_months, 1) > 1
      AND rp.start_month_key ~ '^\d{4}-\d{2}$'
      AND pe.month_key ~ '^\d{4}-\d{2}$'
      AND (
        (
          (split_part(pe.month_key,'-',1)::int * 12 + (split_part(pe.month_key,'-',2)::int - 1))
          -
          (split_part(rp.start_month_key,'-',1)::int * 12 + (split_part(rp.start_month_key,'-',2)::int - 1))
        ) %% greatest(1, least(24, COALESCE(rp.frequency_months, 1))) <> 0
      );
  $SQL$, cur_month);

  EXECUTE format($SQL$
    INSERT INTO company_expenses_backup_20260303_freq
    SELECT ce.*
    FROM company_expenses ce
    JOIN recurring_payments rp ON rp.id = ce.fixed_expense_id
    WHERE ce.month_key >= %L
      AND COALESCE(ce.status,'unpaid') <> 'paid'
      AND (ce.generated_from = 'recurring_payments' OR (coalesce(ce.generated_from,'') = '' AND coalesce(ce.note,'') ILIKE 'Fixed payment%%'))
      AND COALESCE(rp.frequency_months, 1) > 1
      AND rp.start_month_key ~ '^\d{4}-\d{2}$'
      AND ce.month_key ~ '^\d{4}-\d{2}$'
      AND (
        (
          (split_part(ce.month_key,'-',1)::int * 12 + (split_part(ce.month_key,'-',2)::int - 1))
          -
          (split_part(rp.start_month_key,'-',1)::int * 12 + (split_part(rp.start_month_key,'-',2)::int - 1))
        ) %% greatest(1, least(24, COALESCE(rp.frequency_months, 1))) <> 0
      );
  $SQL$, cur_month);

  EXECUTE format($SQL$
    DELETE FROM property_expenses pe
    USING recurring_payments rp
    WHERE rp.id = pe.fixed_expense_id
      AND pe.month_key >= %L
      AND COALESCE(pe.status,'unpaid') <> 'paid'
      AND (pe.generated_from = 'recurring_payments' OR (coalesce(pe.generated_from,'') = '' AND coalesce(pe.note,'') ILIKE 'Fixed payment%%'))
      AND COALESCE(rp.frequency_months, 1) > 1
      AND rp.start_month_key ~ '^\d{4}-\d{2}$'
      AND pe.month_key ~ '^\d{4}-\d{2}$'
      AND (
        (
          (split_part(pe.month_key,'-',1)::int * 12 + (split_part(pe.month_key,'-',2)::int - 1))
          -
          (split_part(rp.start_month_key,'-',1)::int * 12 + (split_part(rp.start_month_key,'-',2)::int - 1))
        ) %% greatest(1, least(24, COALESCE(rp.frequency_months, 1))) <> 0
      );
  $SQL$, cur_month);

  EXECUTE format($SQL$
    DELETE FROM company_expenses ce
    USING recurring_payments rp
    WHERE rp.id = ce.fixed_expense_id
      AND ce.month_key >= %L
      AND COALESCE(ce.status,'unpaid') <> 'paid'
      AND (ce.generated_from = 'recurring_payments' OR (coalesce(ce.generated_from,'') = '' AND coalesce(ce.note,'') ILIKE 'Fixed payment%%'))
      AND COALESCE(rp.frequency_months, 1) > 1
      AND rp.start_month_key ~ '^\d{4}-\d{2}$'
      AND ce.month_key ~ '^\d{4}-\d{2}$'
      AND (
        (
          (split_part(ce.month_key,'-',1)::int * 12 + (split_part(ce.month_key,'-',2)::int - 1))
          -
          (split_part(rp.start_month_key,'-',1)::int * 12 + (split_part(rp.start_month_key,'-',2)::int - 1))
        ) %% greatest(1, least(24, COALESCE(rp.frequency_months, 1))) <> 0
      );
  $SQL$, cur_month);
END $$;

COMMIT;

