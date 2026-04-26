BEGIN;

-- 1) Drop the old narrow check constraint and replace with the full workflow set
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_order_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_order_status_check
    CHECK (order_status IN ('pending', 'processing', 'dispatched', 'completed', 'cancelled'));

-- 2) Add status_changed_at column (safe for existing rows – defaults to created_at)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;

-- Backfill existing rows so the column is never NULL for old data
UPDATE orders
  SET status_changed_at = COALESCE(updated_at, created_at)
WHERE status_changed_at IS NULL;

COMMIT;
