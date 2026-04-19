BEGIN;

-- 1) Payments table (append-only; updates limited)
CREATE TABLE IF NOT EXISTS payments (
  id                SERIAL PRIMARY KEY,
  order_id           INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,

  amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method             TEXT NOT NULL CHECK (method IN ('cash','mpesa','bank','card','other')),
  reference          TEXT, -- mpesa code / bank ref / etc
  received_by_user_id INTEGER REFERENCES users(id), -- admin or sales rep who recorded it

  status             TEXT NOT NULL DEFAULT 'completed'
                     CHECK (status IN ('completed','reversed','voided')),

  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method);

-- 2) Helpful summary view (optional but useful)
CREATE OR REPLACE VIEW v_order_payment_summary AS
SELECT
  o.id AS order_id,
  o.total_amount::numeric(12,2) AS order_total,
  COALESCE(SUM(CASE WHEN p.status='completed' THEN p.amount ELSE 0 END), 0)::numeric(12,2) AS paid_total,
  (o.total_amount::numeric(12,2) - COALESCE(SUM(CASE WHEN p.status='completed' THEN p.amount ELSE 0 END), 0))::numeric(12,2) AS balance
FROM orders o
LEFT JOIN payments p ON p.order_id = o.id
GROUP BY o.id;

COMMIT;