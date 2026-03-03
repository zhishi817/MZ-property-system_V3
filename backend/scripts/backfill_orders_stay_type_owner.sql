SELECT
  id,
  property_id,
  source,
  guest_name,
  note,
  checkin,
  checkout,
  price,
  status
FROM orders
WHERE stay_type = 'guest'
  AND (
    lower(coalesce(guest_name, '')) LIKE '%owner%'
    OR coalesce(guest_name, '') LIKE '%房东%'
    OR coalesce(guest_name, '') LIKE '%自住%'
    OR lower(coalesce(note, '')) LIKE '%owner%'
    OR coalesce(note, '') LIKE '%房东%'
    OR coalesce(note, '') LIKE '%自住%'
    OR (source = 'offline' AND coalesce(price, 0) = 0)
  )
ORDER BY checkin DESC
LIMIT 200;

UPDATE orders
SET stay_type = 'owner'
WHERE stay_type = 'guest'
  AND (
    lower(coalesce(guest_name, '')) LIKE '%owner%'
    OR coalesce(guest_name, '') LIKE '%房东%'
    OR coalesce(guest_name, '') LIKE '%自住%'
    OR lower(coalesce(note, '')) LIKE '%owner%'
    OR coalesce(note, '') LIKE '%房东%'
    OR coalesce(note, '') LIKE '%自住%'
    OR (source = 'offline' AND coalesce(price, 0) = 0)
  );
