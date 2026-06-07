-- Product-level selling constraints.
-- Example: Bic razors sold only as 12, 24, 36... pieces can use
-- min_order_qty = 12, order_qty_step = 12, selling_unit_label = 'dozen'.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS min_order_qty INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS order_qty_step INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS selling_unit_label TEXT NOT NULL DEFAULT 'piece';

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_min_order_qty;

ALTER TABLE products
  ADD CONSTRAINT chk_products_min_order_qty
  CHECK (min_order_qty >= 1);

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_order_qty_step;

ALTER TABLE products
  ADD CONSTRAINT chk_products_order_qty_step
  CHECK (order_qty_step >= 1);

CREATE INDEX IF NOT EXISTS idx_products_order_quantity_rules
  ON products (min_order_qty, order_qty_step);