BEGIN;

-- Products: retail/wholesale/min wholesale qty + manual quote flag
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS retail_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS wholesale_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS min_qty_wholesale INTEGER,
  ADD COLUMN IF NOT EXISTS requires_manual_price BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_min_qty_wholesale;

ALTER TABLE products
  ADD CONSTRAINT chk_products_min_qty_wholesale
  CHECK (min_qty_wholesale IS NULL OR min_qty_wholesale >= 1);

-- Categories: combo discount fields
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS combo_discount_qty INTEGER,
  ADD COLUMN IF NOT EXISTS combo_discount_price NUMERIC(12,2);

ALTER TABLE categories
  DROP CONSTRAINT IF EXISTS chk_categories_combo_qty;

ALTER TABLE categories
  ADD CONSTRAINT chk_categories_combo_qty
  CHECK (combo_discount_qty IS NULL OR combo_discount_qty >= 1);

ALTER TABLE categories
  DROP CONSTRAINT IF EXISTS chk_categories_combo_pair;

ALTER TABLE categories
  ADD CONSTRAINT chk_categories_combo_pair
  CHECK (
    (combo_discount_qty IS NULL AND combo_discount_price IS NULL)
    OR
    (combo_discount_qty IS NOT NULL AND combo_discount_price IS NOT NULL)
  );

-- Product quantity tiers
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

CREATE UNIQUE INDEX IF NOT EXISTS ux_product_price_tiers_product_min_qty
  ON product_price_tiers(product_id, min_qty);

COMMIT;