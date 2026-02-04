ALTER TABLE property_expenses
ADD COLUMN IF NOT EXISTS due_date date;

UPDATE property_expenses
SET due_date = occurred_at
WHERE due_date IS NULL
  AND occurred_at IS NOT NULL;

