-- ============================================================
--  XPOSE DISTRIBUTORS — Safe catch-up migration
--  Run this once in psql to fix the 500 error on order placement.
--  All statements use IF NOT EXISTS / IF EXISTS so it is safe
--  to run multiple times.
-- ============================================================

BEGIN;

-- ── orders table ────────────────────────────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_email         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS delivery_address       TEXT,
  ADD COLUMN IF NOT EXISTS order_workflow_type    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS payment_state         VARCHAR(50)  DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS is_printed            BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS printed_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_changed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_payment_date     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS amount_paid           NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ── order_items table ────────────────────────────────────────
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS price_source     TEXT,
  ADD COLUMN IF NOT EXISTS line_total      NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS pricing_locked_at TIMESTAMPTZ;

-- Auto-stamp pricing_locked_at on insert
CREATE OR REPLACE FUNCTION lock_order_item_pricing_on_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.pricing_locked_at := COALESCE(NEW.pricing_locked_at, NOW());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_order_item_pricing_insert ON order_items;
CREATE TRIGGER trg_lock_order_item_pricing_insert
  BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION lock_order_item_pricing_on_insert();

-- ── order_item_pricing_audit ─────────────────────────────────
CREATE TABLE IF NOT EXISTS order_item_pricing_audit (
  id                BIGSERIAL    PRIMARY KEY,
  order_item_id     INT          NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  order_id          INT          NOT NULL,
  product_id        INT          NOT NULL,
  quantity          INT          NOT NULL,
  price_at_purchase NUMERIC(10,2) NOT NULL,
  line_total        NUMERIC(12,2) NOT NULL,
  price_source      TEXT,
  pricing_locked_at TIMESTAMPTZ  NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── sales_rep_locations ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_rep_locations (
  id               BIGSERIAL    PRIMARY KEY,
  sales_rep_id     INTEGER      NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  latitude         NUMERIC(10,7) NOT NULL,
  longitude        NUMERIC(10,7) NOT NULL,
  accuracy_meters  NUMERIC(10,2),
  speed_kph        NUMERIC(10,2),
  heading_degrees  NUMERIC(10,2),
  battery_level    NUMERIC(5,2),
  source           VARCHAR(50)  NOT NULL DEFAULT 'web',
  recorded_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_rep_locations_rep_recorded
  ON sales_rep_locations (sales_rep_id, recorded_at DESC);

-- ── sales_reps auth columns ──────────────────────────────────
ALTER TABLE sales_reps
  ADD COLUMN IF NOT EXISTS full_name          TEXT,
  ADD COLUMN IF NOT EXISTS phone              VARCHAR(20),
  ADD COLUMN IF NOT EXISTS username           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS password_hash      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS route_area         TEXT,
  ADD COLUMN IF NOT EXISTS last_login_at      TIMESTAMPTZ;

-- ── categories image support ─────────────────────────────────
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS image_url TEXT;

-- ── blog_posts image support (already in migration but safe) ─
ALTER TABLE blog_posts
  ADD COLUMN IF NOT EXISTS featured_image_url TEXT;

COMMIT;