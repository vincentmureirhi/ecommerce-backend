BEGIN;

-- ============================================================
-- Pricing Rules foundation
-- ============================================================
-- Pricing rule types supported by the evaluator
-- (pricingRuleEvaluator.js / docs/pricing-precedence.md):
--
--   CONSTANT       : Fixed retail price regardless of quantity.
--   SKU_THRESHOLD  : Wholesale price when quantity of this exact
--                    SKU in the order >= threshold_qty.
--   GROUP_THRESHOLD: Wholesale price when the combined quantity
--                    across ALL products sharing this rule in the
--                    same order >= threshold_qty.
--   TIERED         : Uses product_price_tiers rows for the product.
--
-- NOTE: categories.combo_discount_qty / combo_discount_price are
--       DEPRECATED and no longer the active pricing model.
--       See docs/pricing-precedence.md.
-- ============================================================

CREATE TABLE IF NOT EXISTS pricing_rules (
  id            SERIAL       PRIMARY KEY,
  name          VARCHAR(150) NOT NULL,
  rule_type     VARCHAR(20)  NOT NULL
                  CHECK (rule_type IN ('CONSTANT','SKU_THRESHOLD','GROUP_THRESHOLD','TIERED')),
  threshold_qty INTEGER      CHECK (threshold_qty IS NULL OR threshold_qty >= 1),
  description   TEXT,
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE pricing_rules IS
  'Named pricing rules used by the backend pricing engine. '
  'Categories are NOT the active pricing model; use pricing_rules instead. '
  'See docs/pricing-precedence.md for full evaluation order.';

COMMENT ON COLUMN pricing_rules.rule_type IS
  'CONSTANT: always retail price; SKU_THRESHOLD: wholesale when this SKU qty >= threshold_qty; '
  'GROUP_THRESHOLD: wholesale when group total qty >= threshold_qty; TIERED: product_price_tiers.';

COMMENT ON COLUMN pricing_rules.threshold_qty IS
  'Minimum combined quantity required to unlock wholesale pricing. '
  'Applies to SKU_THRESHOLD and GROUP_THRESHOLD rule types only.';

-- Assign a pricing rule to a product (nullable; NULL = legacy fallback)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS pricing_rule_id INTEGER
    REFERENCES pricing_rules(id) ON DELETE SET NULL;

COMMENT ON COLUMN products.pricing_rule_id IS
  'Active pricing rule for this product. NULL = legacy fallback '
  '(wholesale threshold via min_qty_wholesale, then retail).';

CREATE INDEX IF NOT EXISTS idx_products_pricing_rule_id
  ON products(pricing_rule_id);

COMMIT;
