BEGIN;

-- Sales Representatives table
CREATE TABLE IF NOT EXISTS sales_reps (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone_number VARCHAR(20),
  email VARCHAR(100),
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Routes table (geographic areas/territories)
CREATE TABLE IF NOT EXISTS routes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  sales_rep_id INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Update customer_locations to link to routes
ALTER TABLE customer_locations
  ADD COLUMN IF NOT EXISTS route_id INTEGER REFERENCES routes(id) ON DELETE SET NULL;

-- Update customers table to track if route customer or normal
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS customer_type VARCHAR(20) DEFAULT 'normal' CHECK (customer_type IN ('normal', 'route')),
  ADD COLUMN IF NOT EXISTS route_id INTEGER REFERENCES routes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sales_rep_id INTEGER REFERENCES sales_reps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_purchase_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_purchases NUMERIC(12,2) DEFAULT 0;

-- Track customer visits by sales reps
CREATE TABLE IF NOT EXISTS customer_visits (
  id SERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sales_rep_id INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  visit_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_visits_customer ON customer_visits(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_visits_sales_rep ON customer_visits(sales_rep_id);
CREATE INDEX IF NOT EXISTS idx_customer_visits_date ON customer_visits(visit_date);

-- Track purchases/orders by customers
CREATE TABLE IF NOT EXISTS customer_purchases (
  id SERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  purchase_amount NUMERIC(12,2) NOT NULL,
  purchase_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_purchases_customer ON customer_purchases(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_purchases_date ON customer_purchases(purchase_date);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_customers_type ON customers(customer_type);
CREATE INDEX IF NOT EXISTS idx_customers_route ON customers(route_id);
CREATE INDEX IF NOT EXISTS idx_customers_sales_rep ON customers(sales_rep_id);
CREATE INDEX IF NOT EXISTS idx_routes_sales_rep ON routes(sales_rep_id);

COMMIT;