-- Phase 3C: vendor password recovery support, vendor analytics inbox, and customer messages.
-- Additive only. Existing vendor applications, product approvals, checkout, and route orders remain unchanged.

BEGIN;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ;

ALTER TABLE vendor_users
  ADD COLUMN IF NOT EXISTS last_password_reset_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS vendor_customer_messages (
  id BIGSERIAL PRIMARY KEY,
  vendor_id BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  customer_email TEXT,
  message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'storefront',
  status TEXT NOT NULL DEFAULT 'new',
  vendor_notes TEXT,
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vendor_customer_messages_status
    CHECK (status IN ('new', 'read', 'closed')),
  CONSTRAINT chk_vendor_customer_messages_source
    CHECK (source IN ('storefront', 'product_page', 'admin', 'vendor_portal'))
);

CREATE INDEX IF NOT EXISTS idx_vendor_customer_messages_vendor_status
  ON vendor_customer_messages (vendor_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vendor_customer_messages_product
  ON vendor_customer_messages (product_id, created_at DESC)
  WHERE product_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_vendor_customer_messages_updated_at ON vendor_customer_messages;
CREATE TRIGGER trg_vendor_customer_messages_updated_at
BEFORE UPDATE ON vendor_customer_messages
FOR EACH ROW EXECUTE FUNCTION touch_vendor_marketplace_updated_at();

COMMIT;
