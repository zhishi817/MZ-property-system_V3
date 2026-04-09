ALTER TABLE warehouses
ADD COLUMN IF NOT EXISTS stocktake_enabled boolean NOT NULL DEFAULT true;
