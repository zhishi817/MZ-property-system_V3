-- Unique constraint for property expenses on (property_id, month_key, category, amount)
DO $$ BEGIN
  BEGIN
    ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS month_key text;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_expenses_month ON property_expenses(property_id, month_key, category, amount);
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

