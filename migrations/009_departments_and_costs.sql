BEGIN;

-- 1) Departments table
CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) Add to products: department_id + cost_price
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,2);

-- Optional: default cost_price to 0 for existing rows (or leave NULL)
-- UPDATE products SET cost_price = 0 WHERE cost_price IS NULL;

COMMIT;