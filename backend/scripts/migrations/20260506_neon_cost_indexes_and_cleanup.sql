CREATE INDEX IF NOT EXISTS idx_order_internal_deductions_order_id
ON order_internal_deductions(order_id);

CREATE INDEX IF NOT EXISTS idx_orders_property_checkin_checkout
ON orders(property_id, checkin, checkout);

CREATE INDEX IF NOT EXISTS idx_property_expenses_month_sort
ON property_expenses(month_key, paid_date DESC, due_date DESC, occurred_at DESC);

DROP INDEX IF EXISTS uniq_property_expenses_fixed_month;
