BEGIN;

ALTER TABLE recurring_payments
  ADD COLUMN IF NOT EXISTS property_ids text[];

UPDATE recurring_payments
SET property_ids = ARRAY[property_id]
WHERE (property_ids IS NULL OR array_length(property_ids, 1) IS NULL)
  AND property_id IS NOT NULL
  AND length(trim(property_id)) > 0;

COMMIT;
