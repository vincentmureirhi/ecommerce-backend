-- Phase 3A: vendor portal, verified storefront visibility, and product submission workflow.
-- Additive only. Existing XPOSE products, route orders, checkout, and admin users remain unchanged.

BEGIN;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS public_description TEXT,
  ADD COLUMN IF NOT EXISTS support_phone TEXT,
  ADD COLUMN IF NOT EXISTS support_email TEXT,
  ADD COLUMN IF NOT EXISTS website_url TEXT,
  ADD COLUMN IF NOT EXISTS store_visibility_status TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS storefront_featured BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verification_badge_label TEXT NOT NULL DEFAULT 'Verified by XPOSE',
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_product_submission_at TIMESTAMPTZ;

UPDATE vendors
SET
  store_visibility_status = CASE
    WHEN status = 'active' AND verification_status = 'verified' THEN 'public'
    ELSE COALESCE(store_visibility_status, 'private')
  END,
  published_at = CASE
    WHEN status = 'active' AND verification_status = 'verified' AND published_at IS NULL THEN NOW()
    ELSE published_at
  END
WHERE store_visibility_status IS NULL
   OR (status = 'active' AND verification_status = 'verified' AND store_visibility_status = 'private');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_vendors_store_visibility_status'
  ) THEN
    ALTER TABLE vendors
      ADD CONSTRAINT chk_vendors_store_visibility_status
      CHECK (store_visibility_status IN ('private', 'public', 'hidden'));
  END IF;
END $$;

ALTER TABLE vendor_users
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_password_reset_at TIMESTAMPTZ;

ALTER TABLE vendor_product_submissions
  ADD COLUMN IF NOT EXISTS brand_name TEXT,
  ADD COLUMN IF NOT EXISTS product_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_featured_requested BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS vendor_notes TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_vendors_public_storefront
  ON vendors (store_visibility_status, status, verification_status, storefront_featured, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vendor_product_submissions_status_created
  ON vendor_product_submissions (submission_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_products_public_vendor_store
  ON products (vendor_id, is_active, vendor_approval_status, product_owner_type, current_stock);

COMMIT;
