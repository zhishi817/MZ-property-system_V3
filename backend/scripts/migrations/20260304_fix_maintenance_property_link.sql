BEGIN;

ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS property_code text;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS property_code text;

UPDATE property_maintenance pm
SET property_id = p.id
FROM properties p
WHERE pm.property_id IS NOT NULL
  AND pm.property_id = p.code
  AND pm.property_id <> p.id;

UPDATE property_deep_cleaning dc
SET property_id = p.id
FROM properties p
WHERE dc.property_id IS NOT NULL
  AND dc.property_id = p.code
  AND dc.property_id <> p.id;

UPDATE property_maintenance pm
SET property_code = p.code
FROM properties p
WHERE pm.property_id = p.id
  AND (pm.property_code IS NULL OR pm.property_code = '');

UPDATE property_deep_cleaning dc
SET property_code = p.code
FROM properties p
WHERE dc.property_id = p.id
  AND (dc.property_code IS NULL OR dc.property_code = '');

COMMIT;

