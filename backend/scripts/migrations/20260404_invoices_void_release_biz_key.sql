DROP INDEX IF EXISTS uniq_invoices_biz_unique_key;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_biz_unique_key
ON invoices(biz_unique_key)
WHERE biz_unique_key IS NOT NULL AND COALESCE(status, '') <> 'void';
