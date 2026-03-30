DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'keys_required'
  ) THEN
    ALTER TABLE orders
    ADD COLUMN keys_required integer NOT NULL DEFAULT 1;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cleaning_tasks'
      AND column_name = 'keys_required'
  ) THEN
    WITH t AS (
      SELECT order_id::text AS order_id, MAX(COALESCE(keys_required, 1)) AS max_k
      FROM cleaning_tasks
      WHERE order_id IS NOT NULL
      GROUP BY order_id::text
    )
    UPDATE orders o
    SET keys_required = GREATEST(1, LEAST(2, t.max_k))
    FROM t
    WHERE o.id::text = t.order_id;
  END IF;
END $$;
