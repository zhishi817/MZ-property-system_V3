BEGIN;

CREATE TABLE IF NOT EXISTS property_maintenance_phase3_cleanup_snapshot_20260422 (
  id text PRIMARY KEY,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  property_id text,
  work_no text,
  area text,
  category text,
  category_detail text,
  details text,
  notes text,
  started_at timestamptz,
  updated_at timestamptz
);

INSERT INTO property_maintenance_phase3_cleanup_snapshot_20260422 (
  id,
  snapshot_at,
  property_id,
  work_no,
  area,
  category,
  category_detail,
  details,
  notes,
  started_at,
  updated_at
)
SELECT
  pm.id,
  now(),
  pm.property_id,
  pm.work_no,
  pm.area,
  pm.category,
  pm.category_detail,
  pm.details,
  pm.notes,
  pm.started_at,
  pm.updated_at
FROM property_maintenance pm
WHERE (
    NULLIF(BTRIM(COALESCE(pm.details, '')), '') IS NULL
    AND NULLIF(BTRIM(COALESCE(pm.notes, '')), '') IS NOT NULL
  )
  OR (
    NULLIF(BTRIM(COALESCE(pm.area, '')), '') IS NULL
    AND NULLIF(BTRIM(COALESCE(pm.category, '')), '') IS NOT NULL
    AND pm.category IN ('入户走廊', '客厅', '厨房', '卧室', '阳台', '浴室', '其他')
  )
  OR NULLIF(BTRIM(COALESCE(pm.category_detail, '')), '') IS NOT NULL
  OR pm.started_at IS NOT NULL
ON CONFLICT (id) DO UPDATE
SET
  snapshot_at = EXCLUDED.snapshot_at,
  property_id = EXCLUDED.property_id,
  work_no = EXCLUDED.work_no,
  area = EXCLUDED.area,
  category = EXCLUDED.category,
  category_detail = EXCLUDED.category_detail,
  details = EXCLUDED.details,
  notes = EXCLUDED.notes,
  started_at = EXCLUDED.started_at,
  updated_at = EXCLUDED.updated_at;

CREATE TABLE IF NOT EXISTS property_maintenance_category_detail_archive_20260422 (
  id text PRIMARY KEY,
  archived_at timestamptz NOT NULL DEFAULT now(),
  property_id text,
  work_no text,
  area text,
  category text,
  category_detail text,
  details text,
  notes text,
  started_at timestamptz,
  updated_at timestamptz
);

INSERT INTO property_maintenance_category_detail_archive_20260422 (
  id,
  archived_at,
  property_id,
  work_no,
  area,
  category,
  category_detail,
  details,
  notes,
  started_at,
  updated_at
)
SELECT
  pm.id,
  now(),
  pm.property_id,
  pm.work_no,
  pm.area,
  pm.category,
  pm.category_detail,
  pm.details,
  pm.notes,
  pm.started_at,
  pm.updated_at
FROM property_maintenance pm
WHERE NULLIF(BTRIM(COALESCE(pm.category_detail, '')), '') IS NOT NULL
ON CONFLICT (id) DO UPDATE
SET
  archived_at = EXCLUDED.archived_at,
  property_id = EXCLUDED.property_id,
  work_no = EXCLUDED.work_no,
  area = EXCLUDED.area,
  category = EXCLUDED.category,
  category_detail = EXCLUDED.category_detail,
  details = EXCLUDED.details,
  notes = EXCLUDED.notes,
  started_at = EXCLUDED.started_at,
  updated_at = EXCLUDED.updated_at;

UPDATE property_maintenance
SET
  details = notes,
  updated_at = now()
WHERE NULLIF(BTRIM(COALESCE(details, '')), '') IS NULL
  AND NULLIF(BTRIM(COALESCE(notes, '')), '') IS NOT NULL;

UPDATE property_maintenance
SET
  area = category,
  updated_at = now()
WHERE NULLIF(BTRIM(COALESCE(area, '')), '') IS NULL
  AND NULLIF(BTRIM(COALESCE(category, '')), '') IS NOT NULL
  AND category IN ('入户走廊', '客厅', '厨房', '卧室', '阳台', '浴室', '其他');

COMMIT;

SELECT
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(details, '')), '') IS NOT NULL) AS details_filled,
  COUNT(*) FILTER (
    WHERE NULLIF(BTRIM(COALESCE(details, '')), '') IS NULL
      AND NULLIF(BTRIM(COALESCE(notes, '')), '') IS NOT NULL
  ) AS details_still_missing_but_notes_present,
  COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(area, '')), '') IS NOT NULL) AS area_filled,
  COUNT(*) FILTER (
    WHERE NULLIF(BTRIM(COALESCE(area, '')), '') IS NULL
      AND NULLIF(BTRIM(COALESCE(category, '')), '') IS NOT NULL
      AND category IN ('入户走廊', '客厅', '厨房', '卧室', '阳台', '浴室', '其他')
  ) AS area_still_missing_but_category_is_area,
  COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(category_detail, '')), '') IS NOT NULL) AS category_detail_remaining,
  COUNT(*) FILTER (WHERE started_at IS NOT NULL) AS started_at_remaining
FROM property_maintenance;

SELECT
  category_detail,
  COUNT(*) AS row_count
FROM property_maintenance
WHERE NULLIF(BTRIM(COALESCE(category_detail, '')), '') IS NOT NULL
GROUP BY category_detail
ORDER BY row_count DESC, category_detail ASC;

-- Drop readiness checks:
-- 1. Confirm `details_still_missing_but_notes_present = 0`
-- 2. Confirm `area_still_missing_but_category_is_area = 0`
-- 3. Confirm whether `category_detail_remaining` and `started_at_remaining` can be accepted as archive-only
--
-- Planned drop SQL after verification:
-- ALTER TABLE property_maintenance DROP COLUMN notes;
-- ALTER TABLE property_maintenance DROP COLUMN category;
-- ALTER TABLE property_maintenance DROP COLUMN category_detail;
-- ALTER TABLE property_maintenance DROP COLUMN started_at;
