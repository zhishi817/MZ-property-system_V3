DO $$ BEGIN
  BEGIN
    ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;
    ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS month_key text;
    ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS due_date date;
    ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS paid_date date;
    ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS status text;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY fixed_expense_id, month_key
          ORDER BY
            CASE WHEN status = 'paid' THEN 1 ELSE 0 END DESC,
            paid_date DESC NULLS LAST,
            due_date DESC NULLS LAST,
            occurred_at DESC NULLS LAST,
            id DESC
        ) AS rn
      FROM property_expenses
      WHERE fixed_expense_id IS NOT NULL
        AND fixed_expense_id <> ''
        AND month_key IS NOT NULL
        AND month_key <> ''
    )
    DELETE FROM property_expenses p
    USING ranked r
    WHERE p.id = r.id AND r.rn > 1;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_expenses_fixed_expense_month_key
      ON property_expenses(fixed_expense_id, month_key)
      WHERE fixed_expense_id IS NOT NULL
        AND fixed_expense_id <> ''
        AND month_key IS NOT NULL
        AND month_key <> '';
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;
    ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS month_key text;
    ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS due_date date;
    ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS paid_date date;
    ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS status text;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY fixed_expense_id, month_key
          ORDER BY
            CASE WHEN status = 'paid' THEN 1 ELSE 0 END DESC,
            paid_date DESC NULLS LAST,
            due_date DESC NULLS LAST,
            occurred_at DESC NULLS LAST,
            id DESC
        ) AS rn
      FROM company_expenses
      WHERE fixed_expense_id IS NOT NULL
        AND fixed_expense_id <> ''
        AND month_key IS NOT NULL
        AND month_key <> ''
    )
    DELETE FROM company_expenses c
    USING ranked r
    WHERE c.id = r.id AND r.rn > 1;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_expenses_fixed_expense_month_key
      ON company_expenses(fixed_expense_id, month_key)
      WHERE fixed_expense_id IS NOT NULL
        AND fixed_expense_id <> ''
        AND month_key IS NOT NULL
        AND month_key <> '';
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

