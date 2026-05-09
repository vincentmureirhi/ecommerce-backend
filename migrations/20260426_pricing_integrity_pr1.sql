BEGIN;

-- Ensure price_source and line_total exist on order_items
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS price_source TEXT,
  ADD COLUMN IF NOT EXISTS line_total NUMERIC(12,2);

-- Ensure pricing_locked_at exists on order_items
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS pricing_locked_at TIMESTAMPTZ;

-- Auto-lock pricing fields on insert (idempotent)
CREATE OR REPLACE FUNCTION lock_order_item_pricing_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.pricing_locked_at := COALESCE(NEW.pricing_locked_at, NOW());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_order_item_pricing_insert ON order_items;

CREATE TRIGGER trg_lock_order_item_pricing_insert
BEFORE INSERT ON order_items
FOR EACH ROW
EXECUTE FUNCTION lock_order_item_pricing_on_insert();

-- Ensure the pricing audit table exists
CREATE TABLE IF NOT EXISTS order_item_pricing_audit (
  id BIGSERIAL PRIMARY KEY,
  order_item_id INT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  price_at_purchase NUMERIC(10,2) NOT NULL,
  line_total NUMERIC(12,2) NOT NULL,
  price_source TEXT,
  pricing_locked_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_item_pricing_audit_order_item
  ON order_item_pricing_audit(order_item_id);

CREATE INDEX IF NOT EXISTS idx_order_item_pricing_audit_order
  ON order_item_pricing_audit(order_id);

-- Ensure product_price_tiers exists
CREATE TABLE IF NOT EXISTS product_price_tiers (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_qty INTEGER NOT NULL CHECK (min_qty >= 1),
  max_qty INTEGER CHECK (max_qty IS NULL OR max_qty >= min_qty),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_price_tiers_product_qty
  ON product_price_tiers(product_id, min_qty, max_qty);

COMMIT;
