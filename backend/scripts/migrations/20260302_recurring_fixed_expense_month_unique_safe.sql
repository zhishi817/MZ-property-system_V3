BEGIN;

ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS month_key text;
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS paid_date date;
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS status text;

ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS month_key text;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS paid_date date;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS status text;

CREATE TABLE IF NOT EXISTS property_expenses_dedup_backup_20260302 (LIKE property_expenses INCLUDING ALL);
CREATE TABLE IF NOT EXISTS company_expenses_dedup_backup_20260302 (LIKE company_expenses INCLUDING ALL);

WITH ranked AS (
  SELECT
    p.id,
    ROW_NUMBER() OVER (
      PARTITION BY fixed_expense_id, month_key
      ORDER BY
        CASE WHEN status = 'paid' THEN 1 ELSE 0 END DESC,
        paid_date DESC NULLS LAST,
        due_date DESC NULLS LAST,
        occurred_at DESC NULLS LAST,
        id DESC
    ) AS rn
  FROM property_expenses p
  WHERE fixed_expense_id IS NOT NULL
    AND fixed_expense_id <> ''
    AND month_key IS NOT NULL
    AND month_key <> ''
)
INSERT INTO property_expenses_dedup_backup_20260302
SELECT p.*
FROM property_expenses p
JOIN ranked r ON r.id = p.id
WHERE r.rn > 1
ON CONFLICT (id) DO NOTHING;

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

WITH ranked AS (
  SELECT
    c.id,
    ROW_NUMBER() OVER (
      PARTITION BY fixed_expense_id, month_key
      ORDER BY
        CASE WHEN status = 'paid' THEN 1 ELSE 0 END DESC,
        paid_date DESC NULLS LAST,
        due_date DESC NULLS LAST,
        occurred_at DESC NULLS LAST,
        id DESC
    ) AS rn
  FROM company_expenses c
  WHERE fixed_expense_id IS NOT NULL
    AND fixed_expense_id <> ''
    AND month_key IS NOT NULL
    AND month_key <> ''
)
INSERT INTO company_expenses_dedup_backup_20260302
SELECT c.*
FROM company_expenses c
JOIN ranked r ON r.id = c.id
WHERE r.rn > 1
ON CONFLICT (id) DO NOTHING;

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

CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_expenses_fixed_expense_month_key
  ON property_expenses(fixed_expense_id, month_key)
  WHERE fixed_expense_id IS NOT NULL
    AND fixed_expense_id <> ''
    AND month_key IS NOT NULL
    AND month_key <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_expenses_fixed_expense_month_key
  ON company_expenses(fixed_expense_id, month_key)
  WHERE fixed_expense_id IS NOT NULL
    AND fixed_expense_id <> ''
    AND month_key IS NOT NULL
    AND month_key <> '';

COMMIT;

SELECT fixed_expense_id, month_key, COUNT(*) AS cnt
FROM property_expenses
WHERE COALESCE(fixed_expense_id,'') <> '' AND COALESCE(month_key,'') <> ''
GROUP BY fixed_expense_id, month_key
HAVING COUNT(*) > 1
ORDER BY cnt DESC
LIMIT 50;

SELECT fixed_expense_id, month_key, COUNT(*) AS cnt
FROM company_expenses
WHERE COALESCE(fixed_expense_id,'') <> '' AND COALESCE(month_key,'') <> ''
GROUP BY fixed_expense_id, month_key
HAVING COUNT(*) > 1
ORDER BY cnt DESC
LIMIT 50;
