-- Fill report_category for existing recurring_payments rows
-- This script is idempotent and safe to run multiple times
ALTER TABLE IF NOT EXISTS recurring_payments ADD COLUMN IF NOT EXISTS report_category text;

UPDATE recurring_payments SET report_category = 'parking_fee'
WHERE report_category IS NULL AND (
  lower(coalesce(category,'')) LIKE '%carpark%' OR
  lower(coalesce(vendor,'')) LIKE '%carpark%' OR
  vendor LIKE '%车位%'
);

UPDATE recurring_payments SET report_category = 'body_corp'
WHERE report_category IS NULL AND (
  lower(coalesce(category,'')) LIKE '%body%' OR
  lower(coalesce(category,'')) LIKE '%owners%' OR
  lower(coalesce(vendor,'')) LIKE '%body%' OR
  lower(coalesce(vendor,'')) LIKE '%owners%' OR
  vendor LIKE '%物业%'
);

UPDATE recurring_payments SET report_category = 'internet'
WHERE report_category IS NULL AND (
  lower(coalesce(category,'')) LIKE '%internet%' OR
  lower(coalesce(category,'')) LIKE '%nbn%' OR
  lower(coalesce(vendor,'')) LIKE '%internet%' OR
  lower(coalesce(vendor,'')) LIKE '%nbn%' OR
  vendor LIKE '%网%'
);

UPDATE recurring_payments SET report_category = 'water'
WHERE report_category IS NULL AND (
  lower(coalesce(category,'')) LIKE '%water%' AND lower(coalesce(category,'')) NOT LIKE '%hot%'
);

UPDATE recurring_payments SET report_category = 'electricity'
WHERE report_category IS NULL AND (
  lower(coalesce(category,'')) LIKE '%electric%'
);

UPDATE recurring_payments SET report_category = 'gas'
WHERE report_category IS NULL AND (
  lower(coalesce(category,'')) LIKE '%gas%' OR lower(coalesce(category,'')) LIKE '%hot%'
);

UPDATE recurring_payments SET report_category = 'consumables'
WHERE report_category IS NULL AND (
  lower(coalesce(category,'')) LIKE '%consumable%'
);

UPDATE recurring_payments SET report_category = 'council'
WHERE report_category IS NULL AND (
  lower(coalesce(category,'')) LIKE '%council%'
);

UPDATE recurring_payments SET report_category = 'other'
WHERE report_category IS NULL;

-- Optional: enforce NOT NULL after filling
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name='recurring_payments' AND column_name='report_category'
  ) THEN
    BEGIN
      ALTER TABLE recurring_payments ALTER COLUMN report_category SET NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
END $$;