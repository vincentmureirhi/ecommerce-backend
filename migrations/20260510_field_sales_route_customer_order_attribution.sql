BEGIN;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS route_area TEXT,
  ADD COLUMN IF NOT EXISTS route_notes TEXT;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_workflow_type VARCHAR(50);

UPDATE orders
SET order_workflow_type = CASE
  WHEN order_type = 'route' AND sales_rep_id IS NOT NULL THEN 'route_sales_rep_capture'
  WHEN order_type = 'route' THEN 'route_self_service'
  ELSE 'normal_self_service'
END
WHERE order_workflow_type IS NULL;

ALTER TABLE orders
  ALTER COLUMN order_workflow_type SET DEFAULT 'normal_self_service';

ALTER TABLE orders
  ALTER COLUMN order_workflow_type SET NOT NULL;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_order_workflow_type_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_order_workflow_type_check
    CHECK (order_workflow_type IN ('normal_self_service', 'route_self_service', 'route_sales_rep_capture'));

CREATE INDEX IF NOT EXISTS idx_orders_workflow_type ON orders(order_workflow_type);

COMMIT;
