-- XPOSE marketing foundation: campaigns, coupons, campaign targets,
-- coupon redemptions, and order-level discount columns.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id SERIAL PRIMARY KEY,
  campaign_code VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(180) NOT NULL,
  description TEXT,
  campaign_type VARCHAR(40) NOT NULL DEFAULT 'general',
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  customer_scope VARCHAR(30) NOT NULL DEFAULT 'all',
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  priority INTEGER NOT NULL DEFAULT 0,
  hero_title VARCHAR(180),
  hero_subtitle TEXT,
  badge_label VARCHAR(80),
  cta_label VARCHAR(80),
  cta_url TEXT,
  budget_amount NUMERIC(12,2),
  target_amount NUMERIC(12,2),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_marketing_campaign_status CHECK (status IN ('draft', 'active', 'paused', 'ended', 'archived')),
  CONSTRAINT chk_marketing_campaign_type CHECK (campaign_type IN ('general', 'flash', 'coupon', 'route', 'category', 'clearance', 'bundle', 'vendor', 'referral')),
  CONSTRAINT chk_marketing_campaign_scope CHECK (customer_scope IN ('all', 'normal', 'route', 'vendor')),
  CONSTRAINT chk_marketing_campaign_window CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS marketing_campaign_products (
  campaign_id INTEGER NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, product_id)
);

CREATE TABLE IF NOT EXISTS marketing_campaign_categories (
  campaign_id INTEGER NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, category_id)
);

CREATE TABLE IF NOT EXISTS marketing_campaign_regions (
  campaign_id INTEGER NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  region_id INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, region_id)
);

CREATE TABLE IF NOT EXISTS coupons (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  code VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  description TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  discount_type VARCHAR(30) NOT NULL,
  discount_value NUMERIC(12,2) NOT NULL,
  max_discount_amount NUMERIC(12,2),
  min_order_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  customer_scope VARCHAR(30) NOT NULL DEFAULT 'all',
  applies_to VARCHAR(30) NOT NULL DEFAULT 'all',
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  max_total_uses INTEGER,
  max_uses_per_customer INTEGER,
  max_uses_per_phone INTEGER,
  uses_count INTEGER NOT NULL DEFAULT 0,
  stackable BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER,
  updated_by INTEGER,
  last_redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_coupons_status CHECK (status IN ('draft', 'active', 'paused', 'expired', 'archived')),
  CONSTRAINT chk_coupons_discount_type CHECK (discount_type IN ('percentage', 'fixed_amount')),
  CONSTRAINT chk_coupons_scope CHECK (customer_scope IN ('all', 'normal', 'route', 'vendor')),
  CONSTRAINT chk_coupons_applies_to CHECK (applies_to IN ('all', 'campaign_targets', 'products', 'categories')),
  CONSTRAINT chk_coupons_discount_positive CHECK (discount_value > 0),
  CONSTRAINT chk_coupons_percentage_max CHECK (discount_type <> 'percentage' OR discount_value <= 100),
  CONSTRAINT chk_coupons_window CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id BIGSERIAL PRIMARY KEY,
  coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
  campaign_id INTEGER REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_phone VARCHAR(40),
  order_type VARCHAR(30),
  subtotal_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  final_total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'redeemed',
  request_id VARCHAR(120),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_coupon_redemptions_status CHECK (status IN ('redeemed', 'reversed', 'void')),
  CONSTRAINT uq_coupon_redemptions_coupon_order UNIQUE (coupon_id, order_id)
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_id INTEGER REFERENCES coupons(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(60);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS marketing_campaign_id INTEGER REFERENCES marketing_campaigns(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_discount_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE orders
SET subtotal_amount = COALESCE(subtotal_amount, total_amount, 0),
    discount_amount = COALESCE(discount_amount, 0)
WHERE subtotal_amount IS NULL;

CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_status_window
  ON marketing_campaigns (status, starts_at, ends_at, priority DESC);

CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_type_status
  ON marketing_campaigns (campaign_type, status);

CREATE INDEX IF NOT EXISTS idx_coupons_code_upper
  ON coupons (UPPER(code));

CREATE INDEX IF NOT EXISTS idx_coupons_status_window
  ON coupons (status, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS idx_coupons_campaign_id
  ON coupons (campaign_id);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_status
  ON coupon_redemptions (coupon_id, status, redeemed_at DESC);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_order_id
  ON coupon_redemptions (order_id);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_customer_id
  ON coupon_redemptions (customer_id) WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_phone_digits
  ON coupon_redemptions ((regexp_replace(COALESCE(customer_phone, ''), '\D', '', 'g')));

CREATE INDEX IF NOT EXISTS idx_orders_coupon_id
  ON orders (coupon_id) WHERE coupon_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_marketing_campaign_id
  ON orders (marketing_campaign_id) WHERE marketing_campaign_id IS NOT NULL;