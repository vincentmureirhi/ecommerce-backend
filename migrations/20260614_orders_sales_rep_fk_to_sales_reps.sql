-- Fix route order attribution so order.sales_rep_id points to the field-sales table.
-- Older schema snapshots had orders.sales_rep_id linked to users(id), which breaks
-- sales-rep checkout because the sales rep portal authenticates against sales_reps(id).

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS sales_rep_id INTEGER;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_sales_rep_id_fkey;

UPDATE public.orders o
SET sales_rep_id = NULL,
    updated_at = COALESCE(o.updated_at, NOW())
WHERE o.sales_rep_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.sales_reps sr
    WHERE sr.id = o.sales_rep_id
  );

ALTER TABLE public.orders
  ADD CONSTRAINT orders_sales_rep_id_fkey
  FOREIGN KEY (sales_rep_id)
  REFERENCES public.sales_reps(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_sales_rep_created
  ON public.orders (sales_rep_id, created_at DESC);

COMMIT;
