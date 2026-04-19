BEGIN;

-- 1) Columns (Postgres supports IF NOT EXISTS here ✅)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS department_id INTEGER;

-- 2) FK constraint (Postgres does NOT support "ADD CONSTRAINT IF NOT EXISTS" ❌)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'products_department_fk'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_department_fk
      FOREIGN KEY (department_id) REFERENCES departments(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- 3) CHECK constraint (same issue, must be guarded)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'products_cost_price_nonneg'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_cost_price_nonneg
      CHECK (cost_price IS NULL OR cost_price >= 0);
  END IF;
END
$$;

COMMIT;