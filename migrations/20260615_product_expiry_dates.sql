-- Product expiry visibility for inventory and dashboard alerts.
-- Additive migration: existing products can remain NULL until the admin edits them,
-- while the API/form will require expiry_date for new and updated products.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS expiry_date DATE,
  ADD COLUMN IF NOT EXISTS expiry_warning_days INTEGER NOT NULL DEFAULT 210;

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS chk_products_expiry_warning_days;

ALTER TABLE public.products
  ADD CONSTRAINT chk_products_expiry_warning_days
  CHECK (expiry_warning_days BETWEEN 1 AND 1095);

CREATE INDEX IF NOT EXISTS idx_products_expiry_date
  ON public.products (expiry_date)
  WHERE expiry_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_active_expiry
  ON public.products (is_active, expiry_date)
  WHERE expiry_date IS NOT NULL;
