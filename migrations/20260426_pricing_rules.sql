BEGIN;

-- Pricing rules table
-- Supports: CONSTANT, SKU_THRESHOLD, GROUP_THRESHOLD, TIERED
CREATE TABLE IF NOT EXISTS pricing_rules (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  rule_type     TEXT NOT NULL,
  threshold_qty INTEGER CHECK (threshold_qty IS NULL OR threshold_qty >= 1),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_pricing_rules_rule_type
    CHECK (rule_type IN ('CONSTANT', 'SKU_THRESHOLD', 'GROUP_THRESHOLD', 'TIERED'))
);

-- Optional FK from products to pricing_rules (nullable, backward-compatible)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS pricing_rule_id BIGINT
    REFERENCES pricing_rules(id) ON DELETE SET NULL;

COMMIT;
