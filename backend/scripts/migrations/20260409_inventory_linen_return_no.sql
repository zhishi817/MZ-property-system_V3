ALTER TABLE linen_supplier_return_batches
  ADD COLUMN IF NOT EXISTS return_no text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_linen_supplier_return_batches_return_no_unique
  ON linen_supplier_return_batches(return_no)
  WHERE return_no IS NOT NULL;
