BEGIN;

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

COMMIT;