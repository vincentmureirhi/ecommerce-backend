-- Allows admin to intentionally label storefront stock state while order safety still uses current_stock.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS stock_status_override TEXT;

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS chk_products_stock_status_override;

ALTER TABLE public.products
  ADD CONSTRAINT chk_products_stock_status_override
  CHECK (
    stock_status_override IS NULL
    OR stock_status_override IN ('in_stock', 'limited_stock', 'out_of_stock')
  );

CREATE INDEX IF NOT EXISTS idx_products_stock_status_override
  ON public.products (stock_status_override)
  WHERE stock_status_override IS NOT NULL;
