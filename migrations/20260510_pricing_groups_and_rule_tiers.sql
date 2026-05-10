BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Explicit pricing groups
-- Allows any mix of products to be grouped for GROUP_THRESHOLD / GROUP_TIERED
-- rules, replacing the implicit "shared pricing_rule_id" approach.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pricing_groups (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Products explicitly assigned to a pricing group.
-- Supports optional effective date windows.
CREATE TABLE IF NOT EXISTS pricing_group_products (
  pricing_group_id BIGINT NOT NULL REFERENCES pricing_groups(id) ON DELETE CASCADE,
  product_id       BIGINT NOT NULL REFERENCES products(id)       ON DELETE CASCADE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from   TIMESTAMPTZ,
  effective_until  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pricing_group_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_pricing_group_products_product
  ON pricing_group_products(product_id)
  WHERE is_active = TRUE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rule-level price tiers
-- Used by SKU_TIERED (individual qty selects tier) and GROUP_TIERED (combined
-- group qty selects tier).  Separate from product_price_tiers which holds
-- per-product tier overrides used by the legacy TIERED rule type.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pricing_rule_tiers (
  id              BIGSERIAL PRIMARY KEY,
  pricing_rule_id BIGINT NOT NULL REFERENCES pricing_rules(id) ON DELETE CASCADE,
  min_qty         INTEGER NOT NULL CHECK (min_qty >= 1),
  max_qty         INTEGER CHECK (max_qty IS NULL OR max_qty >= min_qty),
  unit_price      NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pricing_rule_tiers_rule_min_qty
  ON pricing_rule_tiers(pricing_rule_id, min_qty);

CREATE INDEX IF NOT EXISTS idx_pricing_rule_tiers_rule
  ON pricing_rule_tiers(pricing_rule_id, min_qty);

-- ─────────────────────────────────────────────────────────────────────────────
-- Link pricing_rules to an explicit pricing_group
-- When a rule has pricing_group_id set, GROUP_THRESHOLD / GROUP_TIERED will
-- use that group's combined quantity rather than the implicit shared-rule-id
-- grouping.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pricing_rules
  ADD COLUMN IF NOT EXISTS pricing_group_id BIGINT
    REFERENCES pricing_groups(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Extend rule_type constraint to include new explicit types.
-- Existing data is preserved; old types remain valid.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pricing_rules
  DROP CONSTRAINT IF EXISTS chk_pricing_rules_rule_type;

ALTER TABLE pricing_rules
  ADD CONSTRAINT chk_pricing_rules_rule_type
  CHECK (rule_type IN (
    'CONSTANT',        -- legacy: fixed retail price
    'SKU_THRESHOLD',   -- per-SKU quantity threshold for wholesale
    'GROUP_THRESHOLD', -- combined group quantity threshold for wholesale
    'TIERED',          -- legacy per-product tier ladder
    'FIXED_UNIT',      -- explicit fixed unit price (canonical alias for CONSTANT)
    'SKU_TIERED',      -- per-SKU quantity selects tier from pricing_rule_tiers
    'GROUP_TIERED'     -- combined group quantity selects tier from pricing_rule_tiers
  ));

COMMIT;
