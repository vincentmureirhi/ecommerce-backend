-- Phase 1 foundation for XPOSE Marketplace vendors.
-- This migration is intentionally additive: existing XPOSE products, checkout,
-- pricing rules, orders, suppliers, and route-customer flows remain unchanged.

BEGIN;

CREATE TABLE IF NOT EXISTS vendor_subscription_plans (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  monthly_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  commission_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  max_products INTEGER NOT NULL DEFAULT 25,
  featured_slots INTEGER NOT NULL DEFAULT 0,
  product_approval_required BOOLEAN NOT NULL DEFAULT TRUE,
  price_review_required BOOLEAN NOT NULL DEFAULT TRUE,
  minimum_margin_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  allow_vendor_discounts BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vendor_subscription_monthly_fee CHECK (monthly_fee >= 0),
  CONSTRAINT chk_vendor_subscription_commission CHECK (commission_rate >= 0 AND commission_rate <= 100),
  CONSTRAINT chk_vendor_subscription_max_products CHECK (max_products >= 0),
  CONSTRAINT chk_vendor_subscription_featured_slots CHECK (featured_slots >= 0),
  CONSTRAINT chk_vendor_subscription_min_margin CHECK (minimum_margin_percent >= 0 AND minimum_margin_percent <= 100)
);

INSERT INTO vendor_subscription_plans
  (
    code,
    name,
    description,
    monthly_fee,
    commission_rate,
    max_products,
    featured_slots,
    product_approval_required,
    price_review_required,
    minimum_margin_percent,
    allow_vendor_discounts
  )
VALUES
  (
    'starter',
    'Starter Store',
    'Entry marketplace plan for small sellers. XPOSE reviews every product before it goes live.',
    1500,
    8,
    25,
    0,
    TRUE,
    TRUE,
    5,
    FALSE
  ),
  (
    'growth',
    'Growth Store',
    'Higher catalogue capacity with lower commission for consistent sellers.',
    3500,
    6,
    100,
    2,
    TRUE,
    TRUE,
    5,
    TRUE
  ),
  (
    'premium',
    'Premium Store',
    'Featured placement for verified sellers with larger catalogues.',
    7500,
    4,
    500,
    6,
    TRUE,
    TRUE,
    4,
    TRUE
  )
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  monthly_fee = EXCLUDED.monthly_fee,
  commission_rate = EXCLUDED.commission_rate,
  max_products = EXCLUDED.max_products,
  featured_slots = EXCLUDED.featured_slots,
  product_approval_required = EXCLUDED.product_approval_required,
  price_review_required = EXCLUDED.price_review_required,
  minimum_margin_percent = EXCLUDED.minimum_margin_percent,
  allow_vendor_discounts = EXCLUDED.allow_vendor_discounts,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS vendors (
  id BIGSERIAL PRIMARY KEY,
  store_name TEXT NOT NULL,
  store_slug TEXT NOT NULL UNIQUE,
  legal_name TEXT,
  contact_person TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  business_type TEXT,
  business_registration_no TEXT,
  kra_pin TEXT,
  national_id TEXT,
  address TEXT,
  region_id INTEGER REFERENCES regions(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  product_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  subscription_plan_id BIGINT REFERENCES vendor_subscription_plans(id) ON DELETE SET NULL,
  monthly_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  commission_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  max_products INTEGER NOT NULL DEFAULT 25,
  product_approval_required BOOLEAN NOT NULL DEFAULT TRUE,
  price_review_required BOOLEAN NOT NULL DEFAULT TRUE,
  minimum_margin_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  allow_vendor_discounts BOOLEAN NOT NULL DEFAULT FALSE,
  fulfillment_model TEXT NOT NULL DEFAULT 'xpose_reviewed',
  payout_phone TEXT,
  payout_name TEXT,
  payout_notes TEXT,
  logo_url TEXT,
  banner_url TEXT,
  admin_notes TEXT,
  approved_by INTEGER,
  approved_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vendors_status CHECK (status IN ('pending', 'active', 'suspended', 'closed')),
  CONSTRAINT chk_vendors_verification_status CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
  CONSTRAINT chk_vendors_fulfillment_model CHECK (fulfillment_model IN ('xpose_reviewed', 'xpose_fulfilled', 'vendor_fulfilled', 'hybrid')),
  CONSTRAINT chk_vendors_monthly_fee CHECK (monthly_fee >= 0),
  CONSTRAINT chk_vendors_commission CHECK (commission_rate >= 0 AND commission_rate <= 100),
  CONSTRAINT chk_vendors_max_products CHECK (max_products >= 0),
  CONSTRAINT chk_vendors_min_margin CHECK (minimum_margin_percent >= 0 AND minimum_margin_percent <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendors_email_lower
  ON vendors (LOWER(email));

CREATE INDEX IF NOT EXISTS idx_vendors_status
  ON vendors (status, verification_status);

CREATE INDEX IF NOT EXISTS idx_vendors_subscription_plan
  ON vendors (subscription_plan_id);

CREATE TABLE IF NOT EXISTS vendor_applications (
  id BIGSERIAL PRIMARY KEY,
  application_number TEXT NOT NULL UNIQUE,
  store_name TEXT NOT NULL,
  legal_name TEXT,
  contact_person TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  business_type TEXT,
  business_registration_no TEXT,
  kra_pin TEXT,
  national_id TEXT,
  address TEXT,
  region_id INTEGER REFERENCES regions(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  product_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  estimated_skus INTEGER,
  expected_monthly_sales NUMERIC(12,2),
  sample_price_min NUMERIC(12,2),
  sample_price_max NUMERIC(12,2),
  pricing_notes TEXT,
  preferred_plan_id BIGINT REFERENCES vendor_subscription_plans(id) ON DELETE SET NULL,
  requested_commission_rate NUMERIC(5,2),
  requested_monthly_fee NUMERIC(12,2),
  fulfillment_preference TEXT NOT NULL DEFAULT 'xpose_reviewed',
  status TEXT NOT NULL DEFAULT 'submitted',
  admin_review_notes TEXT,
  rejection_reason TEXT,
  reviewed_by INTEGER,
  reviewed_at TIMESTAMPTZ,
  approved_vendor_id BIGINT REFERENCES vendors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vendor_app_status CHECK (status IN ('submitted', 'under_review', 'approved', 'rejected', 'withdrawn')),
  CONSTRAINT chk_vendor_app_fulfillment CHECK (fulfillment_preference IN ('xpose_reviewed', 'xpose_fulfilled', 'vendor_fulfilled', 'hybrid')),
  CONSTRAINT chk_vendor_app_estimated_skus CHECK (estimated_skus IS NULL OR estimated_skus >= 0),
  CONSTRAINT chk_vendor_app_expected_sales CHECK (expected_monthly_sales IS NULL OR expected_monthly_sales >= 0),
  CONSTRAINT chk_vendor_app_price_min CHECK (sample_price_min IS NULL OR sample_price_min >= 0),
  CONSTRAINT chk_vendor_app_price_max CHECK (sample_price_max IS NULL OR sample_price_max >= 0),
  CONSTRAINT chk_vendor_app_commission CHECK (requested_commission_rate IS NULL OR (requested_commission_rate >= 0 AND requested_commission_rate <= 100)),
  CONSTRAINT chk_vendor_app_monthly_fee CHECK (requested_monthly_fee IS NULL OR requested_monthly_fee >= 0)
);

CREATE INDEX IF NOT EXISTS idx_vendor_applications_status_created
  ON vendor_applications (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vendor_applications_email_lower
  ON vendor_applications (LOWER(email));

CREATE TABLE IF NOT EXISTS vendor_users (
  id BIGSERIAL PRIMARY KEY,
  vendor_id BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  status TEXT NOT NULL DEFAULT 'active',
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vendor_users_role CHECK (role IN ('owner', 'manager', 'staff')),
  CONSTRAINT chk_vendor_users_status CHECK (status IN ('active', 'suspended', 'disabled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_users_username_lower
  ON vendor_users (LOWER(username));

CREATE INDEX IF NOT EXISTS idx_vendor_users_vendor
  ON vendor_users (vendor_id, status);

CREATE TABLE IF NOT EXISTS vendor_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  vendor_id BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  plan_id BIGINT REFERENCES vendor_subscription_plans(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'trial',
  billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  amount_due NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_reference TEXT,
  last_payment_at TIMESTAMPTZ,
  next_invoice_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vendor_subscription_status CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled')),
  CONSTRAINT chk_vendor_subscription_cycle CHECK (billing_cycle IN ('monthly', 'quarterly', 'annual')),
  CONSTRAINT chk_vendor_subscription_amount_due CHECK (amount_due >= 0),
  CONSTRAINT chk_vendor_subscription_amount_paid CHECK (amount_paid >= 0)
);

CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_vendor_status
  ON vendor_subscriptions (vendor_id, status, current_period_end DESC);

CREATE TABLE IF NOT EXISTS vendor_product_submissions (
  id BIGSERIAL PRIMARY KEY,
  vendor_id BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  submission_status TEXT NOT NULL DEFAULT 'draft',
  product_name TEXT NOT NULL,
  sku TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description TEXT,
  image_url TEXT,
  proposed_retail_price NUMERIC(12,2) NOT NULL,
  proposed_wholesale_price NUMERIC(12,2),
  proposed_cost_price NUMERIC(12,2),
  min_order_qty INTEGER NOT NULL DEFAULT 1,
  order_qty_step INTEGER NOT NULL DEFAULT 1,
  current_stock INTEGER NOT NULL DEFAULT 0,
  selling_unit_label TEXT,
  fulfillment_model TEXT NOT NULL DEFAULT 'xpose_reviewed',
  commission_rate NUMERIC(5,2),
  minimum_margin_percent NUMERIC(5,2),
  vendor_net_price NUMERIC(12,2),
  price_review_required BOOLEAN NOT NULL DEFAULT TRUE,
  price_review_notes TEXT,
  admin_review_notes TEXT,
  submitted_at TIMESTAMPTZ,
  reviewed_by INTEGER,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vendor_product_submission_status CHECK (submission_status IN ('draft', 'submitted', 'changes_requested', 'approved', 'rejected', 'archived')),
  CONSTRAINT chk_vendor_product_submission_fulfillment CHECK (fulfillment_model IN ('xpose_reviewed', 'xpose_fulfilled', 'vendor_fulfilled', 'hybrid')),
  CONSTRAINT chk_vendor_product_submission_retail CHECK (proposed_retail_price >= 0),
  CONSTRAINT chk_vendor_product_submission_wholesale CHECK (proposed_wholesale_price IS NULL OR proposed_wholesale_price >= 0),
  CONSTRAINT chk_vendor_product_submission_cost CHECK (proposed_cost_price IS NULL OR proposed_cost_price >= 0),
  CONSTRAINT chk_vendor_product_submission_min_qty CHECK (min_order_qty >= 1),
  CONSTRAINT chk_vendor_product_submission_step CHECK (order_qty_step >= 1),
  CONSTRAINT chk_vendor_product_submission_stock CHECK (current_stock >= 0),
  CONSTRAINT chk_vendor_product_submission_commission CHECK (commission_rate IS NULL OR (commission_rate >= 0 AND commission_rate <= 100)),
  CONSTRAINT chk_vendor_product_submission_margin CHECK (minimum_margin_percent IS NULL OR (minimum_margin_percent >= 0 AND minimum_margin_percent <= 100))
);

CREATE INDEX IF NOT EXISTS idx_vendor_product_submissions_vendor_status
  ON vendor_product_submissions (vendor_id, submission_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vendor_product_submissions_product
  ON vendor_product_submissions (product_id);

CREATE TABLE IF NOT EXISTS vendor_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  vendor_id BIGINT REFERENCES vendors(id) ON DELETE SET NULL,
  application_id BIGINT REFERENCES vendor_applications(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id INTEGER,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vendor_audit_actor CHECK (actor_type IN ('system', 'admin', 'vendor'))
);

CREATE INDEX IF NOT EXISTS idx_vendor_audit_vendor_created
  ON vendor_audit_logs (vendor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vendor_audit_application_created
  ON vendor_audit_logs (application_id, created_at DESC);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS vendor_id BIGINT REFERENCES vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_owner_type TEXT NOT NULL DEFAULT 'xpose',
  ADD COLUMN IF NOT EXISTS vendor_approval_status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS vendor_product_submission_id BIGINT REFERENCES vendor_product_submissions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vendor_commission_rate NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS vendor_net_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS vendor_price_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vendor_price_review_notes TEXT;

UPDATE products
SET
  product_owner_type = COALESCE(product_owner_type, 'xpose'),
  vendor_approval_status = COALESCE(vendor_approval_status, 'approved')
WHERE product_owner_type IS NULL
   OR vendor_approval_status IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_owner_type'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT chk_products_owner_type
      CHECK (product_owner_type IN ('xpose', 'vendor'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_vendor_approval_status'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT chk_products_vendor_approval_status
      CHECK (vendor_approval_status IN ('draft', 'pending_review', 'approved', 'rejected', 'suspended'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_vendor_commission_rate'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT chk_products_vendor_commission_rate
      CHECK (vendor_commission_rate IS NULL OR (vendor_commission_rate >= 0 AND vendor_commission_rate <= 100));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_vendor_net_price'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT chk_products_vendor_net_price
      CHECK (vendor_net_price IS NULL OR vendor_net_price >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_vendor_owner_status
  ON products (vendor_id, product_owner_type, vendor_approval_status);

CREATE INDEX IF NOT EXISTS idx_products_vendor_submission
  ON products (vendor_product_submission_id);

CREATE OR REPLACE FUNCTION touch_vendor_marketplace_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendor_subscription_plans_updated_at ON vendor_subscription_plans;
CREATE TRIGGER trg_vendor_subscription_plans_updated_at
BEFORE UPDATE ON vendor_subscription_plans
FOR EACH ROW EXECUTE FUNCTION touch_vendor_marketplace_updated_at();

DROP TRIGGER IF EXISTS trg_vendors_updated_at ON vendors;
CREATE TRIGGER trg_vendors_updated_at
BEFORE UPDATE ON vendors
FOR EACH ROW EXECUTE FUNCTION touch_vendor_marketplace_updated_at();

DROP TRIGGER IF EXISTS trg_vendor_applications_updated_at ON vendor_applications;
CREATE TRIGGER trg_vendor_applications_updated_at
BEFORE UPDATE ON vendor_applications
FOR EACH ROW EXECUTE FUNCTION touch_vendor_marketplace_updated_at();

DROP TRIGGER IF EXISTS trg_vendor_users_updated_at ON vendor_users;
CREATE TRIGGER trg_vendor_users_updated_at
BEFORE UPDATE ON vendor_users
FOR EACH ROW EXECUTE FUNCTION touch_vendor_marketplace_updated_at();

DROP TRIGGER IF EXISTS trg_vendor_subscriptions_updated_at ON vendor_subscriptions;
CREATE TRIGGER trg_vendor_subscriptions_updated_at
BEFORE UPDATE ON vendor_subscriptions
FOR EACH ROW EXECUTE FUNCTION touch_vendor_marketplace_updated_at();

DROP TRIGGER IF EXISTS trg_vendor_product_submissions_updated_at ON vendor_product_submissions;
CREATE TRIGGER trg_vendor_product_submissions_updated_at
BEFORE UPDATE ON vendor_product_submissions
FOR EACH ROW EXECUTE FUNCTION touch_vendor_marketplace_updated_at();

COMMIT;
