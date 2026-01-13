BEGIN;
UPDATE orders
SET checkin = (checkin + INTERVAL '1 year')::date,
    checkout = (checkout + INTERVAL '1 year')::date
WHERE source IN ('airbnb_email','airbnb_email_import_v1')
  AND (
    (created_at >= '2026-01-01' AND EXTRACT(YEAR FROM checkin) = 2025 AND EXTRACT(YEAR FROM checkout) = 2025)
    OR
    (EXTRACT(YEAR FROM created_at) = 2025 AND EXTRACT(MONTH FROM created_at) = 12 AND EXTRACT(MONTH FROM checkin) = 1 AND EXTRACT(YEAR FROM checkin) = 2025 AND EXTRACT(YEAR FROM checkout) = 2025)
  );
COMMIT;