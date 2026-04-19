BEGIN;

-- Keep your existing columns, just add what pricing needs
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS price_source TEXT,
  ADD COLUMN IF NOT EXISTS line_total NUMERIC(12,2);

COMMIT;