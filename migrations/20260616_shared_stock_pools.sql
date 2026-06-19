-- Shared stock pools for assorted products such as braids.
-- This lets individual sellable variants use one honest parent inventory pool
-- when exact per-variant stock is not known.

CREATE TABLE IF NOT EXISTS inventory_stock_pools (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT UNIQUE,
  description TEXT,
  total_stock INTEGER NOT NULL DEFAULT 0 CHECK (total_stock >= 0),
  reorder_level INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  stock_status_override TEXT CHECK (
    stock_status_override IS NULL
    OR stock_status_override IN ('in_stock', 'limited_stock', 'out_of_stock')
  ),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_source TEXT NOT NULL DEFAULT 'product';

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_pool_id BIGINT;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_pool_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'products_stock_source_check'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_stock_source_check
      CHECK (stock_source IN ('product', 'pool'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'products_stock_pool_id_fkey'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_stock_pool_id_fkey
      FOREIGN KEY (stock_pool_id)
      REFERENCES inventory_stock_pools(id)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_stock_pools_active
  ON inventory_stock_pools(is_active, name);

CREATE INDEX IF NOT EXISTS idx_products_stock_pool_id
  ON products(stock_pool_id)
  WHERE stock_pool_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_stock_source
  ON products(stock_source);

INSERT INTO inventory_stock_pools (
  name,
  sku,
  description,
  total_stock,
  reorder_level,
  stock_status_override,
  is_active
)
VALUES (
  'BRAIDS ASSORTED STOCK',
  'POOL-BRAIDS-ASSORTED',
  'Shared stock pool for braid variants where exact colour/length/number quantities are not counted separately.',
  0,
  100,
  NULL,
  TRUE
)
ON CONFLICT (sku) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  updated_at = NOW();
