-- Keeps product admin fields aligned with the backend create/update controller.
-- Safe to run more than once.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS barcode VARCHAR(100),
  ADD COLUMN IF NOT EXISTS reorder_level INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS is_combo_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS chk_products_reorder_level_nonnegative;

ALTER TABLE public.products
  ADD CONSTRAINT chk_products_reorder_level_nonnegative
  CHECK (reorder_level >= 0);

CREATE INDEX IF NOT EXISTS idx_products_barcode
  ON public.products (barcode)
  WHERE barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_active_stock
  ON public.products (is_active, current_stock);
